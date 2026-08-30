const express = require('express');
const router = express.Router();
const plantsController = require('../controllers/plantsController');
const { requireAuth, requireRole } = require('../middleware/auth');

const workerOrAdmin = requireRole(['worker', 'admin']);

router.get('/',            requireAuth,                          plantsController.getPlants);
router.get('/:id',         requireAuth,                          plantsController.getPlantDetail);
router.post('/',           requireAuth, workerOrAdmin,           plantsController.createPlant);
router.put('/:id',         requireAuth, workerOrAdmin,           plantsController.updatePlant);
router.delete('/:id',      requireAuth, workerOrAdmin,           plantsController.deletePlant);
router.post('/:id/water',  requireAuth,                          plantsController.triggerWatering);
router.patch('/:id/auto-water', requireAuth,                     plantsController.toggleAutoWater);
router.get('/:id/history', requireAuth,                          plantsController.getPlantChartHistory);

module.exports = router;
