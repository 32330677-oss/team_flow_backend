-- =====================================================================
-- 2026-10 Staff salary advances
--
-- Run AFTER migrations/2026_10_payroll_adjustments/01_ddl.sql.
-- Idempotent: safe to run more than once. No existing value is changed:
--   * new tables document_sequences, staff_financial_reports, staff_advances,
--     staff_advance_installments, staff_advance_ledger
--   * new column staff_payroll.advance_deduction_amount (DEFAULT 0 for every old row)
--   * new settings (only inserted when missing)
-- net_salary keeps its meaning: what the person is paid in that batch.
-- For new staff batches: net_salary = calculated + adjustments_amount - advance_deduction_amount.
-- Staff only. Worker payroll is not touched.
-- Rollback: 99_rollback.sql
-- =====================================================================

-- One row per document series (e.g. 'ADV-2026', 'RCP-2026'). Numbers are taken
-- inside the caller's transaction with a row lock: never repeated, never reused.
CREATE TABLE IF NOT EXISTS document_sequences (
  seq_key     VARCHAR(30) NOT NULL,
  last_number  INT NOT NULL DEFAULT 0,
  updated_at  TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (seq_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- The financial report the Admin must open before creating an advance.
-- `snapshot` keeps exactly what the Admin saw.
CREATE TABLE IF NOT EXISTS staff_financial_reports (
  report_id             INT NOT NULL AUTO_INCREMENT,
  staff_id              INT NOT NULL,
  generated_by_user_id  INT NOT NULL,
  generated_at          DATETIME NOT NULL,
  snapshot              JSON NOT NULL,
  PRIMARY KEY (report_id),
  KEY idx_sfr_staff (staff_id, generated_at),
  CONSTRAINT fk_sfinr_staff FOREIGN KEY (staff_id) REFERENCES staff_members (staff_id),
  CONSTRAINT fk_sfinr_user FOREIGN KEY (generated_by_user_id) REFERENCES users (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS staff_advances (
  advance_id              INT NOT NULL AUTO_INCREMENT,
  voucher_no              VARCHAR(20) NOT NULL COMMENT 'ADV-YYYY-NNNNNN, unique, never reused',
  staff_id                INT NOT NULL,
  currency                CHAR(3) NOT NULL,
  amount                  DECIMAL(12,2) NOT NULL,
  deduction_mode          ENUM('Full','Partial') NOT NULL,
  reason                  VARCHAR(1000) NOT NULL,
  payment_method          ENUM('Cash','BankTransfer','Cheque') NOT NULL DEFAULT 'Cash',
  payment_reference       VARCHAR(100) NULL,
  financial_report_id     INT NOT NULL,
  status                  ENUM('Active','Settled','Cancelled','WrittenOff') NOT NULL,
  outstanding_balance     DECIMAL(12,2) NOT NULL COMMENT 'Cache of SUM(staff_advance_ledger.amount)',
  cancel_deadline         DATETIME NOT NULL COMMENT 'created_at + advance_cancel_window_hours',
  idempotency_key         VARCHAR(64) NULL,
  created_by_user_id      INT NOT NULL,
  created_at              DATETIME NOT NULL,
  cancelled_by_user_id    INT NULL,
  cancelled_at            DATETIME NULL,
  cancel_reason           VARCHAR(500) NULL,
  written_off_by_user_id  INT NULL,
  written_off_at          DATETIME NULL,
  write_off_reason        VARCHAR(500) NULL,
  settled_at              DATETIME NULL,
  voucher_print_count     INT NOT NULL DEFAULT 0,
  receipt_file            VARCHAR(255) NULL COMMENT 'Signed receipt (fileStorage name)',
  receipt_uploaded_by     INT NULL,
  receipt_uploaded_at     DATETIME NULL,
  PRIMARY KEY (advance_id),
  UNIQUE KEY uq_sa_voucher (voucher_no),
  UNIQUE KEY uq_sa_idempotency (idempotency_key),
  UNIQUE KEY uq_sa_report (financial_report_id),
  KEY idx_sa_staff_status (staff_id, status),
  CONSTRAINT fk_sadv_staff FOREIGN KEY (staff_id) REFERENCES staff_members (staff_id),
  CONSTRAINT fk_sadv_report FOREIGN KEY (financial_report_id) REFERENCES staff_financial_reports (report_id),
  CONSTRAINT fk_sadv_created_by FOREIGN KEY (created_by_user_id) REFERENCES users (user_id),
  CONSTRAINT fk_sadv_cancelled_by FOREIGN KEY (cancelled_by_user_id) REFERENCES users (user_id),
  CONSTRAINT fk_sadv_written_off_by FOREIGN KEY (written_off_by_user_id) REFERENCES users (user_id),
  CONSTRAINT fk_sadv_receipt_by FOREIGN KEY (receipt_uploaded_by) REFERENCES users (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- The deduction schedule. One row per (month, amount).
--   Scheduled   waits for the staff batch whose end_date is in deduction_month
--   Included    carried by a Generated batch (included_batch_id)
--   Deducted    that batch was marked Paid
--   Unscheduled could not be deducted in its month (pay too low / not in the batch):
--               the Admin chooses a new month (reschedule)
--   Replaced    superseded by a reschedule (kept as history)
--   Repaid      covered by a cash repayment
--   WrittenOff  written off
--   Cancelled   the advance was cancelled
CREATE TABLE IF NOT EXISTS staff_advance_installments (
  installment_id            INT NOT NULL AUTO_INCREMENT,
  advance_id                INT NOT NULL,
  seq                       INT NOT NULL,
  deduction_month           CHAR(7) NULL COMMENT 'YYYY-MM; NULL when Unscheduled without a month',
  amount                    DECIMAL(12,2) NOT NULL,
  status                    ENUM('Scheduled','Included','Deducted','Unscheduled','Replaced','Repaid','WrittenOff','Cancelled') NOT NULL,
  included_batch_id         INT NULL COMMENT 'staff_payroll_batches that carries / carried it',
  displaced_by_batch_id     INT NULL COMMENT 'Batch that could not deduct it (made it Unscheduled)',
  split_from_installment_id INT NULL COMMENT 'Remainder row created from this installment by a batch',
  deducted_at               DATETIME NULL,
  created_at                DATETIME NOT NULL,
  PRIMARY KEY (installment_id),
  UNIQUE KEY uq_sai_seq (advance_id, seq),
  KEY idx_sai_status_month (status, deduction_month),
  KEY idx_sai_included (included_batch_id),
  KEY idx_sai_displaced (displaced_by_batch_id),
  CONSTRAINT fk_sadvi_advance FOREIGN KEY (advance_id) REFERENCES staff_advances (advance_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Append-only money ledger. Balance of an advance = SUM(amount).
CREATE TABLE IF NOT EXISTS staff_advance_ledger (
  entry_id                INT NOT NULL AUTO_INCREMENT,
  advance_id              INT NOT NULL,
  entry_type              ENUM('Disbursement','PayrollDeduction','CashRepayment','WriteOff','Cancellation') NOT NULL,
  amount                  DECIMAL(12,2) NOT NULL COMMENT '+ increases what is owed, - reduces it',
  installment_id          INT NULL,
  staff_payroll_batch_id  INT NULL,
  receipt_no              VARCHAR(20) NULL COMMENT 'RCP-YYYY-NNNNNN for cash repayments',
  payment_method          ENUM('Cash','BankTransfer','Cheque') NULL,
  note                    VARCHAR(500) NULL,
  created_by_user_id      INT NOT NULL,
  created_at              DATETIME NOT NULL,
  PRIMARY KEY (entry_id),
  UNIQUE KEY uq_sal_receipt (receipt_no),
  KEY idx_sal_advance (advance_id),
  CONSTRAINT fk_sadvl_advance FOREIGN KEY (advance_id) REFERENCES staff_advances (advance_id),
  CONSTRAINT fk_sadvl_user FOREIGN KEY (created_by_user_id) REFERENCES users (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

SET @s := (SELECT IF(COUNT(*) = 0,
  'ALTER TABLE staff_payroll ADD COLUMN advance_deduction_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00',
  'SELECT ''staff_payroll.advance_deduction_amount already exists'' AS info')
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'staff_payroll' AND COLUMN_NAME = 'advance_deduction_amount');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

INSERT IGNORE INTO system_settings (setting_key, setting_value) VALUES
  ('advance_cancel_window_hours', '72'),
  ('advance_allow_multiple_open', 'false'),
  ('advance_report_valid_minutes', '30');

-- Verification: must return 6 rows, each with present = 1.
SELECT 'document_sequences' AS object, COUNT(*) AS present FROM information_schema.TABLES
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'document_sequences'
UNION ALL
SELECT 'staff_financial_reports', COUNT(*) FROM information_schema.TABLES
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'staff_financial_reports'
UNION ALL
SELECT 'staff_advances', COUNT(*) FROM information_schema.TABLES
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'staff_advances'
UNION ALL
SELECT 'staff_advance_installments', COUNT(*) FROM information_schema.TABLES
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'staff_advance_installments'
UNION ALL
SELECT 'staff_advance_ledger', COUNT(*) FROM information_schema.TABLES
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'staff_advance_ledger'
UNION ALL
SELECT 'staff_payroll.advance_deduction_amount', COUNT(*) FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'staff_payroll' AND COLUMN_NAME = 'advance_deduction_amount';
