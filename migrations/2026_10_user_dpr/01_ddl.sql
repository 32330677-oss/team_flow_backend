-- =====================================================================
-- 2026-10 Accounts of type "User" + roles & permissions + Daily Progress
-- Report (DPR). ONE file, run once (safe to run again: idempotent).
--
-- The ONLY change to an existing table: the value 'User' is ADDED at the end
-- of users.role. Existing values, rows, defaults and NULL-ability are kept.
-- Every other table here is NEW. Nothing that exists is changed.
--
-- Part A  roles & accounts
--   app_roles, app_role_permissions, app_user_roles, app_access_audit
-- Part B  Daily Progress Report (one set of data PER CONTRACT, never shared)
--   dpr_contracts       contract information, dates, hours/day, linked sites
--   dpr_eot_vo          variation orders / extensions of time
--   dpr_lines           resource lines: own trades, own plant, subcontractors
--   dpr_boq             bill of quantities
--   dpr_days            one row per contract + day (weather, HSE, texts...)
--   dpr_day_counts      daily counts typed for lines with no system source
--   dpr_activities      activities executed (BOQ item, location, qty)
--   dpr_activity_alloc  crew / plant allocated to each activity
--   dpr_qa              QA / QC entries (IR, MIR, tests...)
--   dpr_ncr             NCR register
--   dpr_concerns        areas of concern register
--   dpr_photos          site photographs
--   dpr_overrides       manual values over system values (with history)
--   dpr_change_log      every change (old / new / who / when)
--   dpr_reports         issued reports (frozen data, revisions)
--
-- Team Flow data (attendance, workers, sites...) and the Equipment system
-- are only READ, never written. Rollback: 99_rollback.sql
-- =====================================================================

-- ======================= Part A: accounts & roles =====================
-- 1. users.role: add 'User' (rebuilt from the live column definition)
DROP PROCEDURE IF EXISTS mig_202610_user_dpr_add_user_type;
DELIMITER $$
CREATE PROCEDURE mig_202610_user_dpr_add_user_type()
BEGIN
  DECLARE v_type TEXT;
  DECLARE v_null VARCHAR(3);
  DECLARE v_default TEXT;
  SELECT COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT INTO v_type, v_null, v_default
    FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'role';
  IF v_type IS NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'users.role not found. Nothing changed.';
  END IF;
  IF LOCATE('''User''', v_type) = 0 THEN
    SET @mig_sql = CONCAT(
      'ALTER TABLE users MODIFY role ', LEFT(v_type, CHAR_LENGTH(v_type) - 1), ',''User'')',
      IF(v_null = 'NO', ' NOT NULL', ' NULL'),
      IF(v_default IS NULL, '', CONCAT(' DEFAULT ', QUOTE(v_default))));
    PREPARE mig_stmt FROM @mig_sql;
    EXECUTE mig_stmt;
    DEALLOCATE PREPARE mig_stmt;
  END IF;
END$$
DELIMITER ;
CALL mig_202610_user_dpr_add_user_type();
DROP PROCEDURE IF EXISTS mig_202610_user_dpr_add_user_type;

