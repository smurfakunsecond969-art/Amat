const { supabase } = require('../db');
const { computePlantStatus, computeLastUpdateMinutes } = require('../services/statusService');
const { computePlantCondition } = require('../services/plantConditionService');

async function formatPlantSummary(plant) {
  // Fetch device
  const { data: device } = await supabase
    .from('device')
    .select('id, device_code, last_seen_at, status_koneksi')
    .eq('tanaman_id', plant.id)
    .maybeSingle();

  // Tidak ada fallback dummy — kalau belum ada sensor, moisture = null
  let latestMoisture = null;
  let lastSeenAt = null; // hanya diisi dari data sensor nyata, bukan dari device.last_seen_at

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
      // last_seen_at hanya valid kalau ada sensor reading nyata
      lastSeenAt = latestReading.recorded_at;
    }
    // Kalau tidak ada sensor reading sama sekali, lastSeenAt tetap null
    // — device terdaftar tapi belum pernah kirim data
  }

  // Fetch latest photo
  let latestPhoto = null;
  const { data: photoData } = await supabase
    .from('plant_photos')
    .select('id, photo_url, is_analysis_photo, catatan, created_at')
    .eq('tanaman_id', plant.id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (photoData) {
    latestPhoto = {
      id: photoData.id,
      url: photoData.photo_url,
      isAnalysis: photoData.is_analysis_photo,
      note: photoData.catatan,
      uploadedAt: photoData.created_at,
    };
  }

  // Fetch latest AI disease analysis
  let latestAnalysis = null;
  const { data: analysisData } = await supabase
    .from('disease_analyses')
    .select('id, status, hasil_analisis, health_score, disease_category, saran, analyzed_at')
    .eq('tanaman_id', plant.id)
    .order('analyzed_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (analysisData) {
    latestAnalysis = {
      id: analysisData.id,
      status: analysisData.status,
      result: analysisData.hasil_analisis,
      health_score: analysisData.health_score,
      disease_category: analysisData.disease_category,
      saran: analysisData.saran,
      analyzedAt: analysisData.analyzed_at,
    };
  }

  const computedStatus = computePlantStatus(latestMoisture, plant.threshold_min, lastSeenAt);
  const lastUpdate = computeLastUpdateMinutes(lastSeenAt);

  // Compute canonical plant condition
  const conditionObj = computePlantCondition({
    deviceId: device?.device_code || null,
    hasDevice: Boolean(device),
    lastSeenAt,
    lastUpdate,
    moisture: latestMoisture,
    moistureMin: Number(plant.threshold_min),
    moistureMax: Number(plant.threshold_max),
    threshold_min: Number(plant.threshold_min),
    threshold_max: Number(plant.threshold_max),
    latestHealthScore: latestAnalysis?.health_score ?? null,
    latestAnalysis,
  });

  return {
    id: plant.id,
    name: plant.nama,
    type: plant.jenis_tanaman,
    emoji: plant.emoji || '🌱',
    startDate: plant.tanggal_tanam || plant.created_at?.split('T')[0] || new Date().toISOString().split('T')[0],
    moisture: latestMoisture,           // null jika belum ada sensor/data
    moistureMin: Number(plant.threshold_min),
    moistureMax: Number(plant.threshold_max),
    status: computedStatus,
    deviceId: device?.device_code || null,
    lastUpdate,
    autoWater: Boolean(plant.auto_water_mode),
    hasDevice: Boolean(device),
    latestPhoto,
    latestAnalysis,
    // Rich Agronomic Metadata
    varietas: plant.varietas || null,
    fasePertumbuhan: plant.fase_pertumbuhan || null,
    mediaTanam: plant.media_tanam || null,
    lokasiBlok: plant.lokasi_blok || null,
    catatan: plant.catatan || null,
    // Canonical condition fields from plantConditionService
    condition: conditionObj.condition,
    conditionLabel: conditionObj.conditionLabel,
    conditionSeverity: conditionObj.conditionSeverity,
    conditionColor: conditionObj.conditionColor,
    sensorNotConnected: conditionObj.sensorNotConnected,
    healthScore: conditionObj.healthScore,
    countsInAverage: conditionObj.countsInAverage,
  };
}

