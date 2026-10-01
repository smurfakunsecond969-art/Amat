const { supabase } = require('../db');
const {
  computePlantCondition,
  computeGardenScore,
  buildDailyGardenSummary,
} = require('../services/plantConditionService');

/**
 * GET /api/ai/garden/analytics
 * Ambil skor kesehatan per tanaman + statistik penyakit untuk halaman analytics.
 * Query param: period = 'day' | 'week' | 'month' (default 'week')
 */
async function getGardenAnalytics(req, res, next) {
  try {
    const userId = req.user.id;
    const period = req.query.period || 'week';

    // Hitung cutoff waktu berdasar period (hanya jika bukan 'all')
    let cutoffISO = null;
    if (period === 'day') {
      const c = new Date();
      c.setDate(c.getDate() - 1);
      cutoffISO = c.toISOString();
    } else if (period === 'week') {
      const c = new Date();
      c.setDate(c.getDate() - 7);
      cutoffISO = c.toISOString();
    } else if (period === 'month') {
      const c = new Date();
      c.setMonth(c.getMonth() - 1);
      cutoffISO = c.toISOString();
    }

    // 1. Ambil semua tanaman user
    const { data: plants, error: plantErr } = await supabase
      .from('tanaman')
      .select('id, nama, jenis_tanaman, threshold_min, threshold_max')
      .eq('user_id', userId);

    if (plantErr) return res.status(500).json({ error: 'Gagal ambil data tanaman.' });
    if (!plants || plants.length === 0) {
      const emptyCounts = { sehat: 0, perlu_perhatian: 0, kritis: 0, tidak_ada_data: 0, total: 0 };
      return res.json({
        plantScores: [],
        diseaseStats: [],
        counts: emptyCounts,
        gardenScore: null,
        avgScore: null,
        dailySummary: buildDailyGardenSummary(emptyCounts, null),
        period,
      });
    }

    const plantIds = plants.map((p) => p.id);

    // 2. Ambil seluruh riwayat analisis AI per tanaman (untuk status terkini & tren)
    let analysisQuery = supabase
      .from('disease_analyses')
      .select('id, tanaman_id, health_score, disease_category, status, hasil_analisis, saran, analyzed_at')
      .in('tanaman_id', plantIds)
      .order('analyzed_at', { ascending: false });

    const { data: allAnalyses } = await analysisQuery;

    // 3. Ambil analisis terbaru per tanaman (selalu ada jika sudah pernah diagnosa)
    const latestAnalysisMap = {};
    const allAnalysesByPlant = {};
    (allAnalyses || []).forEach((a) => {
      if (!latestAnalysisMap[a.tanaman_id]) latestAnalysisMap[a.tanaman_id] = a;
      if (!allAnalysesByPlant[a.tanaman_id]) allAnalysesByPlant[a.tanaman_id] = [];
      allAnalysesByPlant[a.tanaman_id].push(a);
    });

    // Filter analisis untuk diseaseStats sesuai periode jika cutoffISO aktif
    const analyses = cutoffISO
      ? (allAnalyses || []).filter((a) => a.analyzed_at >= cutoffISO)
      : (allAnalyses || []);

    // 4. Ambil foto terbaru per tanaman untuk avatar
    const { data: latestPhotos } = await supabase
      .from('plant_photos')
      .select('tanaman_id, photo_url')
      .in('tanaman_id', plantIds)
      .order('created_at', { ascending: false });

    const latestPhotoMap = {};
    (latestPhotos || []).forEach((p) => {
      if (!latestPhotoMap[p.tanaman_id]) latestPhotoMap[p.tanaman_id] = p.photo_url;
    });

    // 5. Ambil kelembaban terkini & device info per tanaman
    const moistureMap = {};
    const deviceMap = {};
    await Promise.all(plants.map(async (plant) => {
      const { data: device } = await supabase
        .from('device')
        .select('id, device_code, last_seen_at')
        .eq('tanaman_id', plant.id)
        .maybeSingle();

      if (device) {
        deviceMap[plant.id] = device;
        const { data: reading } = await supabase
          .from('sensor_readings')
          .select('kelembaban_tanah, recorded_at')
          .eq('device_id', device.id)
          .order('recorded_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        if (reading) {
          moistureMap[plant.id] = {
            moisture: Number(reading.kelembaban_tanah),
            recordedAt: reading.recorded_at,
          };
        }
      }
    }));

    // 6. Hitung tren: bandingkan 2 analisis terakhir per tanaman
    function computeTrend(analysesList) {
      if (!analysesList || analysesList.length < 2) return 'stabil';
      const latest = analysesList[0].health_score;
      const prev   = analysesList[1].health_score;
      if (latest == null || prev == null) return 'stabil';
      if (latest > prev + 5) return 'membaik';
      if (latest < prev - 5) return 'memburuk';
      return 'stabil';
    }

    // 7. Bangun plantScores array dengan canonical condition
    const plantScores = plants.map((plant) => {
      const latest = latestAnalysisMap[plant.id];
      const analysesList = allAnalysesByPlant[plant.id];
      const sensorInfo = moistureMap[plant.id];
      const device = deviceMap[plant.id];
      const min = Number(plant.threshold_min) || 40;
      const max = Number(plant.threshold_max) || 80;

      const conditionObj = computePlantCondition({
        deviceId: device?.device_code || null,
        hasDevice: Boolean(device),
        lastSeenAt: sensorInfo?.recordedAt || null,
        moisture: sensorInfo?.moisture ?? null,
        moistureMin: min,
        moistureMax: max,
        threshold_min: min,
        threshold_max: max,
        latestHealthScore: latest?.health_score ?? null,
        latestAnalysis: latest,
      });

      return {
        id: plant.id,
        name: plant.nama,
        type: plant.jenis_tanaman,
        photoUrl: latestPhotoMap[plant.id] || null,
        healthScore: conditionObj.healthScore,
        condition: conditionObj.condition,
        conditionLabel: conditionObj.conditionLabel,
        conditionSeverity: conditionObj.conditionSeverity,
        conditionColor: conditionObj.conditionColor,
        sensorNotConnected: conditionObj.sensorNotConnected,
        countsInAverage: conditionObj.countsInAverage,
        status: conditionObj.condition, // Backward compat
        diseaseCategory: latest?.disease_category || null,
        saran: latest?.saran || null,
        diagnosis: latest?.hasil_analisis || null,
        lastAnalyzedAt: latest?.analyzed_at || null,
        trend: computeTrend(analysesList),
        moisture: sensorInfo?.moisture ?? null,
        moistureMin: min,
        moistureMax: max,
        hasDevice: Boolean(device),
        hasPhoto: !!latestPhotoMap[plant.id],
        hasAI: !!latest,
        isCritical: conditionObj.condition === 'kritis',
      };
    });

    // 8. Hitung statistik penyakit (pie chart)
    const categoryCount = {};
    (analyses || []).forEach((a) => {
      const cat = a.disease_category || 'Tidak Teridentifikasi';
      if (cat === 'Tidak Teridentifikasi') return; // exclude dari pie chart
      categoryCount[cat] = (categoryCount[cat] || 0) + 1;
    });

    const diseaseStats = Object.entries(categoryCount)
      .map(([category, count]) => ({ category, count }))
      .sort((a, b) => b.count - a.count);

    // 9. Hitung Canonical Breakdown Counts & Skor Total Kebun
    const counts = {
      sehat: plantScores.filter(p => p.condition === 'sehat').length,
      perlu_perhatian: plantScores.filter(p => p.condition === 'perlu_perhatian').length,
      kritis: plantScores.filter(p => p.condition === 'kritis').length,
      tidak_ada_data: plantScores.filter(p => p.condition === 'tidak_ada_data').length,
      total: plantScores.length,
    };

    const gardenScore = computeGardenScore(plantScores);
    const dailySummary = buildDailyGardenSummary(counts, gardenScore);

    return res.json({
      plantScores,
      diseaseStats,
      counts,
      gardenScore,
      avgScore: gardenScore, // Backward compat
      dailySummary,
      period,
    });
  } catch (err) {
    console.error('[getGardenAnalytics] error:', err);
    next(err);
  }
}

