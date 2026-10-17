# 2026-10 Roles & permissions

Run once on the Team Flow database (after a backup):

    mysql ... <db> < migrations/2026_10_roles_permissions/01_ddl.sql

- Adds the value `User` at the end of `users.role` (nothing else in `users` changes).
- Adds `app_roles`, `app_role_permissions`, `app_user_roles`, `app_access_audit`.
- Admin / Supervisor / StaffSupervisor are not affected.

Check:

    SHOW COLUMNS FROM users LIKE 'role';
    SHOW TABLES LIKE 'app_%';

Rollback: `99_rollback.sql` (refuses while an account of type `User` exists).
