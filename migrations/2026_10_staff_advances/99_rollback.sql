-- Rollback of 2026_10_staff_advances.
-- Run the SELECTs first. Advances are financial records: if any exist, keep a
-- backup before dropping. net_salary keeps the paid amounts either way.
SELECT COUNT(*) AS advances_total FROM staff_advances;
SELECT COUNT(*) AS staff_lines_with_advance_deduction FROM staff_payroll WHERE advance_deduction_amount <> 0;

-- Only after deciding to drop (commented out on purpose):
-- ALTER TABLE staff_payroll DROP COLUMN advance_deduction_amount;
-- DROP TABLE IF EXISTS staff_advance_ledger;
-- DROP TABLE IF EXISTS staff_advance_installments;
-- DROP TABLE IF EXISTS staff_advances;
-- DROP TABLE IF EXISTS staff_financial_reports;
-- DROP TABLE IF EXISTS document_sequences;
-- DELETE FROM system_settings WHERE setting_key IN
--   ('advance_cancel_window_hours','advance_allow_multiple_open','advance_report_valid_minutes');