/**
 * GET /api/ai/treatment-logs/pending-checkin
 * Tanaman yg butuh check-in: status perlu_perhatian/terindikasi_penyakit/kritis,
 * belum ada treatment_log yang di-resolve, dan sudah >6 jam sejak analisis terakhir.
 */
async function getPendingCheckin(req, res, next) {
  try {
    const userId = req.user.id;

    // Ambil tanaman user
    const { data: plants } = await supabase
      .from('tanaman')
      .select('id, nama, jenis_tanaman')
      .eq('user_id', userId);

    if (!plants || plants.length === 0) return res.json([]);

    const plantIds = plants.map((p) => p.id);

    // Cutoff: 6 jam lalu
    const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();

    // Ambil analisis terbaru (non-sehat, sudah >6 jam lalu)
    const { data: analyses } = await supabase
      .from('disease_analyses')
      .select('id, tanaman_id, health_score, disease_category, status, hasil_analisis, analyzed_at')
      .in('tanaman_id', plantIds)
      .in('status', ['perlu_perhatian', 'terindikasi_penyakit'])
      .lte('analyzed_at', sixHoursAgo)
      .order('analyzed_at', { ascending: false });

    if (!analyses || analyses.length === 0) return res.json([]);

    // Ambil ID analisis yang sudah ada treatment log resolved
    const analysisIds = analyses.map((a) => a.id);
    const { data: resolvedLogs } = await supabase
      .from('treatment_logs')
      .select('disease_analysis_id')
      .in('disease_analysis_id', analysisIds)
      .eq('marked_resolved', true);

    const resolvedSet = new Set((resolvedLogs || []).map((l) => l.disease_analysis_id));

    // Filter: hanya analisis yang belum di-resolve
    const latestByPlant = {};
    analyses.forEach((a) => {
      if (resolvedSet.has(a.id)) return;
      if (!latestByPlant[a.tanaman_id]) latestByPlant[a.tanaman_id] = a;
    });

    const plantMap = Object.fromEntries(plants.map((p) => [p.id, p]));

    const pending = Object.values(latestByPlant).map((a) => ({
      analysisId:      a.id,
      plantId:         a.tanaman_id,
      plantName:       plantMap[a.tanaman_id]?.nama || 'Tanaman',
      plantType:       plantMap[a.tanaman_id]?.jenis_tanaman || '',
      status:          a.status,
      healthScore:     a.health_score,
      diseaseCategory: a.disease_category,
      diagnosis:       a.hasil_analisis,
      analyzedAt:      a.analyzed_at,
    }));

    return res.json(pending);
  } catch (err) {
    console.error('[getPendingCheckin] error:', err);
    next(err);
  }
}

