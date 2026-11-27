import { MODELS_SMART } from "./config.js";
import { addDaysISO, localWeekday, todayISO } from "./dates.js";
import { gemini, parseJson } from "./gemini.js";
import { workText } from "./work.js";
import { postTweet } from "./xpost.js";
import { postLinkedIn } from "./lipost.js";

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
${work || "- LanderSim: a fuel-optimal rocket-landing simulator (G-FOLD, CVXPY)\n- Learn article on Medium: Why Landing a Rocket Is a Math Problem"}
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

// Alex tapped "Approve & post on X" (and confirmed): the ONLY way Haneul posts anything.
export async function approveX(env, { text } = {}) {
  const s = await getSocial(env);
  const d = todayISO();
  const day = (s.days[d] ||= { idea: "", linkedin: "", x: "", posted: {} });
  if (day.posted?.x) return { error: "today's X post is already up" + (day.xUrl ? `: ${day.xUrl}` : "") };
  const body = String(text ?? day.x ?? "").trim();
  const r = await postTweet(env, body).catch((err) => ({ error: err.message, noCredits: !!err.noCredits }));
  if (r.noCredits) await env.DB.put("x_mode", "share"); // stays on the free share page until he re-enables the API
  if (r.error) return r;
  day.x = body;
  day.posted = { ...(day.posted || {}), x: true };
  day.xUrl = r.url;
  await saveSocial(env, s);
  return { ok: true, url: r.url, streak: socialStreak(s, d, "x") };
}

// Alex tapped "Approve & post on LinkedIn" (and confirmed).
export async function approveLinkedIn(env, { text } = {}) {
  const s = await getSocial(env);
  const d = todayISO();
  const day = (s.days[d] ||= { idea: "", linkedin: "", x: "", posted: {} });
  if (day.posted?.linkedin) return { error: "today's LinkedIn post is already up" + (day.liUrl ? `: ${day.liUrl}` : "") };
  const body = String(text ?? day.linkedin ?? "").trim();
  const r = await postLinkedIn(env, body).catch((err) => ({ error: err.message }));
  if (r.error) return r;
  day.linkedin = body;
  day.posted = { ...(day.posted || {}), linkedin: true };
  day.liUrl = r.url;
  await saveSocial(env, s);
  return { ok: true, url: r.url, streak: socialStreak(s, d) };
}

// "Didn't show up? Send again": the automation accepted it but nothing appeared (scenario off, a field
// not mapped…). Reopens today's draft so it can be approved again.
export async function unmarkPosted(env, { net }) {
  if (!["linkedin", "x"].includes(net)) return { error: "which network?" };
  const s = await getSocial(env);
  const day = s.days[todayISO()];
  if (!day?.posted?.[net]) return { ok: true };
  day.posted = { ...day.posted, [net]: false };
  if (net === "linkedin") delete day.liUrl; else delete day.xUrl;
  await saveSocial(env, s);
  return { ok: true };
}

export async function saveSocialText(env, { net, text }) {
  const s = await getSocial(env);
  const day = s.days[todayISO()];
  if (!day || !["linkedin", "x"].includes(net)) return { error: "nothing to save" };
  day[net] = String(text || "").slice(0, 3000);
  await saveSocial(env, s);
  return { ok: true };
}

// This week's article = this week's newsletter issue (newsletter.js writes the draft on Thursdays);
// it shows in the app under Mentors → Posts.
export async function setWeeklyFromNewsletter(env, issue) {
  const s = await getSocial(env);
  s.weekly = { week: todayISO(), n: issue.n, date: issue.date, title: issue.title, hook: issue.hook || "", outline: issue.outline || [], proof: "", draftUrl: issue.draftUrl || "" };
  await saveSocial(env, s);
}

// For her prompt.
export async function socialContext(env) {
  const s = await getSocial(env);
  const today = s.days[todayISO()];
  const streak = socialStreak(s);
  return `SOCIAL (Jordan told him to level up his networking: LinkedIn every day, X, one article a week, which is his Sunday newsletter): LinkedIn streak ${streak} day(s).
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
