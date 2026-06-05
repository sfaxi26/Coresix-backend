// ── WEEKLY INTELLIGENCE ENGINE ────────────────────────────
// Cross-pillar analysis — the real brain of CoreSix

const { pool } = require("./db");
const { callGroq } = require("./ai");

// ── COLLECT WEEKLY DATA ───────────────────────────────────
const collectWeeklyData = async (userId, weekData) => {
  const {
    fuel, move, rest, calm, connect, focus,
    streak, activePillars, weeklyImpact,
    history: appHistory2,
    impactHistory,
    ladder,
  } = weekData;

  // Get habit check-in counts — use app history as primary source of truth
  // DB may lag behind when user is using Simulate Next Day in test mode
  const habitDays = {};

  // First try app history (passed from localStorage - always accurate)
  const appHistory = weekData.history || [];
  const recentHistory = appHistory.slice(-7);
  if (recentHistory.length > 0) {
    const PIDS = ["fuel","move","rest","calm","connect","focus"];
    PIDS.forEach(pid => {
      const days = recentHistory.filter(h => h.pillars?.includes(pid)).length;
      if (days > 0) habitDays[pid] = days;
    });
  }

  // Fall back to DB if no app history
  if (Object.keys(habitDays).length === 0) {
    const { rows: checkinRows } = await pool.query(`
      SELECT pillar, COUNT(DISTINCT date) as days_checked
      FROM checkins
      WHERE user_id = $1
      AND created_at > NOW() - INTERVAL '7 days'
      GROUP BY pillar
    `, [userId]);
    checkinRows.forEach(r => { habitDays[r.pillar] = parseInt(r.days_checked); });
  }

  // ── 3-LAYER HABIT SCORE ──────────────────────────────────
  // Layer 1: Consistency (40%) — did they show up?
  // Layer 2: Rung progress (30%) — is it becoming automatic?
  // Layer 3: Self-rated impact (30%) — is it actually working?

  const scores = {};
  const PILLARS = ["fuel","move","rest","calm","connect","focus"];

  // Get rung data from weekData
  const appLadder = weekData.ladder || {};

  // Get latest impact ratings from weekData
  const appImpact = weekData.weeklyImpact || {};


  PILLARS.forEach(pillar => {
    const days = habitDays[pillar] || 0;
    if (days === 0) return; // Skip pillars with no habit data

    // ── LAYER 1: Consistency (40 points max) ──────────────
    // How many days did they check in this week?
    let consistencyScore = 0;
    if (days >= 7) consistencyScore = 40;
    else if (days >= 5) consistencyScore = 34;
    else if (days >= 4) consistencyScore = 28;
    else if (days >= 3) consistencyScore = 20;
    else if (days >= 2) consistencyScore = 12;
    else if (days >= 1) consistencyScore = 6;

    // ── LAYER 2: Rung Progress (30 points max) ────────────
    // Higher rung = more mastery. Habits mastered in current rung = bonus.
    let rungScore = 0;
    const ladder = appLadder[pillar] || {};
    const rung = ladder.rung || 0;
    const habits = ladder.habits || [];
    const masteredCount = habits.filter(h => h.mastered).length;

    // Base rung score (0-20 points)
    rungScore += Math.min(20, rung * 5); // Rung 1=5, Rung 2=10, Rung 3=15, Rung 4=20

    // Mastery bonus within current rung (0-10 points)
    rungScore += Math.min(10, masteredCount * 3.33);

    // ── LAYER 3: Self-rated Impact (30 points max) ────────
    // Weekly feeling rating (0-3 scale → 0-30 points)
    let impactScore = 0;
    const rating = appImpact[pillar]; // 0, 1, 2, or 3
    if (rating !== undefined && rating !== null) {
      impactScore = Math.round((rating / 3) * 30);
    } else {
      // No rating this week — use last known rating if available
      const lastRated = [...impactHistory].reverse().find(h => h.answers?.[pillar] !== undefined);
      if (lastRated) {
        impactScore = Math.round((lastRated.answers[pillar] / 3) * 15); // Half weight for old data
      }
    }

    // ── TOTAL SCORE ───────────────────────────────────────
    const total = Math.round(consistencyScore + rungScore + impactScore);
    scores[pillar] = Math.min(100, total);
  });

  // Also calculate score labels for the report
  const scoreLabels = {};
  Object.entries(scores).forEach(([p, s]) => {
    scoreLabels[p] = s >= 85 ? "Excellent" : s >= 70 ? "Strong" : s >= 55 ? "Building" : s >= 35 ? "Developing" : "Just starting";
  });

  // Only score pillars that have data — skip inactive pillars
  // A user focusing on 3 pillars should not be penalised for the other 3
  const activeScores = Object.entries(scores).filter(([_,s])=>s>0);
  const overall = activeScores.length > 0
    ? Math.round(activeScores.reduce((a,[_,s])=>a+s,0) / activeScores.length)
    : 0;

  // Mark which pillars have scores this week
  const scoredPillars = activeScores.map(([p])=>p);

  return { scores, overall, streak, activePillars: scoredPillars, habitDays, scoreLabels };
};

