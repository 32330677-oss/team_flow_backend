const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const contractRoutes = require('./routes/contractRoutes');
const siteRoutes = require('./routes/siteRoutes');
const workerRoutes = require('./routes/workerRoutes');
const assignmentRoutes = require('./routes/assignmentRoutes');
const supervisorRouter = require('./routes/supervisorRoutes');
const attendanceImportRoutes = require('./routes/attendanceImportRoutes');
const biometricProcessingRoutes = require('./routes/biometricProcessingRoutes');
const deviceUserRoutes = require('./routes/deviceUserRoutes');
const adminAttendanceRoutes = require('./routes/adminAttendanceRoutes');
const transferRoutes = require('./routes/transferRoutes');
const adminPayrollRoutes = require('./routes/adminPayrollRoutes');
const dashboardRoutes = require('./routes/dashboardRoutes');
const path = require('path');
const staffRoutes = require('./routes/staffRoutes');
const staffAttendanceRoutes = require('./routes/staffAttendanceRoutes');
const staffPayrollRoutes = require('./routes/StaffPayrollRoutes');
const staffOvertimeRoutes = require('./routes/staffOvertimeRoutes');
const mainDashboardRoutes = require('./routes/mainDashboardRoutes');
const biometricAttendanceAdminRoutes = require('./routes/biometricAttendanceAdminRoutes');

require('dotenv').config();
if (!process.env.JWT_SECRET) {
    console.error("FATAL ERROR: JWT_SECRET environment variable is not defined.");
    process.exit(1);
}
// استيراد المسارات (Routes)
const authRoutes = require('./routes/authRoutes');
const projectRoutes = require('./routes/projectRoutes'); 

const app = express();

// Middlewares
// Security headers. The API serves JSON, Excel and PDF only, so the defaults
// are safe. Exception: the public QR documents are opened straight in a phone
// browser's PDF viewer, so they skip the Content-Security-Policy header.
const helmetDefault = helmet();
const helmetPublicDocs = helmet({ contentSecurityPolicy: false });
app.use((req, res, next) =>
    (req.path.startsWith('/api/public/documents/') ? helmetPublicDocs : helmetDefault)(req, res, next));

// CORS: CORS_ORIGIN is a comma-separated list of allowed web origins
// (e.g. https://app.example.com). Mobile/desktop apps send no Origin and are
// always allowed. When CORS_ORIGIN is empty every origin is allowed (old behaviour).
const allowedOrigins = (process.env.CORS_ORIGIN || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
app.use(cors({
    origin: (origin, cb) => {
        if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) return cb(null, true);
        return cb(null, false); // no CORS headers -> the browser blocks it
    },
}));
app.use(express.json({ limit: '2mb' }));
app.set('trust proxy', 1); // أو true
// ربط المسارات بالسيرفر
app.use('/api/auth', authRoutes);
app.use('/api/projects', projectRoutes); 
app.use('/api/contracts', contractRoutes);
app.use('/api/sites', siteRoutes);
app.use('/api/workers', workerRoutes);
app.use('/api/assignments', assignmentRoutes);
app.use('/api/users/supervisors', supervisorRouter);
app.use('/api/biometric', attendanceImportRoutes);
app.use('/api/biometric/device-users', deviceUserRoutes);
app.use('/api/biometric/processing', biometricProcessingRoutes);
app.use('/api/attendance', require('./routes/attendanceRoutes'));
app.use('/api/admin/attendance', adminAttendanceRoutes);
app.use('/api/admin/payroll', adminPayrollRoutes);
app.use('/api/transfers', transferRoutes);
// C-18: uploads/ is no longer public. Worker photos: GET /api/workers/:id/files/:type (Admin);
// transfer documents: GET /api/transfers/:id/document (authorized).
app.use('/api/biometric/attendance', biometricAttendanceAdminRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/staff', staffRoutes);
app.use('/api/staff-attendance', staffAttendanceRoutes);
app.use('/api/staff-payroll', staffPayrollRoutes);
app.use('/api/staff-overtime', staffOvertimeRoutes);
app.use('/api/main-dashboard', mainDashboardRoutes);
app.use('/api/recycle-bin', require('./routes/recycleBinRoutes'));
app.use('/api/payroll-adjustments', require('./routes/payrollAdjustmentRoutes'));
app.use('/api/staff-advances', require('./routes/staffAdvanceRoutes'));
// Public (no login): QR download of frozen advance vouchers / receipts.
app.use('/api/public/documents', require('./routes/publicDocumentRoutes'));
app.use('/api/reports/daily-site', require('./routes/dailySiteReportRoutes'));
app.use('/api/reports/project-daily', require('./routes/projectDailyReportRoutes'));
// Roles & accounts of type 'User' (Admin), and /api/access/me for any signed-in account.
app.use('/api/access', require('./routes/accessRoutes'));
// Daily Progress Report (accounts with the dpr.* permissions; Admin read only).
app.use('/api/dpr', require('./routes/dprRoutes'));
// In-app Help Center (always on) and AI assistant (needs ANTHROPIC_API_KEY).
app.use('/api/assistant', require('./routes/assistantRoutes'));
// Liveness: is the process up? Kept DB-free on purpose so a slow database
// never makes the host restart the service.
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

// Readiness / monitoring: is the database reachable?
app.get('/health/db', async (req, res) => {
  try {
    await require('./config/db').query('SELECT 1');
    res.status(200).json({ status: 'ok', db: 'up' });
  } catch (error) {
    console.error('Health check: database unreachable:', error.message);
    res.status(503).json({ status: 'error', db: 'down' });
  }
});

// Unknown routes.
app.use((req, res) => {
  res.status(404).json({ status: 'error', message: 'Route not found.' });
});

// Last-resort error handler: anything not caught by a route ends here.
// Details go to the log; the client only gets a generic message for 5xx.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(`[${req.method} ${req.originalUrl}]`, err);
  if (res.headersSent) return next(err);
  const status = Number(err.statusCode || err.status) || 500;
  res.status(status).json({
    status: 'error',
    message: status >= 500 ? 'Internal server error.' : err.message,
  });
});

