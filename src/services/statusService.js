/**
  * Hitung status 'good' atau 'warning' secara real-time.
  * status = 'warning' jika:
  *   1. kelembaban < threshold_min
  *   2. last_seen_at tidak ada (belum pernah sync) — status 'no_data'
  *   3. last_seen_at lebih tua dari 30 menit
  */
function computePlantStatus(moisture, thresholdMin, lastSeenAt) {
  // Belum pernah ada data sensor sama sekali
  if (!lastSeenAt) {
    return 'no_data';
  }

  const now = new Date();
  const lastSeen = new Date(lastSeenAt);
  const diffMinutes = (now.getTime() - lastSeen.getTime()) / (1000 * 60);

  // Device offline / terlalu lama tidak kirim data
  if (diffMinutes > 30) {
    return 'warning';
  }

  // Kelembaban di bawah threshold minimum
  if (moisture !== null && moisture !== undefined && Number(moisture) < Number(thresholdMin)) {
    return 'warning';
  }

  return 'good';
}

/**
  * Hitung menit sejak lastSeenAt
  */
function computeLastUpdateMinutes(lastSeenAt) {
  if (!lastSeenAt) return null;
  const now = new Date();
  const lastSeen = new Date(lastSeenAt);
  const diffMinutes = Math.floor((now.getTime() - lastSeen.getTime()) / (1000 * 60));
  return Math.max(0, diffMinutes);
}

module.exports = {
  computePlantStatus,
  computeLastUpdateMinutes,
};
