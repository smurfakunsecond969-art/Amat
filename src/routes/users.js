const express = require('express');
const router = express.Router();
const usersController = require('../controllers/usersController');
const { requireAuth, requireRole } = require('../middleware/auth');

router.get('/managed', requireAuth, requireRole(['worker', 'admin']), usersController.getManagedUsers);

module.exports = router;
