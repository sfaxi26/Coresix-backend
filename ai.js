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
- Trust the process — growth is often invisible before it's visible
- Better not perfect — self-compassion over perfection
- Purpose drives consistency — connect habits to their why

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
