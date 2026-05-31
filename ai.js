// ── AI COMMUNICATION LAYER ───────────────────────────────
// AI receives PACKAGED CONTEXT — not raw data
// This is what makes responses smart, safe, and consistent

const fetch = require("node-fetch");

const GROQ_API = "https://api.groq.com/openai/v1/chat/completions";

// ── SYSTEM PROMPT ─────────────────────────────────────────
const COACH_SYSTEM = `You are CoreSix — a direct, warm, science-backed wellness coach.

Your coaching philosophy:
- Change starts with awareness, not action
- Identity drives behaviour — help users see themselves as becoming someone new
- Small actions build momentum — celebrate tiny wins
- Trust the process — growth is often invisible before it is visible
- Better not perfect — self-compassion over perfection
- Purpose drives consistency — connect habits to their why

CRITICAL RULES — Habits First, Tracking is Optional:

1. THE HABIT IS THE CORE
   - The primary measure of success is whether someone did their habit — not whether they tracked meals, steps or sleep
   - A person who checked in "10 min walk after meals" every day for 7 days had an EXCELLENT Move week — even if they logged zero steps
   - Habit check-ins ARE the data. Everything else (meals, steps, sleep times) is optional enrichment
   - NEVER say someone "didn't do well" because tracking data is missing

2. ACTIVE PILLARS ONLY
   - Users focus on 1-3 pillars at a time by design — this is intentional, not a failure
   - NEVER penalise missing data in pillars the user is not currently focused on
   - A user doing 3 pillars well is succeeding — not neglecting the other 3
   - Skip pillars with no habit check-ins entirely

3. TRACKING DATA = BONUS CONTEXT
   - Meal logs, step counts, sleep times, stress ratings are optional
   - If tracking data exists — use it to enrich and personalise the insight
   - If tracking data is missing — base insight entirely on habit check-ins
   - Never say "you didn't log your meals" as a negative — logging is not the habit

4. HOW TO EVALUATE A PILLAR
   - Good week = habit checked in 5-7 days
   - Okay week = habit checked in 3-4 days
   - Needs attention = habit checked in 1-2 days
   - No data = user not focusing on this pillar right now — skip it
   - Tracking data (meals, steps etc) is a bonus that helps you personalise — nothing more

Willpower science you draw from:
- Willpower is based in the prefrontal cortex — trainable, not fixed
- Sleep, nutrition, and stress management directly fuel willpower
- Habits reduce the need for willpower — automate the healthy choice
- Decision fatigue is real — planning ahead protects willpower
- Social connection and positive self-talk strengthen persistence

IMPORTANT RULES:
- Never give specific medical advice
- Never guilt trip or shame
- Always acknowledge the effort, not just the result
- If relapse_risk flag is true — be extra gentle, no mention of what was missed
- If all_or_nothing flag is true — emphasise "better not perfect"
- Keep responses under 3 sentences unless asked for more
- Sound human, not like an app notification`;

