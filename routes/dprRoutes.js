// routes/dprRoutes.js — /api/dpr : Daily Progress Report.
// Every route needs a signed-in account AND the permission written next to it
// (services/accessControl.js). Admin: dpr.view (read only). The old routes of
// the system are not touched.
const express = require('express');
const router = express.Router();
const c = require('../controllers/dprController');
const authMiddleware = require('../middleware/authMiddleware');
const can = require('../middleware/requirePermission');

router.use(authMiddleware);

const VIEW = can('dpr.view');
const EDIT = can('dpr.view', 'dpr.edit');
const OVERRIDE = can('dpr.view', 'dpr.override');
const REG = can('dpr.view', 'dpr.registers');
const ISSUE = can('dpr.view', 'dpr.issue');
const REVISE = can('dpr.view', 'dpr.revise');
const SETUP = can('dpr.view', 'dpr.setup');

const DAY = '/contracts/:cid/days/:date';

// general
router.get('/options', VIEW, c.options);
router.get('/source-options', SETUP, c.sourceOptions);
router.get('/differences', VIEW, c.differences);
router.get('/team-flow-today', VIEW, c.teamFlowToday);

// contracts & setup
router.get('/contracts', VIEW, c.listContracts);
router.post('/contracts', SETUP, c.createContract);
router.get('/contracts/:cid', VIEW, c.getSetup);
router.put('/contracts/:cid', SETUP, c.updateContract);
router.post('/contracts/:cid/copy-setup', SETUP, c.copySetup);
router.post('/contracts/:cid/eot-vo', SETUP, c.saveEotVo);
router.put('/contracts/:cid/eot-vo/:id', SETUP, c.saveEotVo);
router.delete('/contracts/:cid/eot-vo/:id', SETUP, c.deleteEotVo);
router.post('/contracts/:cid/lines', SETUP, c.saveLine);
router.put('/contracts/:cid/lines/:id', SETUP, c.saveLine);
router.patch('/contracts/:cid/lines/:id/active', SETUP, c.setLineActive);
router.put('/contracts/:cid/lines-order', SETUP, c.reorderLines);
router.post('/contracts/:cid/boq', SETUP, c.saveBoq);
router.put('/contracts/:cid/boq/:id', SETUP, c.saveBoq);
router.post('/contracts/:cid/boq-import', SETUP, c.xlsxUpload, c.importBoq);
router.put('/contracts/:cid/boq-order', SETUP, c.reorderBoq);
router.delete('/contracts/:cid/boq/:id', SETUP, c.deleteBoq);
router.post('/contracts/:cid/default-lines', SETUP, c.loadDefaultLines);
router.post('/contracts/:cid/areas', SETUP, c.saveArea);
router.put('/contracts/:cid/areas/:id', SETUP, c.saveArea);
router.post('/contracts/:cid/fixed-pages', SETUP, c.photoUpload, c.addFixedPage);
router.put('/contracts/:cid/fixed-pages/:id', SETUP, c.updateFixedPage);
router.get('/contracts/:cid/fixed-pages/:id/file', VIEW, c.fixedPageFile);

// dashboard, archive, registers
router.get('/contracts/:cid/dashboard', VIEW, c.dashboard);
router.get('/contracts/:cid/reports', VIEW, c.listReports);
router.get('/contracts/:cid/reports/:rid/pdf', VIEW, c.reportPdf);
router.get('/contracts/:cid/reports/:rid/xlsx', VIEW, c.reportXlsx);
router.get('/contracts/:cid/history', VIEW, c.history);
router.get('/contracts/:cid/registers/:kind', VIEW, c.listRegister);
router.post('/contracts/:cid/registers/:kind', REG, c.saveRegister);
router.put('/contracts/:cid/registers/:kind/:id', REG, c.saveRegister);
router.delete('/contracts/:cid/registers/:kind/:id', REG, c.deleteRegister);

// the day
router.get(DAY, VIEW, c.getDay);
router.patch(DAY, EDIT, c.patchDay);
router.get(`${DAY}/history`, VIEW, c.history);
router.put(`${DAY}/counts/:lineId`, EDIT, c.setCount);
router.put(`${DAY}/overrides/:lineId`, OVERRIDE, c.setOverride);
router.delete(`${DAY}/overrides/:lineId`, OVERRIDE, c.revertOverride);
router.get(`${DAY}/overrides/:lineId`, VIEW, c.overrideHistory);
router.post(`${DAY}/activities`, EDIT, c.saveActivity);
router.put(`${DAY}/activities/:id`, EDIT, c.saveActivity);
router.delete(`${DAY}/activities/:id`, EDIT, c.deleteActivity);
router.put(`${DAY}/activities-order`, EDIT, c.reorderActivities);
router.post(`${DAY}/materials`, EDIT, c.saveMaterial);
router.put(`${DAY}/materials/:id`, EDIT, c.saveMaterial);
router.delete(`${DAY}/materials/:id`, EDIT, c.deleteMaterial);
router.put(`${DAY}/manual`, EDIT, c.setManual);
router.post(`${DAY}/manual/preview`, VIEW, c.previewManual);
router.post(`${DAY}/manual/revert`, EDIT, c.revertManual);
router.get(`${DAY}/manual/history`, VIEW, c.manualHistory);
router.post(`${DAY}/qa`, EDIT, c.saveQa);
router.put(`${DAY}/qa/:id`, EDIT, c.saveQa);
router.delete(`${DAY}/qa/:id`, EDIT, c.deleteQa);
router.post(`${DAY}/photos`, EDIT, c.photoUpload, c.addPhoto);
router.put(`${DAY}/photos/:id`, EDIT, c.updatePhoto);
router.delete(`${DAY}/photos/:id`, EDIT, c.deletePhoto);
router.get('/contracts/:cid/photos/:id/file', VIEW, c.photoFile);
router.post(`${DAY}/copy`, EDIT, c.copyDay);
router.get(`${DAY}/pdf`, VIEW, c.draftPdf);
router.get(`${DAY}/xlsx`, VIEW, c.draftXlsx);
router.post(`${DAY}/issue`, ISSUE, c.issue);
router.post(`${DAY}/revise`, REVISE, c.revise);

module.exports = router;
