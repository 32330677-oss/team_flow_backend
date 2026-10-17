-- =====================================================================
-- 2026-10 Roles & permissions (accounts of type "User")
--
-- The ONLY change to an existing table: the value 'User' is ADDED at the end
-- of users.role. Existing values, rows, defaults and NULL-ability are kept.
-- Accounts already in the table are not touched.
--
-- New tables:
--   app_roles             roles created by the Admin (name editable any time)
--   app_role_permissions  permission keys of each role (keys are defined in
--                         services/accessControl.js — the list of things the
--                         code can check; WHO gets them is data, here)
--   app_user_roles        the role of each account of type 'User'
--   app_access_audit      who changed which role / account, and when
--
-- Admin, Supervisor and StaffSupervisor keep working exactly as before.
-- Idempotent: safe to run more than once. Rollback: 99_rollback.sql
-- =====================================================================

-- 1. users.role: add 'User' (rebuilt from the live column definition)
DROP PROCEDURE IF EXISTS mig_202610_roles_add_user_type;
DELIMITER $$
CREATE PROCEDURE mig_202610_roles_add_user_type()
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
CALL mig_202610_roles_add_user_type();
DROP PROCEDURE IF EXISTS mig_202610_roles_add_user_type;

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
