// controllers/projectDailyReportController.js
//
// PROJECT DAILY REPORT (form UCC-IMS-CM-3003A) — Admin only. One Word file
// that combines Team Flow (manpower) and Equipment Flow (plant).
//
//   GET  /api/reports/project-daily/options        profiles, Team Flow sites, equipment sites, defaults
//   POST /api/reports/project-daily/profiles       { name, config }
//   PUT  /api/reports/project-daily/profiles/:id   { name?, config?, is_active? }
//   POST /api/reports/project-daily/preview        counts + warnings + suggestions (JSON), nothing saved
//   POST /api/reports/project-daily/generate       the .docx; saved with a report number
//   GET  /api/reports/project-daily/history        last generated reports
//   GET  /api/reports/project-daily/:id/docx       download a saved report again (same data)
//
// Body of preview / generate:
//   { profile_id, date: 'YYYY-MM-DD' (default today),
//     sections: { info, weather, manpower, plant, boq, activities, photos },   (default: the profile's)
//     fill_present_absent, pending_as_operative,                               (default: the profile's)
//     weather: { sunny, rainy, cloudy, dusty, temp_max, temp_min, humidity: 'high'|'medium'|'low' },
//     activities: [{ description, location }] }

const pool = require('../config/db');
const { businessToday } = require('../services/businessDate');
const { businessNow } = require('../services/biometricPunchProcessor');
const { listReportableSites } = require('../services/dailySiteReportService');
const equipment = require('../services/equipmentIntegrationClient');
const D = require('../services/projectDailyReportDefaults');
const {
  PdrError, sanitizeConfig, defaultConfig, getProfile, listProfiles, buildModel,
} = require('../services/projectDailyReportService');
const { renderProjectDailyReportDocx } = require('../services/projectDailyReportDocx');

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

function fail(res, error, where) {
  if (error && error.code === 'ER_NO_SUCH_TABLE') {
    return res.status(503).json({
      status: 'error',
      message: 'The project daily report tables are missing. Run migrations/2026_10_project_daily_report/01_ddl.sql first.',
    });
  }
  if (error && error.code === 'ER_DUP_ENTRY') {
    return res.status(409).json({ status: 'error', message: 'A report profile with this name already exists.' });
  }
  if (error && error.statusCode && error.statusCode < 500) {
    return res.status(error.statusCode).json({ status: 'error', message: error.message });
  }
  console.error(`${where}:`, error);
  return res.status(500).json({ status: 'error', message: 'Failed to build the project daily report.' });
}

function json(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') { try { return JSON.parse(v); } catch (_) { return null; } }
  return v;
}

function profileName(v) {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, 150);
  if (s.length < 3) throw new PdrError('Enter a profile name (at least 3 characters).');
  return s;
}

/** Report ids of the sites must exist (Team Flow) — equipment ids are checked by the equipment API. */
async function checkTfSites(config) {
  if (!config.tf_site_ids.length) return;
  const [rows] = await pool.query('SELECT site_id FROM sites WHERE site_id IN (?)', [config.tf_site_ids]);
  const found = new Set(rows.map((r) => Number(r.site_id)));
  const bad = config.tf_site_ids.filter((id) => !found.has(id));
  if (bad.length) throw new PdrError(`These Team Flow sites do not exist: ${bad.join(', ')}.`);
}

// One Word file at a time on a small server.
let renderChain = Promise.resolve();
function queuedRender(model) {
  const run = renderChain.then(() => renderProjectDailyReportDocx(model));
  renderChain = run.catch(() => {});
  return run;
}

function sendDocx(res, buffer, reportNo, warnings = 0) {
  res.setHeader('Content-Type', DOCX_MIME);
  res.setHeader('Content-Disposition', `attachment; filename="${reportNo}.docx"`);
  res.setHeader('Content-Length', buffer.length);
  res.setHeader('X-Report-No', reportNo);
  res.setHeader('X-Report-Warnings', String(warnings));
  res.setHeader('Access-Control-Expose-Headers', 'X-Report-No, X-Report-Warnings, Content-Disposition');
  return res.end(buffer);
}

exports.getOptions = async (req, res) => {
  try {
    const [profiles, tfSites, eqSites] = await Promise.all([
      listProfiles(),
      listReportableSites(),
      equipment.listSites(),
    ]);
    const eq = equipment.config();
    return res.json({
      status: 'success',
      data: {
        business_today: businessToday(),
        profiles,
        team_flow_sites: tfSites,
        equipment: {
          configured: eq.configured,
          ok: eqSites.ok,
          error: eqSites.ok ? null : eqSites.error,
          sites: eqSites.ok ? eqSites.data || [] : [],
        },
        defaults: {
          config: defaultConfig(),
          staff_rows: D.STAFF_ROWS,
          trade_rows: D.TRADE_ROWS,
          plant_rows: D.PLANT_ROWS,
        },
      },
    });
  } catch (error) {
    return fail(res, error, 'projectDailyReport.getOptions');
  }
};

