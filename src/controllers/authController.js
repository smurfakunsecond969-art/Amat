const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { supabase } = require('../db');

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

async function register(req, res, next) {
  try {
    const { name, phone, email, password, role } = req.body;

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
    const validRoles = ['user', 'worker', 'admin'];
    const userRole = validRoles.includes(role) ? role : 'user';

    const { data: newUser, error } = await supabase
      .from('users')
      .insert([
        {
          nama: name.trim(),
          email: email.toLowerCase().trim(),
          password_hash,
          telepon: phone ? phone.trim() : null,
          role: userRole,
          approval_status: 'pending',
        },
      ])
      .select()
      .single();

    if (error) throw error;

    // Return pesan saja — akun perlu disetujui admin sebelum bisa login.
    // supportPhone diambil dari env agar bisa dikonfigurasi tanpa deploy ulang.
    res.status(201).json({
      message: 'Pendaftaran berhasil. Akunmu sedang menunggu persetujuan admin.',
      supportPhone: process.env.SUPPORT_PHONE || '',
    });
  } catch (err) {
    next(err);
  }
}

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

    // Cek status persetujuan akun
    if (user.approval_status === 'pending') {
      return res.status(403).json({
        error: 'pending_approval',
        message: 'Akunmu sedang menunggu persetujuan admin.',
        supportPhone: process.env.SUPPORT_PHONE || '',
      });
    }
    if (user.approval_status === 'rejected') {
      return res.status(403).json({
        error: 'account_rejected',
        message: 'Akunmu telah ditolak. Hubungi admin untuk informasi lebih lanjut.',
        supportPhone: process.env.SUPPORT_PHONE || '',
      });
    }

    const token = generateToken(user.id);
    res.json({ token, user: formatUserResponse(user) });
  } catch (err) {
    next(err);
  }
}

async function getMe(req, res) {
  res.json({ user: formatUserResponse(req.user) });
}

async function forgotPassword(req, res, next) {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ error: 'Email wajib diisi' });
    }
    // Stub response for prototype
    res.json({ message: 'Jika email terdaftar, instruksi reset kata sandi telah dikirim.' });
  } catch (err) {
    next(err);
  }
}

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

module.exports = {
  register,
  login,
  getMe,
  forgotPassword,
  changePassword,
};
