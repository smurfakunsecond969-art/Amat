const express = require('express');
const router = express.Router();
const plantsController = require('../controllers/plantsController');
const { requireAuth } = require('../middleware/auth');

router.get('/', requireAuth, plantsController.getPlants);
router.get('/:id', requireAuth, plantsController.getPlantDetail);
router.post('/', requireAuth, plantsController.createPlant);
router.put('/:id', requireAuth, plantsController.updatePlant);
router.delete('/:id', requireAuth, plantsController.deletePlant);
router.post('/:id/water', requireAuth, plantsController.triggerWatering);
router.patch('/:id/auto-water', requireAuth, plantsController.toggleAutoWater);
router.get('/:id/history', requireAuth, plantsController.getPlantChartHistory);

module.exports = router;