// ── PILLAR SCORERS ────────────────────────────────────────
// Returns 0 if no data — caller should skip 0-score pillars
const scoreFuel = (fuel={}) => {
  let score = 0;
  const meals = (fuel.meals||[]);
  if (!meals.length && !(fuel.waterGlasses) && !fuel.setup) return 0; // No data
  if (meals.length >= 2) score += 30;
  if (meals.length >= 3) score += 10;
  const targets = fuel.targets || {calories:2000,protein:150};
  const totals = meals.reduce((a,m)=>({cal:a.cal+(m.cal||0),protein:a.protein+(m.protein||0)}),{cal:0,protein:0});
  if (totals.protein >= targets.protein * 0.8) score += 30;
  if (totals.cal >= targets.calories * 0.7 && totals.cal <= targets.calories * 1.1) score += 20;
  if ((fuel.waterGlasses||0) >= 6) score += 10;
  return Math.min(100, score);
};

const scoreMove = (move={}) => {
  let score = 0;
  const steps = move.stepsToday || 0;
  const goal = move.stepGoal || 7000;
  const workouts = move.workouts || [];
  if (steps >= goal) score += 40;
  else if (steps >= goal * 0.5) score += 20;
  if (workouts.length >= 1) score += 40;
  if (workouts.length >= 2) score += 20;
  return Math.min(100, score);
};

const scoreRest = (rest={}) => {
  let score = 0;
  const hours = calcSleepHours(rest.bedtime, rest.wakeTime);
  if (hours >= 7 && hours <= 9) score += 40;
  else if (hours >= 6) score += 20;
  const quality = rest.quality || 0;
  score += quality * 8;
  score += (rest.windDown||[]).length * 2.5;
  return Math.min(100, Math.round(score));
};

const scoreCalm = (calm={}) => {
  let score = 0;
  const stress = calm.stressLevel || 0;
  if (stress > 0) score += Math.round((10 - stress) * 4);
  score += (calm.calmActivities||[]).length * 5;
  score += (calm.gratitude||[]).length * 7;
  if (calm.mood) score += 10;
  return Math.min(100, score);
};

const scoreConnect = (connect={}) => {
  let score = 0;
  const conns = connect.connections || [];
  if (conns.length >= 1) score += 40;
  if (conns.length >= 2) score += 20;
  const avgQ = conns.length ? conns.reduce((a,c)=>a+c.quality,0)/conns.length : 0;
  score += Math.round(avgQ * 6);
  score += (connect.kindness||[]).length * 4;
  const battery = connect.socialBattery || 0;
  if (battery >= 7) score += 10;
  return Math.min(100, score);
};

const scoreFocus = (focus={}) => {
  let score = 0;
  const poms = focus.pomodoros || 0;
  score += Math.min(40, poms * 10);
  const tasks = focus.tasks || [];
  const done = tasks.filter(t=>t.done).length;
  if (tasks.length > 0) score += Math.round((done/tasks.length) * 30);
  score += Math.min(20, (focus.energyLevel||0) * 2);
  score -= Math.min(10, (focus.distractions||[]).length * 2);
  return Math.min(100, Math.max(0, score));
};

const calcSleepHours = (bed, wake) => {
  if (!bed || !wake) return 0;
  const [bh,bm] = bed.split(":").map(Number);
  const [wh,wm] = wake.split(":").map(Number);
  let h = wh - bh + (wm-bm)/60;
  if (h < 0) h += 24;
  return Math.round(h*10)/10;
};

