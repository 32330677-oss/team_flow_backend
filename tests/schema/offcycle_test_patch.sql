-- TEST-ONLY reconstruction of the off-cycle payroll columns.
-- The real migration folder migrations/2026_10_offcycle_payroll is not in the
-- repository; tests/helpers.js uses this file only when that folder is missing.
-- Never run on production.
ALTER TABLE payrollbatches
  ADD COLUMN batch_type ENUM('Regular','OffCycle') NOT NULL DEFAULT 'Regular',
  ADD COLUMN scope_worker_id INT NULL,
  ADD COLUMN offcycle_reason VARCHAR(500) NULL,
  ADD CONSTRAINT fk_payrollbatches_scope_worker FOREIGN KEY (scope_worker_id) REFERENCES workers (worker_id);
