import { MODELS_SMART } from "./config.js";
import { addDaysISO, localWeekday, todayISO } from "./dates.js";
import { gemini, parseJson } from "./gemini.js";
import { workText } from "./work.js";

// ---------- LinkedIn + X: a daily post draft, a weekly article outline ----------
// Jordan's advice (1-1, Nov 18): "If I don't put myself out there, I don't exist." LinkedIn is his home
// (active every day), X gets a short version, and he writes one article a week.
// Haneul drafts from his REAL work (work list, Build, Learn article, today's space news); he edits, taps
// "Copy & open LinkedIn / X" (the sites' own share pages, nothing is posted by Haneul), then "Posted ✓".
// KV "social": { days: { "YYYY-MM-DD": { idea, linkedin, x, posted: { linkedin, x } } }, weekly: { week, title, outline } }

const FORMATS = [
  "build-in-public: one concrete result, bug or lesson from his main project",
  "explain ONE GNC or propulsion idea simply (e.g. lossless convexification, the throttle floor, glide-slope cones, Isp), like in his article",
  "react to a recent space news story from a GNC / propulsion angle",
  "a lesson from TKS, mentors or networking, tied to aerospace",
  "ask the aerospace community one sharp question he's genuinely stuck on",
  "behind the scenes of learning: AP Physics, CS50P, reading research papers",
];

export async function getSocial(env) {
  return (await env.DB.get("social", "json")) || { days: {}, weekly: null };
}
async function saveSocial(env, s) {
  const keep = Object.keys(s.days).sort().slice(-40);
  s.days = Object.fromEntries(keep.map((d) => [d, s.days[d]]));
  await env.DB.put("social", JSON.stringify(s));
}

const slugWords = (url) => String(url).split("/").filter(Boolean).pop()?.replace(/[-_]+/g, " ").replace(/\.\w+$/, "") || "";

// Days in a row he posted on LinkedIn (today counts once posted; otherwise from yesterday).
export function socialStreak(s, today = todayISO(), net = "linkedin") {
  let d = s.days[today]?.posted?.[net] ? today : addDaysISO(today, -1);
  let n = 0;
  while (s.days[d]?.posted?.[net]) { n++; d = addDaysISO(d, -1); }
  return n;
}

export async function draftSocial(env, { again = false } = {}) {
  const s = await getSocial(env);
  const today = todayISO();
  if (s.days[today]?.linkedin && !again) return s.days[today];
  const n = Object.keys(s.days).length + (again ? 1 : 0);
  const format = FORMATS[n % FORMATS.length];
  const recent = Object.values(s.days).slice(-7).map((d) => d.idea).filter(Boolean);
  const news = ((await env.DB.get("space_history", "json")) || []).slice(-3).map(slugWords);
  const work = await workText(env).catch(() => "");
  const prompt = `Write today's social posts for Alex: an 11th grader in Lima, Peru, in TKS, whose focus is SPACE TECH (guidance,
navigation & control and propulsion). He wants to be visible to aerospace people: LinkedIn is his home, X gets a short version.

Today's angle: ${format}.
His real work (use only these facts; never invent results, numbers, internships or awards):
${work || "- (his work list is empty: keep it about what he's learning)"}
Recent space news he read: ${news.join(" | ") || "(none)"}.
Ideas used lately (don't repeat): ${recent.join(" | ") || "(none)"}.

LinkedIn: 80-170 words, first line is a hook, short paragraphs, his own voice (curious, honest, a high schooler learning fast; not
corporate, no "I'm thrilled to announce"), at most 2 hashtags at the end, end with a question about half the time. No links (he adds them).
X: one post under 260 characters, punchy, at most 1 hashtag.
Return JSON: {"idea": "5-8 word summary of the angle", "linkedin": "...", "x": "..."}`;
  const r = parseJson(await gemini(env, [{ role: "user", parts: [{ text: prompt }] }], { json: true, models: MODELS_SMART }));
  if (!r?.linkedin) throw new Error("the post draft came back empty");
  const day = { idea: String(r.idea || format).slice(0, 120), linkedin: String(r.linkedin).slice(0, 3000), x: String(r.x || "").slice(0, 280), posted: s.days[today]?.posted || {} };
  s.days[today] = day;
  await saveSocial(env, s);
  return day;
}

