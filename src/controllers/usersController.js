const { supabase } = require('../db');

/**
 * GET /api/users/managed
 * Untuk worker/admin: ambil daftar user (role='user') yang bisa mereka kelola.
 * User biasa tidak boleh akses endpoint ini.
 */
async function getManagedUsers(req, res, next) {
  try {
    if (req.user.role === 'user') {
      return res.status(403).json({ error: 'Akses ditolak. Hanya worker dan admin yang dapat melihat daftar pengguna.' });
    }

    const { data: users, error } = await supabase
      .from('users')
      .select('id, nama, email')
      .eq('role', 'user')
      .eq('approval_status', 'approved')
      .order('nama', { ascending: true });

    if (error) throw error;

    const formatted = (users || []).map((u) => ({
      id: u.id,
      name: u.nama,
      email: u.email,
    }));

    res.json(formatted);
  } catch (err) {
    next(err);
  }
}

module.exports = { getManagedUsers };