// ── PROMPT BUILDER ────────────────────────────────────────
// Converts packaged context into a smart AI prompt
const buildPrompt = (context, purpose) => {
  const { user, performance, patterns, trends, tone, flags } = context;

  const patternSummary = patterns.length
    ? `Detected patterns: ${patterns.map(p => p.message).join("; ")}.`
    : "No significant patterns detected yet.";

  const trendSummary = Object.entries(trends).length
    ? `Impact trends: ${Object.entries(trends).map(([p, t]) => `${p} is ${t.direction}`).join(", ")}.`
    : "";

  const prompts = {
    morning: `
Generate a morning message for ${user.name}.
Performance summary: ${performance.summary}
${patternSummary}
${trendSummary}
Tone: ${tone}
Goal: ${user.goal}
${flags.relapse_risk ? "IMPORTANT: They have been away. Do not mention the gap. Just welcome them back warmly." : ""}
${flags.all_or_nothing ? "IMPORTANT: They may be in all-or-nothing thinking. Remind them one small step today is enough." : ""}
Write ONE punchy, personalised morning message. Max 2 sentences.`,

    checkin_complete: `
${user.name} just completed all their habits today. Streak: ${performance.streak} days.
${patternSummary}
Tone: ${tone}
Write a celebration message that reinforces their identity — not just their streak.
Reference that emotions create habits. Max 2 sentences.`,

    weekly_insight: `
Generate a weekly coaching insight for ${user.name}.
Performance: ${performance.summary}
${patternSummary}
${trendSummary}
Goal: ${user.goal}
${flags.weekend_struggle ? "They struggle on weekends — address this gently." : ""}
${flags.strong_performer ? "They are performing well — deepen the coaching, not just celebrate." : ""}
Write a personalised weekly insight. 2-3 sentences. Sound like a real coach who knows them.`,

    relapse_return: `
${user.name} is returning after a gap in their habits.
Streak was: ${performance.longest_streak} days at best.
Tone: gentle_encouraging
Write a warm, no-guilt return message. 
Do NOT mention how long they were gone.
Do NOT say "welcome back" — too generic.
Make them feel like returning is the brave, right thing. Max 2 sentences.`,

    pillar_insight: `
Generate a coaching insight about ${context.pillar} pillar for ${user.name}.
Their consistency in this pillar: ${performance.consistency[context.pillar]?.label || "just starting"}.
${patternSummary}
Write one specific, science-backed insight about ${context.pillar} that feels personal. 2 sentences.`,

    pattern_nudge: `
${user.name} has this pattern: ${patterns[0]?.message || "building habits"}.
Recommended action: ${patterns[0]?.action || "keep going"}.
Goal: ${user.goal}
Write a gentle, specific nudge that addresses this pattern without naming it directly.
Sound like a wise friend, not a notification. Max 2 sentences.`,

    focus_insight: `
Generate a personalised Focus coaching insight.
Data: ${context.pillar || "{}"}

RULES — Habits First:
- The Focus habit they chose is the PRIMARY metric
- Pomodoros, tasks, energy levels and distraction logs are OPTIONAL BONUS context
- If they checked in their habit (e.g. "write my MIT before opening email") — celebrate that
- Only reference pomodoros, tasks or distractions if they actually logged them
- MIT and energy level are great bonuses to acknowledge if present
- Direct, science-backed tone. Cal Newport inspired. Max 2 sentences.`,

    connect_insight: `
Generate a personalised Connect coaching insight.
Data: ${context.pillar || "{}"}

RULES — Habits First:
- The Connect habit they chose is the PRIMARY metric
- Connection logs, social battery ratings and kindness acts are OPTIONAL BONUS context
- If they checked in their habit (e.g. "send one genuine message") — celebrate that specifically
- Only reference connection logs or social battery if they actually logged them
- Kindness acts are a great bonus to acknowledge if present
- Warm, human tone — like a wise friend. Max 2 sentences.`,

    calm_insight: `
Generate a personalised Calm coaching insight.
Data: ${context.pillar || "{}"}

RULES — Habits First:
- The Calm habit they chose is the PRIMARY metric
- Stress level ratings, mood logs and activity completions are OPTIONAL BONUS context
- If they checked in their habit — that is the win. Celebrate it.
- Only reference stress numbers or mood if they actually logged them
- Gratitude entries and calm activities are great bonuses to acknowledge if present
- Never alarm or medicalise — normalise stress as human
- Max 2 sentences. Warm, grounded, human.`,

    rest_insight: `
Generate a personalised Rest coaching insight.
Data: ${context.pillar || "{}"}

RULES — Habits First:
- The Rest habit they chose is the PRIMARY metric
- Sleep time logs (bedtime, wake time, hours) are OPTIONAL BONUS context
- If they checked in their habit — celebrate that specifically
- Only reference sleep hours or quality if they actually logged them
- Wind-down checklist completions are a great bonus to acknowledge if present
- NEVER say they "didn't track sleep" as a negative
- Gentle, science-backed tone. Max 2 sentences.`,

    move_insight: `
Generate a personalised movement coaching insight based on this data:
${context.pillar || "{}"}

Rules:
- Reference the specific Move habit they chose
- Reference their actual step count and workout data
- If habit goal is met — celebrate and suggest progression
- If not met — encourage gently with one specific tip
- Max 2 sentences. Sound like a real fitness coach who knows their day.`,

    fuel_insight: `
Generate a personalised Fuel coaching insight.
Data: ${context.pillar || "{}"}

RULES — Habits First:
- The habit they chose is the PRIMARY metric. If they did their habit — that is success.
- Meal tracking data (calories, protein, fiber) is OPTIONAL BONUS context only
- If they logged meals — use that data to enrich your insight
- If they did NOT log meals — base your insight entirely on their habit check-in
- NEVER say they "didn't track" or imply missing logs are a failure
- Example: if habit = "eat 3 structured meals" and they checked in — celebrate that. Don't mention protein numbers unless they logged them.
- Max 2 sentences. Warm, specific, habit-focused.`,
  };

  return prompts[purpose] || prompts.morning;
};

// ── GROQ CALL ─────────────────────────────────────────────
const callGroq = async (prompt, system = COACH_SYSTEM, maxTokens = 150) => {
  const response = await fetch(GROQ_API, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.GROQ_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "llama-3.3-70b-versatile",
      max_tokens: maxTokens,
      messages: [
        { role: "system", content: system },
        { role: "user", content: prompt },
      ],
    }),
  });

  const data = await response.json();
  return data.choices?.[0]?.message?.content || "Keep going. Every day counts.";
};

// ── MAIN AI FUNCTION ──────────────────────────────────────
const generateInsight = async (context, purpose) => {
  const prompt = buildPrompt(context, purpose);

  try {
    const insight = await callGroq(prompt);
    return {
      content: insight,
      purpose,
      context_used: {
        patterns: context.patterns.map(p => p.type),
        tone: context.tone,
        streak: context.performance?.streak,
      },
    };
  } catch (err) {
    console.error("Groq error:", err);
    // Safe fallbacks based on tone
    const fallbacks = {
      gentle_encouraging: "One habit today is enough. The door is always open — and you just walked through it.",
      celebratory_deepening: "This streak is proof of something deeper than discipline. You are becoming someone new.",
      compassionate_realistic: "Better, not perfect. Today does not need to be extraordinary. It just needs to happen.",
      fresh_start: "Every day is a clean slate. What matters is that you showed up today.",
      warm_supportive: "You are building something real. Trust the process.",
    };
    return {
      content: fallbacks[context.tone] || fallbacks.warm_supportive,
      purpose,
      fallback: true,
    };
  }
};

module.exports = { generateInsight, callGroq };
