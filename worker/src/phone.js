import { addDaysISO, localHour, localMinute, todayISO } from "./dates.js";
import { focusActive } from "./focus.js";
import { eventsForDay } from "./schedule.js";

// Which calendar events count as "important" (apps get blocked during them)
const IMPORTANT = /homework|tarea|study|estudi|physics|f[ií]sica|calc|math|exam|test|quiz|class|clase|session|meeting|reuni[oó]n|innovate|tks|church|iglesia|misa|newsletter|focus|deep work|braindate|interview|mentor/i;
const FREE = /^cancel+ed\b|lunch|almuerzo|bus\b|wake ?up|devo\b|music time|bed\b|dinner|cena|\bbreak\b|free time/i;
export function importantEvent(e) {
  if (!e || e.all_day) return false;
  const t = String(e.title || "");
  if (FREE.test(t)) return false;
  if (/^velocity:/i.test(t)) return /session|meet|squad/i.test(t); // small Velocity to-dos aren't, live sessions are
  if (e.tag === "SCHOOL") return true;
  return IMPORTANT.test(t) || / and alex\b|^alex\b.* and /i.test(t); // 1:1s ("X and Alex Rivera")
}
// The important event happening at this minute of the day, if any.
export function importantNow(events, minute) {
  const toMin = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
  return (events || []).find((e) => {
    if (!importantEvent(e) || !e.start) return false;
    const s = toMin(e.start.slice(11, 16)), end = e.end ? toMin(e.end.slice(11, 16)) : s + 60;
    return minute >= s && minute < end;
  }) || null;
}
export const isLauncher = (app) => /launcher|pantalla de inicio|home ?screen|one ui home|pixel launcher/i.test(String(app || ""));

// Why apps are blocked right now ("" = they aren't).
export async function blockReason(env) {
  if (await focusActive(env)) return "focus session";
  const ev = importantNow(await eventsForDay(env, todayISO()).catch(() => []), localHour() * 60 + localMinute());
  return ev ? ev.title : "";
}

// ---------- Phone focus: Haneul blocks distracting apps (with MacroDroid on his phone) ----------
// MacroDroid: when one of the chosen apps (social media, games) opens, it calls
//   GET /phone?key=WORKER_SECRET&app=<app name>
// and goes back to the home screen if the answer is "block". Haneul blocks ONLY while something important
// is happening: an important calendar event right now (class, homework/study block, TKS session, a 1:1,
// a meeting, church…; not lunch, the bus or routines) or a focus session (/focus). Any other time → "ok".
// During those times she answers "ok" only if she has unlocked that app (he asks in chat, with a reason). Every try is counted,
// she teases him about it (at most every 20 min), and on Sundays she sends a weekly report.
// KV: phone_unlock {app, until, reason}, phone:<date> {app: tries}, phone_nudge (cool-down).

const MAX_UNLOCK_MIN = 30;
const lc = (s) => String(s || "").toLowerCase().trim();

export async function phoneCheck(env, app, { say } = {}) {
  app = String(app || "una app").replace(/[[\]]/g, "").trim().slice(0, 40) || "una app";
  // The home screen is never blocked: MacroDroid's "block" goes back to the home screen, so blocking the
  // launcher itself would loop. (Its opening still counts as an unlock for screen time, in index.js.)
  if (isLauncher(app)) return "ok";
  const unlock = await env.DB.get("phone_unlock", "json");
  const why = await blockReason(env);
  const open = !why || (unlock && unlock.until > Date.now() && (unlock.app === "all" || lc(app).includes(lc(unlock.app)) || lc(unlock.app).includes(lc(app))));
  // count it
  const key = `phone:${todayISO()}`;
  const day = (await env.DB.get(key, "json")) || {};
  const k = !why ? `${app} (free time)` : open ? `${app} (unlocked)` : app;
  day[k] = (day[k] || 0) + 1;
  await env.DB.put(key, JSON.stringify(day), { expirationTtl: 86400 * 15 });
  if (open) return "ok";
  if (say && !(await env.DB.get("phone_nudge"))) {
    await env.DB.put("phone_nudge", "1", { expirationTtl: 1200 });
    const tries = Object.entries(day).filter(([a]) => !/\)$/.test(a)).reduce((s, [, n]) => s + n, 0);
    await say(`Alex just tried to open ${app} on his phone, and you (Haneul) blocked it because he's in something important right now
(${why}); social media and games are blocked only during important calendar events and focus sessions. That's ${tries} blocked tr${tries === 1 ? "y" : "ies"} today. Text him 1 short message like a friend who caught him:
playful, a little teasing, not mean or preachy. Remind him he can ask you to unlock it for a few minutes if he really needs it (with a reason).`);
  }
  return "block";
}

