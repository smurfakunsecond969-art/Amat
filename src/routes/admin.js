const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { requireAdmin, listUsers, approveUser, rejectUser, changeRole } = require('../controllers/adminController');

// Semua route admin butuh login dulu, lalu cek role admin
router.use(requireAuth, requireAdmin);

router.get('/users', listUsers);
router.patch('/users/:id/approve', approveUser);
router.patch('/users/:id/reject', rejectUser);
router.patch('/users/:id/role', changeRole);

module.exports = router;
