-- ============================================================
-- Migration 003: AI Features — plant_photos, disease_analyses, chat_messages
-- Jalankan di: Supabase Dashboard → SQL Editor → New Query → Run
-- ============================================================

-- ── Tabel: plant_photos ──────────────────────────────────────
-- Menyimpan semua foto tanaman:
-- is_analysis_photo = true  → foto yang dikirim ke AI buat analisis
-- is_analysis_photo = false → foto dokumentasi biasa dari user/worker

CREATE TABLE IF NOT EXISTS plant_photos (
  id                   UUID      PRIMARY KEY DEFAULT gen_random_uuid(),
  tanaman_id           UUID      NOT NULL REFERENCES tanaman(id) ON DELETE CASCADE,
  photo_url            TEXT      NOT NULL,
  uploaded_by_user_id  UUID      REFERENCES users(id) ON DELETE SET NULL,
  is_analysis_photo    BOOLEAN   DEFAULT true,
  catatan              TEXT,
  created_at           TIMESTAMP DEFAULT NOW()
);

-- ── Tabel: disease_analyses ──────────────────────────────────
-- Hasil analisis AI per foto tanaman

DO $$ BEGIN
  CREATE TYPE analysis_status_enum AS ENUM ('sehat', 'perlu_perhatian', 'terindikasi_penyakit');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS disease_analyses (
  id              UUID                  PRIMARY KEY DEFAULT gen_random_uuid(),
  tanaman_id      UUID                  NOT NULL REFERENCES tanaman(id) ON DELETE CASCADE,
  photo_id        UUID                  NOT NULL REFERENCES plant_photos(id) ON DELETE CASCADE,
  hasil_analisis  TEXT                  NOT NULL,
  status          analysis_status_enum,
  analyzed_at     TIMESTAMP             DEFAULT NOW()
);

-- ── Tabel: chat_messages ─────────────────────────────────────
-- Riwayat percakapan dengan Taku AI

CREATE TABLE IF NOT EXISTS chat_messages (
  id          UUID      PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tanaman_id  UUID      REFERENCES tanaman(id) ON DELETE SET NULL,
  role        VARCHAR(10) NOT NULL CHECK (role IN ('user', 'assistant')),
  content     TEXT      NOT NULL,
  created_at  TIMESTAMP DEFAULT NOW()
);

-- ── Indexes ──────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_plant_photos_tanaman     ON plant_photos(tanaman_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_disease_analyses_photo   ON disease_analyses(photo_id);
CREATE INDEX IF NOT EXISTS idx_disease_analyses_tanaman ON disease_analyses(tanaman_id, analyzed_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_messages_user       ON chat_messages(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_messages_tanaman    ON chat_messages(tanaman_id, created_at DESC);
