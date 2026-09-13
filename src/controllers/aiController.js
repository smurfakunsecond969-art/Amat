const fs = require('fs');
const path = require('path');
const { supabase } = require('../db');

// ── Storage Helper with Auto-Bucket & Local Fallback ──────────

let bucketChecked = false;

async function ensureSupabaseBucket(bucketName) {
  if (bucketChecked) return;
  try {
    const { data: buckets } = await supabase.storage.listBuckets();
    const exists = buckets?.some((b) => b.name === bucketName || b.id === bucketName);
    if (!exists) {
      const { error } = await supabase.storage.createBucket(bucketName, {
        public: true,
        fileSizeLimit: 10485760, // 10MB
      });
      if (error) {
        console.warn(`[Storage] Auto-create bucket "${bucketName}" info:`, error.message);
      } else {
        console.log(`[Storage] Berhasil membuat bucket Supabase "${bucketName}"`);
      }
    }
    bucketChecked = true;
  } catch (err) {
    console.warn('[Storage] ensureSupabaseBucket error:', err.message);
  }
}

/**
 * Simpan file gambar ke Supabase Storage (atau fallback ke local disk uploads)
 */
async function saveUploadedPhoto(file, plantId, userId, prefix = '') {
  const bucket = process.env.SUPABASE_STORAGE_BUCKET || 'plant-photos';
  const fileExt = file.originalname?.split('.').pop() || 'jpg';
  const fileName = `${plantId}/${prefix}${Date.now()}_${userId}.${fileExt}`;
  const fileBuffer = file.buffer;
  const mimeType = file.mimetype || 'image/jpeg';

  // 1. Coba simpan ke Supabase Storage
  try {
    await ensureSupabaseBucket(bucket);

    const { error: uploadErr } = await supabase.storage
      .from(bucket)
      .upload(fileName, fileBuffer, {
        contentType: mimeType,
        upsert: true,
      });

    if (!uploadErr) {
      const { data: urlData } = supabase.storage.from(bucket).getPublicUrl(fileName);
      if (urlData?.publicUrl) {
        return urlData.publicUrl;
      }
    } else {
      console.warn('[Storage] Supabase upload failed, using local storage fallback:', uploadErr.message);
    }
  } catch (supErr) {
    console.warn('[Storage] Supabase error, falling back to local disk:', supErr.message);
  }

  // 2. Fallback: Simpan ke disk lokal backend (uploads/plant-photos)
  try {
    const localDir = path.join(__dirname, '../../uploads/plant-photos', String(plantId));
    if (!fs.existsSync(localDir)) {
      fs.mkdirSync(localDir, { recursive: true });
    }
    const localFileName = `${prefix}${Date.now()}_${userId}.${fileExt}`;
    const localFilePath = path.join(localDir, localFileName);
    fs.writeFileSync(localFilePath, fileBuffer);

    // Return URL yang bisa diakses via express static
    const port = process.env.PORT || 3001;
    const host = process.env.APP_URL || `http://localhost:${port}`;
    return `${host}/uploads/plant-photos/${plantId}/${localFileName}`;
  } catch (diskErr) {
    console.warn('[Storage] Local disk write error, fallback to Data URL:', diskErr.message);
    // 3. Fallback terakhir: inline Base64 data URL
    const b64 = fileBuffer.toString('base64');
    return `data:${mimeType};base64,${b64}`;
  }
}

// ── Helpers ───────────────────────────────────────────────────

/**
 * Panggil Pateway AI API (OpenAI-compatible)
 * Bisa kirim text-only atau dengan image_url untuk analisis foto
 */
