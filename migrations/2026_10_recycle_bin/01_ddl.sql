-- =====================================================================
-- 2026-10 Recycle bin (safe delete with a 30-day undo window)
--
-- Adds two NEW tables only. No existing table or column is changed, so no
-- existing query is affected. Idempotent: safe to run more than once.
-- Rollback: 99_rollback.sql (drops these two tables; refuses while the bin
-- still holds restorable entries).
--
-- recycle_bin
--   One row per deleted person (Staff now, Worker later). Every row of every
--   table that belonged to that person is copied into `payload` (JSON, keyed
--   by table name) in the SAME transaction that removes them from the live
--   tables. To the rest of the system the person no longer exists; no query
--   needs a "deleted" filter. Restore re-inserts the rows with their original
--   ids. After `purge_after` the entry is purged: the row is removed from the
--   bin and only a minimal audit entry (ids, no name) remains in auditlogs.
--
-- entity_deletion_holds
--   "Pending deletion": a person on hold is excluded from NEW payroll
--   generation (and its preview). Used to correct a Finalized (unpaid) batch
--   with Supersede before deleting, so the new version is generated without
--   that person.
-- =====================================================================

CREATE TABLE IF NOT EXISTS recycle_bin (
  recycle_id           INT NOT NULL AUTO_INCREMENT,
  entity_type          ENUM('Staff','Worker') NOT NULL,
  entity_id            INT NOT NULL COMMENT 'staff_id or worker_id (original id, re-used on restore)',
  entity_code          VARCHAR(50) NULL COMMENT 'staff_unique_id / worker_unique_id',
  entity_name          VARCHAR(255) NOT NULL,
  payload              JSON NOT NULL COMMENT '{ table_name: [ full rows ] }',
  row_counts           JSON NOT NULL COMMENT '{ table_name: count }',
  reason               VARCHAR(500) NOT NULL,
  status               ENUM('Deleted','Restored') NOT NULL DEFAULT 'Deleted',
  deleted_by_user_id   INT NOT NULL,
  deleted_at           DATETIME NOT NULL,
  purge_after          DATETIME NOT NULL,
  excluded_since       DATETIME NOT NULL COMMENT 'From when payroll stopped including the person (hold start or deletion)',
  restored_by_user_id  INT NULL,
  restored_at          DATETIME NULL,
  restore_reason       VARCHAR(500) NULL,
  PRIMARY KEY (recycle_id),
  KEY idx_rb_status_purge (status, purge_after),
  KEY idx_rb_entity (entity_type, entity_id),
  CONSTRAINT fk_rb_deleted_by FOREIGN KEY (deleted_by_user_id) REFERENCES users (user_id),
  CONSTRAINT fk_rb_restored_by FOREIGN KEY (restored_by_user_id) REFERENCES users (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS entity_deletion_holds (
  hold_id              INT NOT NULL AUTO_INCREMENT,
  entity_type          ENUM('Staff','Worker') NOT NULL,
  entity_id            INT NOT NULL,
  reason               VARCHAR(500) NOT NULL,
  created_by_user_id   INT NOT NULL,
  created_at           DATETIME NOT NULL,
  released_by_user_id  INT NULL,
  released_at          DATETIME NULL,
  release_reason       VARCHAR(500) NULL,
  open_flag            TINYINT GENERATED ALWAYS AS (CASE WHEN released_at IS NULL THEN 1 ELSE NULL END) STORED,
  PRIMARY KEY (hold_id),
  UNIQUE KEY uq_edh_open (entity_type, entity_id, open_flag),
  CONSTRAINT fk_edh_created_by FOREIGN KEY (created_by_user_id) REFERENCES users (user_id),
  CONSTRAINT fk_edh_released_by FOREIGN KEY (released_by_user_id) REFERENCES users (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

INSERT INTO system_settings (setting_key, setting_value)
VALUES ('recycle_bin_retention_days', '30')
ON DUPLICATE KEY UPDATE setting_value = setting_value;
