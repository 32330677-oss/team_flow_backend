-- =====================================================================
-- 2026-10 Daily Site Manpower Report (for the sub-contractor / client)
--
-- Adds two NEW tables only. No existing table or column is changed, so no
-- existing query is affected. Idempotent: safe to run more than once.
-- Rollback: 99_rollback.sql
--
-- report_signatories
--   The people a report can be issued in the name of ("Issued by"), e.g.
--   "Eng. Hamza ...  /  Site Manager". Managed by the Admin. Deactivated,
--   never deleted, so old reports keep pointing to a valid row.
--
-- daily_site_reports
--   One row per generated report. `report_no` is printed on the PDF and
--   `payload` keeps the exact data that was printed, so the same PDF can be
--   re-printed later even if attendance changes afterwards (dispute proof).
-- =====================================================================

CREATE TABLE IF NOT EXISTS report_signatories (
  signatory_id        INT NOT NULL AUTO_INCREMENT,
  full_name           VARCHAR(150) NOT NULL,
  title               VARCHAR(150) NOT NULL,
  is_active           TINYINT(1) NOT NULL DEFAULT 1,
  created_by_user_id  INT NULL,
  created_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (signatory_id),
  KEY idx_rs_active (is_active),
  CONSTRAINT fk_rs_created_by FOREIGN KEY (created_by_user_id) REFERENCES users (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS daily_site_reports (
  report_id             INT NOT NULL AUTO_INCREMENT,
  report_no             VARCHAR(40) NULL COMMENT 'DSR-YYYYMMDD-#### (set right after insert)',
  report_date           DATE NOT NULL,
  shift_filter          ENUM('All','Day','Night') NOT NULL DEFAULT 'All',
  site_ids              JSON NOT NULL,
  recipient_name        VARCHAR(200) NULL,
  signatory_id          INT NULL,
  issued_by_name        VARCHAR(150) NOT NULL,
  issued_by_title       VARCHAR(150) NULL,
  options               JSON NOT NULL,
  totals                JSON NOT NULL,
  payload               JSON NOT NULL COMMENT 'Exact data printed on the PDF',
  generated_by_user_id  INT NOT NULL,
  generated_at          DATETIME NOT NULL,
  PRIMARY KEY (report_id),
  UNIQUE KEY uq_dsr_report_no (report_no),
  KEY idx_dsr_date (report_date),
  CONSTRAINT fk_dsr_signatory FOREIGN KEY (signatory_id) REFERENCES report_signatories (signatory_id),
  CONSTRAINT fk_dsr_user FOREIGN KEY (generated_by_user_id) REFERENCES users (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
