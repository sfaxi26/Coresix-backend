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
      severity: "encouragement",
      message: "Every day is a fresh start",
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
      severity: "encouragement",
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
        severity: "encouragement",
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
        severity: "encouragement",
        message: "Strong weeks build strong habits",
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

  // Build pillar activity map from HABIT CHECK-INS (primary metric)
  const pillarActivity = {};
  checkinRows.forEach(r => {
    if (!pillarActivity[r.pillar]) pillarActivity[r.pillar] = [];
    pillarActivity[r.pillar].push(r.date);
  });

  // Build pillar consistency scores — based on habit checkins only
  const pillarConsistency = {};
  Object.entries(pillarActivity).forEach(([pillar, dates]) => {
    pillarConsistency[pillar] = dates.length; // days checked in this week
  });

  // Build impact score map (weekly self-ratings — optional)
  const impactByPillar = {};
  impactRows.forEach(r => {
    if (!impactByPillar[r.pillar]) impactByPillar[r.pillar] = [];
    impactByPillar[r.pillar].push({ score: r.score, date: r.created_at });
  });

  // Only analyse pillars where user has done habit checkins
  // Missing checkins = user not focusing on that pillar, NOT a failure
  const activePillarList = Object.keys(pillarActivity);
  if (activePillarList.length === 0) return patterns; // No data yet

  // ── PATTERN 1: REST → FOCUS ───────────────────────────
  // Only check patterns for pillars user is actively working on
  const restDays = pillarConsistency.rest || 0;
  const focusDays = pillarConsistency.focus || 0;
  const moveDays = pillarConsistency.move || 0;
  const calmDays = pillarConsistency.calm || 0;
  const connectDays = pillarConsistency.connect || 0;
  const fuelDays = pillarConsistency.fuel || 0;

  // Use impact scores as secondary signal (self-rated weekly feelings)
  const restScore = impactByPillar.rest?.[0]?.score ?? null;
  const focusScore = impactByPillar.focus?.[0]?.score ?? null;

  // Only detect pattern if BOTH pillars are active
  if (restDays > 0 && focusDays > 0 && restScore !== null && focusScore !== null) {
    if (restScore <= 1 && focusScore <= 1) {
      patterns.push({
        type: "rest_focus_link",
        severity: "encouragement",
        pillars: ["rest", "focus"],
        title: "Rest and Focus are connected for you",
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
  if (moveDays > 0 && calmDays > 0 && moveScore !== null && calmScore !== null) {
    if (moveScore <= 1 && calmScore <= 1) {
      patterns.push({
        type: "move_calm_link",
        severity: "encouragement",
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
  if (connectDays > 0 && calmDays > 0 && connectScore !== null && calmScore !== null) {
    if (connectScore <= 1 && calmScore <= 1) {
      patterns.push({
        type: "isolation_stress",
        severity: "encouragement",
        pillars: ["connect", "calm"],
        title: "Connection could lift your Calm this week",
        message: "Low connection and elevated stress often go together. Social isolation activates the same brain regions as physical pain.",
        suggestion: "One genuine conversation today could measurably reduce your cortisol levels.",
        icon: "🤝→🧘",
        actionable: true,
      });
    }
  }

  // ── PATTERN 4: FUEL → FOCUS ───────────────────────────
  const fuelScore = impactByPillar.fuel?.[0]?.score ?? null;
  if (fuelDays > 0 && focusDays > 0 && fuelScore !== null && focusScore !== null) {
    if (fuelScore <= 1 && focusScore <= 1) {
      patterns.push({
        type: "fuel_focus_link",
        severity: "encouragement",
        pillars: ["fuel", "focus"],
        title: "Fuel and Focus move together for you",
        message: "Your Fuel and Focus scores are both low. The brain consumes 20% of your daily energy — poor nutrition directly limits cognitive performance.",
        suggestion: "Try adding protein to breakfast tomorrow and notice the difference in morning clarity.",
        icon: "⚡→🎯",
        actionable: true,
      });
    }
  }

  // ── PATTERN 5: REST → CALM ────────────────────────────
  if (restDays > 0 && calmDays > 0 && restScore !== null && calmScore !== null) {
    if (restScore <= 1 && calmScore <= 1) {
      patterns.push({
        type: "rest_calm_link",
        severity: "encouragement",
        pillars: ["rest", "calm"],
        title: "Better sleep could transform your week",
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

  // ── PATTERN 7: NEGLECTED ACTIVE PILLAR ──────────────
  // Only flag pillars the user is actively tracking — not all 6
  // Users focus on 1-3 pillars at a time by design
  const checkedPillars = Object.keys(pillarActivity);

  // Get user's active pillars from ladder (pillars they've selected habits for)
  const { rows: ladderRows } = await pool.query(`
    SELECT pillar FROM ladder
    WHERE user_id = $1 AND selected_habit IS NOT NULL AND selected_habit != ''
  `, [userId]);
  const activePillars = ladderRows.map(r=>r.pillar);

  // Only warn about neglect if pillar is active AND has been checked before
  // Never penalise for not tracking a pillar the user isn't focused on
  if (activePillars.length > 0 && checkedPillars.length > 0) {
    const neglectedActive = activePillars.filter(p=>!checkedPillars.includes(p));
    const rippleMap = {
      rest:["focus","calm"], move:["calm","fuel"], fuel:["focus","move"],
      calm:["connect","focus"], connect:["calm"], focus:["move"],
    };
    neglectedActive.slice(0,1).forEach(p => { // Max 1 neglect warning
      const affected = rippleMap[p] || [];
      patterns.push({
        type: "neglect_ripple",
        severity: "low",
        pillars: [p, ...affected],
        title: `${p.charAt(0).toUpperCase()+p.slice(1)} hasn't been checked in recently`,
        message: `You have a habit selected for ${p} but haven't logged it this week. This is just a gentle reminder — focus on your main pillars first.`,
        suggestion: `When you're ready, even one ${p} check-in this week keeps the momentum going.`,
        icon: "💡",
        actionable: true,
      });
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

// ── PREDICTIVE WARNINGS ENGINE ───────────────────────────
// Fires BEFORE problems happen — not after
const generatePredictiveWarnings = async (userId) => {
  const warnings = [];
  const today = new Date();
  const dayOfWeek = today.getDay();
  const dayName = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"][dayOfWeek];

  // Need at least 7 days of data before generating meaningful warnings
  const { rows: dataCheck } = await pool.query(`
    SELECT COUNT(DISTINCT date) as days
    FROM checkins WHERE user_id = $1
    AND created_at > NOW() - INTERVAL '30 days'
  `, [userId]);
  const daysOfData = parseInt(dataCheck[0]?.days || 0);
  if (daysOfData < 7) return []; // Not enough data yet

  // ── WARNING 1: STREAK RISK BY DAY OF WEEK ────────────────
  const { rows: streakByDay } = await pool.query(`
    SELECT EXTRACT(DOW FROM created_at) as day, COUNT(*) as checkins
    FROM checkins
    WHERE user_id = $1
    AND created_at > NOW() - INTERVAL '60 days'
    GROUP BY day
    ORDER BY day
  `, [userId]);

  const dayCheckins = {};
  streakByDay.forEach(r => { dayCheckins[parseInt(r.day)] = parseInt(r.checkins); });

  const avgCheckins = Object.values(dayCheckins).reduce((a,b)=>a+b,0) / Math.max(Object.keys(dayCheckins).length,1);
  const todayCheckins = dayCheckins[dayOfWeek] || 0;
  const tomorrowCheckins = dayCheckins[(dayOfWeek+1)%7] || 0;

  if (todayCheckins < avgCheckins * 0.5) {
    warnings.push({
      type: "streak_risk_today",
      severity: "encouragement",
      timing: "today",
      title: `${dayName}s are your risk day`,
      message: `Your data shows ${dayName}s are your lowest check-in day. Your streak is at risk today.`,
      suggestion: "Do your habits earlier today than usual — don't leave them for the evening.",
      icon: "💪",
      actionable: true,
      urgency: 9,
    });
  } else if (tomorrowCheckins < avgCheckins * 0.5) {
    const tomorrow = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"][(dayOfWeek+1)%7];
    warnings.push({
      type: "streak_risk_tomorrow",
      severity: "encouragement",
      timing: "tomorrow",
      title: `${tomorrow} is historically your hard day`,
      message: `Based on your data, ${tomorrow}s are when you most often miss habits. Tomorrow could be tough.`,
      suggestion: "Plan your habits for tomorrow now — decide exactly when you will do them.",
      icon: "📅",
      actionable: true,
      urgency: 6,
    });
  }

  // ── WARNING 2: SLEEP DECLINE → FOCUS PREDICTION ──────────
  const { rows: recentCheckins } = await pool.query(`
    SELECT date, COUNT(DISTINCT pillar) as pillars
    FROM checkins
    WHERE user_id = $1
    AND created_at > NOW() - INTERVAL '5 days'
    GROUP BY date
    ORDER BY date DESC
  `, [userId]);

  const last4Days = recentCheckins.slice(0,4);
  // Requires 4+ days, consistently declining over 3 consecutive days
  const declining = last4Days.length >= 4 &&
    last4Days[0].pillars < last4Days[1].pillars &&
    last4Days[1].pillars < last4Days[2].pillars &&
    last4Days[0].pillars <= 1; // Only warn if today is very low (0-1 habits)

  if (declining) {
    warnings.push({
      type: "declining_streak",
      severity: "encouragement",
      timing: "today",
      title: "One habit today keeps everything alive",
      message: "Every streak has quiet days. The people who keep going through them are the ones who actually change. You're still here — that's what matters.",
      suggestion: "Do the smallest version of one habit today. That's it. That's enough.",
      icon: "🌱",
      actionable: true,
      urgency: 8,
    });
  }

  // ── WARNING 3: WEEKEND PREPARATION ───────────────────────
  if (dayOfWeek === 5) { // Friday
    const { rows: weekendData } = await pool.query(`
      SELECT COUNT(*) as weekend_checkins
      FROM checkins
      WHERE user_id = $1
      AND EXTRACT(DOW FROM created_at) IN (0, 6)
      AND created_at > NOW() - INTERVAL '30 days'
    `, [userId]);

    const weekendAvg = parseInt(weekendData[0]?.weekend_checkins || 0) / 4;
    const { rows: weekdayData } = await pool.query(`
      SELECT COUNT(*) as weekday_checkins
      FROM checkins
      WHERE user_id = $1
      AND EXTRACT(DOW FROM created_at) NOT IN (0, 6)
      AND created_at > NOW() - INTERVAL '30 days'
    `, [userId]);

    const weekdayAvg = parseInt(weekdayData[0]?.weekday_checkins || 0) / 20;

    if (weekendAvg < weekdayAvg * 0.6) {
      warnings.push({
        type: "weekend_preparation",
        severity: "encouragement",
        timing: "this weekend",
        title: "Weekends are where habits become identity",
        message: "Your weekday consistency is impressive. The next 48 hours are critical for your streak.",
        suggestion: "Set a specific time for tomorrow's habits right now — morning works best. Decide before the weekend starts.",
        icon: "📅",
        actionable: true,
        urgency: 7,
      });
    }
  }

  // ── WARNING 4: RELAPSE PATTERN DETECTION ─────────────────
  const { rows: gapData } = await pool.query(`
    SELECT date,
           LAG(date) OVER (ORDER BY date) as prev_date,
           date::date - LAG(date::date) OVER (ORDER BY date) as gap_days
    FROM (
      SELECT DISTINCT date FROM checkins
      WHERE user_id = $1
      AND created_at > NOW() - INTERVAL '60 days'
    ) d
    ORDER BY date DESC
    LIMIT 10
  `, [userId]);

  const gaps = gapData.map(r=>parseInt(r.gap_days)).filter(g=>!isNaN(g)&&g>1);
  const avgGap = gaps.length ? gaps.reduce((a,b)=>a+b,0)/gaps.length : 0;

  if (avgGap >= 3 && avgGap <= 7) {
    warnings.push({
      type: "relapse_cycle",
      severity: "encouragement",
      timing: "awareness",
      title: `You tend to take ${Math.round(avgGap)}-day breaks`,
      message: `Your data shows a pattern: you build momentum then take a ${Math.round(avgGap)}-day break. You may be approaching one now.`,
      suggestion: "Recognise the pattern. Tomorrow — do the smallest possible version of your habit to break the cycle.",
      icon: "🔄",
      actionable: true,
      urgency: 5,
    });
  }

  // ── WARNING 5: EVENING CHECK — NOT DONE YET ──────────────
  const hour = today.getHours();
  if (hour >= 19) { // After 7pm
    const todayDate = today.toISOString().slice(0,10);
    const { rows: todayCheckinData } = await pool.query(`
      SELECT COUNT(DISTINCT pillar) as count
      FROM checkins
      WHERE user_id = $1 AND date = $2
    `, [userId, todayDate]);

    const todayCount = parseInt(todayCheckinData[0]?.count || 0);
    if (todayCount === 0) {
      warnings.push({
        type: "evening_reminder",
        severity: "encouragement",
        timing: "tonight",
        title: "Today is still yours",
        message: "There's still time today. One habit logged tonight keeps everything going tonight.",
        suggestion: "Even one habit logged tonight keeps the streak alive. Which one is easiest right now?",
        icon: "🌙",
        actionable: true,
        urgency: 10,
      });
    }
  }

  // ── WARNING 6: POSITIVE — PERSONAL BEST APPROACHING ──────
  const { rows: streakData } = await pool.query(
    "SELECT streak FROM users WHERE id=$1", [userId]
  );
  const currentStreak = parseInt(streakData[0]?.streak || 0);

  const { rows: maxStreakData } = await pool.query(`
    SELECT MAX(streak) as max_streak FROM users WHERE id=$1
  `, [userId]);
  const maxStreak = parseInt(maxStreakData[0]?.max_streak || 0);

  if (currentStreak > 0 && maxStreak > 0 && currentStreak >= maxStreak - 3 && currentStreak < maxStreak) {
    warnings.push({
      type: "personal_best_approaching",
      severity: "positive",
      timing: "this week",
      title: `Personal best in ${maxStreak - currentStreak} days`,
      message: `Your longest ever streak is ${maxStreak} days. You're only ${maxStreak - currentStreak} days away from beating it.`,
      suggestion: "This is worth protecting. Show up tomorrow.",
      icon: "🏆",
      actionable: false,
      urgency: 7,
    });
  }

  // Sort by urgency
  return warnings.sort((a,b)=>b.urgency-a.urgency).slice(0,4);
};

// ── CROSS-PILLAR TREND ANALYSIS ──────────────────────────────
const analyzeCrossPillarTrends = (impactHistory) => {
  if (!impactHistory || impactHistory.length < 2) return { trends:{}, correlations:[] };

  const PILLARS = ["fuel","move","rest","calm","connect","focus"];
  const trends = {};

  PILLARS.forEach(pid => {
    const ratings = impactHistory
      .filter(h => h.answers?.[pid] !== undefined)
      .map(h => ({ week: h.week, score: h.answers[pid], date: h.date }));

    if (ratings.length < 2) return;

    const recent = ratings.slice(-2);
    const older = ratings.slice(-4, -2);
    const recentAvg = recent.reduce((a,b)=>a+b.score,0) / recent.length;
    const olderAvg = older.length > 0 ? older.reduce((a,b)=>a+b.score,0) / older.length : recentAvg;
    const change = recentAvg - olderAvg;

    trends[pid] = {
      direction: change > 0.4 ? "rising ↑" : change < -0.4 ? "dropping ↓" : "stable →",
      change: Math.round(change * 10) / 10,
      recentAvg: Math.round(recentAvg * 10) / 10,
      allRatings: ratings.map(r => r.score),
    };
  });

  // Find correlated pillars — ones that move together
  const correlations = [];
  PILLARS.forEach((p1, i) => {
    PILLARS.slice(i+1).forEach(p2 => {
      const weeks = impactHistory.filter(h => h.answers?.[p1] !== undefined && h.answers?.[p2] !== undefined);
      if (weeks.length < 3) return;

      // Check same-direction movement
      let sameDir = 0;
      for (let i = 1; i < weeks.length; i++) {
        const d1 = weeks[i].answers[p1] - weeks[i-1].answers[p1];
        const d2 = weeks[i].answers[p2] - weeks[i-1].answers[p2];
        if ((d1 > 0 && d2 > 0) || (d1 < 0 && d2 < 0) || (d1 === 0 && d2 === 0)) sameDir++;
      }
      const correlation = sameDir / (weeks.length - 1);
      if (correlation >= 0.65) {
        correlations.push({ p1, p2, strength: Math.round(correlation * 100) });
      }
    });
  });

  return { trends, correlations };
};

module.exports = {
  getConsistencyScores,
  getStreakAnalysis,
  detectPatterns,
  getImpactTrends,
  packageContextForAI,
  detectCrossPillarPatterns,
  getPillarRippleEffect,
  generatePredictiveWarnings,
  analyzeCrossPillarTrends,
};
