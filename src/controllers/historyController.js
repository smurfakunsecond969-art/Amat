const { supabase } = require('../db');

async function getGlobalHistory(req, res, next) {
  try {
    const { plantId = 'all', type = 'all' } = req.query;

    // Fetch user's plants
    const { data: userPlants } = await supabase
      .from('tanaman')
      .select('id, nama, emoji')
      .eq('user_id', req.user.id);

    if (!userPlants || userPlants.length === 0) {
      return res.json([]);
    }

    const plantMap = {};
    const plantIds = [];
    userPlants.forEach((p) => {
      plantMap[p.id] = p;
      plantIds.push(p.id);
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
        type: log.trigger_type,
        time: log.waktu_mulai,
        before: log.kelembaban_awal ? Number(log.kelembaban_awal) : 50,
        after: log.kelembaban_akhir ? Number(log.kelembaban_akhir) : 70,
        duration: Math.round((log.durasi_detik || 600) / 60), // minutes
        by: log.users?.nama || (log.trigger_type === 'manual' ? req.user.nama : undefined),
      };
    });

    res.json(formattedLogs);
  } catch (err) {
    next(err);
  }
}

module.exports = { getGlobalHistory };
