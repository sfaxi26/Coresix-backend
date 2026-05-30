// ── DATABASE ─────────────────────────────────────────────
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // Required for Supabase
});

// ── SCHEMA SETUP ─────────────────────────────────────────
const setupDB = async () => {
  const client = await pool.connect();
  try {
    await client.query(`
      -- Users table
      CREATE TABLE IF NOT EXISTS users (
        id VARCHAR(64) PRIMARY KEY,
        name VARCHAR(100),
        created_at TIMESTAMP DEFAULT NOW(),
        last_active TIMESTAMP DEFAULT NOW(),
        profile JSONB DEFAULT '{}',
        scores JSONB DEFAULT '{}',
        streak INTEGER DEFAULT 0,
        last_checkin_date VARCHAR(20)
      );

      -- Ladder table — tracks rung progress per pillar
      CREATE TABLE IF NOT EXISTS ladder (
        user_id VARCHAR(64),
        pillar VARCHAR(20),
        rung INTEGER DEFAULT 0,
        days INTEGER DEFAULT 0,
        selected_habit TEXT,
        updated_at TIMESTAMP DEFAULT NOW(),
        PRIMARY KEY (user_id, pillar)
      );

      -- Daily checkins
      CREATE TABLE IF NOT EXISTS checkins (
        id SERIAL PRIMARY KEY,
        user_id VARCHAR(64),
        pillar VARCHAR(20),
        habit TEXT,
        date VARCHAR(20),
        created_at TIMESTAMP DEFAULT NOW()
      );

      -- Weekly impact answers
      CREATE TABLE IF NOT EXISTS weekly_impact (
        id SERIAL PRIMARY KEY,
        user_id VARCHAR(64),
        week_key VARCHAR(20),
        pillar VARCHAR(20),
        score INTEGER,
        created_at TIMESTAMP DEFAULT NOW()
      );

      -- Pattern log — backend brain writes here
      CREATE TABLE IF NOT EXISTS patterns (
        id SERIAL PRIMARY KEY,
        user_id VARCHAR(64),
        pattern_type VARCHAR(50),
        pattern_data JSONB,
        detected_at TIMESTAMP DEFAULT NOW()
      );

      -- AI insights sent to user
      CREATE TABLE IF NOT EXISTS insights (
        id SERIAL PRIMARY KEY,
        user_id VARCHAR(64),
        insight_type VARCHAR(50),
        content TEXT,
        context JSONB,
        created_at TIMESTAMP DEFAULT NOW()
      );

      -- Indexes for performance
      CREATE INDEX IF NOT EXISTS idx_checkins_user ON checkins(user_id);
      CREATE INDEX IF NOT EXISTS idx_checkins_date ON checkins(date);
      CREATE INDEX IF NOT EXISTS idx_patterns_user ON patterns(user_id);
      CREATE INDEX IF NOT EXISTS idx_weekly_impact_user ON weekly_impact(user_id);
    `);
    console.log("✅ Database schema ready");
  } finally {
    client.release();
  }
};

module.exports = { pool, setupDB };
