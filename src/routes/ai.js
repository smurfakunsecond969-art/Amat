const express = require('express');
const multer  = require('multer');
const router  = express.Router();
const aiController        = require('../controllers/aiController');
const analyticsController = require('../controllers/analyticsController');
const { requireAuth } = require('../middleware/auth');

// Multer: simpan di memori (bukan disk) untuk langsung forward ke Supabase Storage
const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 10 * 1024 * 1024 }, // maks 10 MB
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Hanya file gambar yang diizinkan.'));
    }
  },
});

// ── Plant photo routes (di-mount di /api/plants oleh index.js) ──
router.post('/:id/photos/analyze', requireAuth, upload.single('photo'), aiController.analyzePhoto);
router.post('/:id/photos',         requireAuth, upload.single('photo'), aiController.addPhoto);
router.get('/:id/photos',          requireAuth, aiController.getPlantPhotos);

// ── Taku AI chat routes ──
router.post('/chat',         requireAuth, aiController.chatWithTaku);
router.get('/chat/history',  requireAuth, aiController.getChatHistory);

// ── Taku active assistant command ──
router.post('/taku/command', requireAuth, aiController.takuCommand);

// ── Garden Analytics routes ──
router.get('/garden/analytics',               requireAuth, analyticsController.getGardenAnalytics);
router.get('/treatment-logs/pending-checkin', requireAuth, analyticsController.getPendingCheckin);
router.get('/treatment-logs/history',         requireAuth, analyticsController.getTreatmentHistory);
router.post('/treatment-logs',                requireAuth, analyticsController.saveTreatmentLog);
router.patch('/treatment-logs/:id/resolve',   requireAuth, analyticsController.resolveCheckin);

module.exports = router;
