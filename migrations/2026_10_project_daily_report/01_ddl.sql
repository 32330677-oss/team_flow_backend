-- =====================================================================
-- 2026-10 Project Daily Report (combined Team Flow + Equipment Flow)
--
-- Adds two NEW tables only. No existing table or column is changed.
-- Idempotent: safe to run more than once. Rollback: 99_rollback.sql
--
-- project_daily_report_profiles
--   One profile per agreement / report (e.g. "Agreement 71 - T2 Underground"):
--   header texts, project info, the Team Flow sites and the Equipment Flow
--   sites it covers, the row lists of the form, name mappings and BOQ lines.
--   Kept in one JSON `config` (validated by services/projectDailyReportService).
--   Deactivated, never deleted, so old reports keep their profile.
--
-- project_daily_reports
--   One row per generated Word file. `payload` keeps the exact data that was
--   printed, so the same file can be downloaded again later.
-- =====================================================================

CREATE TABLE IF NOT EXISTS project_daily_report_profiles (
  profile_id          INT NOT NULL AUTO_INCREMENT,
  name                VARCHAR(150) NOT NULL,
  is_active           TINYINT(1) NOT NULL DEFAULT 1,
  config              JSON NOT NULL,
  created_by_user_id  INT NULL,
  updated_by_user_id  INT NULL,
  created_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (profile_id),
  UNIQUE KEY uq_pdrp_name (name),
  CONSTRAINT fk_pdrp_created_by FOREIGN KEY (created_by_user_id) REFERENCES users (user_id),
  CONSTRAINT fk_pdrp_updated_by FOREIGN KEY (updated_by_user_id) REFERENCES users (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS project_daily_reports (
  report_id             INT NOT NULL AUTO_INCREMENT,
  report_no             VARCHAR(40) NULL COMMENT 'PDR-YYYYMMDD-#### (set right after insert)',
  profile_id            INT NOT NULL,
  report_date           DATE NOT NULL,
  options               JSON NOT NULL,
  payload               JSON NOT NULL COMMENT 'Exact data printed in the Word file',
  generated_by_user_id  INT NOT NULL,
  generated_at          DATETIME NOT NULL,
  PRIMARY KEY (report_id),
  UNIQUE KEY uq_pdr_report_no (report_no),
  KEY idx_pdr_date (report_date),
  KEY idx_pdr_profile (profile_id),
  CONSTRAINT fk_pdr_profile FOREIGN KEY (profile_id) REFERENCES project_daily_report_profiles (profile_id),
  CONSTRAINT fk_pdr_user FOREIGN KEY (generated_by_user_id) REFERENCES users (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