export async function phoneUnlock(env, { app, minutes, reason }) {
  const min = Math.max(1, Math.min(MAX_UNLOCK_MIN, Math.round(Number(minutes) || 10)));
  const u = { app: lc(app) || "all", until: Date.now() + min * 60000, reason: String(reason || "").slice(0, 200), min };
  await env.DB.put("phone_unlock", JSON.stringify(u), { expirationTtl: min * 60 + 60 });
  return u;
}

export async function phoneLock(env) {
  await env.DB.delete("phone_unlock");
}

async function triesOn(env, iso) {
  return (await env.DB.get(`phone:${iso}`, "json")) || {};
}

// For her prompt: today's tries, what's unlocked, and the rules for unlocking.
export async function phoneContext(env) {
  if (!(await env.DB.get("phone_setup"))) return "";
  const day = await triesOn(env, todayISO());
  const blocked = Object.entries(day).filter(([a]) => !/\)$/.test(a));
  const u = await env.DB.get("phone_unlock", "json");
  const left = u && u.until > Date.now() ? Math.ceil((u.until - Date.now()) / 60000) : 0;
  const hm = localHour() * 60 + localMinute();
  const focusTime = !!why;
  const why = await blockReason(env);
  return `PHONE FOCUS: you block his social media and games (MacroDroid sends him to the home screen), but ONLY during important calendar events and focus sessions. ${why ? `Right now apps ARE blocked (${why}).` : "Right now apps are NOT blocked (nothing important on)."} ${blocked.length ? `Blocked tries today: ${blocked.map(([a, n]) => `${a} ×${n}`).join(", ")}.` : "No blocked tries today."}${left ? ` Right now ${u.app === "all" ? "everything is" : `${u.app} is`} unlocked for ${left} more min (${u.reason || "no reason given"}).` : ""}
Unlocking (the "phone_unlock" action): only when he asks AND gives a reason; at most ${MAX_UNLOCK_MIN} minutes (usually 10-15). Real reasons (school, TKS,
a message he must answer, family) → yes. "Bored" / "just a bit" → push back once, kindly${focusTime ? " (he is in something important right now, so be firmer)" : ""}; if he insists, give 5-10 min.
He can't unlock without you. Never pretend you unlocked something unless you fill the action.`;
}

// Sunday 19:00: the week in numbers.
export async function phoneWeekly(env, haneulSays) {
  if (!(await env.DB.get("phone_setup"))) return;
  const today = todayISO();
  const totals = {};
  let blocked = 0, unlocked = 0;
  for (let i = 0; i < 7; i++) {
    for (const [a, n] of Object.entries(await triesOn(env, addDaysISO(today, -i)))) {
      if (/\)$/.test(a)) { if (a.endsWith("(unlocked)")) unlocked += n; continue; }
      blocked += n;
      totals[a] = (totals[a] || 0) + n;
    }
  }
  const top = Object.entries(totals).sort((a, b) => b[1] - a[1]).slice(0, 3);
  let screenLine = "";
  if (await env.DB.get("screen_setup")) {
    const { screenWeek, hm } = await import("./screen.js");
    const wk = await screenWeek(env);
    const total = wk.reduce((s, d) => s + d.minutes, 0), unlocks = wk.reduce((s, d) => s + d.unlocks, 0);
    const most = wk.slice().sort((a, b) => b.minutes - a.minutes)[0];
    screenLine = ` Screen time this week: ${hm(total)} (about ${hm(Math.round(total / 7))} a day), ${unlocks} unlocks; most on ${most.date} (${hm(most.minutes)}).`;
  }
  await haneulSays(env, `Weekly phone-focus report for Alex (last 7 days): you blocked ${blocked} tries to open distracting apps${top.length ? ` (most: ${top.map(([a, n]) => `${a} ${n}×`).join(", ")})` : ""}; he opened apps ${unlocked} times while you had unlocked them.${screenLine}
Send it in 1-2 short texts like a friend: the number, the app he fights the most, and one encouraging or teasing line. ${blocked === 0 ? "Zero tries: celebrate it!" : ""}`);
}