/**
 * POST /api/ai/treatment-logs
 * Body: { analysisId, plantId, treatmentText, scoreBefore }
 * Simpan treatment log + set follow_up_due_at = sekarang + 3 hari
 */
async function saveTreatmentLog(req, res, next) {
  try {
    const userId = req.user.id;
    const { analysisId, plantId, treatmentText, scoreBefore } = req.body;

    if (!plantId || !treatmentText) {
      return res.status(400).json({ error: 'plantId dan treatmentText wajib diisi.' });
    }

    // Verifikasi tanaman milik user
    const { data: plant } = await supabase
      .from('tanaman')
      .select('id, user_id')
      .eq('id', plantId)
      .maybeSingle();

    if (!plant) return res.status(404).json({ error: 'Tanaman tidak ditemukan.' });
    if (plant.user_id !== userId && !['worker', 'admin'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Akses ditolak.' });
    }

    const followUpDueAt = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();

    const { data: log, error } = await supabase
      .from('treatment_logs')
      .insert({
        tanaman_id:          plantId,
        disease_analysis_id: analysisId || null,
        treatment_text:      treatmentText.trim(),
        score_before:        scoreBefore || null,
        follow_up_due_at:    followUpDueAt,
        last_checkin_at:     new Date().toISOString(),
      })
      .select()
      .single();

    if (error) {
      console.error('[saveTreatmentLog] insert error:', error);
      return res.status(500).json({ error: 'Gagal menyimpan catatan penanganan.' });
    }

    return res.json({ success: true, log });
  } catch (err) {
    console.error('[saveTreatmentLog] error:', err);
    next(err);
  }
}

/**
 * PATCH /api/ai/treatment-logs/:id/resolve
 * Tandai treatment log sebagai selesai
 */
async function resolveCheckin(req, res, next) {
  try {
    const userId = req.user.id;
    const logId  = req.params.id;

    const { data, error } = await supabase
      .from('treatment_logs')
      .update({ marked_resolved: true })
      .eq('id', logId)
      .select()
      .single();

    if (error) return res.status(500).json({ error: 'Gagal memperbarui status.' });

    return res.json({ success: true, log: data });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/ai/treatment-logs/history
 * Riwayat treatment per tanaman user — untuk laporan historis section 5
 */
async function getTreatmentHistory(req, res, next) {
  try {
    const userId = req.user.id;

    // Ambil tanaman user
    const { data: plants } = await supabase
      .from('tanaman')
      .select('id, nama, jenis_tanaman')
      .eq('user_id', userId);

    if (!plants || plants.length === 0) return res.json([]);

    const plantIds = plants.map((p) => p.id);
    const plantMap = Object.fromEntries(plants.map((p) => [p.id, p]));

    // Ambil treatment logs
    const { data: logs, error } = await supabase
      .from('treatment_logs')
      .select('*')
      .in('tanaman_id', plantIds)
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) return res.status(500).json({ error: 'Gagal mengambil riwayat penanganan.' });

    // Ambil data analisis terkait
    const analysisIds = (logs || [])
      .map((l) => l.disease_analysis_id)
      .filter(Boolean);

    let analysisMap = {};
    if (analysisIds.length > 0) {
      const { data: analyses } = await supabase
        .from('disease_analyses')
        .select('id, disease_category, health_score, status')
        .in('id', analysisIds);
      (analyses || []).forEach((a) => { analysisMap[a.id] = a; });
    }

    const result = (logs || []).map((log) => ({
      id:              log.id,
      plantId:         log.tanaman_id,
      plantName:       plantMap[log.tanaman_id]?.nama || 'Tanaman',
      plantType:       plantMap[log.tanaman_id]?.jenis_tanaman || '',
      treatmentText:   log.treatment_text,
      scoreBefore:     log.score_before,
      scoreAfter:      log.score_after,
      effectiveness:   log.effectiveness,
      markedResolved:  log.marked_resolved,
      followUpDueAt:   log.follow_up_due_at,
      createdAt:       log.created_at,
      analysis:        log.disease_analysis_id ? (analysisMap[log.disease_analysis_id] || null) : null,
    }));

    return res.json(result);
  } catch (err) {
    next(err);
  }
}

module.exports = {
  getGardenAnalytics,
  getPendingCheckin,
  saveTreatmentLog,
  resolveCheckin,
  getTreatmentHistory,
};
