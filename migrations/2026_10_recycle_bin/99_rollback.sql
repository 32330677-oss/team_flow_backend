-- Rollback of 2026_10_recycle_bin.
-- Run the SELECT first. If it returns any row, people in the bin can still be
-- restored: restore or purge them before dropping, otherwise their data is
-- lost for good. The DROP statements are commented out on purpose.

SELECT recycle_id, entity_type, entity_id, entity_name, deleted_at, purge_after
FROM recycle_bin WHERE status = 'Deleted';

-- Only after the SELECT above returned 0 rows:
-- DROP TABLE IF EXISTS entity_deletion_holds;
-- DROP TABLE IF EXISTS recycle_bin;
-- DELETE FROM system_settings WHERE setting_key = 'recycle_bin_retention_days';
