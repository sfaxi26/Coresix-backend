// ── WEEKLY INTELLIGENCE ENGINE ────────────────────────────
// Cross-pillar analysis — the real brain of CoreSix

const { pool } = require("./db");
const { callGroq } = require("./ai");

// ── COLLECT WEEKLY DATA ───────────────────────────────────
const collectWeeklyData = async (userId, weekData) => {
  const {
    fuel, move, rest, calm, connect, focus,
    streak, activePillars, weeklyImpact
  } = weekData;

  // Get habit check-in counts from DB — THIS is the primary metric
  const { rows: checkinRows } = await pool.query(`
    SELECT pillar, COUNT(DISTINCT date) as days_checked
    FROM checkins
    WHERE user_id = $1
    AND created_at > NOW() - INTERVAL '7 days'
    GROUP BY pillar
  `, [userId]);

  const habitDays = {};
  checkinRows.forEach(r => { habitDays[r.pillar] = parseInt(r.days_checked); });

  // Score each pillar — habits are primary (70%), tracking data is bonus (30%)
  const scores = {};
  const PILLARS = ["fuel","move","rest","calm","connect","focus"];

  PILLARS.forEach(pillar => {
    const days = habitDays[pillar] || 0;
    if (days === 0) return; // Skip pillars with no habit data

    // Primary score: habit consistency (70 points max)
    let habitScore = 0;
    if (days >= 7) habitScore = 70;
    else if (days >= 5) habitScore = 60;
    else if (days >= 3) habitScore = 45;
    else if (days >= 1) habitScore = 25;

    // Bonus score: tracking data (30 points max)
    let trackingBonus = 0;
    const trackingData = {fuel,move,rest,calm,connect,focus}[pillar];
    if (trackingData) {
      if (pillar==="fuel" && (trackingData.meals||[]).length>0) trackingBonus += 30;
      if (pillar==="move" && ((trackingData.stepsToday||0)>0||(trackingData.workouts||[]).length>0)) trackingBonus += 30;
      if (pillar==="rest" && trackingData.bedtime) trackingBonus += 30;
      if (pillar==="calm" && ((trackingData.calmActivities||[]).length>0||trackingData.stressLevel>0)) trackingBonus += 30;
      if (pillar==="connect" && (trackingData.connections||[]).length>0) trackingBonus += 30;
      if (pillar==="focus" && (trackingData.pomodoros||0)>0) trackingBonus += 30;
    }

    scores[pillar] = Math.min(100, habitScore + trackingBonus);
  });

  // Only score pillars that have data — skip inactive pillars
  // A user focusing on 3 pillars should not be penalised for the other 3
  const activeScores = Object.entries(scores).filter(([_,s])=>s>0);
  const overall = activeScores.length > 0
    ? Math.round(activeScores.reduce((a,[_,s])=>a+s,0) / activeScores.length)
    : 0;

  // Mark which pillars are active
  const activePillars = activeScores.map(([p])=>p);

  return { scores, overall, streak, activePillars };
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
  const { scores, overall, streak } = await collectWeeklyData(userId, weekData);
  const analysis = detectCrossPillarPatterns(scores);

  const PILLAR_EMOJIS = {fuel:"⚡",move:"💪",rest:"😴",calm:"🧘",connect:"🤝",focus:"🎯"};
  const PILLAR_NAMES  = {fuel:"Fuel",move:"Move",rest:"Rest",calm:"Calm",connect:"Connect",focus:"Focus"};

  const scoreLines = Object.entries(scores)
    .map(([p,s])=>`${PILLAR_EMOJIS[p]} ${PILLAR_NAMES[p]}: ${s}/100`)
    .join("\n");

  const patternLines = analysis.patterns
    .map(p=>`- ${p.message}`)
    .join("\n");

  const prompt = `
Write a personalised weekly wellness report for ${userName||"this person"}.

Their ACTIVE pillar scores this week.
Score = based on habit check-ins (primary) + optional tracking data (bonus).
Pillars not listed = user is not focused on them. Do NOT mention them.

${scoreLines}

HOW TO READ THESE SCORES:
- 70-100 = Excellent habit consistency this week
- 45-69  = Good — showing up most days
- 25-44  = Developing — needs more consistency
- Tracking bonus adds up to 30 extra points if they logged meals/steps/sleep etc

IMPORTANT: If someone scored 70 on Move with no tracking data — they did their habit every day. That is EXCELLENT. Do not mention missing tracking.

Overall score: ${overall}/100
Current streak: ${streak} days
Strongest pillar: ${PILLAR_NAMES[analysis.keystone]} (${analysis.keystoneScore}/100)
Needs most attention: ${PILLAR_NAMES[analysis.weakest]} (${analysis.weakestScore}/100)

Cross-pillar patterns detected:
${patternLines||"No significant patterns yet — more data needed."}

Write a report with exactly this structure (use these headers):
**This Week**
2-3 sentences summarising the week honestly. Reference specific scores. Sound like a coach who was watching.

**Your Biggest Win**
1-2 sentences about what they did best. Be specific. Reference the strongest pillar.

**The Connection You May Not Have Noticed**
1-2 sentences about ONE cross-pillar connection from their data. Make it feel like a discovery.

**Next Week — 3 Specific Actions**
Three numbered specific, actionable suggestions. Each one sentence. Reference their actual weak areas.

**One Thought**
End with one powerful coaching sentence. Make it land.

Tone: warm, direct, science-backed. Like the best coach they never had.
Do NOT use generic advice. Everything must reference their specific scores and patterns.`;

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
