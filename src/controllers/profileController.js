const { supabase } = require('../db');

async function updateProfile(req, res, next) {
  try {
    const { name, email, role } = req.body;

    const validRoles = ['user', 'worker', 'admin'];
    const updateData = {};

    if (name) updateData.nama = name.trim();
    if (email) updateData.email = email.toLowerCase().trim();
    if (role && validRoles.includes(role)) updateData.role = role;

    const { data: updatedUser, error } = await supabase
      .from('users')
      .update(updateData)
      .eq('id', req.user.id)
      .select()
      .single();

    if (error) throw error;

    res.json({
      message: 'Profil berhasil diperbarui',
      user: {
        id: updatedUser.id,
        name: updatedUser.nama,
        email: updatedUser.email,
        phone: updatedUser.telepon || '',
        role: updatedUser.role,
        notifWatering: updatedUser.notif_watering,
        notifDevice: updatedUser.notif_device,
        notifReport: updatedUser.notif_report,
      },
    });
  } catch (err) {
    next(err);
  }
}

async function updateNotifications(req, res, next) {
  try {
    const { notifWatering, notifDevice, notifReport } = req.body;

    const updateData = {};
    if (typeof notifWatering === 'boolean') updateData.notif_watering = notifWatering;
    if (typeof notifDevice === 'boolean') updateData.notif_device = notifDevice;
    if (typeof notifReport === 'boolean') updateData.notif_report = notifReport;

    const { data: updatedUser, error } = await supabase
      .from('users')
      .update(updateData)
      .eq('id', req.user.id)
      .select()
      .single();

    if (error) throw error;

    res.json({
      message: 'Pengaturan notifikasi disimpan',
      notifications: {
        notifWatering: updatedUser.notif_watering,
        notifDevice: updatedUser.notif_device,
        notifReport: updatedUser.notif_report,
      },
    });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  updateProfile,
  updateNotifications,
};
