-- ============================================================
-- Migration 002: Role enum rename + approval_status column
-- Jalankan di: Supabase Dashboard → SQL Editor → New Query → Run
-- ============================================================

-- 1. Tambah nilai baru ke enum (Postgres tidak bisa rename nilai langsung)
--    Urutan: tambah nilai baru, update data, hapus nilai lama (via alter workaround).
--    Karena Postgres tidak mendukung DROP ENUM VALUE, kita buat ulang enum-nya.

-- a. Buat enum baru dengan nama sementara
DO $$ BEGIN
  CREATE TYPE user_role_new AS ENUM ('user', 'worker', 'admin');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- b. Update kolom ke tipe baru dengan mapping eksplisit
ALTER TABLE users
  ALTER COLUMN role TYPE user_role_new
  USING (
    CASE role::text
      WHEN 'owner'  THEN 'user'::user_role_new
      WHEN 'viewer' THEN 'worker'::user_role_new
      WHEN 'admin'  THEN 'admin'::user_role_new
      ELSE 'user'::user_role_new
    END
  );

-- c. Hapus enum lama dan rename enum baru
DROP TYPE IF EXISTS user_role;
ALTER TYPE user_role_new RENAME TO user_role;

-- d. Set ulang default
ALTER TABLE users ALTER COLUMN role SET DEFAULT 'user';

-- 2. Tambah kolom approval_status ke tabel users
DO $$ BEGIN
  CREATE TYPE approval_status_enum AS ENUM ('pending', 'approved', 'rejected');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS approval_status approval_status_enum NOT NULL DEFAULT 'approved';

-- Catatan: DEFAULT 'approved' agar user yang sudah ada tetap bisa login.
-- User baru yang didaftarkan lewat register akan di-set 'pending' oleh backend.

-- 3. Index untuk query admin yang filter by approval_status
CREATE INDEX IF NOT EXISTS idx_users_approval ON users(approval_status);
