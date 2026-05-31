// ── ANALYTICS ENGINE ─────────────────────────────────────
// The brain of CoreSix — transforms raw data into meaning
// This runs BEFORE the AI gets involved

const { pool } = require("./db");

// ── CONSISTENCY SCORES ────────────────────────────────────
const getConsistencyScores = async (userId) => {
  const { rows } = await pool.query(`
    SELECT pillar, COUNT(*) as days
    FROM checkins
    WHERE user_id = $1
    AND created_at > NOW() - INTERVAL '7 days'
    GROUP BY pillar
  `, [userId]);

  const scores = {};
  rows.forEach(r => {
    scores[r.pillar] = {
      days: parseInt(r.days),
      score: Math.round((parseInt(r.days) / 7) * 100),
      label: parseInt(r.days) >= 5 ? "strong" : parseInt(r.days) >= 3 ? "building" : "needs attention",
    };
  });
  return scores;
};

// ── STREAK ANALYSIS ───────────────────────────────────────
const getStreakAnalysis = async (userId) => {
  const { rows } = await pool.query(`
    SELECT date, COUNT(DISTINCT pillar) as pillars_done
    FROM checkins
    WHERE user_id = $1
    ORDER BY date DESC
    LIMIT 30
  `, [userId]);

  let currentStreak = 0;
  let longestStreak = 0;
  let tempStreak = 0;
  const today = new Date().toISOString().split("T")[0];

  rows.forEach((row, i) => {
    if (parseInt(row.pillars_done) >= 1) {
      tempStreak++;
      if (i === 0 && row.date === today) currentStreak = tempStreak;
      longestStreak = Math.max(longestStreak, tempStreak);
    } else {
      tempStreak = 0;
    }
  });

  return { currentStreak, longestStreak, totalDays: rows.length };
};

// ── PATTERN DETECTION ─────────────────────────────────────
const detectPatterns = async (userId) => {
  const patterns = [];

  // Pattern 1: Low checkin frequency — relapse risk
  const { rows: recentCheckins } = await pool.query(`
    SELECT COUNT(*) as count FROM checkins
    WHERE user_id = $1
    AND created_at > NOW() - INTERVAL '3 days'
  `, [userId]);

  if (parseInt(recentCheckins[0].count) === 0) {
    patterns.push({
      type: "relapse_risk",
      severity: "high",
      message: "No check-ins in 3 days",
      action: "gentle_return",
    });
  }

  // Pattern 2: Strong consistency — celebrate
  const consistency = await getConsistencyScores(userId);
  const strongPillars = Object.entries(consistency)
    .filter(([_, v]) => v.score >= 80)
    .map(([k]) => k);

  if (strongPillars.length >= 2) {
    patterns.push({
      type: "strong_consistency",
      severity: "positive",
      pillars: strongPillars,
      message: `Consistent in ${strongPillars.join(", ")}`,
      action: "celebrate_and_deepen",
    });
  }

  // Pattern 3: Weekend drop — common behaviour pattern
  const { rows: weekdayRows } = await pool.query(`
    SELECT
      EXTRACT(DOW FROM created_at) as day_of_week,
      COUNT(*) as count
    FROM checkins
    WHERE user_id = $1
    AND created_at > NOW() - INTERVAL '28 days'
    GROUP BY day_of_week
  `, [userId]);

  const weekdayAvg = weekdayRows
    .filter(r => ![0, 6].includes(parseInt(r.day_of_week)))
    .reduce((sum, r) => sum + parseInt(r.count), 0) / 5;

  const weekendAvg = weekdayRows
    .filter(r => [0, 6].includes(parseInt(r.day_of_week)))
    .reduce((sum, r) => sum + parseInt(r.count), 0) / 2;

  if (weekdayAvg > 0 && weekendAvg < weekdayAvg * 0.5) {
    patterns.push({
      type: "weekend_drop",
      severity: "medium",
      weekday_avg: weekdayAvg,
      weekend_avg: weekendAvg,
      message: "Habits drop significantly on weekends",
      action: "weekend_prep_reminder",
    });
  }

  // Pattern 4: Pillar neglect — one pillar consistently skipped
  const allPillars = ["fuel", "move", "rest", "calm", "connect", "focus"];
  const { rows: pillarRows } = await pool.query(`
    SELECT pillar, COUNT(*) as count
    FROM checkins
    WHERE user_id = $1
    AND created_at > NOW() - INTERVAL '14 days'
    GROUP BY pillar
  `, [userId]);

  const pillarCounts = {};
  pillarRows.forEach(r => pillarCounts[r.pillar] = parseInt(r.count));

  const activePillarCheckins = Object.values(pillarCounts);
  const avgCheckins = activePillarCheckins.reduce((a, b) => a + b, 0) / activePillarCheckins.length;

  Object.entries(pillarCounts).forEach(([pillar, count]) => {
    if (count < avgCheckins * 0.4) {
      patterns.push({
        type: "pillar_neglect",
        severity: "medium",
        pillar,
        message: `${pillar} pillar significantly underperforming`,
        action: "focus_nudge",
      });
    }
  });

  // Pattern 5: All-or-nothing thinking — perfect week followed by zero
  const { rows: weekRows } = await pool.query(`
    SELECT
      DATE_TRUNC('week', created_at) as week,
      COUNT(*) as count
    FROM checkins
    WHERE user_id = $1
    AND created_at > NOW() - INTERVAL '28 days'
    GROUP BY week
    ORDER BY week DESC
  `, [userId]);

  if (weekRows.length >= 2) {
    const thisWeek = parseInt(weekRows[0].count);
    const lastWeek = parseInt(weekRows[1].count);
    if (lastWeek >= 15 && thisWeek <= 3) {
      patterns.push({
        type: "all_or_nothing",
        severity: "medium",
        message: "Big drop after a strong week — perfectionism pattern",
        action: "better_not_perfect_coaching",
      });
    }
  }

  // Save patterns to DB
  for (const pattern of patterns) {
    await pool.query(`
      INSERT INTO patterns (user_id, pattern_type, pattern_data)
      VALUES ($1, $2, $3)
    `, [userId, pattern.type, JSON.stringify(pattern)]);
  }

  return patterns;
};

