const { supabase } = require('../db');

async function getGlobalHistory(req, res, next) {
  try {
    const { plantId = 'all', type = 'all' } = req.query;

    let targetUserId = req.user.id;
    if (req.user.role !== 'user' && req.query.userId) {
      targetUserId = req.query.userId;
    }

    const { data: userPlants, error: plantErr } = await supabase
      .from('tanaman')
      .select('id, nama, emoji')
      .eq('user_id', targetUserId);

    if (plantErr || !userPlants || userPlants.length === 0) {
      return res.json([]);
    }

    const plantMap = {};
    const plantIds = [];
    userPlants.forEach((p) => {
      plantMap[p.id] = p;
      plantIds.push(p.id);
    });

    // Fetch latest photos for each plant (opsional)
    const photoMap = {};
    try {
      const { data: photos } = await supabase
        .from('plant_photos')
        .select('tanaman_id, photo_url, created_at')
        .in('tanaman_id', plantIds)
        .order('created_at', { ascending: false });

      (photos || []).forEach((ph) => {
        if (!photoMap[ph.tanaman_id]) {
          photoMap[ph.tanaman_id] = ph.photo_url;
        }
      });
    } catch (e) {
      console.warn('[getGlobalHistory] photo fetch warning:', e.message);
    }

    let query = supabase
      .from('irrigation_logs')
      .select('id, tanaman_id, trigger_type, waktu_mulai, kelembaban_awal, kelembaban_akhir, durasi_detik, dipicu_oleh_user_id')
      .in('tanaman_id', plantIds)
      .order('waktu_mulai', { ascending: false });

    if (plantId !== 'all') {
      query = query.eq('tanaman_id', plantId);
    }

    if (type !== 'all') {
      query = query.eq('trigger_type', type);
    }

    const { data: logs, error } = await query;
    if (error) {
      console.warn('[getGlobalHistory] query warning:', error.message);
      return res.json([]);
    }

    // Fetch nama user yang memicu penyiraman manual
    const userIds = [...new Set((logs || []).map((l) => l.dipicu_oleh_user_id).filter(Boolean))];
    const userMap = {};
    if (userIds.length > 0) {
      try {
        const { data: userRecords } = await supabase
          .from('users')
          .select('id, nama')
          .in('id', userIds);
        (userRecords || []).forEach((u) => {
          userMap[u.id] = u.nama;
        });
      } catch (uErr) {
        console.warn('[getGlobalHistory] user fetch warning:', uErr.message);
      }
    }

    const formattedLogs = (logs || []).map((log) => {
      const plant = plantMap[log.tanaman_id] || {};
      const userName = userMap[log.dipicu_oleh_user_id] || (log.trigger_type === 'manual' ? req.user.nama || req.user.name : undefined);
      return {
        id: log.id,
        plantId: log.tanaman_id,
        plantName: plant.nama || 'Tanaman',
        plantEmoji: plant.emoji || '🌱',
        plantPhoto: photoMap[log.tanaman_id] || null,
        type: log.trigger_type,
        time: log.waktu_mulai,
        before: log.kelembaban_awal !== null && log.kelembaban_awal !== undefined ? Number(log.kelembaban_awal) : null,
        after: log.kelembaban_akhir !== null && log.kelembaban_akhir !== undefined ? Number(log.kelembaban_akhir) : null,
        duration: log.durasi_detik !== null && log.durasi_detik !== undefined ? Math.round(log.durasi_detik / 60) : null,
        by: userName,
      };
    });

    res.json(formattedLogs);
  } catch (err) {
    console.error('[getGlobalHistory] Error:', err);
    res.json([]);
  }
}

/**
 * GET /api/history/photos
 * Mengambil semua riwayat foto yang diupload user beserta diagnosa AI-nya
 */
async function getPhotosHistory(req, res, next) {
  try {
    const { plantId = 'all' } = req.query;

    let targetUserId = req.user.id;
    if (req.user.role !== 'user' && req.query.userId) {
      targetUserId = req.query.userId;
    }

    const { data: userPlants, error: plantErr } = await supabase
      .from('tanaman')
      .select('id, nama, jenis_tanaman, emoji')
      .eq('user_id', targetUserId);

    if (plantErr || !userPlants || userPlants.length === 0) {
      return res.json([]);
    }

    const plantMap = {};
    const plantIds = [];
    userPlants.forEach((p) => {
      plantMap[p.id] = p;
      plantIds.push(p.id);
    });

    let photoQuery = supabase
      .from('plant_photos')
      .select('id, tanaman_id, photo_url, uploaded_by_user_id, is_analysis_photo, catatan, created_at')
      .in('tanaman_id', plantIds)
      .order('created_at', { ascending: false });

    if (plantId !== 'all') {
      photoQuery = photoQuery.eq('tanaman_id', plantId);
    }

    const { data: photos, error: photoErr } = await photoQuery;
    if (photoErr) {
      console.warn('[getPhotosHistory] photoQuery warning:', photoErr.message);
      return res.json([]);
    }

    // Fetch all analyses for these photos
    const photoIds = (photos || []).map((p) => p.id);
    let analyses = [];
    if (photoIds.length > 0) {
      try {
        const { data: analysisData } = await supabase
          .from('disease_analyses')
          .select('id, photo_id, hasil_analisis, status, health_score, disease_category, saran, analyzed_at')
          .in('photo_id', photoIds);
        analyses = analysisData || [];
      } catch (aErr) {
        console.warn('[getPhotosHistory] analysis fetch warning:', aErr.message);
      }
    }

    const analysisMap = {};
    analyses.forEach((a) => {
      analysisMap[a.photo_id] = a;
    });

    const formattedPhotos = (photos || []).map((ph) => {
      const plant = plantMap[ph.tanaman_id] || {};
      return {
        id: ph.id,
        plantId: ph.tanaman_id,
        plantName: plant.nama || 'Tanaman',
        plantType: plant.jenis_tanaman || '',
        plantEmoji: plant.emoji || '🌱',
        photoUrl: ph.photo_url,
        isAnalysis: ph.is_analysis_photo,
        note: ph.catatan,
        createdAt: ph.created_at,
        analysis: analysisMap[ph.id] || null,
      };
    });

    res.json(formattedPhotos);
  } catch (err) {
    console.error('[getPhotosHistory] Error:', err);
    res.json([]);
  }
}

module.exports = { getGlobalHistory, getPhotosHistory };

