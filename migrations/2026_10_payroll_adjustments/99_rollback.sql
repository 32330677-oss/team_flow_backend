-- Rollback of 2026_10_payroll_adjustments.
-- Run the SELECTs first. If any batch already carries adjustments, dropping the
-- columns loses that information (net_salary keeps the paid amount).
SELECT COUNT(*) AS adjustments_total FROM payroll_adjustments;
SELECT COUNT(*) AS worker_lines_with_adjustments FROM payroll WHERE adjustments_amount <> 0;
SELECT COUNT(*) AS staff_lines_with_adjustments FROM staff_payroll WHERE adjustments_amount <> 0;

-- Only after deciding to drop (commented out on purpose):
-- ALTER TABLE payroll DROP COLUMN adjustments_amount;
-- ALTER TABLE staff_payroll DROP COLUMN adjustments_amount;
-- DROP TABLE IF EXISTS payroll_adjustments;
