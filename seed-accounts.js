/**
 * seed-accounts.js — Buat akun Admin dan Worker pertama
 *
 * Jalankan SETELAH migration 002_role_approval.sql sudah dieksekusi di Supabase.
 * Cara pakai:  node seed-accounts.js
 */

require('dotenv').config();
const bcrypt = require('bcryptjs');
const { supabase } = require('./src/db');

const ACCOUNTS = [
  {
    nama: 'Admin',
    email: 'admin@tanamanku.id',
    password: 'Admin@123',
    role: 'admin',
    approval_status: 'approved',
  },
  {
    nama: 'Worker 1',
    email: 'worker1@tanamanku.id',
    password: 'Worker@123',
    role: 'worker',
    approval_status: 'approved',
  },
];

async function seed() {
  console.log('🌱 Seeding akun admin & worker...\n');

  for (const acc of ACCOUNTS) {
    // Cek apakah sudah ada
    const { data: existing } = await supabase
      .from('users')
      .select('id')
      .eq('email', acc.email)
      .maybeSingle();

    if (existing) {
      console.log(`⏭  Lewati — ${acc.email} sudah ada.`);
      continue;
    }

    const password_hash = await bcrypt.hash(acc.password, 10);

    const { data, error } = await supabase
      .from('users')
      .insert([{
        nama: acc.nama,
        email: acc.email,
        password_hash,
        role: acc.role,
        approval_status: acc.approval_status,
        approved_at: new Date().toISOString(),
      }])
      .select('id, nama, email, role')
      .single();

    if (error) {
      console.error(`❌ Gagal buat ${acc.email}:`, error.message);
    } else {
      console.log(`✅ Dibuat: ${data.nama} (${data.email}) — role: ${data.role}`);
      console.log(`   Password sementara: ${acc.password}`);
    }
  }

  console.log('\nSelesai. Ganti password setelah login pertama!');
  process.exit(0);
}

seed().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
