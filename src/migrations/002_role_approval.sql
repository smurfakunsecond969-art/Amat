-- ============================================================
-- Migration 002: Role Baru & Alur Persetujuan Akun
-- Jalankan di: Supabase Dashboard → SQL Editor → New Query → Run
--
-- PENTING: Jalankan SEMUA sekaligus (select all → Run)
-- ============================================================

-- ── 1. Ubah kolom role dari ENUM ke VARCHAR dulu ─────────────
--    Ini perlu karena PostgreSQL enum tidak bisa langsung diisi
--    nilai yang belum ada di enum lama.
ALTER TABLE users
  ALTER COLUMN role TYPE VARCHAR(20)
  USING role::TEXT;

-- ── 2. Hapus constraint / enum lama ──────────────────────────
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
DROP TYPE IF EXISTS user_role CASCADE;

-- ── 3. Update nilai role lama → role baru ────────────────────
UPDATE users SET role = 'user'  WHERE role IN ('viewer', 'owner');
-- 'admin' tetap 'admin', tidak perlu diubah

-- ── 4. Set default baru dan tambah constraint check ──────────
ALTER TABLE users ALTER COLUMN role SET DEFAULT 'user';
ALTER TABLE users
  ADD CONSTRAINT users_role_check
  CHECK (role IN ('user', 'worker', 'admin'));

-- ── 5. Kolom approval_status ─────────────────────────────────
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS approval_status VARCHAR(20)
  NOT NULL DEFAULT 'pending';

ALTER TABLE users
  ADD CONSTRAINT users_approval_status_check
  CHECK (approval_status IN ('pending', 'approved', 'rejected'));

-- Semua akun yang sudah ada sebelum fitur ini → langsung approved
UPDATE users SET approval_status = 'approved' WHERE approval_status = 'pending';

-- ── 6. Kolom tracking siapa yang approve ─────────────────────
ALTER TABLE users ADD COLUMN IF NOT EXISTS approved_by UUID REFERENCES users(id);
ALTER TABLE users ADD COLUMN IF NOT EXISTS approved_at TIMESTAMP;

-- ── 7. Kolom tanaman: siapa worker yang buat ─────────────────
ALTER TABLE tanaman
  ADD COLUMN IF NOT EXISTS created_by_worker_id UUID REFERENCES users(id);

-- ── 8. Index baru ─────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_users_approval ON users(approval_status);
CREATE INDEX IF NOT EXISTS idx_users_role     ON users(role);
