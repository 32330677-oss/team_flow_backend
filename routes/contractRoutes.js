const express = require('express');
const router = express.Router();
const contractController = require('../controllers/contractController');

// المسارات الخاصة بالعقود
router.get('/project/:projectId', contractController.getContractsByProject);
router.post('/', contractController.createContract);
router.put('/:contractId', contractController.updateContract);

module.exports = router;