// controllers/dprController.js
//
// DAILY PROGRESS REPORT (DPR) — for accounts whose role has the dpr.* permissions
// (and read-only for the Admin: dpr.view). Every route is guarded in
// routes/dprRoutes.js with requirePermission. All writes go to dpr_* tables only.
'use strict';

const path = require('path');
const multer = require('multer');
const fileStorage = require('../services/fileStorage');
const { businessToday } = require('../services/businessDate');
const C = require('../services/dpr/dprCommon');
const Setup = require('../services/dpr/dprSetup');
const Day = require('../services/dpr/dprDay');
const Reports = require('../services/dpr/dprReports');
const Sources = require('../services/dpr/dprSources');

const PDF = 'application/pdf';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function fail(res, error, where) {
  if (error && error.code === 'ER_NO_SUCH_TABLE') {
    return res.status(503).json({ status: 'error', message: 'The DPR tables are missing. Run migrations/2026_10_user_dpr/01_ddl.sql first.' });
  }
  if (error && error.code === 'ER_DUP_ENTRY') {
    return res.status(409).json({ status: 'error', message: 'This entry already exists (same code / item number).' });
  }
  if (error instanceof C.DprError || (error && error.statusCode && error.statusCode < 500)) {
    return res.status(error.statusCode || 400).json({ status: 'error', message: error.message, ...(error.extra || {}) });
  }
  console.error(`dpr.${where}:`, error);
  return res.status(500).json({ status: 'error', message: 'Something went wrong in the daily progress report. Please try again.' });
}

const ok = (res, data, code = 200) => res.status(code).json({ status: 'success', data });
const uid = (req) => req.user.user_id;
const cid = (req) => C.id(req.params.cid, 'contract');
function dateParam(req) {
  const d = C.date(req.params.date, { required: true, label: 'Report date' });
  if (d > businessToday()) throw new C.DprError('The report date cannot be in the future.');
  return d;
}
const wrap = (where, fn) => async (req, res) => {
  try {
    return await fn(req, res);
  } catch (e) {
    if (res.headersSent) return undefined;
    return fail(res, e, where);
  }
};
function sendFile(res, buf, name, mime, inline) {
  res.setHeader('Content-Type', mime);
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${name}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Length', buf.length);
  return res.end(buf);
}

// ------------------------------------------------------------------ uploads
const IMAGE_TYPES = { '.jpg': ['image/jpeg'], '.jpeg': ['image/jpeg'], '.png': ['image/png'], '.webp': ['image/webp'] };
const photoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (IMAGE_TYPES[ext] && (IMAGE_TYPES[ext].includes(file.mimetype) || file.mimetype === 'application/octet-stream')) return cb(null, true);
    const e = new Error('Only JPG, PNG or WEBP photos are allowed.');
    e.code = 'INVALID_FILE_TYPE';
    return cb(e);
  },
}).single('file');
const xlsxUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    if (path.extname(file.originalname || '').toLowerCase() === '.xlsx') return cb(null, true);
    const e = new Error('Choose an Excel .xlsx file.');
    e.code = 'INVALID_FILE_TYPE';
    return cb(e);
  },
}).single('file');
const uploadErr = (mw, maxText) => (req, res, next) => mw(req, res, (err) => {
  if (!err) return next();
  return res.status(400).json({ status: 'error', message: err.code === 'LIMIT_FILE_SIZE' ? `The file must be ${maxText} or smaller.` : (err.code === 'INVALID_FILE_TYPE' ? err.message : 'Invalid upload.') });
});
exports.photoUpload = uploadErr(photoUpload, '10 MB');
exports.xlsxUpload = uploadErr(xlsxUpload, '5 MB');

// ------------------------------------------------------------------ general
exports.options = wrap('options', async (req, res) => ok(res, {
  today: businessToday(), lists: C.LISTS, sections: C.SECTIONS, copy_parts: Day.ALL_PARTS,
  permissions: (req.access && req.access.permissions) || [],
}));
exports.sourceOptions = wrap('sourceOptions', async (req, res) => {
  const ids = String(req.query.tf_site_ids || '').split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0);
  return ok(res, await Sources.sourceOptions({ tfSiteIds: ids }));
});

// ------------------------------------------------------------------ contracts & setup
exports.listContracts = wrap('listContracts', async (req, res) => ok(res, await Setup.listContracts()));
exports.createContract = wrap('createContract', async (req, res) => ok(res, await Setup.createContract(req.body, uid(req)), 201));
exports.getSetup = wrap('getSetup', async (req, res) => ok(res, await Setup.getSetup(cid(req))));
exports.updateContract = wrap('updateContract', async (req, res) => ok(res, await Setup.updateContract(cid(req), req.body, uid(req))));
exports.copySetup = wrap('copySetup', async (req, res) => ok(res, await Setup.copySetup(cid(req), C.id((req.body || {}).from_contract_id, 'contract to copy from'), (req.body || {}).parts, uid(req))));

