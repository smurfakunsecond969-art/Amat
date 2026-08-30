const { supabase } = require('../db');
const { computePlantStatus, computeLastUpdateMinutes } = require('../services/statusService');

async function formatPlantSummary(plant) {
  const { data: device } = await supabase
    .from('device')
    .select('id, device_code, last_seen_at, status_koneksi')
    .eq('tanaman_id', plant.id)
    .maybeSingle();

  let latestMoisture = null;
  let lastSeenAt = device?.last_seen_at || null;

  if (device) {
    const { data: latestReading } = await supabase
      .from('sensor_readings')
      .select('kelembaban_tanah, recorded_at')
      .eq('device_id', device.id)
      .order('recorded_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (latestReading) {
      latestMoisture = Number(latestReading.kelembaban_tanah);
      if (!lastSeenAt) lastSeenAt = latestReading.recorded_at;
    }
  }

  const computedStatus = computePlantStatus(latestMoisture, plant.threshold_min, lastSeenAt);
  const lastUpdate = computeLastUpdateMinutes(lastSeenAt);

  return {
    id: plant.id,
    name: plant.nama,
    type: plant.jenis_tanaman,
    emoji: plant.emoji || '🌱',
    startDate: plant.tanggal_tanam || plant.created_at?.split('T')[0] || new Date().toISOString().split('T')[0],
    moisture: latestMoisture,
    moistureMin: Number(plant.threshold_min),
    moistureMax: Number(plant.threshold_max),
    status: computedStatus,
    deviceId: device?.device_code || '-',
    lastUpdate,
    autoWater: Boolean(plant.auto_water_mode),
    ownerId: plant.user_id,
  };
}

// ── Resolve target user ID berdasarkan role ──────────────────
// - role 'user'           : selalu pakai req.user.id sendiri
// - role 'worker'/'admin' : pakai targetUserId dari query/body, wajib diisi
function resolveTargetUserId(req, source = 'query') {
  const { role, id: callerId } = req.user;
  if (role === 'user') return { targetId: callerId, error: null };

  const rawId = source === 'query' ? req.query.userId : req.body.targetUserId;
  if (!rawId) {
    return {
      targetId: null,
      error: `Worker/admin wajib menyertakan ${source === 'query' ? 'userId' : 'targetUserId'}.`,
    };
  }
  return { targetId: rawId, error: null };
}

// ── GET /api/plants ──────────────────────────────────────────
async function getPlants(req, res, next) {
  try {
    const { targetId, error: idErr } = resolveTargetUserId(req, 'query');
    if (idErr) return res.status(400).json({ error: idErr });

    const { data: plants, error } = await supabase
      .from('tanaman')
      .select('*')
      .eq('user_id', targetId)
      .eq('status', 'aktif')
      .order('created_at', { ascending: true });

    if (error) throw error;

    const formattedPlants = await Promise.all((plants || []).map(formatPlantSummary));
    res.json(formattedPlants);
  } catch (err) {
    next(err);
  }
}

// ── GET /api/plants/:id ──────────────────────────────────────
async function getPlantDetail(req, res, next) {
  try {
    const { id } = req.params;

    // Cari tanaman; user hanya bisa akses miliknya, worker/admin bisa semua
    let query = supabase.from('tanaman').select('*').eq('id', id);
    if (req.user.role === 'user') {
      query = query.eq('user_id', req.user.id);
    }
    const { data: plant, error } = await query.maybeSingle();

    if (error || !plant) {
      return res.status(404).json({ error: 'Tanaman tidak ditemukan' });
    }

    const baseSummary = await formatPlantSummary(plant);

    const { data: device } = await supabase
      .from('device')
      .select('id')
      .eq('tanaman_id', plant.id)
      .maybeSingle();

    let dailyHistory = [];
    let weeklyHistory = [];

    if (device) {
      const { data: readings } = await supabase
        .from('sensor_readings')
        .select('kelembaban_tanah, recorded_at')
        .eq('device_id', device.id)
        .order('recorded_at', { ascending: false })
        .limit(28);

      if (readings && readings.length > 0) {
        const values = readings.map((r) => Number(r.kelembaban_tanah)).reverse();
        dailyHistory = values.slice(-7);
        weeklyHistory = values.slice(-7);
      }
    }

    const { data: waterLogs } = await supabase
      .from('irrigation_logs')
      .select('id, trigger_type, waktu_mulai, kelembaban_awal, kelembaban_akhir, durasi_detik, dipicu_oleh_user_id, users(nama)')
      .eq('tanaman_id', plant.id)
      .order('waktu_mulai', { ascending: false })
      .limit(6);

    const formattedWaterLog = (waterLogs || []).map((log) => ({
      id: log.id,
      type: log.trigger_type,
      time: log.waktu_mulai,
      before: log.kelembaban_awal != null ? Number(log.kelembaban_awal) : null,
      after: log.kelembaban_akhir != null ? Number(log.kelembaban_akhir) : null,
      duration: log.durasi_detik != null ? Math.round(log.durasi_detik / 60) : null,
      by: log.users?.nama || (log.trigger_type === 'manual' ? req.user.nama : undefined),
    }));

    res.json({
      ...baseSummary,
      moistureHistory: { daily: dailyHistory, weekly: weeklyHistory },
      waterLog: formattedWaterLog,
    });
  } catch (err) {
    next(err);
  }
}

