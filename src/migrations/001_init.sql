-- ============================================================
-- Tanamanku Database Schema
-- Jalankan di: Supabase Dashboard → SQL Editor → New Query → Run
-- ============================================================

-- Extension UUID (sudah ada di Supabase by default, tapi just in case)
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ── Enum Types ───────────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE user_role AS ENUM ('user', 'worker', 'admin');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE approval_status_enum AS ENUM ('pending', 'approved', 'rejected');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE device_status AS ENUM ('aktif', 'perlu_dicek');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE trigger_type AS ENUM ('auto', 'manual');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE irrigation_status AS ENUM ('berjalan', 'selesai', 'gagal');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE command_type AS ENUM ('siram_mulai', 'siram_stop');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE command_status AS ENUM ('pending', 'terkirim', 'dieksekusi', 'gagal');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE tanaman_record_status AS ENUM ('aktif', 'nonaktif');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── Tabel: users ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS users (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  nama            VARCHAR(100) NOT NULL,
  email           VARCHAR(255) UNIQUE NOT NULL,
  password_hash   VARCHAR      NOT NULL,
  telepon         VARCHAR(20),
  role            user_role    NOT NULL DEFAULT 'user',
  approval_status approval_status_enum NOT NULL DEFAULT 'pending',
  notif_watering  BOOLEAN DEFAULT true,
  notif_device    BOOLEAN DEFAULT true,
  notif_report    BOOLEAN DEFAULT false,
  created_at      TIMESTAMP    DEFAULT NOW()
);

-- ── Tabel: lahan ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS lahan (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        REFERENCES users(id) ON DELETE CASCADE,
  nama_lahan  VARCHAR(100) NOT NULL,
  lokasi      VARCHAR(255),
  luas        DECIMAL(10, 2),
  created_at  TIMESTAMP   DEFAULT NOW()
);

-- ── Tabel: tanaman ───────────────────────────────────────────
-- user_id ditambahkan langsung (selain via lahan) agar query per-user lebih simpel

CREATE TABLE IF NOT EXISTS tanaman (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  lahan_id        UUID         REFERENCES lahan(id) ON DELETE SET NULL,
  nama            VARCHAR(100) NOT NULL,
  jenis_tanaman   VARCHAR(100) NOT NULL,
  emoji           VARCHAR(10)  DEFAULT '🌱',
  tanggal_tanam   DATE         DEFAULT CURRENT_DATE,
  threshold_min   DECIMAL(5,2) DEFAULT 50,
  threshold_max   DECIMAL(5,2) DEFAULT 80,
  auto_water_mode BOOLEAN      DEFAULT false,
  status          tanaman_record_status DEFAULT 'aktif',
  created_at      TIMESTAMP    DEFAULT NOW()
);

-- ── Tabel: device ────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS device (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tanaman_id      UUID        REFERENCES tanaman(id) ON DELETE CASCADE,
  device_code     VARCHAR(50) UNIQUE NOT NULL,
  tipe_device     VARCHAR(100) DEFAULT 'ESP32',
  last_seen_at    TIMESTAMP,
  status_koneksi  device_status DEFAULT 'perlu_dicek',
  battery_level   INT,         -- opsional, untuk versi masa depan dengan baterai
  created_at      TIMESTAMP   DEFAULT NOW()
);

-- ── Tabel: sensor_readings ───────────────────────────────────

CREATE TABLE IF NOT EXISTS sensor_readings (
  id               BIGSERIAL   PRIMARY KEY,
  device_id        UUID        NOT NULL REFERENCES device(id) ON DELETE CASCADE,
  kelembaban_tanah DECIMAL(5,2) NOT NULL,
  recorded_at      TIMESTAMP   DEFAULT NOW()
);

-- ── Tabel: irrigation_logs ───────────────────────────────────

CREATE TABLE IF NOT EXISTS irrigation_logs (
  id                    UUID             PRIMARY KEY DEFAULT gen_random_uuid(),
  tanaman_id            UUID             NOT NULL REFERENCES tanaman(id) ON DELETE CASCADE,
  device_id             UUID             REFERENCES device(id) ON DELETE SET NULL,
  trigger_type          trigger_type     NOT NULL,
  waktu_mulai           TIMESTAMP        DEFAULT NOW(),
  waktu_selesai         TIMESTAMP,
  kelembaban_awal       DECIMAL(5,2),
  kelembaban_akhir      DECIMAL(5,2),
  durasi_detik          INT              DEFAULT 0,
  status                irrigation_status DEFAULT 'berjalan',
  dipicu_oleh_user_id   UUID             REFERENCES users(id) ON DELETE SET NULL
);

-- ── Tabel: device_commands ───────────────────────────────────

CREATE TABLE IF NOT EXISTS device_commands (
  id                UUID           PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id         UUID           NOT NULL REFERENCES device(id) ON DELETE CASCADE,
  command           command_type   NOT NULL,
  target_kelembaban DECIMAL(5,2),
  status            command_status DEFAULT 'pending',
  created_at        TIMESTAMP      DEFAULT NOW(),
  executed_at       TIMESTAMP
);

-- ── Indexes untuk performa ───────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_sensor_device_time   ON sensor_readings(device_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_users_approval       ON users(approval_status);
CREATE INDEX IF NOT EXISTS idx_tanaman_user         ON tanaman(user_id);
CREATE INDEX IF NOT EXISTS idx_tanaman_status       ON tanaman(user_id, status);
CREATE INDEX IF NOT EXISTS idx_device_tanaman       ON device(tanaman_id);
CREATE INDEX IF NOT EXISTS idx_device_code          ON device(device_code);
CREATE INDEX IF NOT EXISTS idx_irrigation_tanaman   ON irrigation_logs(tanaman_id, waktu_mulai DESC);
CREATE INDEX IF NOT EXISTS idx_commands_pending     ON device_commands(device_id, status) WHERE status = 'pending';