exports.saveEotVo = wrap('saveEotVo', async (req, res) => ok(res, await Setup.saveEotVo(cid(req), req.params.id ? C.id(req.params.id) : null, req.body, uid(req)), req.params.id ? 200 : 201));
exports.deleteEotVo = wrap('deleteEotVo', async (req, res) => { await Setup.deleteEotVo(cid(req), C.id(req.params.id), uid(req)); return ok(res, null); });

exports.saveLine = wrap('saveLine', async (req, res) => ok(res, await Setup.saveLine(cid(req), req.params.id ? C.id(req.params.id) : null, req.body, uid(req)), req.params.id ? 200 : 201));
exports.setLineActive = wrap('setLineActive', async (req, res) => ok(res, await Setup.setLineActive(cid(req), C.id(req.params.id), C.bool((req.body || {}).is_active), uid(req))));
exports.reorderLines = wrap('reorderLines', async (req, res) => ok(res, await Setup.reorderLines(cid(req), (req.body || {}).kind, (req.body || {}).line_ids, uid(req))));

exports.saveBoq = wrap('saveBoq', async (req, res) => ok(res, await Setup.saveBoq(cid(req), req.params.id ? C.id(req.params.id) : null, req.body, uid(req)), req.params.id ? 200 : 201));
exports.importBoq = wrap('importBoq', async (req, res) => {
  if (!req.file || !req.file.buffer || !req.file.buffer.length) throw new C.DprError('Choose the BOQ Excel file.');
  return ok(res, await Setup.importBoq(cid(req), req.file.buffer, uid(req)));
});

// ------------------------------------------------------------------ the day
exports.getDay = wrap('getDay', async (req, res) => {
  if (C.bool(req.query.refresh)) Sources.clearCache();
  return ok(res, await Day.getDayBundle(cid(req), dateParam(req)));
});
exports.patchDay = wrap('patchDay', async (req, res) => ok(res, await Day.patchDay(cid(req), dateParam(req), req.body, uid(req))));
exports.setCount = wrap('setCount', async (req, res) => ok(res, await Day.setCount(cid(req), dateParam(req), C.id(req.params.lineId, 'line'), (req.body || {}).value, uid(req))));
exports.setOverride = wrap('setOverride', async (req, res) => ok(res, await Day.setOverride(cid(req), dateParam(req), C.id(req.params.lineId, 'line'), req.body, uid(req))));
exports.revertOverride = wrap('revertOverride', async (req, res) => ok(res, await Day.revertOverride(cid(req), dateParam(req), C.id(req.params.lineId, 'line'), uid(req))));
exports.overrideHistory = wrap('overrideHistory', async (req, res) => ok(res, await Day.overrideHistory(cid(req), dateParam(req), C.id(req.params.lineId, 'line'))));
exports.history = wrap('history', async (req, res) => ok(res, await Day.history(cid(req), {
  date: req.params.date ? dateParam(req) : C.date(req.query.date, { label: 'date' }),
  entity: req.query.entity ? String(req.query.entity).slice(0, 40) : null,
  entityId: req.query.entity_id ?? null,
  field: req.query.field ? String(req.query.field).slice(0, 80) : null,
  limit: req.query.limit,
})));

exports.saveActivity = wrap('saveActivity', async (req, res) => ok(res, await Day.saveActivity(cid(req), dateParam(req), req.params.id ? C.id(req.params.id) : null, req.body, uid(req)), req.params.id ? 200 : 201));
exports.deleteActivity = wrap('deleteActivity', async (req, res) => { await Day.deleteActivity(cid(req), dateParam(req), C.id(req.params.id), uid(req)); return ok(res, null); });
exports.saveQa = wrap('saveQa', async (req, res) => ok(res, await Day.saveQa(cid(req), dateParam(req), req.params.id ? C.id(req.params.id) : null, req.body, uid(req)), req.params.id ? 200 : 201));
exports.deleteQa = wrap('deleteQa', async (req, res) => { await Day.deleteQa(cid(req), dateParam(req), C.id(req.params.id), uid(req)); return ok(res, null); });