const PORT = process.env.PORT || 5000;

// Assignment end-date semantics interlock (requirements §5): the database must
// carry the 'inclusive_last_day' marker written by
// migrations/2026_10_hardening/05_data.sql, otherwise every assignment query
// would be off by one day. Refuse to start instead of computing wrong dates.
async function start() {
    const db = require('./config/db');
    const { assertSemanticsMarker } = require('./services/assignmentDates');
    const { assertOffCycleSchema } = require('./services/payrollLock');
    try {
        await assertSemanticsMarker(db);
        await assertOffCycleSchema(db);   // migrations/2026_10_offcycle_payroll
        await require('./services/recycleBinService').assertRecycleBinSchema(db); // migrations/2026_10_recycle_bin
        {
            const [[c]] = await db.query(
                `SELECT COUNT(*) AS n FROM information_schema.COLUMNS
                 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('payroll','staff_payroll') AND COLUMN_NAME = 'adjustments_amount'`);
            const [[t]] = await db.query(
                "SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'payroll_adjustments'");
            if (Number(c.n) !== 2 || Number(t.n) !== 1) {
                throw new Error('Payroll adjustment tables are missing. Run migrations/2026_10_payroll_adjustments/01_ddl.sql before starting this version.');
            }
        }
        await require('./services/staffAdvanceService').assertStaffAdvanceSchema(db); // migrations/2026_10_staff_advances
        {
            // migrations/2026_10_staff_payroll_hours (Worked Hrs / Paid Hrs / Hourly Rate in staff payroll reports)
            const [[h]] = await db.query(
                `SELECT COUNT(*) AS n FROM information_schema.COLUMNS
                 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'staff_payroll'
                   AND COLUMN_NAME IN ('worked_hours','paid_hours','hourly_rate_exact','pay_detail')`);
            if (Number(h.n) !== 4) {
                throw new Error('Staff payroll hour columns are missing. Run migrations/2026_10_staff_payroll_hours/01_ddl.sql before starting this version.');
            }
        }
    } catch (error) {
        console.error(`FATAL: ${error.message}`);
        process.exit(1);
    }
    // Recycle bin: purge entries whose 30-day undo window ended. Runs at start
    // and every 6 hours; safe with several instances (named lock in the service).
    const { purgeExpired } = require('./services/recycleBinService');
    const runPurge = () => purgeExpired()
        .then((n) => { if (n > 0) console.log(`Recycle bin: ${n} expired entr${n === 1 ? 'y' : 'ies'} purged.`); })
        .catch((e) => console.error('Recycle bin purge failed:', e.message));
    runPurge();
    setInterval(runPurge, 6 * 60 * 60 * 1000).unref();
    const server = app.listen(PORT, '0.0.0.0', () => {
        console.log(`Server is running on port ${PORT}`);
    });

    // Graceful shutdown (Render sends SIGTERM on every redeploy): stop taking
    // new requests, let running ones finish, then close the DB pool.
    let shuttingDown = false;
    const shutdown = (signal) => {
        if (shuttingDown) return;
        shuttingDown = true;
        console.log(`${signal} received: shutting down gracefully...`);
        setTimeout(() => {
            console.error('Shutdown timed out after 10s, forcing exit.');
            process.exit(1);
        }, 10000).unref();
        server.close(async () => {
            // Never wait more than 3s for the DB pool to close.
            await Promise.race([
                db.end().catch(() => {}),
                new Promise((resolve) => setTimeout(resolve, 3000)),
            ]);
            console.log('Server closed.');
            process.exit(0);
        });
        // Browsers / the app keep idle keep-alive connections open, which would
        // make server.close() wait. Close the idle ones now; busy ones finish first.
        if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
    return server;
}

if (require.main === module) {
    start();
}

module.exports = { app, start };