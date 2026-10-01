-- ============================================================
-- Migration 004: Plant Metadata & Variety for Precision AI Diagnosis
-- Jalankan di: Supabase Dashboard → SQL Editor → New Query → Run
-- ============================================================

ALTER TABLE tanaman ADD COLUMN IF NOT EXISTS varietas VARCHAR(100);
ALTER TABLE tanaman ADD COLUMN IF NOT EXISTS fase_pertumbuhan VARCHAR(100);
ALTER TABLE tanaman ADD COLUMN IF NOT EXISTS media_tanam VARCHAR(100);
ALTER TABLE tanaman ADD COLUMN IF NOT EXISTS lokasi_blok VARCHAR(150);
ALTER TABLE tanaman ADD COLUMN IF NOT EXISTS catatan TEXT;

COMMENT ON COLUMN tanaman.varietas IS 'Varietas atau kultivar tanaman (cth: Musang King, Bawor, Merah Keriting)';
COMMENT ON COLUMN tanaman.fase_pertumbuhan IS 'Fase pertumbuhan tanaman saat ini (cth: Semai, Vegetatif, Pembungaan, Pembuahan, Panen)';
COMMENT ON COLUMN tanaman.media_tanam IS 'Media tanam & tipe tanah (cth: Tanah Lempung Berpasir, Humus Organik, Polybag)';
COMMENT ON COLUMN tanaman.lokasi_blok IS 'Lokasi blok kebun atau nomor bedeng (cth: Blok A Bedeng 5)';
COMMENT ON COLUMN tanaman.catatan IS 'Catatan perlakuan atau riwayat agronomis';
