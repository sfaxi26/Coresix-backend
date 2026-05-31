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

CRITICAL RULE — Active Pillars Only:
- Users focus on 1-3 pillars at a time by design — this is intentional, not a failure
- NEVER penalise or flag missing data in pillars the user is not currently focused on
- Absence of data in a pillar means they are not tracking it — not that they failed
- Only analyse and comment on pillars the user has actively selected habits for
- A user doing 3 pillars well is succeeding — not neglecting the other 3
- When scoring or analysing, only include pillars with actual data
- If a pillar has no data this week, skip it completely — do not score it as zero

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
Generate a personalised focus and productivity coaching insight:
${context.pillar || "{}"}

Rules:
- Reference their specific Focus habit
- If pomodoros done — celebrate deep work specifically
- Reference energy level if available — timing of deep work matters
- If distractions logged — acknowledge awareness as the first step
- If MIT set — reference it specifically
- Cal Newport / BJ Fogg inspired tone — direct, science-backed
- Max 2 sentences.`,

    connect_insight: `
Generate a personalised connection coaching insight:
${context.pillar || "{}"}

Rules:
- Reference their Connect habit specifically
- If they logged connections — acknowledge quality and type
- Reference social battery level — if low, suggest one small action
- If kindness acts done — reinforce the science (giving = receiving in neuroscience)
- Warm, human tone — like a wise friend, not a coach
- Max 2 sentences.`,

    calm_insight: `
Generate a personalised stress and calm coaching insight:
${context.pillar || "{}"}

Rules:
- Reference their stress level (1-10) — if high (7+) be extra gentle
- Reference their mood if available
- Acknowledge activities they completed
- If gratitude done — reinforce the neuroscience
- One specific suggestion for reducing stress right now
- Never alarm or medicalise stress — normalise it
- Max 2 sentences. Warm, human, grounded tone.`,

    rest_insight: `
Generate a personalised sleep coaching insight based on this data:
${context.pillar || "{}"}

Rules:
- Reference their specific Rest habit
- Reference their sleep hours and quality if available
- If wind-down routine items completed — acknowledge them
- Gentle, science-backed tone — never shame poor sleep
- One specific tip for tonight if sleep was poor
- Max 2 sentences.`,

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
Generate a personalised nutrition coaching insight based on this data:
${context.pillar || "{}"}

Rules:
- Reference the specific habit they chose
- Reference their actual meal data (meals logged, protein %, calories %)
- If habit goal is met — celebrate specifically and suggest what to keep doing
- If habit goal not met — encourage gently, one specific suggestion
- Reference fiber if it is low (under 50%)
- Max 2 sentences. Sound like a real nutrition coach who knows their day.`,
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
