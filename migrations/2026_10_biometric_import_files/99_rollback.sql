-- Rollback for 2026_10_biometric_import_files.
-- The stored files themselves stay in S3; only the index table is removed.
-- Check first:
SELECT COUNT(*) AS rows_in_table FROM biometric_import_files;

-- Then, only if you are sure:
-- DROP TABLE biometric_import_files;
