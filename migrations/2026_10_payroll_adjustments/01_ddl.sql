-- =====================================================================
-- 2026-10 Payroll adjustments (retro pay)
--
-- Run AFTER migrations/2026_10_recycle_bin/01_ddl.sql.
-- Idempotent: safe to run more than once. No existing value is changed:
--   * new table payroll_adjustments
--   * new column payroll.adjustments_amount       (DEFAULT 0 for every old row)
--   * new column staff_payroll.adjustments_amount (DEFAULT 0 for every old row)
-- net_salary keeps its meaning: what the person is paid in that batch.
-- For new batches: net_salary = calculated salary + adjustments_amount.
-- Rollback: 99_rollback.sql
-- =====================================================================

CREATE TABLE IF NOT EXISTS payroll_adjustments (
  adjustment_id        INT NOT NULL AUTO_INCREMENT,
  person_type          ENUM('Worker','Staff') NOT NULL,
  person_id            INT NOT NULL COMMENT 'worker_id or staff_id',
  source               ENUM('Correction','Manual') NOT NULL,
  correction_id        INT NULL COMMENT 'attendance_corrections_log row that caused it (source = Correction)',
  origin_batch_id      INT NULL COMMENT 'The PAID batch the difference belongs to (payrollbatches / staff_payroll_batches)',
  origin_date          DATE NULL COMMENT 'Corrected attendance date',
  currency             CHAR(3) NOT NULL,
  amount               DECIMAL(12,2) NOT NULL COMMENT 'Signed: + pay more, - deduct',
  before_amount        DECIMAL(12,2) NULL COMMENT 'Pay for the day / month before the correction',
  after_amount         DECIMAL(12,2) NULL COMMENT 'Pay for the day / month after the correction',
  calc_detail          JSON NULL,
  reason               VARCHAR(1000) NOT NULL,
  status               ENUM('AwaitingConfirmation','Pending','Included','Applied','Cancelled') NOT NULL,
  included_batch_id    INT NULL COMMENT 'Batch that carries it (payrollbatches / staff_payroll_batches)',
  created_by_user_id   INT NOT NULL,
  created_at           DATETIME NOT NULL,
  confirmed_by_user_id INT NULL,
  confirmed_at         DATETIME NULL,
  cancelled_by_user_id INT NULL,
  cancelled_at         DATETIME NULL,
  cancel_reason        VARCHAR(500) NULL,
  applied_at           DATETIME NULL,
  PRIMARY KEY (adjustment_id),
  UNIQUE KEY uq_pa_correction (correction_id),
  KEY idx_pa_person_status (person_type, person_id, status),
  KEY idx_pa_included (person_type, included_batch_id),
  CONSTRAINT fk_pa_correction FOREIGN KEY (correction_id) REFERENCES attendance_corrections_log (correction_id),
  CONSTRAINT fk_pa_created_by FOREIGN KEY (created_by_user_id) REFERENCES users (user_id),
  CONSTRAINT fk_pa_confirmed_by FOREIGN KEY (confirmed_by_user_id) REFERENCES users (user_id),
  CONSTRAINT fk_pa_cancelled_by FOREIGN KEY (cancelled_by_user_id) REFERENCES users (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

SET @s := (SELECT IF(COUNT(*) = 0,
  'ALTER TABLE payroll ADD COLUMN adjustments_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00',
  'SELECT ''payroll.adjustments_amount already exists'' AS info')
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'payroll' AND COLUMN_NAME = 'adjustments_amount');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s := (SELECT IF(COUNT(*) = 0,
  'ALTER TABLE staff_payroll ADD COLUMN adjustments_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00',
  'SELECT ''staff_payroll.adjustments_amount already exists'' AS info')
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'staff_payroll' AND COLUMN_NAME = 'adjustments_amount');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- Verification: must return 3 rows.
SELECT 'payroll_adjustments' AS object, COUNT(*) AS present FROM information_schema.TABLES
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'payroll_adjustments'
UNION ALL
SELECT 'payroll.adjustments_amount', COUNT(*) FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'payroll' AND COLUMN_NAME = 'adjustments_amount'
UNION ALL
SELECT 'staff_payroll.adjustments_amount', COUNT(*) FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'staff_payroll' AND COLUMN_NAME = 'adjustments_amount';
