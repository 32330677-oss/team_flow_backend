-- Rollback of 2026_10_roles_permissions.
-- Refuses (nothing changed) while an account of type 'User' exists: switch or
-- remove those accounts first. Then drops the four new tables and removes the
-- value 'User' from users.role.
DROP PROCEDURE IF EXISTS mig_202610_roles_rollback;
DELIMITER $$
CREATE PROCEDURE mig_202610_roles_rollback()
BEGIN
  DECLARE v_users INT DEFAULT 0;
  DECLARE v_type TEXT;
  DECLARE v_null VARCHAR(3);
  DECLARE v_default TEXT;
  SELECT COUNT(*) INTO v_users FROM users WHERE role = 'User';
  IF v_users > 0 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Accounts of type User still exist. Nothing changed.';
  END IF;
  DROP TABLE IF EXISTS app_access_audit;
  DROP TABLE IF EXISTS app_user_roles;
  DROP TABLE IF EXISTS app_role_permissions;
  DROP TABLE IF EXISTS app_roles;
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
CALL mig_202610_roles_rollback();
DROP PROCEDURE IF EXISTS mig_202610_roles_rollback;