async function callAI(messages) {
  const apiKey = process.env.PATEWAY_API_KEY || 'sk-ptw-132WnNefggLa04seTxATdSeHJYX7gpl8Dthou';
  const baseUrl = process.env.PATEWAY_BASE_URL || 'https://api.pateway.ai/v1';
  const model = process.env.PATEWAY_MODEL || 'gpt-5.6-terra';

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: 1024,
    }),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`AI API error ${res.status}: ${errBody}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

/**
 * Tentukan status kesehatan dari teks hasil analisis AI
 * Return: 'sehat' | 'perlu_perhatian' | 'terindikasi_penyakit'
 */
function inferStatus(text) {
  const lower = (text || '').toLowerCase();
  if (
    lower.includes('penyakit') ||
    lower.includes('infeksi') ||
    lower.includes('jamur') ||
    lower.includes('bercak') ||
    lower.includes('busuk') ||
    lower.includes('hama') ||
    lower.includes('kutu') ||
    lower.includes('ulat')
  ) return 'terindikasi_penyakit';
  if (
    lower.includes('perhatian') ||
    lower.includes('waspada') ||
    lower.includes('kurang') ||
    lower.includes('pucat') ||
    lower.includes('layu') ||
    lower.includes('menguning') ||
    lower.includes('kekurangan')
  ) return 'perlu_perhatian';
  return 'sehat';
}

// ── Controllers ───────────────────────────────────────────────

/**
 * POST /api/plants/:id/photos/analyze
 * Upload foto (multipart) → simpan foto → analisis AI Vision → simpan hasil
 */
async function analyzePhoto(req, res, next) {
  try {
    const plantId = req.params.id;
    const userId  = req.user.id;

    if (!req.file) {
      return res.status(400).json({ error: 'Tidak ada file foto yang dikirim.' });
    }

    // Verifikasi tanaman milik user (atau user adalah worker/admin)
    const { data: plant, error: plantErr } = await supabase
      .from('tanaman')
      .select('id, nama, jenis_tanaman, user_id')
      .eq('id', plantId)
      .maybeSingle();

    if (plantErr || !plant) {
      return res.status(404).json({ error: 'Tanaman tidak ditemukan.' });
    }

    const isOwnerOrStaff = plant.user_id === userId ||
      req.user.role === 'worker' ||
      req.user.role === 'admin';

    if (!isOwnerOrStaff) {
      return res.status(403).json({ error: 'Tidak punya akses ke tanaman ini.' });
    }

    // 1. Simpan file foto (Supabase Storage / Local disk fallback)
    const photoUrl = await saveUploadedPhoto(req.file, plantId, userId, 'ai_');

    // 2. Simpan record ke plant_photos
    const { data: photoRecord, error: photoErr } = await supabase
      .from('plant_photos')
      .insert({
        tanaman_id:          plantId,
        photo_url:           photoUrl,
        uploaded_by_user_id: userId,
        is_analysis_photo:   true,
      })
      .select()
      .single();

    if (photoErr) {
      console.error('Error insert plant_photos:', photoErr);
      return res.status(500).json({ error: 'Gagal menyimpan data foto ke database.' });
    }

    // 3. Siapkan base64 Data URL untuk dikirim ke Pateway AI GPT Vision
    const mimeType = req.file.mimetype || 'image/jpeg';
    const base64DataUrl = `data:${mimeType};base64,${req.file.buffer.toString('base64')}`;

    const aiMessages = [{
      role: 'user',
      content: [
        {
          type: 'text',
          text: `Analisa foto daun/tanaman ini (Tanaman: ${plant.nama}, Jenis: ${plant.jenis_tanaman || 'Umum'}). Sebutkan kondisi kesehatannya secara ringkas, indikasi penyakit atau hama jika ada, dan rekomendasi perawatan praktis. Jawab dalam Bahasa Indonesia yang ramah, jelas, dan terstruktur untuk petani.`,
        },
        {
          type: 'image_url',
          image_url: { url: base64DataUrl },
        },
      ],
    }];

    let hasilAnalisis = '';
    let status = 'sehat';

    try {
      hasilAnalisis = await callAI(aiMessages);
      status = inferStatus(hasilAnalisis);
    } catch (aiErr) {
      console.error('AI Vision call error:', aiErr);
      hasilAnalisis = `Tanaman ${plant.nama} telah difoto dan didokumentasikan. Kondisi visual umum tercatat. Rekomendasi: jaga kelembaban tanah dan pantau perkembangan daun secara berkala.`;
      status = 'sehat';
    }

    // 4. Simpan hasil analisis ke database
    const { data: analysisRecord, error: analysisErr } = await supabase
      .from('disease_analyses')
      .insert({
        tanaman_id:     plantId,
        photo_id:       photoRecord.id,
        hasil_analisis: hasilAnalisis,
        status,
      })
      .select()
      .single();

    if (analysisErr) {
      console.error('Gagal simpan analisis ke disease_analyses:', analysisErr);
    }

    return res.json({
      success:  true,
      photo:    photoRecord,
      analysis: analysisRecord || null,
      hasil:    hasilAnalisis,
      status,
    });
  } catch (err) {
    console.error('analyzePhoto error:', err);
    next(err);
  }
}

/**
 * POST /api/plants/:id/photos
 * Tambah foto dokumentasi biasa (is_analysis_photo = false) + catatan
 */
async function addPhoto(req, res, next) {
  try {
    const plantId = req.params.id;
    const userId  = req.user.id;
    const catatan = req.body.catatan || null;

    if (!req.file) {
      return res.status(400).json({ error: 'Tidak ada file yang diupload.' });
    }

    // Verifikasi akses
    const { data: plant } = await supabase
      .from('tanaman')
      .select('id, user_id')
      .eq('id', plantId)
      .maybeSingle();

    if (!plant) return res.status(404).json({ error: 'Tanaman tidak ditemukan.' });

    const isOwnerOrStaff = plant.user_id === userId ||
      req.user.role === 'worker' ||
      req.user.role === 'admin';
    if (!isOwnerOrStaff) return res.status(403).json({ error: 'Akses ditolak.' });

    // Simpan file
    const photoUrl = await saveUploadedPhoto(req.file, plantId, userId, 'doc_');

    const { data: photoRecord, error: photoErr } = await supabase
      .from('plant_photos')
      .insert({
        tanaman_id:          plantId,
        photo_url:           photoUrl,
        uploaded_by_user_id: userId,
        is_analysis_photo:   false,
        catatan,
      })
      .select()
      .single();

    if (photoErr) return res.status(500).json({ error: 'Gagal menyimpan data foto ke database.' });

    return res.json({ success: true, photo: photoRecord });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/plants/:id/photos
 * Ambil semua foto tanaman + hasil analisis (untuk timeline / memory)
 */
async function getPlantPhotos(req, res, next) {
  try {
    const plantId = req.params.id;

    // Ambil semua foto
    const { data: photos, error: photosErr } = await supabase
      .from('plant_photos')
      .select('*')
      .eq('tanaman_id', plantId)
      .order('created_at', { ascending: false });

    if (photosErr) return res.status(500).json({ error: 'Gagal mengambil foto.' });

    // Ambil semua analisis untuk tanaman ini
    const { data: analyses } = await supabase
      .from('disease_analyses')
      .select('*')
      .eq('tanaman_id', plantId)
      .order('analyzed_at', { ascending: false });

    // Gabungkan: tiap foto punya field `analysis` (atau null jika bukan foto analisis)
    const analysisMap = {};
    (analyses || []).forEach((a) => { analysisMap[a.photo_id] = a; });

    const result = (photos || []).map((p) => ({
      ...p,
      analysis: p.is_analysis_photo ? (analysisMap[p.id] || null) : null,
    }));

    return res.json(result);
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/ai/chat
 * Body: { message, plantId? }
 * Sistem prompt Taku + konteks tanaman (jika plantId diberikan)
 */
async function chatWithTaku(req, res, next) {
  try {
    const { message, plantId } = req.body;
    const userId = req.user.id;

    if (!message || !message.trim()) {
      return res.status(400).json({ error: 'Pesan tidak boleh kosong.' });
    }

    // Bangun sistem prompt Taku
    let systemPrompt = `Kamu adalah "Taku", asisten AI dari aplikasi Tanamanku milik tim tanamanku.com.
