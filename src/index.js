require('dotenv').config();
const express = require('express');
const cors = require('cors');

const authRoutes    = require('./routes/auth');
const plantsRoutes  = require('./routes/plants');
const historyRoutes = require('./routes/history');
const profileRoutes = require('./routes/profile');
const deviceRoutes  = require('./routes/device');
const adminRoutes   = require('./routes/admin');
const usersRoutes   = require('./routes/users');
const aiRoutes      = require('./routes/ai');
const errorHandler  = require('./middleware/errorHandler');

const path = require('path');
const fs = require('fs');

const app  = express();
const PORT = process.env.PORT || 3001;

// ── Ensure uploads directory exists ──
const uploadsDir = path.join(__dirname, '../uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// ── Middleware ────────────────────────────────────────────
app.use(cors({
  origin: [
    'http://localhost:5173',  // Vite dev server
    'http://localhost:3000',
    'http://127.0.0.1:5173',
  ],
  credentials: true,
}));
app.use(express.json());
app.use('/uploads', express.static(uploadsDir));

// ── Health check ──────────────────────────────────────────
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', service: 'Tanamanku API', timestamp: new Date().toISOString() });
});

// ── Routes ────────────────────────────────────────────────
app.use('/api/auth',    authRoutes);
app.use('/api/plants',  plantsRoutes);
app.use('/api/plants',  aiRoutes);      // foto analisis: /api/plants/:id/photos/*
app.use('/api/history', historyRoutes); // riwayat penyiraman & foto: /api/history, /api/history/photos
app.use('/api/device',  deviceRoutes);  // device telemetry: /api/device/*
app.use('/api/profile', profileRoutes);
app.use('/api/admin',   adminRoutes);
app.use('/api/users',   usersRoutes);
app.use('/api/ai',      aiRoutes);      // chat Taku & analytics: /api/ai/*


// ── 404 catch ─────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: 'Endpoint tidak ditemukan' });
});

// ── Global error handler ──────────────────────────────────
app.use(errorHandler);

app.listen(PORT, () => {
  console.log(`🌱 Tanamanku API berjalan di http://localhost:${PORT}`);
  console.log(`   Supabase: ${process.env.SUPABASE_URL}`);
});
