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

module.exports = {
  getConsistencyScores,
  getStreakAnalysis,
  detectPatterns,
  getImpactTrends,
  packageContextForAI,
};
