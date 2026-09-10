const { supabase } = require('../db');

/**
 * Middleware: hanya admin yang boleh akses
 */
function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Akses ditolak. Hanya admin yang diizinkan.' });
  }
  next();
}

/**
 * GET /api/admin/users?status=pending|approved|rejected|all
 * List semua user beserta status persetujuan
 */
async function listUsers(req, res, next) {
  try {
    const { status = 'pending' } = req.query;

    let query = supabase
      .from('users')
      .select('id, nama, email, telepon, role, approval_status, created_at')
      .neq('id', req.user.id) // jangan tampilkan diri sendiri
      .order('created_at', { ascending: false });

    if (status !== 'all') {
      query = query.eq('approval_status', status);
    }

    const { data: users, error } = await query;
    if (error) throw error;

    const formatted = (users || []).map((u) => ({
      id: u.id,
      name: u.nama,
      email: u.email,
      phone: u.telepon || '',
      role: u.role,
      approvalStatus: u.approval_status,
      createdAt: u.created_at,
    }));

    res.json(formatted);
  } catch (err) {
    next(err);
  }
}

/**
 * PATCH /api/admin/users/:id/approve
 * Setujui akun user
 */
async function approveUser(req, res, next) {
  try {
    const { id } = req.params;

    const { data: user, error } = await supabase
      .from('users')
      .update({ approval_status: 'approved' })
      .eq('id', id)
      .select('id, nama, email, role, approval_status')
      .single();

    if (error || !user) {
      return res.status(404).json({ error: 'Pengguna tidak ditemukan' });
    }

    res.json({
      message: `Akun ${user.nama} berhasil disetujui`,
      user: {
        id: user.id,
        name: user.nama,
        email: user.email,
        role: user.role,
        approvalStatus: user.approval_status,
      },
    });
  } catch (err) {
    next(err);
  }
}

/**
 * PATCH /api/admin/users/:id/reject
 * Tolak akun user
 */
async function rejectUser(req, res, next) {
  try {
    const { id } = req.params;

    const { data: user, error } = await supabase
      .from('users')
      .update({ approval_status: 'rejected' })
      .eq('id', id)
      .select('id, nama, email, role, approval_status')
      .single();

    if (error || !user) {
      return res.status(404).json({ error: 'Pengguna tidak ditemukan' });
    }

    res.json({
      message: `Akun ${user.nama} ditolak`,
      user: {
        id: user.id,
        name: user.nama,
        email: user.email,
        role: user.role,
        approvalStatus: user.approval_status,
      },
    });
  } catch (err) {
    next(err);
  }
}

/**
 * PATCH /api/admin/users/:id/role
 * Ubah role user
 */
async function changeRole(req, res, next) {
  try {
    const { id } = req.params;
    const { role } = req.body;

    const validRoles = ['user', 'worker', 'admin'];
    if (!role || !validRoles.includes(role)) {
      return res.status(400).json({ error: `Role tidak valid. Pilihan: ${validRoles.join(', ')}` });
    }

    const { data: user, error } = await supabase
      .from('users')
      .update({ role })
      .eq('id', id)
      .select('id, nama, email, role, approval_status')
      .single();

    if (error || !user) {
      return res.status(404).json({ error: 'Pengguna tidak ditemukan' });
    }

    res.json({
      message: `Role ${user.nama} diubah ke ${role}`,
      user: {
        id: user.id,
        name: user.nama,
        email: user.email,
        role: user.role,
        approvalStatus: user.approval_status,
      },
    });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  requireAdmin,
  listUsers,
  approveUser,
  rejectUser,
  changeRole,
};
