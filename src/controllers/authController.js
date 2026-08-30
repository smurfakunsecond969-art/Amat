const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { supabase } = require('../db');

const SUPPORT_PHONE = '085215002047';

function formatUserResponse(user) {
  return {
    id: user.id,
    name: user.nama,
    email: user.email,
    phone: user.telepon || '',
    role: user.role,
    approvalStatus: user.approval_status,
    notifWatering: user.notif_watering ?? true,
    notifDevice: user.notif_device ?? true,
    notifReport: user.notif_report ?? false,
  };
}

function generateToken(userId) {
  return jwt.sign({ id: userId }, process.env.JWT_SECRET, { expiresIn: '7d' });
}

// ── POST /api/auth/register ──────────────────────────────────
// Role dipaksa 'user', approval_status = 'pending'.
// Tidak return token — return pesan tunggu persetujuan.
async function register(req, res, next) {
  try {
    const { name, phone, email, password } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Nama, email, dan kata sandi wajib diisi' });
    }

    const { data: existingUser } = await supabase
      .from('users')
      .select('id')
      .eq('email', email.toLowerCase().trim())
      .maybeSingle();

    if (existingUser) {
      return res.status(400).json({ error: 'Email sudah terdaftar' });
    }

    const password_hash = await bcrypt.hash(password, 10);

    const { data: newUser, error } = await supabase
      .from('users')
      .insert([
        {
          nama: name.trim(),
          email: email.toLowerCase().trim(),
          password_hash,
          telepon: phone ? phone.trim() : null,
          role: 'user',              // selalu 'user' saat register
          approval_status: 'pending', // harus disetujui admin dulu
        },
      ])
      .select()
      .single();

    if (error) throw error;

    // Tidak kasih token — akun belum disetujui
    res.status(201).json({
      message: 'Akun berhasil dibuat, menunggu persetujuan admin.',
      supportPhone: SUPPORT_PHONE,
    });
  } catch (err) {
    next(err);
  }
}

// ── POST /api/auth/login ─────────────────────────────────────
async function login(req, res, next) {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email dan kata sandi wajib diisi' });
    }

    const { data: user, error } = await supabase
      .from('users')
      .select('*')
      .eq('email', email.toLowerCase().trim())
      .maybeSingle();

    if (error || !user) {
      return res.status(400).json({ error: 'Email atau kata sandi salah' });
    }

    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      return res.status(400).json({ error: 'Email atau kata sandi salah' });
    }

    // Cek approval setelah password cocok
    if (user.approval_status !== 'approved') {
      return res.status(403).json({
        error: 'pending_approval',
        message: 'Akun kamu belum disetujui. Hubungi Customer Service untuk mengaktifkan.',
        supportPhone: SUPPORT_PHONE,
      });
    }

    const token = generateToken(user.id);
    res.json({ token, user: formatUserResponse(user) });
  } catch (err) {
    next(err);
  }
}

// ── GET /api/auth/me ─────────────────────────────────────────
async function getMe(req, res) {
  res.json({ user: formatUserResponse(req.user) });
}

// ── POST /api/auth/forgot-password ──────────────────────────
async function forgotPassword(req, res, next) {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ error: 'Email wajib diisi' });
    }
    // Stub — belum ada email service
    res.json({ message: 'Jika email terdaftar, instruksi reset kata sandi telah dikirim.' });
  } catch (err) {
    next(err);
  }
}

// ── POST /api/auth/change-password ──────────────────────────
async function changePassword(req, res, next) {
  try {
    const { oldPassword, newPassword } = req.body;
    if (!oldPassword || !newPassword) {
      return res.status(400).json({ error: 'Kata sandi lama dan baru wajib diisi' });
    }

    const { data: user } = await supabase
      .from('users')
      .select('password_hash')
      .eq('id', req.user.id)
      .single();

    const isMatch = await bcrypt.compare(oldPassword, user.password_hash);
    if (!isMatch) {
      return res.status(400).json({ error: 'Kata sandi lama tidak sesuai' });
    }

    const newHash = await bcrypt.hash(newPassword, 10);
    await supabase.from('users').update({ password_hash: newHash }).eq('id', req.user.id);

    res.json({ message: 'Kata sandi berhasil diperbarui' });
  } catch (err) {
    next(err);
  }
}

module.exports = { register, login, getMe, forgotPassword, changePassword };
