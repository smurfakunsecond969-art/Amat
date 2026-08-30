const { supabase } = require('../db');

// ── GET /api/users/managed ──
// Dipakai worker & admin untuk dropdown "Kelola tanaman untuk user:"
// Mengembalikan semua user ber-role 'user' dengan status approved
async function getManagedUsers(req, res, next) {
  try {
    const { data: users, error } = await supabase
      .from('users')
      .select('id, nama, email')
      .eq('role', 'user')
      .eq('approval_status', 'approved')
      .order('nama', { ascending: true });

    if (error) throw error;

    res.json(
      (users || []).map((u) => ({
        id: u.id,
        name: u.nama,
        email: u.email,
      }))
    );
  } catch (err) {
    next(err);
  }
}

module.exports = { getManagedUsers };
