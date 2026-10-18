-- =====================================================================
-- 2026-10 DPR v2: the client's form (UCC-IMS-CM-3003A) + full control.
-- Run AFTER 01_ddl.sql. ONE file, safe to run again (idempotent).
--
-- Changes ONLY dpr_* tables (all created by 01_ddl.sql). Nothing of Team Flow
-- or of the equipment system is touched: both are still only READ.
--
--   dpr_contracts   + template, form texts, system start date, count mode,
--                     automatic rows, section links (71 <-> 26), layout, lists
--   dpr_days        + weather condition, humidity level, layout of the day
--   dpr_lines       + kinds 'staff' and 'tool'
--   dpr_boq         + row type (item / section / text), group, task & cost code, budget
--   dpr_activities  + free-text activity (BOQ item optional), area, chainage, unit
--   dpr_qa          + area, chainage, MS ref (WIR register)
--   dpr_photos      + area
--   dpr_reports     + template, fingerprint of the printed data
--   NEW dpr_manual_values   manual values with scope (this day / from this day on)
--   NEW dpr_areas           areas / bridges with their own pages
--   NEW dpr_activity_crews  crews of an activity (plant / trades, No., hours)
--   NEW dpr_materials       delivered materials register
--   NEW dpr_fixed_pages     cover pages, maps, sections printed every day
--
-- Rollback of this file only: 92_rollback_v2.sql (full rollback: 99_rollback.sql).
-- =====================================================================

DROP PROCEDURE IF EXISTS mig_dpr_v2_add_col;
DELIMITER $$
CREATE PROCEDURE mig_dpr_v2_add_col(IN p_table VARCHAR(64), IN p_col VARCHAR(64), IN p_def TEXT)
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.COLUMNS
                  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = p_table AND COLUMN_NAME = p_col) THEN
    SET @mig_sql = CONCAT('ALTER TABLE ', p_table, ' ADD COLUMN ', p_col, ' ', p_def);
    PREPARE mig_stmt FROM @mig_sql;
    EXECUTE mig_stmt;
    DEALLOCATE PREPARE mig_stmt;
  END IF;
END$$
DELIMITER ;

-- ---------------------------------------------------------------- contracts
CALL mig_dpr_v2_add_col('dpr_contracts', 'template', 'VARCHAR(10) NOT NULL DEFAULT ''ucc'' COMMENT ''ucc = client form UCC-IMS-CM-3003A, dpr = DPR workbook''');
CALL mig_dpr_v2_add_col('dpr_contracts', 'form', 'JSON NULL COMMENT ''texts of the form header: doc ref, rev no / date, project ref, contract ref, project manager, title''');
CALL mig_dpr_v2_add_col('dpr_contracts', 'system_start_date', 'DATE NULL COMMENT ''first day read from the systems (before: opening balances)''');
CALL mig_dpr_v2_add_col('dpr_contracts', 'count_mode', 'VARCHAR(20) NOT NULL DEFAULT ''recorded'' COMMENT ''recorded = any attendance record, checked_in, approved''');
CALL mig_dpr_v2_add_col('dpr_contracts', 'auto_rows', 'TINYINT(1) NOT NULL DEFAULT 1 COMMENT ''positions / types not on a row are shown as their own row''');
CALL mig_dpr_v2_add_col('dpr_contracts', 'section_links', 'JSON NULL COMMENT ''section -> contract it follows (e.g. 26 follows 71 for weather)''');
CALL mig_dpr_v2_add_col('dpr_contracts', 'layout', 'JSON NULL COMMENT ''default layout: sections, tables, columns, titles''');
CALL mig_dpr_v2_add_col('dpr_contracts', 'lists', 'JSON NULL COMMENT ''choice lists of this contract (weather, humidity, WIR status...)''');

-- ---------------------------------------------------------------- days
CALL mig_dpr_v2_add_col('dpr_days', 'weather_condition', 'VARCHAR(40) NULL');
CALL mig_dpr_v2_add_col('dpr_days', 'humidity_level', 'VARCHAR(20) NULL');
CALL mig_dpr_v2_add_col('dpr_days', 'layout', 'JSON NULL COMMENT ''layout of this day (null = contract default)''');