// ── IMPACT TREND ANALYSIS ─────────────────────────────────
const getImpactTrends = async (userId) => {
  const { rows } = await pool.query(`
    SELECT pillar, score, created_at
    FROM weekly_impact
    WHERE user_id = $1
    ORDER BY created_at DESC
    LIMIT 18
  `, [userId]);

  const trends = {};
  const pillars = [...new Set(rows.map(r => r.pillar))];

  pillars.forEach(pillar => {
    const pillarRows = rows.filter(r => r.pillar === pillar);
    if (pillarRows.length >= 2) {
      const latest = pillarRows[0].score;
      const previous = pillarRows[1].score;
      trends[pillar] = {
        latest,
        previous,
        direction: latest > previous ? "improving" : latest < previous ? "declining" : "stable",
        change: latest - previous,
      };
    }
  });

  return trends;
};

// ── CONTEXT PACKAGER ──────────────────────────────────────
// THIS is the key function — packages data for AI
// BAD: send raw data to AI
// GOOD: send structured patterns and insights
const packageContextForAI = async (userId, purpose) => {
  const [consistency, patterns, trends, streak] = await Promise.all([
    getConsistencyScores(userId),
    detectPatterns(userId),
    getImpactTrends(userId),
    getStreakAnalysis(userId),
  ]);

  // Get user profile
  const { rows: userRows } = await pool.query(
    "SELECT name, profile, scores FROM users WHERE id = $1",
    [userId]
  );
  const user = userRows[0] || {};

  // Build meaningful context — not raw data
  const ctx = {
    user: {
      name: user.name || "there",
      goal: user.profile?.goal || "building better habits",
      age: user.profile?.age,
      health: user.profile?.health,
    },
    performance: {
      streak: streak.currentStreak,
      longest_streak: streak.longestStreak,
      consistency: consistency,
      summary: buildPerformanceSummary(consistency, streak),
    },
    patterns: patterns.map(p => ({
      type: p.type,
      message: p.message,
      action: p.action,
    })),
    trends: trends,
    purpose,
    tone: determineTone(patterns, streak),
    flags: {
      relapse_risk: patterns.some(p => p.type === "relapse_risk"),
      all_or_nothing: patterns.some(p => p.type === "all_or_nothing"),
      weekend_struggle: patterns.some(p => p.type === "weekend_drop"),
      strong_performer: patterns.some(p => p.type === "strong_consistency"),
    }
  };

  return ctx;
};

// ── HELPERS ───────────────────────────────────────────────
const buildPerformanceSummary = (consistency, streak) => {
  const strongPillars = Object.entries(consistency).filter(([_, v]) => v.score >= 70).map(([k]) => k);
  const weakPillars = Object.entries(consistency).filter(([_, v]) => v.score < 40).map(([k]) => k);

  let summary = `${streak.currentStreak} day streak.`;
  if (strongPillars.length) summary += ` Strong in: ${strongPillars.join(", ")}.`;
  if (weakPillars.length) summary += ` Needs attention: ${weakPillars.join(", ")}.`;
  return summary;
};

const determineTone = (patterns, streak) => {
  if (patterns.some(p => p.type === "relapse_risk")) return "gentle_encouraging";
  if (patterns.some(p => p.type === "all_or_nothing")) return "compassionate_realistic";
  if (streak.currentStreak >= 7) return "celebratory_deepening";
  if (streak.currentStreak === 0) return "fresh_start";
  return "warm_supportive";
};

