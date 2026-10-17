-- =====================================================================
-- OPTIONAL, only before 99_rollback.sql: deletes every account of type
-- 'User' (and only those). All or nothing: if any table still points to one
-- of these accounts, MySQL refuses and NOTHING is deleted.
--
-- Also removed, because these accounts created them themselves:
--   * their rows in loginhistory (their sign-ins);
--   * their own password-change rows in auditlogs (table_name = 'users').
-- In the new tables of this migration their user id is set to NULL (the
-- rollback drops those tables anyway).
-- =====================================================================
DROP PROCEDURE IF EXISTS mig_202610_user_dpr_remove_accounts;
DELIMITER $$
CREATE PROCEDURE mig_202610_user_dpr_remove_accounts()
BEGIN
  DECLARE EXIT HANDLER FOR SQLEXCEPTION
  BEGIN
    ROLLBACK;
    RESIGNAL;
  END;
  START TRANSACTION;
  DROP TEMPORARY TABLE IF EXISTS tmp_user_accounts;
  CREATE TEMPORARY TABLE tmp_user_accounts (user_id INT PRIMARY KEY);
  INSERT INTO tmp_user_accounts SELECT user_id FROM users WHERE role = 'User';

  UPDATE dpr_contracts SET created_by_user_id = NULL WHERE created_by_user_id IN (SELECT user_id FROM tmp_user_accounts);
  UPDATE dpr_contracts SET updated_by_user_id = NULL WHERE updated_by_user_id IN (SELECT user_id FROM tmp_user_accounts);
  UPDATE dpr_days SET updated_by_user_id = NULL WHERE updated_by_user_id IN (SELECT user_id FROM tmp_user_accounts);
  UPDATE dpr_day_counts SET updated_by_user_id = NULL WHERE updated_by_user_id IN (SELECT user_id FROM tmp_user_accounts);
  UPDATE dpr_activities SET created_by_user_id = NULL WHERE created_by_user_id IN (SELECT user_id FROM tmp_user_accounts);
  UPDATE dpr_photos SET created_by_user_id = NULL WHERE created_by_user_id IN (SELECT user_id FROM tmp_user_accounts);
  UPDATE dpr_overrides SET created_by_user_id = NULL WHERE created_by_user_id IN (SELECT user_id FROM tmp_user_accounts);
  UPDATE dpr_overrides SET reverted_by_user_id = NULL WHERE reverted_by_user_id IN (SELECT user_id FROM tmp_user_accounts);
  UPDATE dpr_change_log SET user_id = NULL WHERE user_id IN (SELECT user_id FROM tmp_user_accounts);
  UPDATE dpr_reports SET issued_by_user_id = NULL WHERE issued_by_user_id IN (SELECT user_id FROM tmp_user_accounts);
  UPDATE app_roles SET created_by_user_id = NULL WHERE created_by_user_id IN (SELECT user_id FROM tmp_user_accounts);
  UPDATE app_roles SET updated_by_user_id = NULL WHERE updated_by_user_id IN (SELECT user_id FROM tmp_user_accounts);
  UPDATE app_access_audit SET actor_user_id = NULL WHERE actor_user_id IN (SELECT user_id FROM tmp_user_accounts);
  DELETE FROM app_user_roles WHERE user_id IN (SELECT user_id FROM tmp_user_accounts);

  DELETE FROM loginhistory WHERE user_id IN (SELECT user_id FROM tmp_user_accounts);
  DELETE FROM auditlogs WHERE table_name = 'users' AND record_id = user_id
     AND user_id IN (SELECT user_id FROM tmp_user_accounts);
  DELETE FROM users WHERE role = 'User';
  COMMIT;
  DROP TEMPORARY TABLE IF EXISTS tmp_user_accounts;
END$$
DELIMITER ;
CALL mig_202610_user_dpr_remove_accounts();
DROP PROCEDURE IF EXISTS mig_202610_user_dpr_remove_accounts;
