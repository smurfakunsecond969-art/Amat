/**
 * plantConditionService.js
 * Single canonical source of truth for plant & garden condition calculation.
 */

function deriveScoreFromMoisture(plant) {
  const m = plant.moisture;
  const min = Number(plant.threshold_min ?? plant.moistureMin ?? 40);
  const max = Number(plant.threshold_max ?? plant.moistureMax ?? 80);

  if (m === null || m === undefined) return null;
  const numM = Number(m);
  if (numM < min) {
    const gap = min - numM;
    return Math.max(10, Math.round(100 - gap * 3.2));
  }
  if (numM > max) {
    const gap = numM - max;
    return Math.max(10, Math.round(100 - gap * 2.5));
  }
  const centre = (min + max) / 2;
  const range = (max - min) / 2 || 1;
  const deviation = Math.abs(numM - centre) / range;
  return Math.min(100, Math.max(50, Math.round(100 - deviation * 18)));
}

function classifyByScore(score) {
  if (score == null) {
    return {
      condition: 'tidak_ada_data',
      conditionLabel: 'Tidak Ada Data',
      conditionSeverity: 0,
      conditionColor: 'gray',
      countsInAverage: false,
    };
  }
  if (score < 40) {
    return {
      condition: 'kritis',
      conditionLabel: 'Kritis / Sakit',
      conditionSeverity: 3,
      conditionColor: 'red',
      countsInAverage: true,
    };
  }
  if (score < 70) {
    return {
      condition: 'perlu_perhatian',
      conditionLabel: 'Perlu Perhatian',
      conditionSeverity: 2,
      conditionColor: 'yellow',
      countsInAverage: true,
    };
  }
  return {
    condition: 'sehat',
    conditionLabel: 'Sehat',
    conditionSeverity: 1,
    conditionColor: 'green',
    countsInAverage: true,
  };
}

/**
 * computePlantCondition(plant)
 * Returns canonical condition object for a single plant.
 */
function computePlantCondition(plant) {
  const hasDevice = Boolean(plant.deviceId || plant.device_id || plant.hasDevice) && (plant.lastSeenAt !== null || plant.lastUpdate !== null || plant.moisture !== null);
  const hasPhotoAnalysis = plant.latestHealthScore != null || plant.latestAnalysis?.health_score != null || plant.health_score != null;
  
  const rawScore = plant.latestHealthScore ?? plant.latestAnalysis?.health_score ?? plant.health_score ?? null;
  const effectiveScore = rawScore != null ? Number(rawScore) : deriveScoreFromMoisture(plant);

  // STATE 1: Tidak ada data sama sekali (sensor maupun foto)
  if (!hasDevice && !hasPhotoAnalysis) {
    return {
      healthScore: null,
      condition: 'tidak_ada_data',
      conditionLabel: 'Tidak Ada Data',
      conditionSeverity: 0,
      conditionColor: 'gray',
      countsInAverage: false,
      isPenalty: true,
      sensorNotConnected: false,
    };
  }

  const base = classifyByScore(effectiveScore);

  // STATE 2: Ada foto/analisa AI, tapi sensor belum terhubung
  if (hasPhotoAnalysis && !hasDevice) {
    return {
      ...base,
      healthScore: effectiveScore,
      sensorNotConnected: true,
      isPenalty: false,
    };
  }

  // STATE 3: Data lengkap (sensor terhubung, dan/atau foto)
  return {
    ...base,
    healthScore: effectiveScore,
    sensorNotConnected: false,
    isPenalty: false,
  };
}

/**
 * computeGardenScore(plantsWithCondition)
 * Computes average of scored plants, penalizes no-data plants (-5 pts per no-data plant).
 */
function computeGardenScore(plantsWithCondition) {
  if (!plantsWithCondition || plantsWithCondition.length === 0) return null;

  const scored = plantsWithCondition.filter(p => p.countsInAverage && p.healthScore != null);
  const noDataCount = plantsWithCondition.filter(p => p.condition === 'tidak_ada_data').length;

  if (scored.length === 0) return null; // Belum ada data di seluruh kebun

  const avgScore = scored.reduce((sum, p) => sum + p.healthScore, 0) / scored.length;
  const penalty = noDataCount * 5; // 5 poin penalti per tanaman tanpa data
  return Math.max(0, Math.min(100, Math.round(avgScore - penalty)));
}

/**
 * buildDailyGardenSummary(counts, gardenScore)
 * Priority order: kritis -> tidak_ada_data -> perlu_perhatian -> sehat
 */
function buildDailyGardenSummary(counts, gardenScore) {
  const c = counts || { kritis: 0, tidak_ada_data: 0, perlu_perhatian: 0, sehat: 0 };
  
  if (c.kritis > 0) {
    return {
      urgency: 'critical',
      text: `🚨 PERHATIAN SERIUS: ${c.kritis} tanaman dalam kondisi kritis dan butuh penanganan SEKARANG. Jangan ditunda — cek Analisis Kebun untuk detail.`,
    };
  }
  if (c.tidak_ada_data > 0) {
    return {
      urgency: 'warning',
      text: `⚠️ ${c.tidak_ada_data} tanaman belum punya data sensor maupun foto. Skor kebun mungkin belum akurat — lengkapi datanya supaya AI bisa menilai dengan benar.`,
    };
  }
  if (c.perlu_perhatian > 0) {
    return {
      urgency: 'attention',
      text: `${c.perlu_perhatian} tanaman butuh perhatian dalam waktu dekat. Skor kebun hari ini: ${gardenScore != null ? gardenScore : '–'}/100.`,
    };
  }
  return {
    urgency: 'good',
    text: `Semua tanaman dalam kondisi baik! Skor kebun hari ini: ${gardenScore != null ? gardenScore : 100}/100. Pertahankan rutinitas perawatan saat ini 🌱`,
  };
}

module.exports = {
  deriveScoreFromMoisture,
  classifyByScore,
  computePlantCondition,
  computeGardenScore,
  buildDailyGardenSummary,
};
