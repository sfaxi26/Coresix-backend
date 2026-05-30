// ── CORESIX BACKEND SERVER ────────────────────────────────
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { pool, setupDB } = require("./db");
const analytics = require("./analytics");
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

  try {
    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{
            parts: [
              {
                inline_data: { mime_type: mimeType || "image/jpeg", data: image }
              },
              {
                text: `Analyse this food image and respond in JSON only with no markdown:
{
  "foods": ["food item 1", "food item 2"],
  "calories": number (total estimate),
  "protein": number (grams),
  "carbs": number (grams),
  "fat": number (grams),
  "insight": "one coaching sentence about this meal and how it fits a healthy diet"
}
Be realistic with estimates. If you cannot identify food, return calories: 0.`
              }
            ]
          }]
        })
      }
    );

    const geminiData = await geminiRes.json();
    const text = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || "{}";

    // Clean and parse JSON
    const clean = text.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(clean);
    res.json(parsed);
  } catch (err) {
    console.error("Food photo error:", err);
    res.status(500).json({ error: "Could not analyse photo. Try again." });
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
