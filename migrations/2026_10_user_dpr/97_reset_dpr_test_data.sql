-- =====================================================================
-- OPTIONAL: clear the DPR TEST data before handing the account over.
-- Touches ONLY dpr_* tables. Team Flow data, the equipment system, the
-- roles and the user accounts are NOT touched.
-- Works before and after 02_ucc_v2.sql (a missing table is skipped).
--
-- Choose ONE of the two calls at the bottom (the other stays commented):
--   A) delete the DAILY data only, keep the setup (contracts, lines, BOQ,
--      VO/EOT, areas, fixed pages): days, counts, activities, crews, QA / WIR,
--      materials, photos list, manual values, issued reports, history,
--      NCR / concerns registers.
--   B) delete EVERYTHING of the DPR, setup included (start from zero).
-- Take a backup first.
-- =====================================================================
DROP PROCEDURE IF EXISTS dpr_reset_table;
DROP PROCEDURE IF EXISTS dpr_reset;
DELIMITER $$
CREATE PROCEDURE dpr_reset_table(IN p_table VARCHAR(64))
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = p_table) THEN
    SET @mig_sql = CONCAT('DELETE FROM ', p_table);
    PREPARE mig_stmt FROM @mig_sql;
    EXECUTE mig_stmt;
    DEALLOCATE PREPARE mig_stmt;
  END IF;
END$$
CREATE PROCEDURE dpr_reset(IN p_everything TINYINT)
BEGIN
  SET FOREIGN_KEY_CHECKS = 0;
  -- A) daily data
  CALL dpr_reset_table('dpr_activity_crews');
  CALL dpr_reset_table('dpr_activity_alloc');
  CALL dpr_reset_table('dpr_activities');
  CALL dpr_reset_table('dpr_day_counts');
  CALL dpr_reset_table('dpr_days');
  CALL dpr_reset_table('dpr_qa');
  CALL dpr_reset_table('dpr_materials');
  CALL dpr_reset_table('dpr_photos');
  CALL dpr_reset_table('dpr_overrides');
  CALL dpr_reset_table('dpr_manual_values');
  CALL dpr_reset_table('dpr_reports');
  CALL dpr_reset_table('dpr_ncr');
  CALL dpr_reset_table('dpr_concerns');
  CALL dpr_reset_table('dpr_change_log');
  -- B) the setup too
  IF p_everything = 1 THEN
    CALL dpr_reset_table('dpr_fixed_pages');
    CALL dpr_reset_table('dpr_areas');
    CALL dpr_reset_table('dpr_boq');
    CALL dpr_reset_table('dpr_lines');
    CALL dpr_reset_table('dpr_eot_vo');
    CALL dpr_reset_table('dpr_contracts');
  END IF;
  SET FOREIGN_KEY_CHECKS = 1;
END$$
DELIMITER ;

-- ---------- A) daily data only (keeps the setup) ----------
   -- CALL dpr_reset(0);
   CALL dpr_reset(1);

-- ---------- B) everything: put two dashes in front of the line above and remove them below ----------
-- CALL dpr_reset(1);

DROP PROCEDURE IF EXISTS dpr_reset;
DROP PROCEDURE IF EXISTS dpr_reset_table;