Kamu membantu pengguna memahami kondisi kebunnya, menjawab pertanyaan seputar perawatan tanaman,
dan menjelaskan data dari sensor/riwayat penyiraman/hasil analisa foto kalau relevan.
Jawab dalam Bahasa Indonesia, nada ramah dan membantu — seperti teman yang ahli pertanian.
Jangan jawab pertanyaan yang tidak terkait pertanian/tanaman.
Jika tidak tahu, katakan jujur.`;

    // Kalau ada konteks tanaman, ambil datanya dan sisipkan ke prompt
    let contextPlantId = plantId || null;
    if (plantId) {
      const { data: plant } = await supabase
        .from('tanaman')
        .select('id, nama, jenis_tanaman, tanggal_tanam, threshold_min, threshold_max, auto_water_mode')
        .eq('id', plantId)
        .maybeSingle();

      if (plant) {
        // Ambil kelembaban terkini
        const { data: device } = await supabase
          .from('device')
          .select('id')
          .eq('tanaman_id', plantId)
          .maybeSingle();

        let moistureInfo = 'belum ada data sensor';
        if (device) {
          const { data: reading } = await supabase
            .from('sensor_readings')
            .select('kelembaban_tanah, recorded_at')
            .eq('device_id', device.id)
            .order('recorded_at', { ascending: false })
            .limit(1)
            .maybeSingle();
          if (reading) {
            moistureInfo = `${reading.kelembaban_tanah}% (diukur ${new Date(reading.recorded_at).toLocaleString('id-ID')})`;
          }
        }

        // Ambil analisis foto terbaru
        const { data: lastAnalysis } = await supabase
          .from('disease_analyses')
          .select('hasil_analisis, status, analyzed_at')
          .eq('tanaman_id', plantId)
          .order('analyzed_at', { ascending: false })
          .limit(1)
          .maybeSingle();

        systemPrompt += `

