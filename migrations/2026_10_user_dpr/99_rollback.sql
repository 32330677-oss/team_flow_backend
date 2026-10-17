-- =====================================================================
-- Rollback of 2026_10_user_dpr (accounts of type "User" + roles + DPR).
--
-- Removes ONLY what 01_ddl.sql added: the 19 new tables and the value 'User'
-- of users.role. Nothing else is touched.
--
-- Refuses, and changes NOTHING, while an account of type 'User' exists
-- (users.role cannot lose the value 'User' while an account uses it).
-- To delete those accounts first, run 98_remove_user_accounts.sql.
--
-- WARNING: the DPR data typed by the users (daily reports, registers, issued
-- reports...) is deleted with its tables. Take a backup first (README.md).
-- =====================================================================
DROP PROCEDURE IF EXISTS mig_202610_user_dpr_rollback;
DELIMITER $$
CREATE PROCEDURE mig_202610_user_dpr_rollback()
BEGIN
  DECLARE v_users INT DEFAULT 0;
  DECLARE v_type TEXT;
  DECLARE v_null VARCHAR(3);
  DECLARE v_default TEXT;
  SELECT COUNT(*) INTO v_users FROM users WHERE role = 'User';
  IF v_users > 0 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Accounts of type User still exist (run 98_remove_user_accounts.sql first). Nothing changed.';
  END IF;
  -- DPR (children first)
  DROP TABLE IF EXISTS dpr_reports;
  DROP TABLE IF EXISTS dpr_change_log;
  DROP TABLE IF EXISTS dpr_overrides;
  DROP TABLE IF EXISTS dpr_photos;
  DROP TABLE IF EXISTS dpr_concerns;
  DROP TABLE IF EXISTS dpr_ncr;
  DROP TABLE IF EXISTS dpr_qa;
  DROP TABLE IF EXISTS dpr_activity_alloc;
  DROP TABLE IF EXISTS dpr_activities;
  DROP TABLE IF EXISTS dpr_day_counts;
  DROP TABLE IF EXISTS dpr_days;
  DROP TABLE IF EXISTS dpr_boq;
  DROP TABLE IF EXISTS dpr_lines;
  DROP TABLE IF EXISTS dpr_eot_vo;
  DROP TABLE IF EXISTS dpr_contracts;
  -- roles & accounts
  DROP TABLE IF EXISTS app_access_audit;
  DROP TABLE IF EXISTS app_user_roles;
  DROP TABLE IF EXISTS app_role_permissions;
  DROP TABLE IF EXISTS app_roles;
  -- users.role: remove 'User' (rebuilt from the live column definition)
  SELECT COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT INTO v_type, v_null, v_default
    FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'role';
  IF LOCATE(',''User''', v_type) > 0 THEN
    SET @mig_sql = CONCAT('ALTER TABLE users MODIFY role ', REPLACE(v_type, ',''User''', ''),
      IF(v_null = 'NO', ' NOT NULL', ' NULL'),
      IF(v_default IS NULL, '', CONCAT(' DEFAULT ', QUOTE(v_default))));
    PREPARE mig_stmt FROM @mig_sql;
    EXECUTE mig_stmt;
    DEALLOCATE PREPARE mig_stmt;
  END IF;
END$$
DELIMITER ;
CALL mig_202610_user_dpr_rollback();
DROP PROCEDURE IF EXISTS mig_202610_user_dpr_rollback;
