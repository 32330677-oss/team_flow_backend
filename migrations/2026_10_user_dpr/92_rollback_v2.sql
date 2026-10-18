-- =====================================================================
-- Rollback of 02_ucc_v2.sql ONLY (back to the shape of 01_ddl.sql).
-- Removes the 5 new tables and the added columns of the dpr_* tables.
-- Nothing of Team Flow or of the equipment system is touched.
--
-- Refuses, and changes NOTHING, while v2 data exists that the old shape
-- cannot hold: lines of kind staff / tool, or activities without BOQ item.
-- (Delete them first, or run 97_reset_dpr_test_data.sql on test data.)
-- WARNING: manual values, areas, crews, materials and fixed pages are deleted.
-- Take a backup first.
-- =====================================================================
DROP PROCEDURE IF EXISTS mig_dpr_v2_rollback;
DELIMITER $$
CREATE PROCEDURE mig_dpr_v2_rollback()
BEGIN
  DECLARE v_lines INT DEFAULT 0;
  DECLARE v_acts INT DEFAULT 0;
  SELECT COUNT(*) INTO v_lines FROM dpr_lines WHERE kind IN ('staff', 'tool');
  SELECT COUNT(*) INTO v_acts FROM dpr_activities WHERE boq_id IS NULL;
  IF v_lines > 0 OR v_acts > 0 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Staff / tool lines or activities without BOQ item exist. Nothing changed.';
  END IF;

  DROP TABLE IF EXISTS dpr_activity_crews;
  DROP TABLE IF EXISTS dpr_materials;
  DROP TABLE IF EXISTS dpr_fixed_pages;
  DROP TABLE IF EXISTS dpr_areas;
  DROP TABLE IF EXISTS dpr_manual_values;

  ALTER TABLE dpr_lines MODIFY kind ENUM('trade','plant','subcon') NOT NULL;
  ALTER TABLE dpr_activities MODIFY boq_id INT NOT NULL;
END$$

DROP PROCEDURE IF EXISTS mig_dpr_v2_drop_col$$
CREATE PROCEDURE mig_dpr_v2_drop_col(IN p_table VARCHAR(64), IN p_col VARCHAR(64))
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = p_table AND COLUMN_NAME = p_col) THEN
    SET @mig_sql = CONCAT('ALTER TABLE ', p_table, ' DROP COLUMN ', p_col);
    PREPARE mig_stmt FROM @mig_sql;
    EXECUTE mig_stmt;
    DEALLOCATE PREPARE mig_stmt;
  END IF;
END$$
DELIMITER ;

CALL mig_dpr_v2_rollback();

CALL mig_dpr_v2_drop_col('dpr_contracts', 'template');
CALL mig_dpr_v2_drop_col('dpr_contracts', 'form');
CALL mig_dpr_v2_drop_col('dpr_contracts', 'system_start_date');
CALL mig_dpr_v2_drop_col('dpr_contracts', 'count_mode');
CALL mig_dpr_v2_drop_col('dpr_contracts', 'auto_rows');
CALL mig_dpr_v2_drop_col('dpr_contracts', 'section_links');
CALL mig_dpr_v2_drop_col('dpr_contracts', 'layout');
CALL mig_dpr_v2_drop_col('dpr_contracts', 'lists');
CALL mig_dpr_v2_drop_col('dpr_days', 'weather_condition');
CALL mig_dpr_v2_drop_col('dpr_days', 'humidity_level');
CALL mig_dpr_v2_drop_col('dpr_days', 'layout');
CALL mig_dpr_v2_drop_col('dpr_boq', 'row_type');
CALL mig_dpr_v2_drop_col('dpr_boq', 'group_name');
CALL mig_dpr_v2_drop_col('dpr_boq', 'task_code');
CALL mig_dpr_v2_drop_col('dpr_boq', 'cost_code');
CALL mig_dpr_v2_drop_col('dpr_boq', 'budget');
CALL mig_dpr_v2_drop_col('dpr_activities', 'description');
CALL mig_dpr_v2_drop_col('dpr_activities', 'area_id');
CALL mig_dpr_v2_drop_col('dpr_activities', 'chainage');
CALL mig_dpr_v2_drop_col('dpr_activities', 'unit');
CALL mig_dpr_v2_drop_col('dpr_qa', 'area_id');
CALL mig_dpr_v2_drop_col('dpr_qa', 'chainage');
CALL mig_dpr_v2_drop_col('dpr_qa', 'ms_ref');
CALL mig_dpr_v2_drop_col('dpr_photos', 'area_id');
CALL mig_dpr_v2_drop_col('dpr_reports', 'template');
CALL mig_dpr_v2_drop_col('dpr_reports', 'fingerprint');

DROP PROCEDURE IF EXISTS mig_dpr_v2_rollback;
DROP PROCEDURE IF EXISTS mig_dpr_v2_drop_col;