// ── CROSS-PILLAR PATTERN DETECTION ───────────────────────
// Analyses relationships between pillars over time
const detectCrossPillarPatterns = async (userId) => {
  const patterns = [];

  // Get last 7 days of checkins per pillar
  const { rows: checkinRows } = await pool.query(`
    SELECT pillar, date, COUNT(*) as count
    FROM checkins
    WHERE user_id = $1
    AND created_at > NOW() - INTERVAL '7 days'
    GROUP BY pillar, date
    ORDER BY date DESC
  `, [userId]);

  // Get weekly impact scores
  const { rows: impactRows } = await pool.query(`
    SELECT pillar, score, created_at
    FROM weekly_impact
    WHERE user_id = $1
    ORDER BY created_at DESC
    LIMIT 18
  `, [userId]);

  // Get insights history to understand patterns over time
  const { rows: insightRows } = await pool.query(`
    SELECT insight_type, context, created_at
    FROM insights
    WHERE user_id = $1
    ORDER BY created_at DESC
    LIMIT 20
  `, [userId]);

  // Build pillar activity map
  const pillarActivity = {};
  checkinRows.forEach(r => {
    if (!pillarActivity[r.pillar]) pillarActivity[r.pillar] = [];
    pillarActivity[r.pillar].push(r.date);
  });

  // Build impact score map
  const impactByPillar = {};
  impactRows.forEach(r => {
    if (!impactByPillar[r.pillar]) impactByPillar[r.pillar] = [];
    impactByPillar[r.pillar].push({ score: r.score, date: r.created_at });
  });

  // ── PATTERN 1: REST → FOCUS ───────────────────────────
  // If rest score is low and focus score is also low
  const restScore = impactByPillar.rest?.[0]?.score ?? null;
  const focusScore = impactByPillar.focus?.[0]?.score ?? null;
  if (restScore !== null && focusScore !== null) {
    if (restScore <= 1 && focusScore <= 1) {
      patterns.push({
        type: "rest_focus_link",
        severity: "high",
        pillars: ["rest", "focus"],
        title: "Sleep is hurting your focus",
        message: "Your Rest and Focus scores are both low this week. Poor sleep directly impairs the prefrontal cortex — the seat of concentration and deep work.",
        suggestion: "Prioritise sleep tonight. Even one extra hour can recover 80% of your cognitive capacity.",
        icon: "😴→🎯",
        actionable: true,
      });
    } else if (restScore >= 3 && focusScore >= 3) {
      patterns.push({
        type: "rest_focus_positive",
        severity: "positive",
        pillars: ["rest", "focus"],
        title: "Sleep is powering your focus",
        message: "Strong Rest and Focus scores this week — your sleep is directly supporting your cognitive performance.",
        suggestion: "Protect your sleep schedule — it is your secret weapon for deep work.",
        icon: "😴→🎯",
        actionable: false,
      });
    }
  }

  // ── PATTERN 2: MOVE → CALM ────────────────────────────
  const moveScore = impactByPillar.move?.[0]?.score ?? null;
  const calmScore = impactByPillar.calm?.[0]?.score ?? null;
  if (moveScore !== null && calmScore !== null) {
    if (moveScore <= 1 && calmScore <= 1) {
      patterns.push({
        type: "move_calm_link",
        severity: "medium",
        pillars: ["move", "calm"],
        title: "Movement could reduce your stress",
        message: "Low movement and high stress this week. Exercise releases endorphins and reduces cortisol — it is one of the most powerful stress interventions available.",
        suggestion: "A 10-minute walk tomorrow morning could shift your stress level significantly.",
        icon: "💪→🧘",
        actionable: true,
      });
    }
  }

  // ── PATTERN 3: CONNECT → CALM ─────────────────────────
  const connectScore = impactByPillar.connect?.[0]?.score ?? null;
  if (connectScore !== null && calmScore !== null) {
    if (connectScore <= 1 && calmScore <= 1) {
      patterns.push({
        type: "isolation_stress",
        severity: "medium",
        pillars: ["connect", "calm"],
        title: "Isolation may be increasing stress",
        message: "Low connection and elevated stress often go together. Social isolation activates the same brain regions as physical pain.",
        suggestion: "One genuine conversation today could measurably reduce your cortisol levels.",
        icon: "🤝→🧘",
        actionable: true,
      });
    }
  }

  // ── PATTERN 4: FUEL → FOCUS ───────────────────────────
  const fuelScore = impactByPillar.fuel?.[0]?.score ?? null;
  if (fuelScore !== null && focusScore !== null) {
    if (fuelScore <= 1 && focusScore <= 1) {
      patterns.push({
        type: "fuel_focus_link",
        severity: "medium",
        pillars: ["fuel", "focus"],
        title: "Nutrition may be limiting your focus",
        message: "Your Fuel and Focus scores are both low. The brain consumes 20% of your daily energy — poor nutrition directly limits cognitive performance.",
        suggestion: "Try adding protein to breakfast tomorrow and notice the difference in morning clarity.",
        icon: "⚡→🎯",
        actionable: true,
      });
    }
  }

  // ── PATTERN 5: REST → CALM ────────────────────────────
  if (restScore !== null && calmScore !== null) {
    if (restScore <= 1 && calmScore <= 1) {
      patterns.push({
        type: "rest_calm_link",
        severity: "high",
        pillars: ["rest", "calm"],
        title: "Poor sleep is amplifying stress",
        message: "Sleep deprivation enlarges the amygdala — your brain's threat detector — making you more reactive and less calm.",
        suggestion: "A consistent bedtime for 3 nights can begin resetting your stress response.",
        icon: "😴→🧘",
        actionable: true,
      });
    }
  }

  // ── PATTERN 6: ALL PILLARS STRONG ────────────────────
  const allScores = [restScore,focusScore,moveScore,calmScore,connectScore,fuelScore].filter(s=>s!==null);
  if (allScores.length >= 4 && allScores.every(s=>s>=2)) {
    patterns.push({
      type: "all_strong",
      severity: "positive",
      pillars: ["fuel","move","rest","calm","connect","focus"],
      title: "All pillars are strong this week",
      message: "Every pillar you are tracking is performing well. This is rare and worth acknowledging — your habits are compounding across your whole life.",
      suggestion: "The goal now is consistency — protect what is working.",
      icon: "✨",
      actionable: false,
    });
  }

  // ── PATTERN 7: NEGLECTED PILLAR AFFECTING OTHERS ─────
  const checkedPillars = Object.keys(pillarActivity);
  const allPillars = ["fuel","move","rest","calm","connect","focus"];
  const neglected = allPillars.filter(p=>!checkedPillars.includes(p));
  if (neglected.length > 0) {
    const rippleMap = {
      rest: ["focus","calm"],
      move: ["calm","fuel"],
      fuel: ["focus","move"],
      calm: ["connect","focus"],
      connect: ["calm"],
      focus: ["move"],
    };
    neglected.forEach(p => {
      const affected = rippleMap[p] || [];
      if (affected.length > 0) {
        patterns.push({
          type: "neglect_ripple",
          severity: "medium",
          pillars: [p, ...affected],
          title: `${p.charAt(0).toUpperCase()+p.slice(1)} neglect may affect other pillars`,
          message: `You haven't checked in on ${p} this week. Research shows neglecting this pillar often impacts ${affected.join(" and ")}.`,
          suggestion: `Even one small ${p} habit today can break the ripple effect.`,
          icon: "🔗",
          actionable: true,
        });
      }
    });
  }

  return patterns.slice(0, 5); // Max 5 patterns at a time
};

