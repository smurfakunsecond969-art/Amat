const express = require('express');
const router = express.Router();
const deviceController = require('../controllers/deviceController');

router.post('/data', deviceController.ingestDeviceData);
router.post('/commands/:id/ack', deviceController.acknowledgeCommand);

module.exports = router;