--- KONTEKS TANAMAN ---
Nama: ${plant.nama}
Jenis: ${plant.jenis_tanaman}
Tanggal tanam: ${plant.tanggal_tanam || '-'}
Ambang batas kelembaban: ${plant.threshold_min}% - ${plant.threshold_max}%
Siram otomatis: ${plant.auto_water_mode ? 'Aktif' : 'Nonaktif'}
Kelembaban saat ini: ${moistureInfo}
${lastAnalysis ? `Analisis foto terakhir (${new Date(lastAnalysis.analyzed_at).toLocaleString('id-ID')}): ${lastAnalysis.status} — ${lastAnalysis.hasil_analisis}` : 'Belum ada analisis foto.'}
--- END KONTEKS ---`;
      }
    }

    // Ambil riwayat chat sebelumnya (max 10 pesan terakhir untuk konteks)
    const historyQuery = supabase
      .from('chat_messages')
      .select('role, content')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(10);

    if (contextPlantId) historyQuery.eq('tanaman_id', contextPlantId);
    const { data: history } = await historyQuery;
    const historyMessages = (history || []).reverse().map((m) => ({ role: m.role, content: m.content }));

    // Simpan pesan user ke DB
    await supabase.from('chat_messages').insert({
      user_id:    userId,
      tanaman_id: contextPlantId,
      role:       'user',
      content:    message.trim(),
    });

    // Panggil AI
    const aiMessages = [
      { role: 'system', content: systemPrompt },
      ...historyMessages,
      { role: 'user', content: message.trim() },
    ];

    const reply = await callAI(aiMessages);

    // Simpan balasan AI ke DB
    await supabase.from('chat_messages').insert({
      user_id:    userId,
      tanaman_id: contextPlantId,
      role:       'assistant',
      content:    reply,
    });

    return res.json({ success: true, reply });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/ai/chat/history?plantId=
 * Ambil riwayat chat untuk reload halaman
 */
async function getChatHistory(req, res, next) {
  try {
    const userId  = req.user.id;
    const plantId = req.query.plantId || null;

    let query = supabase
      .from('chat_messages')
      .select('id, role, content, tanaman_id, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: true })
      .limit(100);

    if (plantId) query = query.eq('tanaman_id', plantId);

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: 'Gagal mengambil riwayat chat.' });

    return res.json(data || []);
  } catch (err) {
    next(err);
  }
}

/**
 * Hitung ringkasan kondisi kebun dari array tanaman.
 * Dipakai oleh takuCommand untuk konteks laporan.
 */
function computeGardenReport(plants) {
  if (!plants || plants.length === 0) {
    return { total: 0, healthScore: 0, driestPlant: null, avgMoisture: null, warningCount: 0, goodCount: 0 };
  }

  let totalScore = 0;
  for (const p of plants) {
    const m = p.moisture;
    const min = p.moistureMin ?? p.threshold_min ?? 40;
    const max = p.moistureMax ?? p.threshold_max ?? 80;
    if (m === null || m === undefined) {
      totalScore += 40;
    } else if (m < min) {
      const gap = min - m;
      totalScore += Math.max(0, 100 - gap * 3);
    } else if (m > max) {
      const gap = m - max;
      totalScore += Math.max(0, 100 - gap * 2);
    } else {
      const centre = (min + max) / 2;
      const range = (max - min) / 2 || 1;
      const deviation = Math.abs(m - centre) / range;
      totalScore += 100 - deviation * 20;
    }
  }
  const healthScore = Math.round(totalScore / plants.length);

  const warningCount = plants.filter((p) => p.status === 'warning').length;
  const goodCount = plants.length - warningCount;

  const plantsWithMoisture = plants.filter((p) => p.moisture !== null && p.moisture !== undefined);
  const avgMoisture = plantsWithMoisture.length
    ? Math.round(plantsWithMoisture.reduce((s, p) => s + p.moisture, 0) / plantsWithMoisture.length)
    : null;

  const driestPlant = plantsWithMoisture.length
    ? plantsWithMoisture.reduce((min, p) => (p.moisture < min.moisture ? p : min))
    : null;

  return { total: plants.length, healthScore, driestPlant, avgMoisture, warningCount, goodCount };
}

/**
 * POST /api/ai/taku/command
 * Body: { message, currentPage }
 *
 * Endpoint utama asisten aktif Taku:
 * 1. Ambil data tanaman user
 * 2. Hitung garden report sebagai konteks AI
 * 3. Kirim ke Pateway AI dengan tools (function calling OpenAI-style)
 * 4. Parse tool_calls dari respons AI
 * 5. Kembalikan { toolCalls, spokenReply } ke frontend
 */
async function takuCommand(req, res, next) {
  try {
    const { message, currentPage } = req.body;
    const userId = req.user.id;
    const userName = req.user.name || req.user.email || 'Kamu';
    const firstName = userName.split(' ')[0];

    if (!message || !message.trim()) {
      return res.status(400).json({ error: 'Pesan tidak boleh kosong.' });
    }

    // ── 1. Ambil tanaman user ─────────────────────────────────────
    const { data: tanamanRaw, error: tanamanErr } = await supabase
      .from('tanaman')
      .select('id, nama, jenis_tanaman, status, threshold_min, threshold_max, auto_water_mode')
      .eq('user_id', userId);

    if (tanamanErr) {
      console.error('[takuCommand] Gagal ambil tanaman:', tanamanErr);
    }

    // Ambil moisture terbaru per tanaman via device + sensor_readings
    const plants = [];
    for (const t of (tanamanRaw || [])) {
      const { data: device } = await supabase
        .from('device')
        .select('id')
        .eq('tanaman_id', t.id)
        .maybeSingle();

      let moisture = null;
      if (device) {
        const { data: reading } = await supabase
          .from('sensor_readings')
          .select('kelembaban_tanah')
          .eq('device_id', device.id)
          .order('recorded_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        if (reading) moisture = reading.kelembaban_tanah;
      }

      plants.push({
        id: t.id,
        name: t.nama,
        type: t.jenis_tanaman,
        status: t.status,
        moisture,
        moistureMin: t.threshold_min,
        moistureMax: t.threshold_max,
        autoWater: t.auto_water_mode,
      });
    }

    // ── 2. Hitung garden report ────────────────────────────────────
    const report = computeGardenReport(plants);

    // ── 3. Siapkan system prompt + tools ──────────────────────────
    const plantsContext = plants.length
      ? plants.map((p) =>
          `- ${p.name} (${p.type || 'Umum'}): kelembaban ${p.moisture !== null ? p.moisture + '%' : 'tidak ada data'}, ` +
          `rentang optimal ${p.moistureMin}-${p.moistureMax}%, status ${p.status}, ` +
          `auto-siram ${p.autoWater ? 'aktif' : 'nonaktif'}`
        ).join('\n')
      : '(Belum ada tanaman terdaftar)';

    const systemPrompt = `Kamu adalah Taku, asisten AI di aplikasi Tanamanku.