-- ---------------------------------------------------------------- lines: kinds staff / tool
SET @kinds = (SELECT COLUMN_TYPE FROM information_schema.COLUMNS
               WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'dpr_lines' AND COLUMN_NAME = 'kind');
SET @mig_sql = IF(LOCATE('''staff''', @kinds) = 0,
  'ALTER TABLE dpr_lines MODIFY kind ENUM(''trade'',''plant'',''subcon'',''staff'',''tool'') NOT NULL',
  'DO 0');
PREPARE mig_stmt FROM @mig_sql;
EXECUTE mig_stmt;
DEALLOCATE PREPARE mig_stmt;

-- ---------------------------------------------------------------- BOQ
CALL mig_dpr_v2_add_col('dpr_boq', 'row_type', 'VARCHAR(10) NOT NULL DEFAULT ''item'' COMMENT ''item, section (heading), text (scope text)''');
CALL mig_dpr_v2_add_col('dpr_boq', 'group_name', 'VARCHAR(100) NOT NULL DEFAULT '''' COMMENT ''empty = main BOQ, else e.g. ADDITIONAL WORKS''');
CALL mig_dpr_v2_add_col('dpr_boq', 'task_code', 'VARCHAR(50) NULL');
CALL mig_dpr_v2_add_col('dpr_boq', 'cost_code', 'VARCHAR(50) NULL');
CALL mig_dpr_v2_add_col('dpr_boq', 'budget', 'DECIMAL(18,4) NULL');

-- ---------------------------------------------------------------- activities (BOQ item optional)
SET @nullable = (SELECT IS_NULLABLE FROM information_schema.COLUMNS
                  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'dpr_activities' AND COLUMN_NAME = 'boq_id');
SET @mig_sql = IF(@nullable = 'NO', 'ALTER TABLE dpr_activities MODIFY boq_id INT NULL', 'DO 0');
PREPARE mig_stmt FROM @mig_sql;
EXECUTE mig_stmt;
DEALLOCATE PREPARE mig_stmt;
CALL mig_dpr_v2_add_col('dpr_activities', 'description', 'VARCHAR(500) NULL COMMENT ''free text (an activity without BOQ item)''');
CALL mig_dpr_v2_add_col('dpr_activities', 'area_id', 'INT NULL');
CALL mig_dpr_v2_add_col('dpr_activities', 'chainage', 'VARCHAR(100) NULL');
CALL mig_dpr_v2_add_col('dpr_activities', 'unit', 'VARCHAR(30) NULL COMMENT ''unit of an activity without BOQ item''');

-- ---------------------------------------------------------------- QA / WIR, photos, reports
CALL mig_dpr_v2_add_col('dpr_qa', 'area_id', 'INT NULL');
CALL mig_dpr_v2_add_col('dpr_qa', 'chainage', 'VARCHAR(100) NULL');
CALL mig_dpr_v2_add_col('dpr_qa', 'ms_ref', 'VARCHAR(100) NULL');
CALL mig_dpr_v2_add_col('dpr_photos', 'area_id', 'INT NULL');
CALL mig_dpr_v2_add_col('dpr_reports', 'template', 'VARCHAR(10) NULL');
CALL mig_dpr_v2_add_col('dpr_reports', 'fingerprint', 'CHAR(64) NULL COMMENT ''hash of the printed data at issue''');

DROP PROCEDURE IF EXISTS mig_dpr_v2_add_col;

