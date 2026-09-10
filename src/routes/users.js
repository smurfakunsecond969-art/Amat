const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { getManagedUsers } = require('../controllers/usersController');

router.get('/managed', requireAuth, getManagedUsers);

module.exports = router;
