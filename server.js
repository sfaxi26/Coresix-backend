// ── CORESIX BACKEND SERVER ────────────────────────────────
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { pool, setupDB } = require("./db");
const analytics = require("./analytics");
const weekly = require('./weekly');
const { generateInsight } = require("./ai");

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors({
  origin: function(origin, callback) {
    // Allow Vercel, localhost, and any vercel preview URLs
    const allowed = [
      "https://coresix-app.vercel.app",
      "http://localhost:3000",
    ];
    if (!origin || allowed.includes(origin) || origin.includes("vercel.app")) {
      callback(null, true);
    } else {
      callback(new Error("Not allowed by CORS"));
    }
  },
  credentials: true,
}));
app.use(express.json());

// ── ERROR HANDLERS ───────────────────────────────────────
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err.message);
});

// ── HEALTH CHECK ──────────────────────────────────────────
app.get("/", async (req, res) => {
  let dbStatus = "unknown";
  try {
    await pool.query("SELECT 1");
    dbStatus = "connected";
  } catch (e) {
    dbStatus = "error: " + e.message;
  }
  res.json({
    status: "CoreSix brain is running",
    version: "1.0.0",
    db: dbStatus,
    env: {
      has_db_url: !!process.env.DATABASE_URL,
      has_groq: !!process.env.GROQ_API_KEY,
      has_gemini: !!process.env.GEMINI_API_KEY,
      node_env: process.env.NODE_ENV,
    }
  });
});

// ── USER ──────────────────────────────────────────────────

