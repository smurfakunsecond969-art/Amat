const express = require('express');
const router = express.Router();
const adminController = require('../controllers/adminController');
const { requireAuth, requireRole } = require('../middleware/auth');

const adminOnly = [requireAuth, requireRole(['admin'])];

router.get('/users', adminOnly, adminController.listUsers);
router.patch('/users/:id/approve', adminOnly, adminController.approveUser);
router.patch('/users/:id/reject', adminOnly, adminController.rejectUser);
router.patch('/users/:id/role', adminOnly, adminController.changeUserRole);

module.exports = router;
