-- Rollback of 2026_10_daily_site_report. Removes the report history too.
-- Check first what would be lost:
SELECT COUNT(*) AS reports_that_will_be_lost FROM daily_site_reports;
DROP TABLE IF EXISTS daily_site_reports;
DROP TABLE IF EXISTS report_signatories;