export async function markPosted(env, { net, text, date } = {}) {
  if (!["linkedin", "x"].includes(net)) return { error: "which network?" };
  const s = await getSocial(env);
  const d = date || todayISO();
  const day = (s.days[d] ||= { idea: "", linkedin: "", x: "", posted: {} });
  day.posted = { ...(day.posted || {}), [net]: true };
  if (text) day[net] = String(text).slice(0, 3000);
  await saveSocial(env, s);
  return { ok: true, streak: socialStreak(s) };
}

export async function saveSocialText(env, { net, text }) {
  const s = await getSocial(env);
  const day = s.days[todayISO()];
  if (!day || !["linkedin", "x"].includes(net)) return { error: "nothing to save" };
  day[net] = String(text || "").slice(0, 3000);
  await saveSocial(env, s);
  return { ok: true };
}

// Weekly article (Sunday 15:00): a topic + Learn -> Build -> Iterate style outline from his real work.
export async function weeklyArticle(env, haneulSays) {
  const s = await getSocial(env);
  const week = todayISO();
  const work = await workText(env).catch(() => "");
  const past = s.weeklyHistory || [];
  const r = parseJson(await gemini(env, [{ role: "user", parts: [{ text: `Alex (11th grader, TKS, focus: space tech, GNC + propulsion) writes ONE article a week
(Substack for the weekly piece; his big technical pieces also go on Medium). Suggest this week's article from his real work and learning:
${work}
Past topics (don't repeat): ${past.join(" | ") || "(none)"}
Make it 600-1000 words, something only he can write (his own build, results, mistakes, what he learned). Return JSON:
{"title": "...", "hook": "first line", "outline": ["5-6 section bullets, each one line"], "proof": "which result/figure from his work backs it"}` }] }], { json: true, models: MODELS_SMART }));
  if (!r?.title) return;
  s.weekly = { week, title: String(r.title).slice(0, 160), hook: String(r.hook || "").slice(0, 300), outline: (r.outline || []).slice(0, 7).map((x) => String(x).slice(0, 200)), proof: String(r.proof || "").slice(0, 300) };
  s.weeklyHistory = [...past, s.weekly.title].slice(-20);
  await saveSocial(env, s);
  await haneulSays(env, `It's Sunday afternoon: time to plan Alex's weekly article. Suggest it in 1-2 short texts: "${s.weekly.title}" (hook: ${s.weekly.hook}).
Say the full outline is in Mentors → Posts, and he can publish any day this week (on Substack; you'll notice it on his feed).`);
}

// For her prompt.
export async function socialContext(env) {
  const s = await getSocial(env);
  const today = s.days[todayISO()];
  const streak = socialStreak(s);
  return `SOCIAL (Jordan told him to level up his networking: LinkedIn every day, X, one article a week): LinkedIn streak ${streak} day(s).
${today ? `Today's drafts are in Mentors → Posts (${today.idea}); LinkedIn ${today.posted?.linkedin ? "posted ✓" : "not posted yet"}, X ${today.posted?.x ? "posted ✓" : "not posted yet"}.` : "Today's drafts aren't made yet."}${s.weekly ? ` This week's article idea: "${s.weekly.title}".` : ""}
If he says he posted, fill "social_posted" with "linkedin" and/or "x".`;
}

// Daily: drafts + a short ping (school days 15:45, weekends 12:00).
export async function socialDaily(env, haneulSays) {
  const day = await draftSocial(env);
  const s = await getSocial(env);
  await haneulSays(env, `Tell Alex in ONE short text that today's LinkedIn + X drafts are ready in Mentors → Posts (angle: ${day.idea}). LinkedIn streak: ${socialStreak(s)} day(s). Playful, no lists.`, { maxTexts: 1 });
}
export const socialDue = () => (["Sat", "Sun"].includes(localWeekday()) ? 12 * 60 : 15 * 60 + 45);
