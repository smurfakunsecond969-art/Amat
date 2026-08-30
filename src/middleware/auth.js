const jwt = require('jsonwebtoken');
const { supabase } = require('../db');

async function requireAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Token autentikasi tidak ditemukan. Silakan login.' });
    }

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const { data: user, error } = await supabase
      .from('users')
      .select('id, nama, email, telepon, role, approval_status, notif_watering, notif_device, notif_report')
      .eq('id', decoded.id)
      .single();

    if (error || !user) {
      return res.status(401).json({ error: 'Sesi tidak valid atau pengguna tidak ditemukan.' });
    }

    // Akun yang approval-nya dicabut setelah login tidak bisa pakai API lagi
    if (user.approval_status !== 'approved') {
      return res.status(403).json({
        error: 'account_not_approved',
        message: 'Akun kamu belum disetujui atau telah dinonaktifkan.',
      });
    }

    req.user = user;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Sesi telah berakhir. Silakan login kembali.' });
    }
    return res.status(401).json({ error: 'Token tidak valid.' });
  }
}

/**
 * requireRole(roles) — factory middleware untuk cek role.
 * Dipanggil setelah requireAuth supaya req.user sudah ada.
 *
 * Contoh:  router.post('/', requireAuth, requireRole(['worker', 'admin']), handler)
 */
function requireRole(roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Tidak terautentikasi.' });
    }
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({
        error: 'Akses ditolak. Role kamu tidak memiliki izin untuk aksi ini.',
      });
    }
    next();
  };
}

module.exports = { requireAuth, requireRole };