exports.createProfile = async (req, res) => {
  try {
    const b = req.body || {};
    const name = profileName(b.name);
    const config = sanitizeConfig(b.config);
    await checkTfSites(config);
    const [ins] = await pool.query(
      `INSERT INTO project_daily_report_profiles (name, config, created_by_user_id, updated_by_user_id)
       VALUES (?, ?, ?, ?)`, [name, JSON.stringify(config), req.user.user_id, req.user.user_id]);
    return res.status(201).json({ status: 'success', data: await getProfile(ins.insertId) });
  } catch (error) {
    return fail(res, error, 'projectDailyReport.createProfile');
  }
};

exports.updateProfile = async (req, res) => {
  try {
    const current = await getProfile(req.params.id);
    const b = req.body || {};
    const name = b.name !== undefined ? profileName(b.name) : current.name;
    // a partial config is merged on top of the saved one (e.g. only the name mappings)
    const config = b.config !== undefined && b.config !== null
      ? sanitizeConfig({ ...current.config, ...(typeof b.config === 'object' ? b.config : {}) })
      : current.config;
    const isActive = b.is_active !== undefined ? (b.is_active === true || b.is_active === 1 || b.is_active === 'true') : current.is_active;
    await checkTfSites(config);
    await pool.query(
      `UPDATE project_daily_report_profiles SET name = ?, config = ?, is_active = ?, updated_by_user_id = ?
       WHERE profile_id = ?`, [name, JSON.stringify(config), isActive ? 1 : 0, req.user.user_id, current.profile_id]);
    return res.json({ status: 'success', data: await getProfile(current.profile_id) });
  } catch (error) {
    return fail(res, error, 'projectDailyReport.updateProfile');
  }
};

exports.preview = async (req, res) => {
  try {
    const profile = await getProfile((req.body || {}).profile_id, { activeOnly: true });
    const { model, extra } = await buildModel(profile, req.body, businessToday());
    const rows = (list, keys) => list.filter((r) => r.label).map((r) => Object.fromEntries([['label', r.label], ...keys.map((k) => [k, r[k] || 0])]));
    return res.json({
      status: 'success',
      data: {
        date: model.report_date,
        profile_id: profile.profile_id,
        sections: model.sections,
        info: model.info,
        manpower: {
          staff: rows(model.staff_rows, ['total', 'present', 'absent']),
          trades: rows(model.trade_rows, ['total', 'present', 'absent']),
          staff_total: model.staff_total,
          trade_total: model.trade_total,
          grand_total: model.grand_total,
        },
        plant: {
          plant: rows(model.plant_rows, ['operative', 'breakdown', 'idle']),
          tools: rows(model.tool_rows, ['operative', 'breakdown', 'idle']),
          plant_total: model.plant_total,
          tool_total: model.tool_total,
        },
        boq_lines: model.boq.length,
        ...extra,
      },
    });
  } catch (error) {
    return fail(res, error, 'projectDailyReport.preview');
  }
};

exports.generate = async (req, res) => {
  try {
    const profile = await getProfile((req.body || {}).profile_id, { activeOnly: true });
    const { model, extra } = await buildModel(profile, req.body, businessToday());
    const generatedAt = businessNow();
    const options = {
      sections: model.sections,
      fill_present_absent: model.fill_present_absent,
      warnings: extra.warnings,
      profile_name: profile.name,
    };
    const [ins] = await pool.query(
      `INSERT INTO project_daily_reports (profile_id, report_date, options, payload, generated_by_user_id, generated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [profile.profile_id, model.report_date, JSON.stringify(options), JSON.stringify(model), req.user.user_id, generatedAt]);
    const reportNo = `PDR-${model.report_date.replace(/-/g, '')}-${String(ins.insertId).padStart(4, '0')}`;
    await pool.query('UPDATE project_daily_reports SET report_no = ? WHERE report_id = ?', [reportNo, ins.insertId]);
    const docx = await queuedRender(model);
    return sendDocx(res, docx, reportNo, extra.warnings.length);
  } catch (error) {
    return fail(res, error, 'projectDailyReport.generate');
  }
};

exports.history = async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), 200);
    const [rows] = await pool.query(
      `SELECT r.report_id, r.report_no, r.profile_id, p.name AS profile_name,
              DATE_FORMAT(r.report_date, '%Y-%m-%d') AS report_date, r.options,
              DATE_FORMAT(r.generated_at, '%Y-%m-%d %H:%i') AS generated_at, u.full_name AS generated_by
       FROM project_daily_reports r
       LEFT JOIN project_daily_report_profiles p ON p.profile_id = r.profile_id
       LEFT JOIN users u ON u.user_id = r.generated_by_user_id
       ORDER BY r.report_id DESC
       LIMIT ${limit}`);
    return res.json({
      status: 'success',
      data: rows.map((r) => {
        const o = json(r.options) || {};
        return { ...r, options: undefined, warnings: o.warnings || [], sections: o.sections || {} };
      }),
    });
  } catch (error) {
    return fail(res, error, 'projectDailyReport.history');
  }
};

exports.download = async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw new PdrError('Invalid report id.');
    const [[row]] = await pool.query('SELECT report_no, payload FROM project_daily_reports WHERE report_id = ?', [id]);
    if (!row) throw new PdrError('Report not found.', 404);
    const model = json(row.payload);
    if (!model) throw new PdrError('This report cannot be read any more.', 409);
    return sendDocx(res, await queuedRender(model), row.report_no);
  } catch (error) {
    return fail(res, error, 'projectDailyReport.download');
  }
};
