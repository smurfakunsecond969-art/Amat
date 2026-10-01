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
/**
 * Validasi status dari JSON AI — fallback ke 'sehat' kalau tidak valid
 */
function validateStatus(status) {
  const valid = ['sehat', 'perlu_perhatian', 'terindikasi_penyakit'];
  return valid.includes(status) ? status : 'sehat';
}

/**
 * Daftar kategori penyakit valid
 */
const DISEASE_CATEGORIES = [
  'Kekurangan Air',
  'Kelebihan Air / Akar Busuk',
  'Serangan Jamur',
  'Serangan Hama/Serangga',
  'Kekurangan Nutrisi',
  'Penyakit Daun Lainnya',
  'Tidak Teridentifikasi',
];

/**
 * Parse JSON response dari AI Vision — defensif terhadap teks non-JSON atau parsial
 * Return: { healthScore, status, disease_category, diagnosis, saran }
 */
function parseAIAnalysis(rawText) {
  try {
    // Coba ekstrak JSON dari teks (kadang AI balas dengan markdown code block)
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      const healthScore = Number(parsed.healthScore);
      return {
        healthScore: (healthScore >= 1 && healthScore <= 100) ? healthScore : 65,
        status: validateStatus(parsed.status),
        disease_category: DISEASE_CATEGORIES.includes(parsed.disease_category)
          ? parsed.disease_category
          : 'Tidak Teridentifikasi',
        diagnosis: parsed.diagnosis || '',
        saran: parsed.saran || '',
        // Buat hasil_analisis teks gabungan untuk kompatibilitas field lama
        hasil: `${parsed.diagnosis || ''}\n\n💡 Saran: ${parsed.saran || ''}`.trim(),
      };
    }
  } catch (e) {
    // JSON parse gagal — fallback ke teks lama
  }
  // Fallback: teks bebas (backward compat)
  return {
    healthScore: 65,
    status: 'sehat',
    disease_category: 'Tidak Teridentifikasi',
    diagnosis: rawText,
    saran: '',
    hasil: rawText,
  };
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
      .select('id, nama, jenis_tanaman, varietas, fase_pertumbuhan, media_tanam, lokasi_blok, catatan, threshold_min, threshold_max, user_id')
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

    // Ambil data sensor terkini jika ada
    let sensorMoistureInfo = 'Sensor belum terhubung';
    const { data: device } = await supabase
      .from('device')
      .select('id')
      .eq('tanaman_id', plantId)
      .maybeSingle();

    if (device) {
      const { data: latestReading } = await supabase
        .from('sensor_readings')
        .select('kelembaban_tanah')
        .eq('device_id', device.id)
        .order('recorded_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (latestReading && latestReading.kelembaban_tanah !== null) {
        sensorMoistureInfo = `${latestReading.kelembaban_tanah}% (Ambang batas ideal: ${plant.threshold_min || 50}%-${plant.threshold_max || 80}%)`;
      }
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

    const plantContextDetails = [
      `Nama Tanaman: ${plant.nama}`,
      `Jenis Komoditas: ${plant.jenis_tanaman || 'Umum'}`,
      plant.varietas ? `Varietas/Kultivar: ${plant.varietas}` : null,
      plant.fase_pertumbuhan ? `Fase Pertumbuhan: ${plant.fase_pertumbuhan}` : null,
      plant.media_tanam ? `Media Tanam/Tipe Tanah: ${plant.media_tanam}` : null,
      plant.lokasi_blok ? `Lokasi Kebun/Blok: ${plant.lokasi_blok}` : null,
      plant.catatan ? `Catatan/Riwayat Perlakuan: ${plant.catatan}` : null,
      `Kelembaban Sensor Tanah Saat Ini: ${sensorMoistureInfo}`,
    ].filter(Boolean).join('\n- ');

    const aiMessages = [{
      role: 'user',
      content: [
        {
          type: 'text',
          text: `Kamu adalah Agronomist & Pakar Patologi Tanaman AI. Analisa foto daun/tanaman ini secara komprehensif dan akurat berdasarkan data agronomis berikut:
- ${plantContextDetails}

Instruksi Analisis:
1. Sesuaikan diagnosa penyakit dengan varietas dan fase pertumbuhan spesifik di atas (misal: gejala pada fase vegetatif vs pembuahan, atau kerentanan khusus varietas).
2. Perhitungkan juga data kelembaban tanah sensor dan media tanam untuk memastikan apakah masalah berasal dari air/akar atau patogen/hama.
3. Berikan saran penanganan dan dosis/tindakan praktis yang realistis dan tepat sasaran.

Balas HANYA dengan format JSON valid berikut (tanpa markdown backticks atau teks tambahan lainnya):
{
  "healthScore": <angka 1-100, 100 = paling sehat dan bebas penyakit>,
  "status": "sehat" atau "perlu_perhatian" atau "terindikasi_penyakit",
  "disease_category": salah satu dari: "Kekurangan Air", "Kelebihan Air / Akar Busuk", "Serangan Jamur", "Serangan Hama/Serangga", "Kekurangan Nutrisi", "Penyakit Daun Lainnya", "Tidak Teridentifikasi",
  "diagnosis": "<penjelasan diagnosa klinis daun/tanaman max 2 kalimat dalam Bahasa Indonesia>",
  "saran": "<saran penanganan terarah dan solusi agronomis praktis max 2 kalimat dalam Bahasa Indonesia>"
}`,
        },
        {
          type: 'image_url',
          image_url: { url: base64DataUrl },
        },
      ],
    }];

    let analysisResult = {
      healthScore: 65,
      status: 'sehat',
      disease_category: 'Tidak Teridentifikasi',
      diagnosis: '',
      saran: '',
      hasil: `Tanaman ${plant.nama} telah difoto dan didokumentasikan. Kondisi visual umum tercatat. Rekomendasi: jaga kelembaban tanah dan pantau perkembangan daun secara berkala.`,
    };

    try {
      const rawReply = await callAI(aiMessages);
      analysisResult = parseAIAnalysis(rawReply);
    } catch (aiErr) {
      console.error('AI Vision call error:', aiErr);
    }

    // 4. Simpan hasil analisis ke database (dengan kolom baru health_score, disease_category, saran)
    const { data: analysisRecord, error: analysisErr } = await supabase
      .from('disease_analyses')
      .insert({
        tanaman_id:       plantId,
        photo_id:         photoRecord.id,
        hasil_analisis:   analysisResult.hasil,
        status:           analysisResult.status,
        health_score:     analysisResult.healthScore,
        disease_category: analysisResult.disease_category,
        saran:            analysisResult.saran,
      })
      .select()
      .single();

    if (analysisErr) {
      console.error('Gagal simpan analisis ke disease_analyses:', analysisErr);
    }

    return res.json({
      success:         true,
      photo:           photoRecord,
      analysis:        analysisRecord || null,
      hasil:           analysisResult.hasil,
      status:          analysisResult.status,
      healthScore:     analysisResult.healthScore,
      diseaseCategory: analysisResult.disease_category,
      saran:           analysisResult.saran,
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

    // ── 1. Ambil tanaman user (paralel) ──────────────────────────
    const { data: tanamanRaw, error: tanamanErr } = await supabase
      .from('tanaman')
      .select('id, nama, jenis_tanaman, status, threshold_min, threshold_max, auto_water_mode')
      .eq('user_id', userId);

    if (tanamanErr) {
      console.error('[takuCommand] Gagal ambil tanaman:', tanamanErr);
    }

    // Ambil moisture terbaru per tanaman via device + sensor_readings (Promise.all paralel)
    const plants = await Promise.all((tanamanRaw || []).map(async (t) => {
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
        if (reading) moisture = Number(reading.kelembaban_tanah);
      }

      return {
        id: t.id,
        name: t.nama,
        type: t.jenis_tanaman,
        status: t.status,
        moisture,
        moistureMin: Number(t.threshold_min) || 40,
        moistureMax: Number(t.threshold_max) || 80,
        autoWater: Boolean(t.auto_water_mode),
      };
    }));

    // ── 2. Hitung garden report ────────────────────────────────────
    const report = computeGardenReport(plants);

    // ── FAST-PATH: Instant intent matching untuk perintah populer (< 20ms) ──
    const lowerMsg = message.toLowerCase().trim();

    // A. Laporan Kebun
    if (
      lowerMsg.includes('laporan') ||
      lowerMsg.includes('kondisi kebun') ||
      lowerMsg.includes('status kebun') ||
      lowerMsg.includes('kondisi tanaman') ||
      lowerMsg.includes('status tanaman') ||
      lowerMsg.includes('bagaimana kebun')
    ) {
      let repReply = '';
      if (report.warningCount > 0 && report.driestPlant) {
        repReply = `Oke, laporan kebunmu siap! Dari ${report.total} tanaman, skor kesehatan kebun ada di ${report.healthScore}. ${report.goodCount} tanaman kondisinya oke, tapi ${report.warningCount} butuh perhatian — terutama ${report.driestPlant.name}, kelembabannya udah di ${report.driestPlant.moisture} persen. Mau langsung gw siram sekarang?`;
      } else {
        repReply = `Laporan kebunmu keren banget hari ini! Semua ${report.total} tanaman dalam kondisi baik, skor kesehatan kebun ada di ${report.healthScore}. Gak ada yang butuh perhatian khusus sekarang 🌱`;
      }
      return res.json({
        success: true,
        toolCalls: [
          { name: 'get_garden_report', parameters: {} },
          { name: 'navigate_to_page', parameters: { page: 'kebun-saya' } },
        ],
        spokenReply: repReply,
        plants,
        report,
      });
    }

    // B. Siram Tanaman
    if (lowerMsg.includes('siram') || lowerMsg.includes('siramin') || lowerMsg.includes('watering')) {
      let targetPlantName = 'semua';
      if (!lowerMsg.includes('semua')) {
        const found = plants.find((p) =>
          lowerMsg.includes(p.name.toLowerCase()) ||
          (p.type && lowerMsg.includes(p.type.toLowerCase())) ||
          p.name.toLowerCase().split(' ').some((w) => w.length > 2 && lowerMsg.includes(w))
        );
        if (found) targetPlantName = found.name;
      }

      const spokenReply = targetPlantName === 'semua'
        ? `Oke, ${plants.length} tanaman udah gw siram semua barusan!`
        : `Sip, ${targetPlantName} udah gw siram sekarang!`;

      return res.json({
        success: true,
        toolCalls: [{ name: 'water_plant', parameters: { target: targetPlantName } }],
        spokenReply,
        plants,
        report,
      });
    }

    // C. Navigasi Halaman
    if (lowerMsg.includes('dashboard') || lowerMsg.includes('beranda')) {
      return res.json({
        success: true,
        toolCalls: [{ name: 'navigate_to_page', parameters: { page: 'dashboard' } }],
        spokenReply: 'Siap, membuka halaman Dashboard.',
        plants,
        report,
      });
    }
    if (lowerMsg.includes('kebun') || lowerMsg.includes('tanaman saya')) {
      return res.json({
        success: true,
        toolCalls: [{ name: 'navigate_to_page', parameters: { page: 'kebun-saya' } }],
        spokenReply: 'Siap, membuka halaman Kebun Saya.',
        plants,
        report,
      });
    }
    if (lowerMsg.includes('riwayat') || lowerMsg.includes('history')) {
      return res.json({
        success: true,
        toolCalls: [{ name: 'navigate_to_page', parameters: { page: 'riwayat' } }],
        spokenReply: 'Siap, membuka halaman Riwayat.',
        plants,
        report,
      });
    }
    if (lowerMsg.includes('kelola') || lowerMsg.includes('manajemen tanaman')) {
      return res.json({
        success: true,
        toolCalls: [{ name: 'navigate_to_page', parameters: { page: 'kelola-tanaman' } }],
        spokenReply: 'Siap, membuka Manajemen Tanaman.',
        plants,
        report,
      });
    }
    if (lowerMsg.includes('profil') || lowerMsg.includes('pengaturan')) {
      return res.json({
        success: true,
        toolCalls: [{ name: 'navigate_to_page', parameters: { page: 'profil' } }],
        spokenReply: 'Siap, membuka Profil dan Pengaturan.',
        plants,
        report,
      });
    }

    // D. Ganti Tema Tampilan (Dark Mode / Light Mode)
    if (lowerMsg.includes('dark mode') || lowerMsg.includes('mode gelap') || lowerMsg.includes('tema malam') || lowerMsg.includes('mode malam')) {
      return res.json({
        success: true,
        toolCalls: [{ name: 'toggle_theme', parameters: { theme: 'dark' } }],
        spokenReply: 'Siap, beralih ke Mode Gelap Kebun Malam.',
        plants,
        report,
      });
    }
    if (lowerMsg.includes('light mode') || lowerMsg.includes('mode terang') || lowerMsg.includes('tema siang') || lowerMsg.includes('mode siang')) {
      return res.json({
        success: true,
        toolCalls: [{ name: 'toggle_theme', parameters: { theme: 'light' } }],
        spokenReply: 'Siap, beralih ke Mode Terang.',
        plants,
        report,
      });
    }
    if (lowerMsg.includes('ganti tema') || lowerMsg.includes('ubah tema') || lowerMsg.includes('toggle mode')) {
      return res.json({
        success: true,
        toolCalls: [{ name: 'toggle_theme', parameters: {} }],
        spokenReply: 'Siap, tema tampilan sudah diganti.',
        plants,
        report,
      });
    }

    // ── 3. Fallback ke Pateway AI untuk pertanyaan bebas / conversational ──
    const plantsContext = plants.length
      ? plants.map((p) =>
          `- ${p.name} (${p.type || 'Umum'}): kelembaban ${p.moisture !== null ? p.moisture + '%' : 'tidak ada data'}, ` +
          `rentang optimal ${p.moistureMin}-${p.moistureMax}%, status ${p.status}, ` +
          `auto-siram ${p.autoWater ? 'aktif' : 'nonaktif'}`
        ).join('\n')
      : '(Belum ada tanaman terdaftar)';

    const systemPrompt = `Kamu adalah Taku, asisten AI ramah di aplikasi Tanamanku.
Jawab singkat (maksimal 2-3 kalimat) dalam Bahasa Indonesia santai.
Nama user: ${firstName}
Kebun ${firstName}: ${plants.length} tanaman, skor ${report.healthScore}/100.
${plantsContext}`;

    const apiKey  = process.env.PATEWAY_API_KEY || 'sk-ptw-132WnNefggLa04seTxATdSeHJYX7gpl8Dthou';
    const baseUrl = process.env.PATEWAY_BASE_URL || 'https://api.pateway.ai/v1';
    const model   = process.env.PATEWAY_MODEL || 'gpt-5.6-terra';

    let spokenReply = '';
    let toolCalls = [];

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 4500); // 4.5s max timeout

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
          max_tokens: 150,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (aiRes.ok) {
        const aiData = await aiRes.json();
        spokenReply = aiData.choices?.[0]?.message?.content?.trim() || '';
      }
    } catch (aiErr) {
      console.warn('[takuCommand] AI timeout or error:', aiErr.message);
    }

    if (!spokenReply) {
      spokenReply = `Siap ${firstName}! Ada yang bisa saya bantu untuk kebunmu? Kamu bisa minta laporan kebun, siram tanaman, atau cek kondisi sensor.`;
    }

    // Simpan ke riwayat chat
    try {
      await supabase.from('chat_messages').insert([
        { user_id: userId, role: 'user',      content: message.trim(), tanaman_id: null },
        { user_id: userId, role: 'assistant', content: spokenReply,    tanaman_id: null },
      ]);
    } catch (dbErr) {
      console.warn('[takuCommand] DB log info:', dbErr.message);
    }

    return res.json({
      success: true,
      toolCalls,
      spokenReply,
      plants,
      report,
    });
  } catch (err) {
    console.error('[takuCommand] Error:', err);
    next(err);
  }
}

module.exports = { analyzePhoto, addPhoto, getPlantPhotos, chatWithTaku, getChatHistory, takuCommand };