// ── CROSS-PILLAR PATTERN DETECTION ────────────────────────
const detectCrossPillarPatterns = (scores, weekHistory=[]) => {
  const patterns = [];
  const { fuel, move, rest, calm, connect, focus } = scores;

  // Pattern 1: Sleep affects focus
  if (rest < 50 && focus < 50) {
    patterns.push({
      type: "sleep_focus_link",
      pillars: ["rest","focus"],
      message: "Your Rest and Focus both suffered this week — poor sleep directly impairs concentration and deep work capacity.",
      suggestion: "Prioritise sleep next week — even one extra hour can recover 80% of your focus capacity.",
      severity: "high",
    });
  }

  // Pattern 2: Movement boosts mood/calm
  if (move >= 70 && calm >= 60) {
    patterns.push({
      type: "move_calm_boost",
      pillars: ["move","calm"],
      message: "Your movement and calm scores are both strong — exercise is one of the most powerful stress regulators.",
      suggestion: "Keep protecting your movement habit — it's directly supporting your mental wellbeing.",
      severity: "positive",
    });
  } else if (move < 40 && calm < 50) {
    patterns.push({
      type: "move_calm_low",
      pillars: ["move","calm"],
      message: "Low movement and high stress often go hand in hand — physical activity is nature's stress reset.",
      suggestion: "Even a 10-minute walk tomorrow morning could shift both scores significantly.",
      severity: "medium",
    });
  }

  // Pattern 3: Connection affects stress
  if (connect < 40 && calm < 50) {
    patterns.push({
      type: "isolation_stress",
      pillars: ["connect","calm"],
      message: "Low connection and elevated stress this week — social isolation activates the same brain regions as physical pain.",
      suggestion: "One genuine conversation next week can measurably reduce cortisol levels.",
      severity: "medium",
    });
  }

  // Pattern 4: Nutrition affects energy/focus
  if (fuel < 50 && focus < 50) {
    patterns.push({
      type: "fuel_focus_link",
      pillars: ["fuel","focus"],
      message: "Your nutrition and focus both need attention — the brain runs on glucose and protein. Poor fuel = poor focus.",
      suggestion: "Try eating protein within 30 minutes of waking next week and notice the difference in morning clarity.",
      severity: "medium",
    });
  }

  // Pattern 5: Strong overall week
  const avgScore = Object.values(scores).reduce((a,b)=>a+b,0)/6;
  if (avgScore >= 65) {
    patterns.push({
      type: "strong_week",
      pillars: Object.keys(scores),
      message: "This was a genuinely strong week across all pillars. Your habits are compounding.",
      suggestion: "The goal next week is to protect what's working — consistency beats intensity.",
      severity: "positive",
    });
  }

  // Pattern 6: Identify keystone pillar
  const strongest = Object.entries(scores).sort((a,b)=>b[1]-a[1])[0];
  const weakest = Object.entries(scores).sort((a,b)=>a[1]-b[1])[0];

  return {
    patterns,
    keystone: strongest[0],
    keystoneScore: strongest[1],
    weakest: weakest[0],
    weakestScore: weakest[1],
    avgScore: Math.round(avgScore),
  };
};