-- 2. New tables
CREATE TABLE IF NOT EXISTS app_roles (
  role_id             INT NOT NULL AUTO_INCREMENT,
  name                VARCHAR(100) NOT NULL,
  description         VARCHAR(500) NULL,
  is_active           TINYINT(1) NOT NULL DEFAULT 1,
  created_by_user_id  INT NULL,
  updated_by_user_id  INT NULL,
  created_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (role_id),
  UNIQUE KEY uq_app_roles_name (name),
  CONSTRAINT fk_app_roles_created_by FOREIGN KEY (created_by_user_id) REFERENCES users (user_id),
  CONSTRAINT fk_app_roles_updated_by FOREIGN KEY (updated_by_user_id) REFERENCES users (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS app_role_permissions (
  role_id         INT NOT NULL,
  permission_key  VARCHAR(64) NOT NULL,
  PRIMARY KEY (role_id, permission_key),
  CONSTRAINT fk_app_role_perms_role FOREIGN KEY (role_id) REFERENCES app_roles (role_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS app_user_roles (
  user_id              INT NOT NULL,
  role_id              INT NOT NULL,
  assigned_by_user_id  INT NULL,
  assigned_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id),
  KEY idx_app_user_roles_role (role_id),
  CONSTRAINT fk_app_user_roles_user FOREIGN KEY (user_id) REFERENCES users (user_id),
  CONSTRAINT fk_app_user_roles_role FOREIGN KEY (role_id) REFERENCES app_roles (role_id),
  CONSTRAINT fk_app_user_roles_by FOREIGN KEY (assigned_by_user_id) REFERENCES users (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS app_access_audit (
  audit_id         INT NOT NULL AUTO_INCREMENT,
  actor_user_id    INT NULL,
  action           VARCHAR(40) NOT NULL COMMENT 'role.create, role.update, user.create, user.update, user.status, user.password',
  target_type      ENUM('Role','User') NOT NULL,
  target_id        INT NOT NULL,
  details          JSON NULL COMMENT 'what changed (old / new); never a password',
  created_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (audit_id),
  KEY idx_app_access_audit_target (target_type, target_id),
  KEY idx_app_access_audit_created (created_at),
  CONSTRAINT fk_app_access_audit_actor FOREIGN KEY (actor_user_id) REFERENCES users (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ======================= Part B: Daily Progress Report ================
CREATE TABLE IF NOT EXISTS dpr_contracts (
  contract_id          INT NOT NULL AUTO_INCREMENT,
  code                 VARCHAR(30)  NOT NULL COMMENT 'short name shown on the tab, e.g. 71',
  title                VARCHAR(200) NOT NULL,
  is_active            TINYINT(1) NOT NULL DEFAULT 1,
  sort_order           INT NOT NULL DEFAULT 0,
  company_name         VARCHAR(200) NULL,
  project_name         VARCHAR(500) NULL,
  project_code         VARCHAR(100) NULL,
  agreement_no         VARCHAR(200) NULL,
  client               VARCHAR(300) NULL,
  consultant           VARCHAR(300) NULL,
  main_contractor      VARCHAR(300) NULL,
  location             VARCHAR(300) NULL,
  currency             VARCHAR(10)  NOT NULL DEFAULT 'AED',
  contract_value       DECIMAL(18,2) NULL,
  commencement_date    DATE NULL,
  original_completion  DATE NULL,
  hrs_mp               DECIMAL(5,2) NOT NULL DEFAULT 10.00 COMMENT 'working hours / day - manpower',
  hrs_pl               DECIMAL(5,2) NOT NULL DEFAULT 10.00 COMMENT 'working hours / day - plant',
  prepared_by          VARCHAR(200) NULL,
  reviewed_by          VARCHAR(200) NULL,
  consultant_rep       VARCHAR(200) NULL,
  report_prefix        VARCHAR(20)  NOT NULL DEFAULT 'DPR-',
  tf_site_ids          JSON NULL COMMENT 'Team Flow sites read for manpower',
  eq_site_ids          JSON NULL COMMENT 'Equipment system sites read for plant',
  copy_from_ids        JSON NULL COMMENT 'contracts whose day data may be copied into this one',
  sections             JSON NULL COMMENT 'sections printed by default',
  created_by_user_id   INT NULL,
  updated_by_user_id   INT NULL,
  created_at           TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at           TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (contract_id),
  UNIQUE KEY uq_dpr_contracts_code (code),
  CONSTRAINT fk_dpr_contracts_created FOREIGN KEY (created_by_user_id) REFERENCES users (user_id),
  CONSTRAINT fk_dpr_contracts_updated FOREIGN KEY (updated_by_user_id) REFERENCES users (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS dpr_eot_vo (
  eot_vo_id      INT NOT NULL AUTO_INCREMENT,
  contract_id    INT NOT NULL,
  sort_order     INT NOT NULL DEFAULT 0,
  description    VARCHAR(500) NOT NULL,
  ref_no         VARCHAR(100) NULL,
  type           ENUM('VO','EOT') NOT NULL,
  days_granted   INT NOT NULL DEFAULT 0,
  value          DECIMAL(18,2) NOT NULL DEFAULT 0,
  approval_date  DATE NULL,
  status         ENUM('Approved','Pending','Rejected') NOT NULL DEFAULT 'Pending',
  is_deleted     TINYINT(1) NOT NULL DEFAULT 0,
  updated_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (eot_vo_id),
  KEY idx_dpr_eot_vo_contract (contract_id),
  CONSTRAINT fk_dpr_eot_vo_contract FOREIGN KEY (contract_id) REFERENCES dpr_contracts (contract_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS dpr_lines (
  line_id        INT NOT NULL AUTO_INCREMENT,
  contract_id    INT NOT NULL,
  kind           ENUM('trade','plant','subcon') NOT NULL,
  sort_order     INT NOT NULL DEFAULT 0,
  name           VARCHAR(200) NOT NULL COMMENT 'trade / equipment / resource',
  category       VARCHAR(60)  NULL COMMENT 'trade: Staff, Supervision, Skilled...',
  ownership      VARCHAR(20)  NULL COMMENT 'plant: Own / Hired',
  subcontractor  VARCHAR(200) NULL COMMENT 'subcon: company',
  res_type       ENUM('Manpower','Plant') NULL COMMENT 'subcon: Manpower / Plant',
  scope          VARCHAR(200) NULL COMMENT 'subcon: scope / package',
  source_map     JSON NULL COMMENT 'system names counted on this line (empty = typed every day)',
  opening_days   DECIMAL(12,2) NOT NULL DEFAULT 0 COMMENT 'man/equipment-days before the system',
  is_active      TINYINT(1) NOT NULL DEFAULT 1,
  updated_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (line_id),
  KEY idx_dpr_lines_contract (contract_id, kind, sort_order),
  CONSTRAINT fk_dpr_lines_contract FOREIGN KEY (contract_id) REFERENCES dpr_contracts (contract_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS dpr_boq (
  boq_id         INT NOT NULL AUTO_INCREMENT,
  contract_id    INT NOT NULL,
  sort_order     INT NOT NULL DEFAULT 0,
  item_no        VARCHAR(50)  NOT NULL,
  description    VARCHAR(1000) NOT NULL,
  unit           VARCHAR(30)  NULL,
  contract_qty   DECIMAL(18,4) NULL,
  rate           DECIMAL(18,4) NULL,
  opening_qty    DECIMAL(18,4) NOT NULL DEFAULT 0 COMMENT 'quantity done before the system',
  remarks        VARCHAR(500) NULL,
  is_active      TINYINT(1) NOT NULL DEFAULT 1,
  updated_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (boq_id),
  UNIQUE KEY uq_dpr_boq_item (contract_id, item_no),
  CONSTRAINT fk_dpr_boq_contract FOREIGN KEY (contract_id) REFERENCES dpr_contracts (contract_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS dpr_days (
  contract_id      INT NOT NULL,
  report_date      DATE NOT NULL,
  weather_am       VARCHAR(40) NULL,
  weather_pm       VARCHAR(40) NULL,
  temp_max         DECIMAL(5,1) NULL,
  temp_min         DECIMAL(5,1) NULL,
  humidity         DECIMAL(5,1) NULL,
  wind             DECIMAL(6,1) NULL,
  hours_lost       DECIMAL(5,2) NULL,
  weather_remarks  VARCHAR(500) NULL,
  tbt_topic        VARCHAR(300) NULL,
  tbt_attendees    INT NULL,
  hse_inspections  INT NULL,
  incidents        INT NULL,
  near_misses      INT NULL,
  first_aid        INT NULL,
  lti              INT NULL,
  ptws             INT NULL,
  hse_observations TEXT NULL,
  next_day_plan    TEXT NULL,
  remarks          TEXT NULL,
  sections         JSON NULL COMMENT 'sections printed for this day (null = contract default)',
  version          INT NOT NULL DEFAULT 1,
  updated_by_user_id INT NULL,
  created_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (contract_id, report_date),
  CONSTRAINT fk_dpr_days_contract FOREIGN KEY (contract_id) REFERENCES dpr_contracts (contract_id),
  CONSTRAINT fk_dpr_days_user FOREIGN KEY (updated_by_user_id) REFERENCES users (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS dpr_day_counts (
  contract_id    INT NOT NULL,
  report_date    DATE NOT NULL,
  line_id        INT NOT NULL,
  count_value    INT NOT NULL DEFAULT 0,
  updated_by_user_id INT NULL,
  updated_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (contract_id, report_date, line_id),
  KEY idx_dpr_day_counts_line (line_id),
  CONSTRAINT fk_dpr_day_counts_contract FOREIGN KEY (contract_id) REFERENCES dpr_contracts (contract_id),
  CONSTRAINT fk_dpr_day_counts_line FOREIGN KEY (line_id) REFERENCES dpr_lines (line_id),
  CONSTRAINT fk_dpr_day_counts_user FOREIGN KEY (updated_by_user_id) REFERENCES users (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS dpr_activities (
  activity_id    INT NOT NULL AUTO_INCREMENT,
  contract_id    INT NOT NULL,
  report_date    DATE NOT NULL,
  sort_order     INT NOT NULL DEFAULT 0,
  boq_id         INT NOT NULL,
  location       VARCHAR(300) NULL,
  qty            DECIMAL(18,4) NOT NULL DEFAULT 0,
  remarks        VARCHAR(500) NULL,
  is_deleted     TINYINT(1) NOT NULL DEFAULT 0,
  created_by_user_id INT NULL,
  updated_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (activity_id),
  KEY idx_dpr_activities_day (contract_id, report_date),
  KEY idx_dpr_activities_boq (boq_id),
  CONSTRAINT fk_dpr_activities_contract FOREIGN KEY (contract_id) REFERENCES dpr_contracts (contract_id),
  CONSTRAINT fk_dpr_activities_boq FOREIGN KEY (boq_id) REFERENCES dpr_boq (boq_id),
  CONSTRAINT fk_dpr_activities_user FOREIGN KEY (created_by_user_id) REFERENCES users (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS dpr_activity_alloc (
  activity_id    INT NOT NULL,
  line_id        INT NOT NULL,
  count_value    INT NOT NULL DEFAULT 0,
  PRIMARY KEY (activity_id, line_id),
  KEY idx_dpr_alloc_line (line_id),
  CONSTRAINT fk_dpr_alloc_activity FOREIGN KEY (activity_id) REFERENCES dpr_activities (activity_id),
  CONSTRAINT fk_dpr_alloc_line FOREIGN KEY (line_id) REFERENCES dpr_lines (line_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS dpr_qa (
  qa_id          INT NOT NULL AUTO_INCREMENT,
  contract_id    INT NOT NULL,
  report_date    DATE NOT NULL,
  sort_order     INT NOT NULL DEFAULT 0,
  type           VARCHAR(40)  NOT NULL,
  ref_no         VARCHAR(100) NULL,
  description    VARCHAR(500) NULL,
  location       VARCHAR(300) NULL,
  result         VARCHAR(40)  NULL,
  remarks        VARCHAR(500) NULL,
  is_deleted     TINYINT(1) NOT NULL DEFAULT 0,
  updated_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (qa_id),
  KEY idx_dpr_qa_day (contract_id, report_date),
  CONSTRAINT fk_dpr_qa_contract FOREIGN KEY (contract_id) REFERENCES dpr_contracts (contract_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS dpr_ncr (
  ncr_id            INT NOT NULL AUTO_INCREMENT,
  contract_id       INT NOT NULL,
  ncr_no            VARCHAR(60)  NOT NULL,
  date_raised       DATE NOT NULL,
  raised_by         VARCHAR(200) NULL,
  description       VARCHAR(1000) NOT NULL,
  root_cause        VARCHAR(1000) NULL,
  corrective_action VARCHAR(1000) NULL,
  responsible       VARCHAR(200) NULL,
  target_date       DATE NULL,
  status            ENUM('Open','Closed') NOT NULL DEFAULT 'Open',
  date_closed       DATE NULL,
  is_deleted        TINYINT(1) NOT NULL DEFAULT 0,
  updated_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (ncr_id),
  KEY idx_dpr_ncr_contract (contract_id, date_raised),
  CONSTRAINT fk_dpr_ncr_contract FOREIGN KEY (contract_id) REFERENCES dpr_contracts (contract_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS dpr_concerns (
  concern_id       INT NOT NULL AUTO_INCREMENT,
  contract_id      INT NOT NULL,
  date_raised      DATE NOT NULL,
  issue            VARCHAR(1000) NOT NULL,
  impact           VARCHAR(40)  NULL,
  severity         VARCHAR(20)  NULL,
  action_required  VARCHAR(1000) NULL,
  by_whom          VARCHAR(200) NULL,
  target_date      DATE NULL,
  status           ENUM('Open','Closed') NOT NULL DEFAULT 'Open',
  date_closed      DATE NULL,
  is_deleted       TINYINT(1) NOT NULL DEFAULT 0,
  updated_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (concern_id),
  KEY idx_dpr_concerns_contract (contract_id, date_raised),
  CONSTRAINT fk_dpr_concerns_contract FOREIGN KEY (contract_id) REFERENCES dpr_contracts (contract_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS dpr_photos (
  photo_id       INT NOT NULL AUTO_INCREMENT,
  contract_id    INT NOT NULL,
  report_date    DATE NOT NULL,
  slot           INT NOT NULL DEFAULT 1,
  file_name      VARCHAR(300) NOT NULL,
  content_type   VARCHAR(60)  NULL,
  boq_activity   VARCHAR(300) NULL,
  location       VARCHAR(300) NULL,
  caption        VARCHAR(500) NULL,
  is_deleted     TINYINT(1) NOT NULL DEFAULT 0,
  created_by_user_id INT NULL,
  created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (photo_id),
  KEY idx_dpr_photos_day (contract_id, report_date),
  CONSTRAINT fk_dpr_photos_contract FOREIGN KEY (contract_id) REFERENCES dpr_contracts (contract_id),
  CONSTRAINT fk_dpr_photos_user FOREIGN KEY (created_by_user_id) REFERENCES users (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS dpr_overrides (
  override_id    INT NOT NULL AUTO_INCREMENT,
  contract_id    INT NOT NULL,
  report_date    DATE NOT NULL,
  field_key      VARCHAR(80)  NOT NULL COMMENT 'e.g. line:12 (today count of line 12)',
  field_label    VARCHAR(300) NULL,
  system_value   VARCHAR(64)  NULL COMMENT 'value from the systems when it was changed',
  manual_value   VARCHAR(64)  NOT NULL,
  reason         VARCHAR(500) NOT NULL,
  created_by_user_id INT NULL,
  created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reverted_at    TIMESTAMP NULL,
  reverted_by_user_id INT NULL,
  PRIMARY KEY (override_id),
  KEY idx_dpr_overrides_day (contract_id, report_date, field_key),
  CONSTRAINT fk_dpr_overrides_contract FOREIGN KEY (contract_id) REFERENCES dpr_contracts (contract_id),
  CONSTRAINT fk_dpr_overrides_by FOREIGN KEY (created_by_user_id) REFERENCES users (user_id),
  CONSTRAINT fk_dpr_overrides_rev FOREIGN KEY (reverted_by_user_id) REFERENCES users (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS dpr_change_log (
  change_id      BIGINT NOT NULL AUTO_INCREMENT,
  contract_id    INT NOT NULL,
  report_date    DATE NULL,
  entity         VARCHAR(40)  NOT NULL COMMENT 'day, count, activity, qa, ncr, concern, photo, override, setup...',
  entity_id      VARCHAR(40)  NULL,
  field          VARCHAR(80)  NULL,
  old_value      TEXT NULL,
  new_value      TEXT NULL,
  user_id        INT NULL,
  created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (change_id),
  KEY idx_dpr_change_day (contract_id, report_date),
  KEY idx_dpr_change_field (contract_id, entity, entity_id, field),
  CONSTRAINT fk_dpr_change_contract FOREIGN KEY (contract_id) REFERENCES dpr_contracts (contract_id),
  CONSTRAINT fk_dpr_change_user FOREIGN KEY (user_id) REFERENCES users (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS dpr_reports (
  report_id      INT NOT NULL AUTO_INCREMENT,
  contract_id    INT NOT NULL,
  report_date    DATE NOT NULL,
  report_no      VARCHAR(60) NOT NULL,
  revision       INT NOT NULL DEFAULT 0,
  status         ENUM('Issued','Superseded') NOT NULL DEFAULT 'Issued',
  snapshot       JSON NOT NULL COMMENT 'everything printed, frozen at issue',
  notes          VARCHAR(500) NULL,
  issued_by_user_id INT NULL,
  issued_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (report_id),
  UNIQUE KEY uq_dpr_reports_rev (contract_id, report_date, revision),
  KEY idx_dpr_reports_date (contract_id, report_date),
  CONSTRAINT fk_dpr_reports_contract FOREIGN KEY (contract_id) REFERENCES dpr_contracts (contract_id),
  CONSTRAINT fk_dpr_reports_by FOREIGN KEY (issued_by_user_id) REFERENCES users (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
