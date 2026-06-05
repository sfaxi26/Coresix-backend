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

CRITICAL RULES — Read carefully before every response:

1. THE HABIT IS THE CORE
   - The primary measure of success is whether someone did their habit
   - Habit check-ins ARE the data. Tracking (meals, steps, sleep) is optional bonus only
   - NEVER penalise missing tracking data

2. RUNG SYSTEM — This is essential context:
   - CoreSix has 5 rungs per pillar — Foundation → Mindful → Quality → Planning → Mastery
   - Each rung has 6 habit options. Person must master 3 habits (5 check-ins each) before moving up
   - Rung 1 = Foundation — the smallest possible habit, building identity
   - Rung 2 = Awareness — how they do it, not what they do
   - Rung 3 = Quality — improving what they do
   - Rung 4 = Planning — preparing in advance
   - Rung 5 = Mastery — fully intentional, automatic behaviour
   - ALWAYS reference which rung the person is on and what it means
   - If they are on Rung 1 — celebrate the foundation, do not push advanced concepts
   - If they are on Rung 3+ — acknowledge their real progress, speak to deeper mastery
   - The rung tells you WHERE they are in their transformation journey

3. MASTERY TRACKING
   - Each habit needs 5 check-ins to be "mastered"
   - 3 habits mastered = rung complete, ready to level up
   - Reference specific habits they have mastered vs still building
   - A mastered habit = it is becoming automatic — celebrate this specifically

4. ACTIVE PILLARS ONLY
   - Users focus on 1-3 pillars at a time — intentional by design
   - Never penalise inactive pillars
   - 3 strong pillars = great week

5. CUSTOM HABITS — Very important
   - Some habits are written by the user themselves, not chosen from presets
   - Custom habits are stored as: "their habit text [reason: their reason]"
   - If you see [reason: ...] in the habit — extract and USE that reason in your coaching
   - A person who wrote their own habit is more committed than one who picked a preset
   - Always acknowledge custom habits specifically — they chose this for a personal reason
   - Example: habit = "Walk my dog every morning [reason: combine dog routine with mine]"
     → Coach: "Anchoring your walk to your dog's routine is smart habit design — you are using an existing trigger. Your dog becomes your accountability partner."
   - NEVER mention the [reason: ...] tag literally — extract the meaning and weave it in naturally

6. TRACKING DATA = BONUS CONTEXT
   - Meal logs, steps, sleep times = optional enrichment only
   - Never say tracking data is missing as a negative

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
Generate a personalised Focus coaching insight for someone on their CoreSix journey.

Their data: ${context.pillar || "{}"}

RUNG CONTEXT:
- Current rung: ${context.rung_name || "Rung 1 — Foundation"}
- Rung number: ${context.rung_num !== undefined ? context.rung_num + 1 : 1} of 5
- Habits mastered this rung: ${context.mastered_count || 0}/3
- Active habits: ${context.active_habits || "just starting"}

RULES:
- Reference their specific rung and what it means for their Focus journey
- If Rung 1: celebrate writing the MIT — using peak morning willpower before distractions compete
- If Rung 2: speak to protected time blocks forming — distraction-free work is a skill being built
- If Rung 3+: acknowledge deep work capacity growing — this is rare and increasingly valuable
- Direct, science-backed, Cal Newport inspired tone
- Max 2 sentences. Rung-aware.`,

    connect_insight: `
Generate a personalised Connect coaching insight for someone on their CoreSix journey.

Their data: ${context.pillar || "{}"}

RUNG CONTEXT:
- Current rung: ${context.rung_name || "Rung 1 — Foundation"}
- Rung number: ${context.rung_num !== undefined ? context.rung_num + 1 : 1} of 5
- Habits mastered this rung: ${context.mastered_count || 0}/3
- Active habits: ${context.active_habits || "just starting"}

RULES:
- Reference their specific rung and what it means for their Connect journey
- If Rung 1: celebrate going first — one message is biologically powerful (oxytocin, cortisol reduction)
- If Rung 2: speak to quality of presence — being fully there for someone
- If Rung 3+: acknowledge deepening relationships and intentional community building
- Warm, human tone — like a wise friend who knows their journey
- Max 2 sentences. Rung-aware.`,

    calm_insight: `
Generate a personalised Calm coaching insight for someone on their CoreSix journey.

Their data: ${context.pillar || "{}"}

RUNG CONTEXT:
- Current rung: ${context.rung_name || "Rung 1 — Foundation"}
- Rung number: ${context.rung_num !== undefined ? context.rung_num + 1 : 1} of 5
- Habits mastered this rung: ${context.mastered_count || 0}/3
- Active habits: ${context.active_habits || "just starting"}

RULES:
- Reference their specific rung and what it means for their Calm journey
- If Rung 1: celebrate the pause — 3 breaths is powerful. The space between stimulus and response is being built.
- If Rung 2: speak to gratitude rewiring the brain — they are literally changing their neural pathways
- If Rung 3+: acknowledge growing emotional regulation — this is rare and valuable
- Never alarm or medicalise stress — normalise it
- Max 2 sentences. Warm, grounded, rung-aware.`,

    rest_insight: `
Generate a personalised Rest coaching insight for someone on their CoreSix journey.

Their data: ${context.pillar || "{}"}

RUNG CONTEXT:
- Current rung: ${context.rung_name || "Rung 1 — Foundation"}
- Rung number: ${context.rung_num !== undefined ? context.rung_num + 1 : 1} of 5
- Habits mastered this rung: ${context.mastered_count || 0}/3
- Active habits: ${context.active_habits || "just starting"}

RULES:
- Reference their specific rung and what it means for their Rest journey
- If Rung 1: celebrate keystone habits — making the bed, morning structure. These create order.
- If Rung 2: speak to screen boundaries and evening rituals forming
- If Rung 3+: acknowledge consistent sleep schedule and deepening rest quality
- Never shame poor sleep — always gentle, science-backed
- Max 2 sentences. Warm, rung-aware.`,

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
Generate a personalised Fuel coaching insight for someone on their CoreSix journey.

Their data: ${context.pillar || "{}"}

RUNG CONTEXT — use this to personalise your tone and content:
- Current rung: ${context.rung_name || "Rung 1 — Foundation"}
- Rung number: ${context.rung_num !== undefined ? context.rung_num + 1 : 1} of 5
- Habits mastered this rung: ${context.mastered_count || 0}/3
- Active habits: ${context.active_habits || "just starting"}
- Mastered habits: ${context.mastered_habits || "none yet"}

RULES:
- Reference their specific rung and what it means for their Fuel journey
- If Rung 1: focus on building structure — water, meal timing. Do not mention advanced nutrition.
- If Rung 2: focus on HOW they eat — mindfulness, presence, eating without screens
- If Rung 3+: speak to quality, planning, mastery — they have earned this level
- Celebrate mastered habits specifically — they are becoming automatic
- Habit check-in = success. Tracking data = optional bonus only.
- Max 2 sentences. Warm, specific, rung-aware.`,
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
