-- Rollback of 2026_10_project_daily_report. Drops the two new tables (their data is lost).
DROP TABLE IF EXISTS project_daily_reports;
DROP TABLE IF EXISTS project_daily_report_profiles;
