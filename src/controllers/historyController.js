const { supabase } = require('../db');

async function getGlobalHistory(req, res, next) {
  try {
    const { plantId = 'all', type = 'all' } = req.query;

    // Fetch user's plants (atau milik target user jika worker/admin)
    let targetUserId = req.user.id;
    if (req.user.role !== 'user' && req.query.userId) {
      targetUserId = req.query.userId;
    }

    const { data: userPlants } = await supabase
      .from('tanaman')
      .select('id, nama, emoji')
      .eq('user_id', targetUserId);

    if (!userPlants || userPlants.length === 0) {
      return res.json([]);
    }

    const plantMap = {};
    const plantIds = [];
    userPlants.forEach((p) => {
      plantMap[p.id] = p;
      plantIds.push(p.id);
    });

    // Fetch latest photos for each plant
    const { data: photos } = await supabase
      .from('plant_photos')
      .select('tanaman_id, photo_url, created_at')
      .in('tanaman_id', plantIds)
      .order('created_at', { ascending: false });

    const photoMap = {};
    (photos || []).forEach((ph) => {
      if (!photoMap[ph.tanaman_id]) {
        photoMap[ph.tanaman_id] = ph.photo_url;
      }
    });

    let query = supabase
      .from('irrigation_logs')
      .select('id, tanaman_id, trigger_type, waktu_mulai, kelembaban_awal, kelembaban_akhir, durasi_detik, dipicu_oleh_user_id, users(nama)')
      .in('tanaman_id', plantIds)
      .order('waktu_mulai', { ascending: false });

    if (plantId !== 'all') {
      query = query.eq('tanaman_id', plantId);
    }

    if (type !== 'all') {
      query = query.eq('trigger_type', type);
    }

    const { data: logs, error } = await query;
    if (error) throw error;

    const formattedLogs = (logs || []).map((log) => {
      const plant = plantMap[log.tanaman_id] || {};
      return {
        id: log.id,
        plantId: log.tanaman_id,
        plantName: plant.nama || 'Tanaman',
        plantEmoji: plant.emoji || '🌱',
        plantPhoto: photoMap[log.tanaman_id] || null,
        type: log.trigger_type,
        time: log.waktu_mulai,
        // Null jika data tidak tersedia — frontend bertanggung jawab menampilkan '-'
        before: log.kelembaban_awal !== null ? Number(log.kelembaban_awal) : null,
        after: log.kelembaban_akhir !== null ? Number(log.kelembaban_akhir) : null,
        duration: log.durasi_detik !== null ? Math.round(log.durasi_detik / 60) : null,
        by: log.users?.nama || (log.trigger_type === 'manual' ? req.user.nama : undefined),
      };
    });

    res.json(formattedLogs);
  } catch (err) {
    next(err);
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

    const { data: userPlants } = await supabase
      .from('tanaman')
      .select('id, nama, jenis_tanaman, emoji')
      .eq('user_id', targetUserId);

    if (!userPlants || userPlants.length === 0) {
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
    if (photoErr) throw photoErr;

    // Fetch all analyses for these photos
    const photoIds = (photos || []).map((p) => p.id);
    let analyses = [];
    if (photoIds.length > 0) {
      const { data: analysisData } = await supabase
        .from('disease_analyses')
        .select('id, photo_id, hasil_analisis, status, analyzed_at')
        .in('photo_id', photoIds);
      analyses = analysisData || [];
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
    next(err);
  }
}

module.exports = { getGlobalHistory, getPhotosHistory };

