-- =====================================================================
-- 2026-10 Staff salary advances, step 2: frozen documents + QR download
--
-- Run AFTER 01_ddl.sql (same folder). Idempotent: safe to run more than once.
-- Only ADDS nullable columns and unique keys. No existing value is changed.
--
--   staff_advances.voucher_snapshot / voucher_hash
--       The payment voucher exactly as issued (JSON) + its SHA-256 fingerprint.
--       Every print and every QR download shows this frozen content, so a copy
--       always matches the signed paper.
--   staff_advances.public_token
--       Random, unguessable token used in the voucher's QR code:
--       GET /api/public/documents/<token>.pdf downloads the voucher (no login).
--   staff_advance_ledger.document_snapshot / document_hash / public_token
--       Same for cash repayment receipts (RCP-YYYY-NNNNNN).
-- Rollback: 99_rollback.sql
-- =====================================================================

SET @s := (SELECT IF(COUNT(*) = 0,
  'ALTER TABLE staff_advances ADD COLUMN voucher_snapshot JSON NULL COMMENT ''Payment voucher exactly as issued''',
  'SELECT ''staff_advances.voucher_snapshot already exists'' AS info')
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'staff_advances' AND COLUMN_NAME = 'voucher_snapshot');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s := (SELECT IF(COUNT(*) = 0,
  'ALTER TABLE staff_advances ADD COLUMN voucher_hash CHAR(64) NULL COMMENT ''SHA-256 of the canonical voucher_snapshot''',
  'SELECT ''staff_advances.voucher_hash already exists'' AS info')
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'staff_advances' AND COLUMN_NAME = 'voucher_hash');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s := (SELECT IF(COUNT(*) = 0,
  'ALTER TABLE staff_advances ADD COLUMN public_token VARCHAR(64) NULL COMMENT ''QR download token (unguessable)''',
  'SELECT ''staff_advances.public_token already exists'' AS info')
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'staff_advances' AND COLUMN_NAME = 'public_token');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s := (SELECT IF(COUNT(*) = 0,
  'ALTER TABLE staff_advances ADD UNIQUE KEY uq_sadv_public_token (public_token)',
  'SELECT ''uq_sadv_public_token already exists'' AS info')
  FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'staff_advances' AND INDEX_NAME = 'uq_sadv_public_token');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s := (SELECT IF(COUNT(*) = 0,
  'ALTER TABLE staff_advance_ledger ADD COLUMN document_snapshot JSON NULL COMMENT ''Receipt exactly as issued (cash repayments)''',
  'SELECT ''staff_advance_ledger.document_snapshot already exists'' AS info')
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'staff_advance_ledger' AND COLUMN_NAME = 'document_snapshot');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s := (SELECT IF(COUNT(*) = 0,
  'ALTER TABLE staff_advance_ledger ADD COLUMN document_hash CHAR(64) NULL COMMENT ''SHA-256 of the canonical document_snapshot''',
  'SELECT ''staff_advance_ledger.document_hash already exists'' AS info')
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'staff_advance_ledger' AND COLUMN_NAME = 'document_hash');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s := (SELECT IF(COUNT(*) = 0,
  'ALTER TABLE staff_advance_ledger ADD COLUMN public_token VARCHAR(64) NULL COMMENT ''QR download token (unguessable)''',
  'SELECT ''staff_advance_ledger.public_token already exists'' AS info')
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'staff_advance_ledger' AND COLUMN_NAME = 'public_token');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @s := (SELECT IF(COUNT(*) = 0,
  'ALTER TABLE staff_advance_ledger ADD UNIQUE KEY uq_sadvl_public_token (public_token)',
  'SELECT ''uq_sadvl_public_token already exists'' AS info')
  FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'staff_advance_ledger' AND INDEX_NAME = 'uq_sadvl_public_token');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- Verification: must return 8 rows, each with present = 1.
SELECT 'staff_advances.voucher_snapshot' AS object, COUNT(*) AS present FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'staff_advances' AND COLUMN_NAME = 'voucher_snapshot'
UNION ALL
SELECT 'staff_advances.voucher_hash', COUNT(*) FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'staff_advances' AND COLUMN_NAME = 'voucher_hash'
UNION ALL
SELECT 'staff_advances.public_token', COUNT(*) FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'staff_advances' AND COLUMN_NAME = 'public_token'
UNION ALL
SELECT 'uq_sadv_public_token', COUNT(DISTINCT INDEX_NAME) FROM information_schema.STATISTICS
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'staff_advances' AND INDEX_NAME = 'uq_sadv_public_token'
UNION ALL
SELECT 'staff_advance_ledger.document_snapshot', COUNT(*) FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'staff_advance_ledger' AND COLUMN_NAME = 'document_snapshot'
UNION ALL
SELECT 'staff_advance_ledger.document_hash', COUNT(*) FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'staff_advance_ledger' AND COLUMN_NAME = 'document_hash'
UNION ALL
SELECT 'staff_advance_ledger.public_token', COUNT(*) FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'staff_advance_ledger' AND COLUMN_NAME = 'public_token'
UNION ALL
SELECT 'uq_sadvl_public_token', COUNT(DISTINCT INDEX_NAME) FROM information_schema.STATISTICS
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'staff_advance_ledger' AND INDEX_NAME = 'uq_sadvl_public_token';