exports.addPhoto = wrap('addPhoto', async (req, res) => {
  const contractId = cid(req);
  const date = dateParam(req);
  if (!req.file || !req.file.buffer || !req.file.buffer.length) throw new C.DprError('Choose a photo.');
  const ext = path.extname(req.file.originalname || '').toLowerCase();
  const type = (IMAGE_TYPES[ext] || ['image/jpeg'])[0];
  const name = await fileStorage.save(fileStorage.newName('dpr_photo', req.file.originalname), req.file.buffer, type);
  return ok(res, await Day.addPhoto(contractId, date, name, type, req.body, uid(req)), 201);
});
exports.updatePhoto = wrap('updatePhoto', async (req, res) => ok(res, await Day.updatePhoto(cid(req), dateParam(req), C.id(req.params.id), req.body, uid(req))));
exports.deletePhoto = wrap('deletePhoto', async (req, res) => { await Day.deletePhoto(cid(req), dateParam(req), C.id(req.params.id), uid(req)); return ok(res, null); });
exports.photoFile = wrap('photoFile', async (req, res) => {
  const p = await Day.photoFile(cid(req), C.id(req.params.id));
  const sent = await fileStorage.send(res, p.file_name);
  if (!sent && !res.headersSent) return res.status(404).json({ status: 'error', message: 'Photo file not found.' });
  return undefined;
});

exports.copyDay = wrap('copyDay', async (req, res) => ok(res, await Day.copyDay(cid(req), dateParam(req), C.id((req.body || {}).from_contract_id, 'contract to copy from'), (req.body || {}).parts, uid(req))));

exports.draftPdf = wrap('draftPdf', async (req, res) => {
  const { buf, name } = await Reports.draftFiles(cid(req), dateParam(req), 'pdf');
  return sendFile(res, buf, name, PDF, true);
});
exports.draftXlsx = wrap('draftXlsx', async (req, res) => {
  const { buf, name } = await Reports.draftFiles(cid(req), dateParam(req), 'xlsx');
  return sendFile(res, buf, name, XLSX, false);
});
exports.issue = wrap('issue', async (req, res) => ok(res, await Reports.issue(cid(req), dateParam(req), req.body, uid(req)), 201));
exports.revise = wrap('revise', async (req, res) => ok(res, await Reports.issue(cid(req), dateParam(req), req.body, uid(req), { revise: true }), 201));

// ------------------------------------------------------------------ archive, dashboard, registers, differences
exports.listReports = wrap('listReports', async (req, res) => ok(res, await Reports.listReports(cid(req), {
  from: C.date(req.query.from, { label: 'from' }), to: C.date(req.query.to, { label: 'to' }),
})));
exports.reportPdf = wrap('reportPdf', async (req, res) => {
  const { buf, name, report } = await Reports.reportFile(C.id(req.params.rid, 'report'), 'pdf');
  if (report.contract_id !== cid(req)) throw new C.DprError('Report not found.', 404);
  return sendFile(res, buf, name, PDF, true);
});
exports.reportXlsx = wrap('reportXlsx', async (req, res) => {
  const { buf, name, report } = await Reports.reportFile(C.id(req.params.rid, 'report'), 'xlsx');
  if (report.contract_id !== cid(req)) throw new C.DprError('Report not found.', 404);
  return sendFile(res, buf, name, XLSX, false);
});
exports.dashboard = wrap('dashboard', async (req, res) => {
  const d = C.date(req.query.date, { label: 'date' }) || businessToday();
  if (d > businessToday()) throw new C.DprError('The date cannot be in the future.');
  return ok(res, await Reports.dashboard(cid(req), d));
});

const regKind = (req) => (req.params.kind === 'ncr' ? 'ncr' : req.params.kind === 'concerns' ? 'concern' : null);
exports.listRegister = wrap('listRegister', async (req, res) => {
  const k = regKind(req);
  if (!k) throw new C.DprError('Unknown register.', 404);
  return ok(res, await Day.listRegister(k, cid(req), { status: C.oneOf(req.query.status, C.LISTS.status, { label: 'status' }) }));
});
exports.saveRegister = wrap('saveRegister', async (req, res) => {
  const k = regKind(req);
  if (!k) throw new C.DprError('Unknown register.', 404);
  return ok(res, await Day.saveRegister(k, cid(req), req.params.id ? C.id(req.params.id) : null, req.body, uid(req)), req.params.id ? 200 : 201);
});
exports.deleteRegister = wrap('deleteRegister', async (req, res) => {
  const k = regKind(req);
  if (!k) throw new C.DprError('Unknown register.', 404);
  await Day.deleteRegister(k, cid(req), C.id(req.params.id), uid(req));
  return ok(res, null);
});

exports.differences = wrap('differences', async (req, res) => ok(res, await Day.differences({
  contractId: req.query.contract_id ? C.id(req.query.contract_id, 'contract') : null,
  from: C.date(req.query.from, { label: 'from' }),
  to: C.date(req.query.to, { label: 'to' }),
  includeReverted: C.bool(req.query.include_reverted),
})));