/**
 * Resolusi target user_id berdasarkan role:
 *  - role 'user'          → selalu pakai id mereka sendiri
 *  - role 'worker'/'admin' → ambil dari query param (?userId / ?targetUserId) atau body (userId / targetUserId)
 */
function resolveTargetUserId(req, res) {
  if (req.user.role === 'user') {
    return { targetId: req.user.id, ok: true };
  }
  const userId = req.query?.userId || req.query?.targetUserId || req.body?.userId || req.body?.targetUserId;
  if (!userId) {
    res.status(400).json({ error: 'Parameter userId wajib disertakan untuk role worker/admin.' });
    return { ok: false };
  }
  return { targetId: userId, ok: true };
}

async function getPlants(req, res, next) {
  try {
    const { targetId, ok } = resolveTargetUserId(req, res);
    if (!ok) return;

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

async function getPlantDetail(req, res, next) {
  try {
    const { id } = req.params;
    let query = supabase.from('tanaman').select('*').eq('id', id);
    if (req.user.role === 'user') {
      query = query.eq('user_id', req.user.id);
    }
    const { data: plant, error } = await query.maybeSingle();

    if (error || !plant) {
      return res.status(404).json({ error: 'Tanaman tidak ditemukan' });
    }

    const baseSummary = await formatPlantSummary(plant);

    // Fetch device
    const { data: device } = await supabase
      .from('device')
      .select('id')
      .eq('tanaman_id', plant.id)
      .maybeSingle();

    // Sensor history — hanya dari data nyata, tidak ada fallback dummy
    let dailyHistory = null;
    let weeklyHistory = null;

    if (device) {
      // Daily: ambil 7 pembacaan terakhir (per jam terakhir atau per titik)
      const { data: dailyReadings } = await supabase
        .from('sensor_readings')
        .select('kelembaban_tanah, recorded_at')
        .eq('device_id', device.id)
        .order('recorded_at', { ascending: false })
        .limit(7);

      if (dailyReadings && dailyReadings.length > 0) {
        dailyHistory = dailyReadings.map((r) => Number(r.kelembaban_tanah)).reverse();
      }

      // Weekly: ambil 28 pembacaan terakhir, rata-rata setiap 4 → 7 titik mingguan
      const { data: weeklyReadings } = await supabase
        .from('sensor_readings')
        .select('kelembaban_tanah, recorded_at')
        .eq('device_id', device.id)
        .order('recorded_at', { ascending: false })
        .limit(28);

      if (weeklyReadings && weeklyReadings.length >= 7) {
        const values = weeklyReadings.map((r) => Number(r.kelembaban_tanah)).reverse();
        // Bagi jadi 7 segmen, ambil rata-rata tiap segmen
        const segSize = Math.floor(values.length / 7);
        weeklyHistory = Array.from({ length: 7 }, (_, i) => {
          const seg = values.slice(i * segSize, (i + 1) * segSize);
          const avg = seg.reduce((s, v) => s + v, 0) / seg.length;
          return Math.round(avg * 10) / 10;
        });
      } else if (weeklyReadings && weeklyReadings.length > 0) {
        weeklyHistory = weeklyReadings.map((r) => Number(r.kelembaban_tanah)).reverse();
      }
    }

    // Fetch water logs (last 6)
    // Fetch water logs (last 6)
    const { data: waterLogs } = await supabase
      .from('irrigation_logs')
      .select('id, trigger_type, waktu_mulai, kelembaban_awal, kelembaban_akhir, durasi_detik, dipicu_oleh_user_id')
      .eq('tanaman_id', plant.id)
      .order('waktu_mulai', { ascending: false })
      .limit(6);

    const formattedWaterLog = (waterLogs || []).map((log) => ({
      id: log.id,
      type: log.trigger_type,
      time: log.waktu_mulai,
      before: log.kelembaban_awal !== null ? Number(log.kelembaban_awal) : null,
      after: log.kelembaban_akhir !== null ? Number(log.kelembaban_akhir) : null,
      duration: log.durasi_detik !== null ? Math.round(log.durasi_detik / 60) : null,
      by: log.trigger_type === 'manual' ? (req.user.nama || req.user.name || 'User') : undefined,
    }));

    res.json({
      ...baseSummary,
      moistureHistory: {
        daily: dailyHistory,     // null jika tidak ada data
        weekly: weeklyHistory,   // null jika tidak ada data
      },
      waterLog: formattedWaterLog,
    });
  } catch (err) {
    next(err);
  }
}

async function createPlant(req, res, next) {
  try {
    const { targetId, ok } = resolveTargetUserId(req, res);
    if (!ok) return;

    const {
      name,
      type,
      emoji,
      deviceId,
      moistureMin,
      moistureMax,
      varietas,
      fasePertumbuhan,
      mediaTanam,
      lokasiBlok,
      catatan,
    } = req.body;

    if (!name || !type) {
      return res.status(400).json({ error: 'Nama dan jenis tanaman wajib diisi' });
    }

    const { data: newPlant, error: plantError } = await supabase
      .from('tanaman')
      .insert([
        {
          user_id: targetId,
          nama: name.trim(),
          jenis_tanaman: type.trim(),
          varietas: varietas ? varietas.trim() : null,
          fase_pertumbuhan: fasePertumbuhan ? fasePertumbuhan.trim() : null,
          media_tanam: mediaTanam ? mediaTanam.trim() : null,
          lokasi_blok: lokasiBlok ? lokasiBlok.trim() : null,
          catatan: catatan ? catatan.trim() : null,
          emoji: emoji || '🌱',
          threshold_min: moistureMin ?? 50,
          threshold_max: moistureMax ?? 80,
          auto_water_mode: false,
          status: 'aktif',
        },
      ])
      .select()
      .single();

    if (plantError) throw plantError;

    // Buat device code hanya jika deviceId diberikan
    if (deviceId && deviceId.trim()) {
      const { error: deviceError } = await supabase
        .from('device')
        .insert([
          {
            tanaman_id: newPlant.id,
            device_code: deviceId.trim(),
            tipe_device: 'ESP32',
            status_koneksi: 'perlu_dicek',
          },
        ]);

      if (deviceError && deviceError.code !== '23505') {
        console.warn('Device insert warning:', deviceError.message);
      }
    }

    const result = await formatPlantSummary(newPlant);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
}

async function updatePlant(req, res, next) {
  try {
    const { id } = req.params;
    const {
      name,
      type,
      emoji,
      deviceId,
      moistureMin,
      moistureMax,
      varietas,
      fasePertumbuhan,
      mediaTanam,
      lokasiBlok,
      catatan,
    } = req.body;

    let checkQuery = supabase.from('tanaman').select('id, user_id').eq('id', id);
    if (req.user.role === 'user') {
      checkQuery = checkQuery.eq('user_id', req.user.id);
    }
    const { data: existing, error: checkErr } = await checkQuery.maybeSingle();
    if (checkErr || !existing) {
      return res.status(404).json({ error: 'Tanaman tidak ditemukan atau tidak memiliki akses' });
    }

    const updatePayload = {
      emoji: emoji || '🌱',
      threshold_min: moistureMin,
      threshold_max: moistureMax,
    };
    if (name !== undefined) updatePayload.nama = name.trim();
    if (type !== undefined) updatePayload.jenis_tanaman = type.trim();
    if (varietas !== undefined) updatePayload.varietas = varietas ? varietas.trim() : null;
    if (fasePertumbuhan !== undefined) updatePayload.fase_pertumbuhan = fasePertumbuhan ? fasePertumbuhan.trim() : null;
    if (mediaTanam !== undefined) updatePayload.media_tanam = mediaTanam ? mediaTanam.trim() : null;
    if (lokasiBlok !== undefined) updatePayload.lokasi_blok = lokasiBlok ? lokasiBlok.trim() : null;
    if (catatan !== undefined) updatePayload.catatan = catatan ? catatan.trim() : null;

    const { data: updatedPlant, error } = await supabase
      .from('tanaman')
      .update(updatePayload)
      .eq('id', id)
      .select()
      .single();

    if (error || !updatedPlant) {
      return res.status(404).json({ error: 'Tanaman tidak ditemukan atau gagal diperbarui' });
    }

    if (deviceId !== undefined) {
      if (deviceId && deviceId.trim()) {
        const { data: existingDevice } = await supabase
          .from('device')
          .select('id')
          .eq('tanaman_id', id)
          .maybeSingle();

        if (existingDevice) {
          await supabase
            .from('device')
            .update({ device_code: deviceId.trim() })
            .eq('id', existingDevice.id);
        } else {
          await supabase
            .from('device')
            .insert([
              {
                tanaman_id: id,
                device_code: deviceId.trim(),
                tipe_device: 'ESP32',
                status_koneksi: 'perlu_dicek',
              },
            ]);
        }
      } else {
        await supabase.from('device').delete().eq('tanaman_id', id);
      }
    }

    const result = await formatPlantSummary(updatedPlant);
    res.json(result);
  } catch (err) {
    next(err);
  }
}

async function deletePlant(req, res, next) {
  try {
    const { id } = req.params;

    let checkQuery = supabase.from('tanaman').select('id, user_id').eq('id', id);
    if (req.user.role === 'user') {
      checkQuery = checkQuery.eq('user_id', req.user.id);
    }
    const { data: existing, error: checkErr } = await checkQuery.maybeSingle();
    if (checkErr || !existing) {
      return res.status(404).json({ error: 'Tanaman tidak ditemukan atau tidak memiliki akses' });
    }

    // Bersihkan semua relasi anak secara eksplisit agar tidak ada ghost records atau foreign key block
    try {
      await supabase.from('disease_analyses').delete().eq('tanaman_id', id);
      await supabase.from('plant_photos').delete().eq('tanaman_id', id);
      await supabase.from('irrigation_logs').delete().eq('tanaman_id', id);

      const { data: devices } = await supabase.from('device').select('id').eq('tanaman_id', id);
      if (devices && devices.length > 0) {
        const deviceIds = devices.map((d) => d.id);
        await supabase.from('device_commands').delete().in('device_id', deviceIds);
        await supabase.from('sensor_readings').delete().in('device_id', deviceIds);
        await supabase.from('device').delete().eq('tanaman_id', id);
      }

      await supabase.from('chat_messages').update({ tanaman_id: null }).eq('tanaman_id', id);
    } catch (cleanupErr) {
      console.warn('[deletePlant] Cleanup child records info:', cleanupErr.message);
    }

    // Hard delete baris tanaman dari database
    const { error: delError } = await supabase
      .from('tanaman')
      .delete()
      .eq('id', id);

    if (delError) throw delError;

    res.json({ message: 'Tanaman berhasil dihapus' });
  } catch (err) {
    next(err);
  }
}

async function triggerWatering(req, res, next) {
  try {
    const { id } = req.params;

    let query = supabase.from('tanaman').select('id, threshold_max, user_id').eq('id', id);
    if (req.user.role === 'user') {
      query = query.eq('user_id', req.user.id);
    }
    const { data: plant, error: plantError } = await query.maybeSingle();

    if (plantError || !plant) {
      return res.status(404).json({ error: 'Tanaman tidak ditemukan' });
    }

    const { data: device } = await supabase
      .from('device')
      .select('id')
      .eq('tanaman_id', id)
      .maybeSingle();

    if (!device) {
      return res.status(400).json({ error: 'Belum ada perangkat IoT yang terhubung ke tanaman ini' });
    }

    // Ambil moisture terkini — null jika belum ada data sensor
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
      .insert([
        {
          device_id: device.id,
          command: 'siram_mulai',
          status: 'pending',
        },
      ])
      .select()
      .single();

    if (cmdError) throw cmdError;

    const { error: logError } = await supabase
      .from('irrigation_logs')
      .insert([
        {
          tanaman_id: plant.id,
          device_id: device.id,
          trigger_type: 'manual',
          waktu_mulai: new Date().toISOString(),
          kelembaban_awal: currentMoisture,
          status: 'berjalan',
          dipicu_oleh_user_id: req.user.id,
        },
      ]);

    if (logError) console.warn('Irrigation log insert warning:', logError.message);

    res.json({
      message: 'Perintah siram terkirim. Menyiram...',
      commandId: command.id,
    });
  } catch (err) {
    next(err);
  }
}

async function toggleAutoWater(req, res, next) {
  try {
    const { id } = req.params;
    const { enabled } = req.body;

    let checkQuery = supabase.from('tanaman').select('id, user_id').eq('id', id);
    if (req.user.role === 'user') {
      checkQuery = checkQuery.eq('user_id', req.user.id);
    }
    const { data: plant, error: checkError } = await checkQuery.maybeSingle();

    if (checkError || !plant) {
      return res.status(404).json({ error: 'Tanaman tidak ditemukan' });
    }

    const { data: updated, error } = await supabase
      .from('tanaman')
      .update({ auto_water_mode: Boolean(enabled) })
      .eq('id', id)
      .select()
      .single();

    if (error || !updated) {
      return res.status(404).json({ error: 'Tanaman tidak ditemukan' });
    }

    res.json({
      id: updated.id,
      autoWater: Boolean(updated.auto_water_mode),
      message: updated.auto_water_mode ? 'Siram otomatis diaktifkan' : 'Siram otomatis dinonaktifkan',
    });
  } catch (err) {
    next(err);
  }
}

async function getPlantChartHistory(req, res, next) {
  try {
    const { id } = req.params;
    const { range = 'daily' } = req.query;

    let query = supabase.from('tanaman').select('id, user_id').eq('id', id);
    if (req.user.role === 'user') {
      query = query.eq('user_id', req.user.id);
    }
    const { data: plant } = await query.maybeSingle();

    if (!plant) {
      return res.status(404).json({ error: 'Tanaman tidak ditemukan' });
    }

    const { data: device } = await supabase
      .from('device')
      .select('id')
      .eq('tanaman_id', id)
      .maybeSingle();

    // Tidak ada device → kembalikan data kosong, bukan dummy
    if (!device) {
      return res.json({ labels: [], values: [], hasData: false });
    }

    const limit = range === 'weekly' ? 28 : 7;
    const { data: readings } = await supabase
      .from('sensor_readings')
      .select('kelembaban_tanah, recorded_at')
      .eq('device_id', device.id)
      .order('recorded_at', { ascending: false })
      .limit(limit);

    if (!readings || readings.length === 0) {
      return res.json({ labels: [], values: [], hasData: false });
    }

    let labels;
    let values;

    if (range === 'weekly' && readings.length >= 7) {
      // Bagi ke 7 segmen, rata-rata per segmen
      const reversed = readings.map((r) => Number(r.kelembaban_tanah)).reverse();
      const segSize = Math.floor(reversed.length / 7);
      values = Array.from({ length: 7 }, (_, i) => {
        const seg = reversed.slice(i * segSize, (i + 1) * segSize);
        return Math.round((seg.reduce((s, v) => s + v, 0) / seg.length) * 10) / 10;
      });
      labels = ['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7'];
    } else {
      // Daily: ambil dari recorded_at untuk label hari
      const sorted = [...readings].reverse();
      values = sorted.map((r) => Number(r.kelembaban_tanah));
      labels = sorted.map((r) => {
        const d = new Date(r.recorded_at);
        return d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
      });
    }

    res.json({ labels, values, hasData: true });
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
