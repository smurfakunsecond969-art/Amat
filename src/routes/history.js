const express = require('express');
const router = express.Router();
const historyController = require('../controllers/historyController');
const { requireAuth } = require('../middleware/auth');

router.get('/', requireAuth, historyController.getGlobalHistory);

module.exports = router;
