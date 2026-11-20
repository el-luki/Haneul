import { MODELS_SMART } from "./config.js";
import { todayISO } from "./dates.js";
import { gemini, parseJson } from "./gemini.js";
import { send, tg } from "./telegram.js";

// ---------- Question of the day + daily SAT practice ----------
// QOTD (school days 6:30 on the bus, weekends 9:00): Haneul asks one thought-provoking question tied to his
// interests; he answers whenever and they talk about it.
// SAT (school days 15:15 on the bus home, weekends 10:00): one ORIGINAL digital-SAT-style multiple-choice
// question (Math and Reading & Writing take turns), buttons A-D, explanation after he answers, a running
// score, and harder/easier questions depending on how he's doing.

export async function sendQotd(env, haneulSays) {
  const past = (await env.DB.get("qotd", "json")) || [];
  await haneulSays(env, `Send Alex the QUESTION OF THE DAY. Start with "question of the day:" and ask ONE thought-provoking question
he'd enjoy thinking about on the bus: rotate between space & physics, brain-computer interfaces & the mind, AI & the future, building
things / being a young founder, faith & meaning, Peru & cities, music, and fun "what would you do if…" ones. Specific and vivid,
answerable in a few sentences, never a quiz with one right answer. 1-2 short texts.
Don't repeat these past questions: ${past.slice(-30).join(" | ") || "(none yet)"}`, { maxTexts: 2 });
  const chat = (await env.DB.get("chat", "json")) || [];
  const said = chat[chat.length - 1]?.parts?.[0]?.text || "";
  const q = (said.match(/question of the day:?\s*([\s\S]*)/i)?.[1] || said).split("\n").slice(-2).join(" ").slice(0, 200);
  await env.DB.put("qotd", JSON.stringify([...past, q].slice(-60)));
}

const LETTERS = ["A", "B", "C", "D"];
const MATH_SKILLS = ["linear equations in one variable", "linear functions", "systems of two linear equations", "linear inequalities",
  "equivalent expressions", "nonlinear equations and systems", "nonlinear functions (quadratic/exponential)", "ratios, rates and proportions",
  "percentages", "one-variable data: distributions and measures of center", "two-variable data: models and scatterplots",
  "probability and conditional probability", "inference from sample statistics and margin of error", "area and volume",
  "lines, angles and triangles", "right triangles and trigonometry", "circles"];
const RW_SKILLS = ["central ideas and details", "command of evidence (textual)", "command of evidence (quantitative)", "inferences",
  "words in context", "text structure and purpose", "cross-text connections", "rhetorical synthesis (notes)", "transitions",
  "boundaries (punctuation)", "form, structure and sense (grammar)"];

export async function getSat(env) {
  return (await env.DB.get("sat", "json")) || { n: 0, total: 0, correct: 0, recent: [], skills: {} };
}

export async function sendSat(env) {
  const s = await getSat(env);
  const math = s.n % 2 === 0;
  const pool = math ? MATH_SKILLS : RW_SKILLS;
  // weakest skills come back more often; otherwise rotate
  const weak = Object.entries(s.skills).filter(([k, v]) => pool.includes(k) && v.tries >= 2 && v.right / v.tries < 0.6).map(([k]) => k);
  const skill = weak.length && Math.random() < 0.5 ? weak[Math.floor(Math.random() * weak.length)] : pool[Math.floor(s.n / 2) % pool.length];
  const last10 = s.recent.slice(-10);
  const acc = last10.length ? last10.filter(Boolean).length / last10.length : 0.6;
  const difficulty = acc >= 0.8 ? "hard" : acc >= 0.5 ? "medium" : "easy";
  const prompt = `Write ONE original practice question in the style of the digital SAT (${math ? "Math" : "Reading and Writing"} section).
Skill: ${skill}. Difficulty: ${difficulty}. It must be your own original question (do not copy real SAT/College Board items).
Rules: multiple choice with exactly 4 options and exactly ONE correct answer; ${math ? "text only (no figures needed), numbers that work out cleanly" : "a short passage (25-120 words) like the real section, then the question"}.
Double-check the answer by solving it yourself before you answer. Plain text, no LaTeX (write x^2, sqrt(3)).
Return JSON: {"passage": "${math ? "" : "the passage"}", "question": "...", "options": ["...", "...", "...", "..."], "answer": 0-3, "explanation": "2-4 sentences: why it's right and the trap in the most tempting wrong option"}`;
  const q = parseJson(await gemini(env, [{ role: "user", parts: [{ text: prompt }] }], { json: true, models: MODELS_SMART }));
  if (!q?.question || !Array.isArray(q.options) || q.options.length !== 4 || !(q.answer >= 0 && q.answer <= 3)) throw new Error("the SAT question came back incomplete");
  const n = s.n + 1;
  s.n = n;
  s.current = { n, skill, math, difficulty, answer: Number(q.answer), options: q.options.map(String), question: String(q.question), explanation: String(q.explanation || ""), date: todayISO() };
  await env.DB.put("sat", JSON.stringify(s));
  const text = `📝 SAT ${math ? "Math" : "Reading & Writing"} · ${skill} · ${difficulty}\n\n${q.passage ? `${q.passage}\n\n` : ""}${q.question}\n\n${q.options.map((o, i) => `${LETTERS[i]}) ${o}`).join("\n")}`;
  await send(env, text, { reply_markup: { inline_keyboard: [LETTERS.map((L, i) => ({ text: L, callback_data: `sat:${n}:${i}` }))] } });
}

export async function answerSat(env, q, data) {
  const [, n, oi] = data.split(":").map(Number);
  if (q?.message) await tg(env, "editMessageReplyMarkup", { chat_id: q.message.chat.id, message_id: q.message.message_id }).catch(() => {});
  const s = await getSat(env);
  const cur = s.current;
  if (!cur || cur.n !== n || cur.answered) return send(env, cur?.n === n ? "You already answered this one 🙂" : "That question expired. A new one comes tomorrow!");
  const right = oi === cur.answer;
  cur.answered = true;
  s.total++;
  if (right) s.correct++;
  s.recent = [...s.recent, right].slice(-30);
  const k = (s.skills[cur.skill] ||= { tries: 0, right: 0 });
  k.tries++;
  if (right) k.right++;
  let streak = 0;
  for (let i = s.recent.length - 1; i >= 0 && s.recent[i]; i--) streak++;
  await env.DB.put("sat", JSON.stringify(s));
  const last10 = s.recent.slice(-10);
  return send(env, `${right ? `✅ Correct! ${LETTERS[oi]}${streak >= 3 ? ` · ${streak} in a row 🔥` : ""}` : `❌ Not quite: it's ${LETTERS[cur.answer]}) ${cur.options[cur.answer]}`}\n\n${cur.explanation}\n\nLast ${last10.length}: ${last10.filter(Boolean).length}/${last10.length} · all time ${s.correct}/${s.total}`);
}

// For her prompt.
export async function satContext(env) {
  const s = await getSat(env);
  if (!s.total) return "";
  const weak = Object.entries(s.skills).filter(([, v]) => v.tries >= 2 && v.right / v.tries < 0.6).map(([k]) => k).slice(0, 3);
  const last10 = s.recent.slice(-10);
  return `Daily SAT practice: ${last10.filter(Boolean).length}/${last10.length} on the last ${last10.length}, ${s.correct}/${s.total} all time.${weak.length ? ` Weak spots: ${weak.join(", ")}.` : ""}${s.current && !s.current.answered && s.current.date === todayISO() ? " Today's question is still unanswered." : ""}`;
}