// Get or create user by device ID
app.post("/api/user", async (req, res) => {
  const { deviceId, name, profile, scores } = req.body;
  if (!deviceId) return res.status(400).json({ error: "deviceId required" });

  try {
    const existing = await pool.query("SELECT * FROM users WHERE id = $1", [deviceId]);

    if (existing.rows.length === 0) {
      // New user
      await pool.query(
        "INSERT INTO users (id, name, profile, scores) VALUES ($1, $2, $3, $4)",
        [deviceId, name || "", profile || {}, scores || {}]
      );
      // Initialise ladder for all pillars
      const pillars = ["fuel","move","rest","calm","connect","focus"];
      for (const pillar of pillars) {
        await pool.query(
          "INSERT INTO ladder (user_id, pillar) VALUES ($1, $2) ON CONFLICT DO NOTHING",
          [deviceId, pillar]
        );
      }
      res.json({ created: true, id: deviceId });
    } else {
      // Update user
      await pool.query(
        `UPDATE users SET
          name = COALESCE($2, name),
          profile = COALESCE($3, profile),
          scores = COALESCE($4, scores),
          last_active = NOW()
         WHERE id = $1`,
        [deviceId, name, profile, scores]
      );
      res.json({ created: false, id: deviceId, user: existing.rows[0] });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Get full user state
app.get("/api/user/:deviceId", async (req, res) => {
  const { deviceId } = req.params;
  try {
    const [userRes, ladderRes] = await Promise.all([
      pool.query("SELECT * FROM users WHERE id = $1", [deviceId]),
      pool.query("SELECT * FROM ladder WHERE user_id = $1", [deviceId]),
    ]);

    if (!userRes.rows.length) return res.status(404).json({ error: "User not found" });

    const user = userRes.rows[0];
    const ladder = {};
    ladderRes.rows.forEach(r => {
      ladder[r.pillar] = {
        rung: r.rung,
        days: r.days,
        selected: r.selected_habit,
      };
    });

    res.json({ ...user, ladder });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── LADDER ────────────────────────────────────────────────

// Update ladder rung
app.post("/api/ladder", async (req, res) => {
  const { deviceId, pillar, rung, days, selected } = req.body;
  try {
    await pool.query(
      `UPDATE ladder SET rung=$3, days=$4, selected_habit=$5, updated_at=NOW()
       WHERE user_id=$1 AND pillar=$2`,
      [deviceId, pillar, rung, days, selected]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── CHECK-INS ─────────────────────────────────────────────

// Log a habit check-in
app.post("/api/checkin", async (req, res) => {
  const { deviceId, pillar, habit, date } = req.body;
  try {
    // Save checkin
    await pool.query(
      "INSERT INTO checkins (user_id, pillar, habit, date) VALUES ($1, $2, $3, $4)",
      [deviceId, pillar, habit, date]
    );

    // Update ladder days
    await pool.query(
      "UPDATE ladder SET days = days + 1 WHERE user_id=$1 AND pillar=$2",
      [deviceId, pillar]
    );

    // Check if all active pillars done today
    const { rows: todayCheckins } = await pool.query(
      "SELECT DISTINCT pillar FROM checkins WHERE user_id=$1 AND date=$2",
      [deviceId, date]
    );

    res.json({ ok: true, pillars_done_today: todayCheckins.map(r => r.pillar) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update streak
app.post("/api/streak", async (req, res) => {
  const { deviceId, streak, date } = req.body;
  try {
    await pool.query(
      "UPDATE users SET streak=$2, last_checkin_date=$3 WHERE id=$1",
      [deviceId, streak, date]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── WEEKLY IMPACT ─────────────────────────────────────────

// Save weekly impact answers
app.post("/api/impact", async (req, res) => {
  const { deviceId, weekKey, answers } = req.body;
  try {
    for (const [pillar, score] of Object.entries(answers)) {
      await pool.query(
        `INSERT INTO weekly_impact (user_id, week_key, pillar, score)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT DO NOTHING`,
        [deviceId, weekKey, pillar, score]
      );
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get impact history
app.get("/api/impact/:deviceId", async (req, res) => {
  const { deviceId } = req.params;
  try {
    const { rows } = await pool.query(
      `SELECT week_key, pillar, score, created_at
       FROM weekly_impact WHERE user_id=$1
       ORDER BY created_at DESC LIMIT 42`,
      [deviceId]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── BRAIN ENDPOINTS ───────────────────────────────────────

// Get analytics for a user
app.get("/api/analytics/:deviceId", async (req, res) => {
  const { deviceId } = req.params;
  try {
    const [consistency, patterns, trends, streak] = await Promise.all([
      analytics.getConsistencyScores(deviceId),
      analytics.detectPatterns(deviceId),
      analytics.getImpactTrends(deviceId),
      analytics.getStreakAnalysis(deviceId),
    ]);

    res.json({ consistency, patterns, trends, streak });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Generate AI insight
app.post("/api/insight", async (req, res) => {
  const { deviceId, purpose, pillar } = req.body;
  try {
    const context = await analytics.packageContextForAI(deviceId, purpose);
    if (pillar) context.pillar = pillar;

    const insight = await generateInsight(context, purpose);

    // Save insight to DB
    await pool.query(
      "INSERT INTO insights (user_id, insight_type, content, context) VALUES ($1, $2, $3, $4)",
      [deviceId, purpose, insight.content, JSON.stringify(insight.context_used)]
    );

    res.json(insight);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get patterns for user
app.get("/api/patterns/:deviceId", async (req, res) => {
  const { deviceId } = req.params;
  try {
    const { rows } = await pool.query(
      `SELECT pattern_type, pattern_data, detected_at
       FROM patterns WHERE user_id=$1
       ORDER BY detected_at DESC LIMIT 10`,
      [deviceId]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── FOOD PHOTO ANALYSIS ──────────────────────────────────
app.post("/api/food-photo", async (req, res) => {
  const { image, mimeType } = req.body;
  if (!image) return res.status(400).json({ error: "No image provided" });
  if (!process.env.GEMINI_API_KEY) return res.status(500).json({ error: "Gemini API key not configured" });

  console.log("Food photo request received, image size:", image.length);

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25000);

    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          contents: [{
            parts: [
              { inline_data: { mime_type: mimeType || "image/jpeg", data: image } },
              { text: `Analyse this food image. Respond in JSON only, no markdown, no explanation:
{"foods":["item1","item2"],"calories":300,"protein":25,"carbs":30,"fat":10,"insight":"One sentence nutrition coaching tip."}
Estimate realistic values. If not food, return all zeros.` }
            ]
          }],
          generationConfig: { temperature: 0.1, maxOutputTokens: 256 }
        })
      }
    );
    clearTimeout(timeout);

    console.log("Gemini response status:", geminiRes.status);
    const geminiData = await geminiRes.json();
    console.log("Gemini response:", JSON.stringify(geminiData).slice(0, 200));

    const text = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
    const clean = text.replace(/```json|```/g, "").trim();

    try {
      const parsed = JSON.parse(clean);
      res.json(parsed);
    } catch {
      // Try to extract JSON from text
      const match = clean.match(/\{[\s\S]*\}/);
      if (match) {
        res.json(JSON.parse(match[0]));
      } else {
        res.json({ foods:["Unknown food"], calories:0, protein:0, carbs:0, fat:0, insight:"Could not identify food clearly. Try a clearer photo." });
      }
    }
  } catch (err) {
    console.error("Food photo error:", err.message);
    if (err.name === "AbortError") {
      res.status(504).json({ error: "Analysis took too long. Try a smaller photo." });
    } else {
      res.status(500).json({ error: "Could not analyse photo: " + err.message });
    }
  }
});

// ── SMART NEXT WEEK PLAN ─────────────────────────────────
app.post("/api/next-week-plan", async (req, res) => {
  const { deviceId, weekData } = req.body;
  if (!deviceId) return res.status(400).json({ error: "deviceId required" });

  try {
    const { rows: userRows } = await pool.query("SELECT name, streak FROM users WHERE id=$1", [deviceId]);
    const user = userRows[0] || {};

    // Get last 4 weeks of data
    const { rows: checkinRows } = await pool.query(`
      SELECT pillar, EXTRACT(DOW FROM created_at) as day_of_week,
             COUNT(*) as checkins
      FROM checkins
      WHERE user_id = $1
      AND created_at > NOW() - INTERVAL '28 days'
      GROUP BY pillar, day_of_week
      ORDER BY day_of_week
    `, [deviceId]);

    // Find weakest days per pillar
    const dayNames = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
    const pillarWeakDays = {};
    const dayCheckins = {};
    checkinRows.forEach(r => {
      const day = parseInt(r.day_of_week);
      if (!dayCheckins[day]) dayCheckins[day] = 0;
      dayCheckins[day] += parseInt(r.checkins);
    });

    // Find 2 lowest check-in days
    const sortedDays = Object.entries(dayCheckins)
      .sort((a,b)=>a[1]-b[1])
      .slice(0,2)
      .map(([day])=>dayNames[parseInt(day)]);

    // Get cross-pillar patterns
    const crossPatterns = await analytics.detectCrossPillarPatterns(deviceId);
    const warnings = await analytics.generatePredictiveWarnings(deviceId);

    // Get pillar scores from weekly impact
    const { rows: impactRows } = await pool.query(`
      SELECT pillar, AVG(score) as avg
      FROM weekly_impact
      WHERE user_id = $1
      AND created_at > NOW() - INTERVAL '14 days'
      GROUP BY pillar
      ORDER BY avg ASC
    `, [deviceId]);

    const weakPillars = impactRows.slice(0,3).map(r=>r.pillar);
    const strongPillars = impactRows.slice(-2).map(r=>r.pillar);

    const PILLAR_NAMES = {fuel:"Fuel",move:"Move",rest:"Rest",calm:"Calm",connect:"Connect",focus:"Focus"};
    const PILLAR_EMOJIS = {fuel:"⚡",move:"💪",rest:"😴",calm:"🧘",connect:"🤝",focus:"🎯"};

    const nextMonday = new Date();
    nextMonday.setDate(nextMonday.getDate() + (1 + 7 - nextMonday.getDay()) % 7 || 7);
    const weekOf = nextMonday.toLocaleDateString("en",{month:"long",day:"numeric"});

    const { callGroq } = require("./ai");

    const prompt = `Create a Smart Next Week Plan for ${user.name||"this person"} based on their CoreSix data.

Week of: ${weekOf}
Current streak: ${user.streak || 0} days
Weakest pillars this week: ${weakPillars.map(p=>`${PILLAR_EMOJIS[p]} ${PILLAR_NAMES[p]}`).join(", ")||"unknown"}
Strongest pillars: ${strongPillars.map(p=>`${PILLAR_EMOJIS[p]} ${PILLAR_NAMES[p]}`).join(", ")||"unknown"}
Historically hard days: ${sortedDays.join(" and ")||"unknown"}
Active cross-pillar patterns: ${crossPatterns.slice(0,2).map(p=>p.message).join("; ")||"none detected"}
Current warnings: ${warnings.slice(0,2).map(w=>w.title).join("; ")||"none"}
This week's data: ${JSON.stringify(weekData||{})}

Generate exactly 3 specific action items for next week. Each action must:
1. Reference a specific day or time window
2. Be based on their actual data — not generic advice
3. Address their weakest areas or break a detected pattern
4. Be achievable in 5-15 minutes

Format your response as JSON only — no markdown, no explanation:
{
  "week_of": "${weekOf}",
  "headline": "one sentence summarising the theme of next week",
  "actions": [
    {
      "pillar": "rest",
      "emoji": "😴",
      "title": "Short action title",
      "description": "Specific description referencing their data and exact days/times",
      "days": ["Wednesday", "Thursday"],
      "why": "One sentence explaining why this matters based on their patterns"
    },
    {
      "pillar": "move",
      "emoji": "💪",
      "title": "Short action title",
      "description": "Specific description",
      "days": ["Tuesday", "Friday"],
      "why": "Why this matters for them specifically"
    },
    {
      "pillar": "connect",
      "emoji": "🤝",
      "title": "Short action title",
      "description": "Specific description",
      "days": ["Thursday"],
      "why": "Why this matters for them specifically"
    }
  ],
  "protect": "One sentence about what is already working and must be protected",
  "streak_note": "One sentence about the streak — honest, not generic"
}`;

    const raw = await callGroq(prompt, undefined, 600);
    let plan;
    try {
      const clean = raw.replace(/```json|```/g,"").trim();
      plan = JSON.parse(clean);
    } catch {
      // Fallback plan
      plan = {
        week_of: weekOf,
        headline: "This week — protect what works and strengthen what doesn't.",
        actions: [
          { pillar:"rest", emoji:"😴", title:"Protect your sleep", description:"Set a consistent bedtime for at least 4 nights this week.", days:["Monday","Tuesday","Wednesday","Thursday"], why:"Rest is the foundation everything else builds on." },
          { pillar:"move", emoji:"💪", title:"Move every day", description:"10 minutes of movement — walk, stretch, or workout.", days:["Monday","Tuesday","Wednesday","Thursday","Friday"], why:"Daily movement compounds faster than intense occasional sessions." },
          { pillar:"connect", emoji:"🤝", title:"One genuine connection", description:"Send one meaningful message to someone you've been meaning to reach out to.", days:["Wednesday"], why:"Connection is the most underinvested pillar for most people." },
        ],
        protect: "Keep doing what's working — your habits are building.",
        streak_note: `Your ${user.streak||0}-day streak is real progress. Protect it.`,
      };
    }

    // Save to insights
    await pool.query(
      "INSERT INTO insights (user_id, insight_type, content, context) VALUES ($1, $2, $3, $4)",
      [deviceId, "next_week_plan", JSON.stringify(plan), JSON.stringify({weakPillars, sortedDays})]
    );

    res.json({ plan });
  } catch (err) {
    console.error("Next week plan error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ── MONTHLY PROGRESS LETTER ──────────────────────────────
app.post("/api/monthly-letter", async (req, res) => {
  const { deviceId, monthData } = req.body;
  if (!deviceId) return res.status(400).json({ error: "deviceId required" });

  try {
    const { rows: userRows } = await pool.query("SELECT name, streak FROM users WHERE id=$1", [deviceId]);
    const user = userRows[0] || {};

    // Get monthly stats
    const { rows: checkinRows } = await pool.query(`
      SELECT pillar, COUNT(*) as count,
             COUNT(DISTINCT date) as days_active
      FROM checkins
      WHERE user_id = $1
      AND created_at > NOW() - INTERVAL '30 days'
      GROUP BY pillar
    `, [deviceId]);

    const { rows: impactRows } = await pool.query(`
      SELECT pillar, AVG(score) as avg_score
      FROM weekly_impact
      WHERE user_id = $1
      AND created_at > NOW() - INTERVAL '30 days'
      GROUP BY pillar
    `, [deviceId]);

    const { rows: totalDaysRow } = await pool.query(`
      SELECT COUNT(DISTINCT date) as days
      FROM checkins
      WHERE user_id = $1
      AND created_at > NOW() - INTERVAL '30 days'
    `, [deviceId]);

    const totalDays = parseInt(totalDaysRow[0]?.days || 0);
    const pillarStats = {};
    checkinRows.forEach(r => {
      pillarStats[r.pillar] = { count: parseInt(r.count), days: parseInt(r.days_active) };
    });

    const impactScores = {};
    impactRows.forEach(r => { impactScores[r.pillar] = Math.round(parseFloat(r.avg_score) * 25); });

    const bestPillar = Object.entries(pillarStats).sort((a,b)=>b[1].days-a[1].days)[0];
    const mostImproved = Object.entries(impactScores).sort((a,b)=>b[1]-a[1])[0];

    const { callGroq } = require("./ai");

// Only mention pillars the person actually worked on
    const activePillarList = Object.keys(pillarStats).filter(p=>pillarStats[p].days>0);
    const activePillarSummary = activePillarList
      .map(p=>`${p}: ${pillarStats[p].days} days`)
      .join(", ");

    const prompt = `Write a warm, personal monthly progress letter for ${user.name||"this person"} from CoreSix.

STRICT RULES:
- Only mention pillars they actually worked on: ${activePillarSummary||"building habits"}
- DO NOT mention pillars with no data — user was not focusing on them
- Habit consistency is the primary success metric
- Missing tracking data (no meal logs, no step counts) is NOT a failure — never mention it
- ${totalDays} days out of 30 is the real number — be honest about it

Their month:
- Days showed up: ${totalDays}/30
- Streak: ${user.streak||0} days
- Active pillars: ${activePillarSummary||"getting started"}
- Best pillar: ${bestPillar?.[0]||"building"} (${bestPillar?.[1]?.days||0} days)

Write this letter:

Dear ${user.name||"there"},

[Opening — honest, warm. Reference ${totalDays} days specifically.]

[Progress — what the habit data actually shows. Only mention active pillars.]

[One shift you noticed — something meaningful, however small.]

[Identity — connect habits to who they are becoming.]

[Next month — one specific focus. Achievable.]

[Closing — one powerful line.]

With you,
CoreSix

Tone: best coach they never had. Warm, honest, specific. Max 280 words.`;

    const letter = await callGroq(prompt, undefined, 500);

    // Save to insights
    await pool.query(
      "INSERT INTO insights (user_id, insight_type, content, context) VALUES ($1, $2, $3, $4)",
      [deviceId, "monthly_letter", letter, JSON.stringify({ totalDays, pillarStats, impactScores })]
    );

    const month = new Date().toLocaleDateString("en", { month:"long", year:"numeric" });
    res.json({ letter, month, stats: { totalDays, pillarStats, impactScores, streak: user.streak } });
  } catch (err) {
    console.error("Monthly letter error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ── PREDICTIVE WARNINGS ──────────────────────────────────
app.get("/api/warnings/:deviceId", async (req, res) => {
  const { deviceId } = req.params;
  try {
    const warnings = await analytics.generatePredictiveWarnings(deviceId);
    res.json({ warnings });
  } catch (err) {
    console.error("Warnings error:", err);
    res.status(500).json({ error: err.message, warnings: [] });
  }
});

// ── CROSS-PILLAR PATTERNS ────────────────────────────────
app.get("/api/cross-patterns/:deviceId", async (req, res) => {
  const { deviceId } = req.params;
  try {
    const [crossPatterns, ripple] = await Promise.all([
      analytics.detectCrossPillarPatterns(deviceId),
      analytics.getPillarRippleEffect(deviceId),
    ]);
    res.json({ patterns: crossPatterns, ripple });
  } catch (err) {
    console.error("Cross-patterns error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ── PREDICTIVE NUDGE ──────────────────────────────────────
app.post("/api/predictive-nudge", async (req, res) => {
  const { deviceId, currentPillarData } = req.body;
  try {
    const [crossPatterns, consistency] = await Promise.all([
      analytics.detectCrossPillarPatterns(deviceId),
      analytics.getConsistencyScores(deviceId),
    ]);

    // Find most urgent actionable pattern
    const urgent = crossPatterns
      .filter(p => p.actionable && p.severity === "high")
      .sort((a,b) => a.severity === "high" ? -1 : 1)[0]
      || crossPatterns.find(p => p.actionable);

    if (!urgent) return res.json({ nudge: null });

    // Generate AI nudge based on pattern
    const { rows: userRows } = await pool.query("SELECT name FROM users WHERE id=$1", [deviceId]);
    const name = userRows[0]?.name || "there";

    const prompt = `You are CoreSix. Generate a gentle, specific nudge for ${name} based on this cross-pillar pattern:

Pattern: ${urgent.title}
Context: ${urgent.message}
Suggested action: ${urgent.suggestion}
Pillars affected: ${urgent.pillars.join(", ")}

Write ONE sentence that feels like it comes from a wise friend who noticed something important.
Do NOT be alarming. Be warm and specific. Reference the connection between pillars.`;

    const { callGroq } = require("./ai");
    const nudgeText = await callGroq(prompt, undefined, 80);

    res.json({
      nudge: {
        text: nudgeText,
        pattern: urgent,
        priority: urgent.severity,
      }
    });
  } catch (err) {
    console.error("Nudge error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ── WEEKLY INTELLIGENCE REPORT ───────────────────────────
app.post("/api/weekly-report", async (req, res) => {
  const { deviceId, weekData } = req.body;
  if (!deviceId || !weekData) return res.status(400).json({ error: "deviceId and weekData required" });

  try {
    // Get user name
    const { rows } = await pool.query("SELECT name FROM users WHERE id=$1", [deviceId]);
    const userName = rows[0]?.name || "there";

    const result = await weekly.generateWeeklyReport(deviceId, weekData, userName);
    res.json(result);
  } catch (err) {
    console.error("Weekly report error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ── DASHBOARD DATA ────────────────────────────────────────

// Get full dashboard in one call
app.get("/api/dashboard/:deviceId", async (req, res) => {
  const { deviceId } = req.params;
  try {
    const [consistency, patterns, trends, streak, userRes, ladderRes, impactRes] = await Promise.all([
      analytics.getConsistencyScores(deviceId),
      analytics.detectPatterns(deviceId),
      analytics.getImpactTrends(deviceId),
      analytics.getStreakAnalysis(deviceId),
      pool.query("SELECT * FROM users WHERE id=$1", [deviceId]),
      pool.query("SELECT * FROM ladder WHERE user_id=$1", [deviceId]),
      pool.query(
        "SELECT week_key, pillar, score FROM weekly_impact WHERE user_id=$1 ORDER BY created_at DESC LIMIT 18",
        [deviceId]
      ),
    ]);

    const ladder = {};
    ladderRes.rows.forEach(r => {
      ladder[r.pillar] = { rung: r.rung, days: r.days, selected: r.selected_habit };
    });

    res.json({
      user: userRes.rows[0],
      ladder,
      analytics: { consistency, patterns, trends, streak },
      impact_history: impactRes.rows,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── START ─────────────────────────────────────────────────
const server = app.listen(PORT, () => {
  console.log(`🧠 CoreSix brain running on port ${PORT}`);
});

server.on("listening", () => {
  // Setup DB after server starts — never crash on DB failure
  setTimeout(() => {
    setupDB()
      .then(() => console.log("✅ Database connected"))
      .catch(err => console.error("⚠️ DB warning:", err.message));
  }, 1000);
});