-- ---------------------------------------------------------------- new tables
CREATE TABLE IF NOT EXISTS dpr_manual_values (
  mv_id               INT NOT NULL AUTO_INCREMENT,
  contract_id         INT NOT NULL,
  field_key           VARCHAR(120) NOT NULL COMMENT 'e.g. line:12:present, boq:5:cum, boq:5:curr',
  field_label         VARCHAR(300) NULL,
  value               VARCHAR(200) NOT NULL COMMENT 'exact number (or text), never rounded',
  scope               VARCHAR(10)  NOT NULL DEFAULT 'day' COMMENT 'day = this report only; forward = from this day on; chain = counts into the cumulative',
  from_date           DATE NOT NULL,
  to_date             DATE NULL COMMENT 'forward: last day (null = open)',
  system_value        VARCHAR(64) NULL COMMENT 'system value when it was typed',
  reason              VARCHAR(500) NULL,
  group_key           CHAR(36) NULL COMMENT 'same value applied to linked contracts in one action',
  created_by_user_id  INT NULL,
  created_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reverted_at         TIMESTAMP NULL,
  reverted_by_user_id INT NULL,
  revert_note         VARCHAR(200) NULL,
  PRIMARY KEY (mv_id),
  KEY idx_dpr_mv_key (contract_id, field_key, from_date),
  KEY idx_dpr_mv_date (contract_id, from_date),
  CONSTRAINT fk_dpr_mv_contract FOREIGN KEY (contract_id) REFERENCES dpr_contracts (contract_id),
  CONSTRAINT fk_dpr_mv_by FOREIGN KEY (created_by_user_id) REFERENCES users (user_id),
  CONSTRAINT fk_dpr_mv_rev FOREIGN KEY (reverted_by_user_id) REFERENCES users (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS dpr_areas (
  area_id      INT NOT NULL AUTO_INCREMENT,
  contract_id  INT NOT NULL,
  name         VARCHAR(150) NOT NULL COMMENT 'e.g. BRIDGE - 08',
  sort_order   INT NOT NULL DEFAULT 0,
  is_active    TINYINT(1) NOT NULL DEFAULT 1,
  updated_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (area_id),
  UNIQUE KEY uq_dpr_areas_name (contract_id, name),
  CONSTRAINT fk_dpr_areas_contract FOREIGN KEY (contract_id) REFERENCES dpr_contracts (contract_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS dpr_activity_crews (
  crew_id      INT NOT NULL AUTO_INCREMENT,
  activity_id  INT NOT NULL,
  kind         VARCHAR(10) NOT NULL COMMENT 'plant / trade',
  sort_order   INT NOT NULL DEFAULT 0,
  name         VARCHAR(150) NOT NULL,
  nos          DECIMAL(10,2) NULL,
  hours        DECIMAL(10,2) NULL COMMENT 'W-HRS (empty = No. x hours / day)',
  PRIMARY KEY (crew_id),
  KEY idx_dpr_crews_activity (activity_id),
  CONSTRAINT fk_dpr_crews_activity FOREIGN KEY (activity_id) REFERENCES dpr_activities (activity_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS dpr_materials (
  material_id    INT NOT NULL AUTO_INCREMENT,
  contract_id    INT NOT NULL,
  report_date    DATE NOT NULL,
  sort_order     INT NOT NULL DEFAULT 0,
  description    VARCHAR(500) NOT NULL COMMENT 'material / specification / grade',
  unit           VARCHAR(30)  NULL,
  qty            DECIMAL(18,4) NULL,
  supplier       VARCHAR(200) NULL,
  delivery_note  VARCHAR(100) NULL,
  mar_ref        VARCHAR(100) NULL,
  area_id        INT NULL,
  element        VARCHAR(200) NULL,
  boq_ref        VARCHAR(100) NULL,
  intended_use   VARCHAR(300) NULL,
  is_deleted     TINYINT(1) NOT NULL DEFAULT 0,
  updated_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (material_id),
  KEY idx_dpr_materials_day (contract_id, report_date),
  CONSTRAINT fk_dpr_materials_contract FOREIGN KEY (contract_id) REFERENCES dpr_contracts (contract_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS dpr_fixed_pages (
  page_id       INT NOT NULL AUTO_INCREMENT,
  contract_id   INT NOT NULL,
  sort_order    INT NOT NULL DEFAULT 0,
  title         VARCHAR(200) NULL,
  file_name     VARCHAR(300) NOT NULL,
  content_type  VARCHAR(60)  NULL,
  is_active     TINYINT(1) NOT NULL DEFAULT 1,
  created_by_user_id INT NULL,
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (page_id),
  KEY idx_dpr_fixed_pages_contract (contract_id, sort_order),
  CONSTRAINT fk_dpr_fixed_pages_contract FOREIGN KEY (contract_id) REFERENCES dpr_contracts (contract_id),
  CONSTRAINT fk_dpr_fixed_pages_user FOREIGN KEY (created_by_user_id) REFERENCES users (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