// ── PILLAR RIPPLE EFFECT ──────────────────────────────────
const getPillarRippleEffect = async (userId) => {
  const { rows: impactRows } = await pool.query(`
    SELECT pillar, AVG(score) as avg_score
    FROM weekly_impact
    WHERE user_id = $1
    AND created_at > NOW() - INTERVAL '30 days'
    GROUP BY pillar
  `, [userId]);

  const scores = {};
  impactRows.forEach(r => { scores[r.pillar] = parseFloat(r.avg_score); });

  // Find keystone pillar — most correlated with others
  const RIPPLE_MAP = {
    rest:    { affects: ["focus","calm","move"], strength: 0.85 },
    fuel:    { affects: ["move","focus","energy"], strength: 0.75 },
    move:    { affects: ["calm","rest","focus"], strength: 0.80 },
    calm:    { affects: ["connect","focus","rest"], strength: 0.70 },
    connect: { affects: ["calm","focus"], strength: 0.65 },
    focus:   { affects: ["fuel","move"], strength: 0.60 },
  };

  const pillarScores = Object.entries(scores);
  if (!pillarScores.length) return null;

  const keystone = pillarScores.sort((a,b)=>b[1]-a[1])[0];
  const weakest  = pillarScores.sort((a,b)=>a[1]-b[1])[0];

  return {
    keystone: keystone[0],
    keystoneScore: Math.round(keystone[1]*25),
    weakest: weakest[0],
    weakestScore: Math.round(weakest[1]*25),
    rippleMap: RIPPLE_MAP,
    scores,
  };
};

module.exports = {
  getConsistencyScores,
  getStreakAnalysis,
  detectPatterns,
  getImpactTrends,
  packageContextForAI,
  detectCrossPillarPatterns,
  getPillarRippleEffect,
};