// ── POST /api/plants ─────────────────────────────────────────
// Role 'user' tidak diizinkan. Worker/admin wajib kirim targetUserId.
async function createPlant(req, res, next) {
  try {
    if (req.user.role === 'user') {
      return res.status(403).json({ error: 'Role user tidak bisa menambah tanaman. Hubungi worker atau admin.' });
    }

    const { name, type, emoji, deviceId, moistureMin, moistureMax, targetUserId } = req.body;

    if (!name || !type) {
      return res.status(400).json({ error: 'Nama dan jenis tanaman wajib diisi' });
    }
    if (!targetUserId) {
      return res.status(400).json({ error: 'targetUserId wajib diisi (tanaman dibuat atas nama user mana?)' });
    }

    // Pastikan targetUserId adalah user approved
    const { data: targetUser } = await supabase
      .from('users')
      .select('id, role, approval_status')
      .eq('id', targetUserId)
      .maybeSingle();

    if (!targetUser || targetUser.approval_status !== 'approved' || targetUser.role !== 'user') {
      return res.status(400).json({ error: 'targetUserId tidak valid atau bukan akun user yang disetujui.' });
    }

    const { data: newPlant, error: plantError } = await supabase
      .from('tanaman')
      .insert([{
        user_id: targetUserId,          // pemilik tanaman = user yang dipilih
        created_by_worker_id: req.user.id, // yang input = worker/admin
        nama: name.trim(),
        jenis_tanaman: type.trim(),
        emoji: emoji || '🌱',
        threshold_min: moistureMin ?? 50,
        threshold_max: moistureMax ?? 80,
        auto_water_mode: false,
        status: 'aktif',
      }])
      .select()
      .single();

    if (plantError) throw plantError;

    const deviceCode = (deviceId && deviceId.trim())
      ? deviceId.trim()
      : `DEV-${newPlant.id.slice(0, 6).toUpperCase()}`;

    const { error: deviceError } = await supabase
      .from('device')
      .insert([{
        tanaman_id: newPlant.id,
        device_code: deviceCode,
        tipe_device: 'ESP32',
        status_koneksi: 'perlu_dicek',
      }]);

    if (deviceError && deviceError.code !== '23505') {
      console.warn('Device insert warning:', deviceError.message);
    }

    const result = await formatPlantSummary(newPlant);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
}

// ── PUT /api/plants/:id ──────────────────────────────────────
async function updatePlant(req, res, next) {
  try {
    const { id } = req.params;
    const { name, type, emoji, deviceId, moistureMin, moistureMax } = req.body;

    // user hanya bisa update miliknya; worker/admin bisa update semua
    let query = supabase.from('tanaman').update({
      nama: name?.trim(),
      jenis_tanaman: type?.trim(),
      emoji: emoji || '🌱',
      threshold_min: moistureMin,
      threshold_max: moistureMax,
    }).eq('id', id);

    if (req.user.role === 'user') {
      query = query.eq('user_id', req.user.id);
    }

    const { data: updatedPlant, error } = await query.select().single();

    if (error || !updatedPlant) {
      return res.status(404).json({ error: 'Tanaman tidak ditemukan atau gagal diperbarui' });
    }

    if (deviceId) {
      await supabase.from('device').update({ device_code: deviceId.trim() }).eq('tanaman_id', id);
    }

    const result = await formatPlantSummary(updatedPlant);
    res.json(result);
  } catch (err) {
    next(err);
  }
}

// ── DELETE /api/plants/:id ───────────────────────────────────
async function deletePlant(req, res, next) {
  try {
    const { id } = req.params;

    let query = supabase.from('tanaman').delete().eq('id', id);
    if (req.user.role === 'user') {
      query = query.eq('user_id', req.user.id);
    }

    const { error } = await query;
    if (error) throw error;

    res.json({ message: 'Tanaman berhasil dihapus' });
  } catch (err) {
    next(err);
  }
}

// ── POST /api/plants/:id/water ───────────────────────────────
async function triggerWatering(req, res, next) {
  try {
    const { id } = req.params;

    // user hanya bisa siram miliknya; worker/admin bisa siram semua
    let query = supabase.from('tanaman').select('id, threshold_max').eq('id', id);
    if (req.user.role === 'user') query = query.eq('user_id', req.user.id);
    const { data: plant, error: plantError } = await query.maybeSingle();

    if (plantError || !plant) {
      return res.status(404).json({ error: 'Tanaman tidak ditemukan' });
    }

    const { data: device } = await supabase
      .from('device').select('id').eq('tanaman_id', id).maybeSingle();

    if (!device) {
      return res.status(400).json({ error: 'Belum ada perangkat IoT yang terhubung ke tanaman ini' });
    }

    const { data: latestReading } = await supabase
      .from('sensor_readings')
      .select('kelembaban_tanah')
      .eq('device_id', device.id)
      .order('recorded_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    const currentMoisture = latestReading ? Number(latestReading.kelembaban_tanah) : null;

    const { data: command, error: cmdError } = await supabase
      .from('device_commands')
      .insert([{ device_id: device.id, command: 'siram_mulai', status: 'pending' }])
      .select()
      .single();

    if (cmdError) throw cmdError;

    await supabase.from('irrigation_logs').insert([{
      tanaman_id: plant.id,
      device_id: device.id,
      trigger_type: 'manual',
      waktu_mulai: new Date().toISOString(),
      kelembaban_awal: currentMoisture,
      status: 'berjalan',
      dipicu_oleh_user_id: req.user.id,
    }]);

    res.json({ message: 'Perintah siram terkirim. Menyiram...', commandId: command.id });
  } catch (err) {
    next(err);
  }
}

// ── PATCH /api/plants/:id/auto-water ────────────────────────
async function toggleAutoWater(req, res, next) {
  try {
    const { id } = req.params;
    const { enabled } = req.body;

    let query = supabase.from('tanaman').update({ auto_water_mode: Boolean(enabled) }).eq('id', id);
    if (req.user.role === 'user') query = query.eq('user_id', req.user.id);

    const { data: plant, error } = await query.select().single();

    if (error || !plant) {
      return res.status(404).json({ error: 'Tanaman tidak ditemukan' });
    }

    res.json({
      id: plant.id,
      autoWater: Boolean(plant.auto_water_mode),
      message: plant.auto_water_mode ? 'Siram otomatis diaktifkan' : 'Siram otomatis dinonaktifkan',
    });
  } catch (err) {
    next(err);
  }
}

// ── GET /api/plants/:id/history ──────────────────────────────
async function getPlantChartHistory(req, res, next) {
  try {
    const { id } = req.params;
    const { range = 'daily' } = req.query;

    const { data: device } = await supabase
      .from('device').select('id').eq('tanaman_id', id).maybeSingle();

    if (!device) {
      return res.json({ labels: ['Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab', 'Min'], values: [] });
    }

    const { data: readings } = await supabase
      .from('sensor_readings')
      .select('kelembaban_tanah, recorded_at')
      .eq('device_id', device.id)
      .order('recorded_at', { ascending: false })
      .limit(7);

    const labels = range === 'daily'
      ? ['Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab', 'Min']
      : ['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7'];

    const values = readings && readings.length > 0
      ? readings.map((r) => Number(r.kelembaban_tanah)).reverse()
      : [];

    res.json({ labels, values });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  getPlants,
  getPlantDetail,
  createPlant,
  updatePlant,
  deletePlant,
  triggerWatering,
  toggleAutoWater,
  getPlantChartHistory,
};
