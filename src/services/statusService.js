/**
  * Hitung status 'good' atau 'warning' secara real-time.
  * status = 'warning' jika:
  *   1. kelembaban < threshold_min
  *   2. last_seen_at tidak ada atau lebih tua dari 30 menit
  */
function computePlantStatus(moisture, thresholdMin, lastSeenAt) {
  if (moisture !== null && moisture !== undefined && Number(moisture) < Number(thresholdMin)) {
    return 'warning';
  }

  if (!lastSeenAt) {
    return 'warning';
  }

  const now = new Date();
  const lastSeen = new Date(lastSeenAt);
  const diffMinutes = (now.getTime() - lastSeen.getTime()) / (1000 * 60);

  if (diffMinutes > 30) {
    return 'warning';
  }

  return 'good';
}

/**
  * Hitung menit sejak lastSeenAt.
  * Return null jika lastSeenAt tidak tersedia (belum pernah sync).
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
