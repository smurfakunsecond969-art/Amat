const { supabase } = require('../db');

// ── GET /api/admin/users?status=pending|approved|rejected|all ──
async function listUsers(req, res, next) {
  try {
    const { status = 'pending' } = req.query;

    let query = supabase
      .from('users')
      .select('id, nama, email, telepon, role, approval_status, approved_at, created_at')
      .order('created_at', { ascending: false });

    if (status !== 'all') {
      query = query.eq('approval_status', status);
    }

    const { data: users, error } = await query;
    if (error) throw error;

    res.json(
      (users || []).map((u) => ({
        id: u.id,
        name: u.nama,
        email: u.email,
        phone: u.telepon || '',
        role: u.role,
        approvalStatus: u.approval_status,
        approvedAt: u.approved_at,
        createdAt: u.created_at,
      }))
    );
  } catch (err) {
    next(err);
  }
}

// ── PATCH /api/admin/users/:id/approve ──
async function approveUser(req, res, next) {
  try {
    const { id } = req.params;

    const { data: user, error } = await supabase
      .from('users')
      .update({
        approval_status: 'approved',
        approved_by: req.user.id,
        approved_at: new Date().toISOString(),
      })
      .eq('id', id)
      .select('id, nama, email, role, approval_status')
      .single();

    if (error || !user) {
      return res.status(404).json({ error: 'Pengguna tidak ditemukan' });
    }

    res.json({
      message: `Akun ${user.nama} berhasil disetujui.`,
      user: { id: user.id, name: user.nama, email: user.email, role: user.role, approvalStatus: user.approval_status },
    });
  } catch (err) {
    next(err);
  }
}

// ── PATCH /api/admin/users/:id/reject ──
async function rejectUser(req, res, next) {
  try {
    const { id } = req.params;

    const { data: user, error } = await supabase
      .from('users')
      .update({ approval_status: 'rejected' })
      .eq('id', id)
      .select('id, nama, email')
      .single();

    if (error || !user) {
      return res.status(404).json({ error: 'Pengguna tidak ditemukan' });
    }

    res.json({ message: `Akun ${user.nama} ditolak.` });
  } catch (err) {
    next(err);
  }
}

// ── PATCH /api/admin/users/:id/role ──
async function changeUserRole(req, res, next) {
  try {
    const { id } = req.params;
    const { role } = req.body;

    const validRoles = ['user', 'worker', 'admin'];
    if (!validRoles.includes(role)) {
      return res.status(400).json({ error: `Role tidak valid. Gunakan: ${validRoles.join(', ')}` });
    }

    // Jangan bisa downgrade diri sendiri
    if (id === req.user.id) {
      return res.status(400).json({ error: 'Tidak bisa mengubah role akun sendiri.' });
    }

    const { data: user, error } = await supabase
      .from('users')
      .update({ role })
      .eq('id', id)
      .select('id, nama, email, role')
      .single();

    if (error || !user) {
      return res.status(404).json({ error: 'Pengguna tidak ditemukan' });
    }

    res.json({
      message: `Role ${user.nama} diubah menjadi ${role}.`,
      user: { id: user.id, name: user.nama, email: user.email, role: user.role },
    });
  } catch (err) {
    next(err);
  }
}

module.exports = { listUsers, approveUser, rejectUser, changeUserRole };
