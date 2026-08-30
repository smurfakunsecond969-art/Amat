const { supabase } = require('../db');

async function ingestDeviceData(req, res, next) {
  try {
    const { device_code, kelembaban_tanah, recorded_at } = req.body;

    if (!device_code || kelembaban_tanah === undefined) {
      return res.status(400).json({ error: 'device_code dan kelembaban_tanah wajib diisi' });
    }

    const moistureVal = Number(kelembaban_tanah);
    const timeVal = recorded_at || new Date().toISOString();

    // 1. Validasi device ada
    const { data: device, error: devErr } = await supabase
      .from('device')
      .select('id, tanaman_id, status_koneksi')
      .eq('device_code', device_code.trim())
      .maybeSingle();

    if (devErr || !device) {
      return res.status(404).json({ error: `Perangkat dengan kode '${device_code}' tidak ditemukan.` });
    }

    // 2. Insert sensor_readings
    await supabase.from('sensor_readings').insert([
      {
        device_id: device.id,
        kelembaban_tanah: moistureVal,
        recorded_at: timeVal,
      },
    ]);

    // 3. Update device status
    await supabase
      .from('device')
      .update({
        last_seen_at: new Date().toISOString(),
        status_koneksi: 'aktif',
      })
      .eq('id', device.id);

    // 4. Fetch tanaman terkait
    if (device.tanaman_id) {
      const { data: plant } = await supabase
        .from('tanaman')
        .select('id, threshold_min, threshold_max, auto_water_mode')
        .eq('id', device.tanaman_id)
        .maybeSingle();

      if (plant) {
        // Cek threshold_min
        const isBelowThreshold = moistureVal < Number(plant.threshold_min);

        if (isBelowThreshold && plant.auto_water_mode) {
          // Cek apakah ada command pending/berjalan
          const { data: pendingCmds } = await supabase
            .from('device_commands')
            .select('id')
            .eq('device_id', device.id)
            .eq('status', 'pending');

          if (!pendingCmds || pendingCmds.length === 0) {
            // Insert command siram_mulai
            await supabase.from('device_commands').insert([
              {
                device_id: device.id,
                command: 'siram_mulai',
                target_kelembaban: Number(plant.threshold_max),
                status: 'pending',
              },
            ]);

            // Insert irrigation_log
            await supabase.from('irrigation_logs').insert([
              {
                tanaman_id: plant.id,
                device_id: device.id,
                trigger_type: 'auto',
                waktu_mulai: new Date().toISOString(),
                kelembaban_awal: moistureVal,
                status: 'berjalan',
              },
            ]);
          }
        }
      }
    }

    // 5. Query all pending commands untuk device ini
    const { data: pendingCommands } = await supabase
      .from('device_commands')
      .select('id, command, target_kelembaban, created_at')
      .eq('device_id', device.id)
      .eq('status', 'pending');

    // Update pending commands status to 'terkirim'
    if (pendingCommands && pendingCommands.length > 0) {
      const cmdIds = pendingCommands.map((c) => c.id);
      await supabase
        .from('device_commands')
        .update({ status: 'terkirim' })
        .in('id', cmdIds);
    }

    res.json({
      message: 'Data sensor berhasil diterima',
      commands: pendingCommands || [],
    });
  } catch (err) {
    next(err);
  }
}

async function acknowledgeCommand(req, res, next) {
  try {
    const { id } = req.params; // command_id
    const { status, kelembaban_akhir } = req.body; // status: 'dieksekusi' | 'gagal'

    if (!status || !['dieksekusi', 'gagal'].includes(status)) {
      return res.status(400).json({ error: "Status harus 'dieksekusi' atau 'gagal'" });
    }

    const { data: command, error: cmdErr } = await supabase
      .from('device_commands')
      .update({
        status,
        executed_at: new Date().toISOString(),
      })
      .eq('id', id)
      .select()
      .single();

    if (cmdErr || !command) {
      return res.status(404).json({ error: 'Command tidak ditemukan' });
    }

    // Update active irrigation log
    const { data: activeLog } = await supabase
      .from('irrigation_logs')
      .select('id, waktu_mulai')
      .eq('device_id', command.device_id)
      .eq('status', 'berjalan')
      .order('waktu_mulai', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (activeLog) {
      const now = new Date();
      const startTime = new Date(activeLog.waktu_mulai);
      const durationSeconds = Math.max(0, Math.floor((now.getTime() - startTime.getTime()) / 1000));

      await supabase
        .from('irrigation_logs')
        .update({
          status: status === 'dieksekusi' ? 'selesai' : 'gagal',
          waktu_selesai: now.toISOString(),
          kelembaban_akhir: kelembaban_akhir !== undefined ? Number(kelembaban_akhir) : null,
          durasi_detik: durationSeconds,
        })
        .eq('id', activeLog.id);
    }

    res.json({ message: `Command status diperbarui menjadi '${status}'` });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  ingestDeviceData,
  acknowledgeCommand,
};