// ── GENERATE WEEKLY REPORT ────────────────────────────────
const generateWeeklyReport = async (userId, weekData, userName) => {
  const { scores, overall, streak, habitDays, scoreLabels } = await collectWeeklyData(userId, weekData);
  const analysis = detectCrossPillarPatterns(scores);
  analysis.habitDays = habitDays || {};

  const PILLAR_EMOJIS = {fuel:"⚡",move:"💪",rest:"😴",calm:"🧘",connect:"🤝",focus:"🎯"};
  const PILLAR_NAMES  = {fuel:"Fuel",move:"Move",rest:"Rest",calm:"Calm",connect:"Connect",focus:"Focus"};

  // Only show active pillars (those with habit check-ins this week)
  const activeEntries = Object.entries(scores).filter(([_,s])=>s>0);
  const activePillarNames = activeEntries.map(([p])=>PILLAR_NAMES[p]).join(", ");
  const scoreLines = activeEntries
    .map(([p,s])=>{
      const days = habitDays[p]||0;
      const label = scoreLabels?.[p] || "";
      const ladder = weekData.ladder?.[p] || {};
      const rung = (ladder.rung||0) + 1;
      const mastered = (ladder.habits||[]).filter(h=>h.mastered).length;
      const impact = weekData.weeklyImpact?.[p];
      const impactLabels = ["Struggling","Getting by","Improving","Thriving"];
      const impactText = impact !== undefined ? impactLabels[impact] : "not rated";
      return `${PILLAR_EMOJIS[p]} ${PILLAR_NAMES[p]}: ${s}/100 (${label})
  → Consistency: ${days}/7 days checked in
  → Rung progress: Rung ${rung}/5, ${mastered}/3 habits mastered
  → Self-rated: ${impactText}`;
    })
    .join("\n\n");

  // Build impact history for cross-pillar trend analysis
  const impactHistoryLines = (weekData.impactHistory||[]).slice(-6).map((h,i)=>{
    const ratings = Object.entries(h.answers||{})
      .map(([p,s])=>`${PILLAR_NAMES[p]}=${s}`)
      .join(", ");
    return `Week ${i+1} (${h.date||""}): ${ratings}`;
  }).join("\n");

  const patternLines = (analysis.patterns||[]).map(p=>`- ${p.message}`).join("\n");

  const prompt = `Write a deeply personalised weekly wellness report for ${userName||"this person"}.

SCORING SYSTEM — understand this:
Each pillar score (0-100) has 3 components:
- Consistency (40%): how many days they checked in
- Rung progress (30%): their mastery level and habit automation
- Self-rated impact (30%): how they felt this pillar affected their life

ACTIVE PILLARS THIS WEEK:
${scoreLines}

Overall score: ${overall}/100 | Streak: ${streak} days

CROSS-PILLAR HISTORY (last 6 weeks of self-ratings, 0=struggling, 3=thriving):
${impactHistoryLines||"Not enough history yet — this is early days."}

CROSS-PILLAR PATTERNS DETECTED:
${patternLines||"Keep building — patterns emerge with more data."}

RULES:
- Only comment on active pillars listed above
- Use the 3-layer score breakdown to give specific insight (e.g. "your consistency is high but impact rating is low — the habit is happening but not yet creating the feeling you want")
- Use the cross-pillar history to detect TRENDS across weeks — if a pillar keeps dropping, name it. If it's rising, celebrate it specifically.
- If two pillars move together across weeks (both up or both down), point that connection out — that is their personal cross-pillar pattern
- Never penalise missing tracking data
- Sound like a coach who has been watching for weeks, not just this week

Write exactly these 5 sections:
**This Week** — 2-3 sentences. Reference specific scores and what drives them (consistency, rung, feeling).
**Your Biggest Win** — the strongest pillar. Name the specific habit. Reference the score breakdown.
**The Connection You May Not Have Noticed** — use the history to find a real cross-pillar pattern specific to this person. Not generic — use their actual numbers.
**Next Week — 3 Specific Actions** — based on lowest-scoring layer (e.g. if consistency is low, focus on showing up; if impact is low, focus on noticing the feeling)
**One Thought** — one powerful closing line.

Tone: warm, honest, specific. Like a coach who knows their data for weeks.`

  try {
    const report = await callGroq(prompt, undefined, 600);

    // Save to DB
    await pool.query(
      "INSERT INTO insights (user_id, insight_type, content, context) VALUES ($1, $2, $3, $4)",
      [userId, "weekly_report", report, JSON.stringify({scores, patterns:analysis.patterns, overall})]
    );

    return {
      report,
      scores,
      overall,
      analysis,
      generated_at: new Date().toISOString(),
    };
  } catch (err) {
    console.error("Weekly report error:", err);
    return {
      report: `This week you showed up. Your overall score was ${overall}/100. Your strongest pillar was ${PILLAR_NAMES[analysis.keystone]}. Next week — focus on ${PILLAR_NAMES[analysis.weakest]} and protect what is already working.`,
      scores,
      overall,
      analysis,
      generated_at: new Date().toISOString(),
    };
  }
};

module.exports = { generateWeeklyReport, collectWeeklyData, detectCrossPillarPatterns };