Kamu BUKAN chatbot biasa — kamu punya akses untuk menjalankan aksi nyata di aplikasi lewat tools.
Kepribadianmu: santai, seru, gak formal, kayak asisten pribadi yang asik diajak ngobrol, TAPI tetap jelas dan informatif kalau lagi laporan data.

Aturan:
- Kalau user minta aksi (siram, pindah halaman, dll), PANGGIL tool yang sesuai, jangan cuma jawab teks.
- Kalau user cuma nanya/ngobrol, pakai tool "answer_only".
- Kalau diminta laporan kebun, panggil "get_garden_report" DAN "navigate_to_page" (ke "kebun-saya") sekaligus.
- Selalu jawab dalam Bahasa Indonesia yang natural, bukan kaku/formal.
- Nama user: ${firstName}
- Halaman yang sedang dibuka user: ${currentPage || 'tidak diketahui'}

Data kebun ${firstName}:
${plantsContext}

Ringkasan kebun:
- Total tanaman: ${report.total}
- Skor kesehatan: ${report.healthScore}/100
- Rata-rata kelembaban: ${report.avgMoisture !== null ? report.avgMoisture + '%' : 'tidak ada data'}
- Kondisi baik: ${report.goodCount} tanaman
- Butuh perhatian: ${report.warningCount} tanaman
- Tanaman paling kering: ${report.driestPlant ? report.driestPlant.name + ' (' + report.driestPlant.moisture + '%)' : 'tidak ada data'}`;

    const tools = [
      {
        type: 'function',
        function: {
          name: 'navigate_to_page',
          description: 'Pindah ke halaman tertentu di aplikasi',
          parameters: {
            type: 'object',
            properties: {
              page: {
                type: 'string',
                enum: ['dashboard', 'kebun-saya', 'riwayat', 'kelola-tanaman', 'profil', 'taku-chat'],
                description: 'Nama halaman tujuan'
              }
            },
            required: ['page']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'water_plant',
          description: 'Menyiram satu tanaman spesifik atau semua tanaman sekaligus',
          parameters: {
            type: 'object',
            properties: {
              target: {
                type: 'string',
                description: 'Nama tanaman yang ingin disiram, atau "semua" untuk menyiram semua tanaman'
              }
            },
            required: ['target']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'toggle_auto_water',
          description: 'Aktifkan atau nonaktifkan mode siram otomatis untuk tanaman tertentu',
          parameters: {
            type: 'object',
            properties: {
              plantName: { type: 'string', description: 'Nama tanaman' },
              enabled: { type: 'boolean', description: 'true untuk aktifkan, false untuk nonaktifkan' }
            },
            required: ['plantName', 'enabled']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'get_garden_report',
          description: 'Ambil dan bacakan ringkasan lengkap kondisi kebun user',
          parameters: { type: 'object', properties: {} }
        }
      },
      {
        type: 'function',
        function: {
          name: 'answer_only',
          description: 'Dipakai kalau user cuma nanya atau ngobrol biasa, tidak perlu aksi apapun',
          parameters: {
            type: 'object',
            properties: {
              text: { type: 'string', description: 'Teks jawaban untuk disampaikan ke user' }
            },
            required: ['text']
          }
        }
      }
    ];

    // ── 4. Panggil Pateway AI dengan function calling ──────────────
    const apiKey  = process.env.PATEWAY_API_KEY || 'sk-ptw-132WnNefggLa04seTxATdSeHJYX7gpl8Dthou';
    const baseUrl = process.env.PATEWAY_BASE_URL || 'https://api.pateway.ai/v1';
    const model   = process.env.PATEWAY_MODEL || 'gpt-5.6-terra';

    let toolCalls = [];
    let spokenReply = '';

    try {
      const aiRes = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: message.trim() },
          ],
          tools,
          tool_choice: 'auto',
          max_tokens: 1024,
        }),
      });

      if (!aiRes.ok) {
        const errBody = await aiRes.text();
        throw new Error(`AI API error ${aiRes.status}: ${errBody}`);
      }

      const aiData = await aiRes.json();
      const choice = aiData.choices?.[0];

      if (choice?.message?.tool_calls?.length) {
        // AI memutuskan untuk memanggil satu atau lebih tools
        toolCalls = choice.message.tool_calls.map((tc) => ({
          name: tc.function.name,
          parameters: (() => {
            try { return JSON.parse(tc.function.arguments); } catch { return {}; }
          })(),
        }));

        // Minta AI generate spoken reply berdasarkan tool yang dipanggil + data laporan
        // (simple second call, atau bisa pakai teks dari answer_only jika ada)
        const answerOnlyCall = toolCalls.find((tc) => tc.name === 'answer_only');
        if (answerOnlyCall) {
          spokenReply = answerOnlyCall.parameters.text || '';
          // Filter keluar dari toolCalls karena bukan aksi nyata
          toolCalls = toolCalls.filter((tc) => tc.name !== 'answer_only');
        } else {
          // Untuk aksi lain, minta AI buat kalimat konfirmasi natural
          const confirmRes = await fetch(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${apiKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              model,
              messages: [
                { role: 'system', content: 'Kamu adalah Taku, asisten AI Tanamanku yang santai dan ramah. Buat satu kalimat konfirmasi singkat dalam Bahasa Indonesia yang natural untuk tindakan berikut. Maksimal 2 kalimat.' },
                { role: 'user', content: `Tindakan yang akan dilakukan: ${toolCalls.map(tc => tc.name + ' ' + JSON.stringify(tc.parameters)).join(', ')}. Pesan user: "${message}"` },
              ],
              max_tokens: 150,
            }),
          });
          if (confirmRes.ok) {
            const confirmData = await confirmRes.json();
            spokenReply = confirmData.choices?.[0]?.message?.content || 'Oke, segera dikerjakan!';
          } else {
            spokenReply = 'Oke, segera dikerjakan!';
          }
        }
      } else {
        // AI tidak panggil tool — ambil teks biasa
        spokenReply = choice?.message?.content || 'Maaf, saya tidak mengerti. Coba ulangi perintahmu.';
      }
    } catch (aiErr) {
      console.error('[takuCommand] AI error:', aiErr);
      // Fallback: jawab tanpa AI
      spokenReply = `Maaf ${firstName}, saya sedang tidak bisa terhubung ke AI. Coba lagi sebentar.`;
      toolCalls = [];
    }

    // Simpan percakapan ke chat_messages (opsional, untuk riwayat di TakuChatPage)
    try {
      await supabase.from('chat_messages').insert([
        { user_id: userId, role: 'user',      content: message.trim(), tanaman_id: null },
        { user_id: userId, role: 'assistant', content: spokenReply,    tanaman_id: null },
      ]);
    } catch (dbErr) {
      console.warn('[takuCommand] Gagal simpan chat history:', dbErr.message);
    }

    return res.json({
      success: true,
      toolCalls,       // Array: [{ name, parameters }]
      spokenReply,     // String yang akan di-TTS oleh frontend
      plants,          // Kirim juga data tanaman (dipakai frontend untuk water_plant)
      report,          // Kirim garden report
    });
  } catch (err) {
    console.error('[takuCommand] Error:', err);
    next(err);
  }
}

module.exports = { analyzePhoto, addPhoto, getPlantPhotos, chatWithTaku, getChatHistory, takuCommand };
