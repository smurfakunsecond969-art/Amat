const express = require('express');
const router = express.Router();
const profileController = require('../controllers/profileController');
const { requireAuth } = require('../middleware/auth');

router.put('/', requireAuth, profileController.updateProfile);
router.patch('/notifications', requireAuth, profileController.updateNotifications);

module.exports = router;
