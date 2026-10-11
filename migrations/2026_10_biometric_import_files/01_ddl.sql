-- 2026-10 Biometric import files: keep every uploaded device file forever.
-- Additive only: one new table. No existing table or row is changed.
-- Safe to run twice.

CREATE TABLE IF NOT EXISTS biometric_import_files (
  id INT NOT NULL AUTO_INCREMENT,
  checksum CHAR(64) NOT NULL,                 -- SHA-256 of the file, same as attendance_import_batches.checksum
  original_name VARCHAR(255) NOT NULL,        -- name of the file the Admin selected
  stored_name VARCHAR(255) NOT NULL,          -- name in file storage (S3 / uploads folder)
  work_name VARCHAR(255) NOT NULL,            -- temporary name given to the Connector on the server
  size_bytes INT NOT NULL,
  uploaded_by INT NULL,                       -- users.user_id
  uploaded_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  batch_id INT NULL,                          -- attendance_import_batches.id once the Connector created it
  result_status VARCHAR(30) NULL,             -- Imported / AlreadyImported / Failed / Pending
  result_details TEXT NULL,                   -- reason / invalid lines when the file was rejected
  PRIMARY KEY (id),
  UNIQUE KEY uq_bif_stored_name (stored_name),
  KEY idx_bif_checksum (checksum),
  KEY idx_bif_batch (batch_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Verification: must return 1 row with present = 1.
SELECT 'biometric_import_files' AS object_name,
       COUNT(*) AS present
FROM information_schema.TABLES
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'biometric_import_files';
