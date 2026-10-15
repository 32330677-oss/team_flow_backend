# 2026-10 Project Daily Report (Team Flow + Equipment Flow)

Run once on the Team Flow database:

    mysql -h <host> -u <user> -p <team_flow_db> < migrations/2026_10_project_daily_report/01_ddl.sql

Adds `project_daily_report_profiles` and `project_daily_reports`. Nothing existing is changed.

Then set on the **Team Flow** server:

    EQUIPMENT_API_URL=https://<equipment-backend>/api
    EQUIPMENT_INTEGRATION_TOKEN=<32+ random characters>

and the **same token** on the **Equipment Flow** server:

    INTEGRATION_TOKEN=<the same 32+ random characters>

Generate a token: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`

Rollback: `99_rollback.sql`.
