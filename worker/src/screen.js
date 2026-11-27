import { addDaysISO, todayISO } from "./dates.js";

// ---------- Screen time (with MacroDroid on his phone) ----------
// Two MacroDroid macros call the same address as phone focus:
//   Screen On  → GET /phone?key=WORKER_SECRET&screen=on
//   Screen Off → GET /phone?key=WORKER_SECRET&screen=off
// Every event is one row in D1 (table screen_events: ts, state). Nothing is added up when it arrives,
// so two events a second apart can never overwrite each other; the totals are worked out when read:
// on → off is a session; a repeated "on" while one is open is ignored; a session with no "off"
// (phone died, macro missed) is capped at MAX_SESSION; sessions that cross midnight are split.
// KV "screen_setup" = first event time (turns the feature on in the app and her chat).

export const MAX_SESSION = 3 * 3600000;
const TZ_MS = 5 * 3600000; // Lima, UTC-5 all year
const localDate = (ms) => new Date(ms - TZ_MS).toISOString().slice(0, 10);
const localHourOf = (ms) => new Date(ms - TZ_MS).getUTCHours();
const dayStart = (date) => Date.parse(`${date}T00:00:00-05:00`);

// A session → milliseconds per (date, hour), split at every hour boundary (UTC-5 is a whole-hour offset).
export function splitSession(start, end) {
  const out = [];
  let t = start;
  while (t < end) {
    const next = Math.min(end, Math.floor(t / 3600000) * 3600000 + 3600000);
    out.push({ date: localDate(t), hour: localHourOf(t), ms: next - t });
    t = next;
  }
  return out;
}

// Events (sorted by time) → sessions [{start, end, open}]. `now` closes a session that's still open.
export function sessionsFrom(events, now = Date.now()) {
  const out = [];
  let cur = null;
  for (const e of events) {
    const on = e.state === "on" || e.state === "unlock";
    if (on) {
      if (cur && e.ts - cur.start < MAX_SESSION) continue; // already counting
      if (cur) out.push({ start: cur.start, end: cur.start + MAX_SESSION, open: false }); // stale: capped
      cur = { start: e.ts };
    } else if (e.state === "off" && cur) {
      out.push({ start: cur.start, end: Math.min(e.ts, cur.start + MAX_SESSION), open: false });
      cur = null;
    }
  }
  if (cur) out.push({ start: cur.start, end: Math.min(now, cur.start + MAX_SESSION), open: now < cur.start + MAX_SESSION });
  return out;
}

// Totals for each date in `dates` from a list of sessions.
export function summarize(sessions, dates) {
  const days = Object.fromEntries(dates.map((d) => [d, { date: d, ms: 0, unlocks: 0, longest: 0, hours: Array(24).fill(0), live: false }]));
  for (const s of sessions) {
    const startDay = days[localDate(s.start)];
    if (startDay) { startDay.unlocks++; startDay.longest = Math.max(startDay.longest, s.end - s.start); }
    for (const p of splitSession(s.start, s.end)) {
      const d = days[p.date];
      if (!d) continue;
      d.ms += p.ms;
      d.hours[p.hour] += p.ms / 60000;
      if (s.open) d.live = true;
    }
  }
  return dates.map((d) => {
    const x = days[d];
    return { date: d, minutes: Math.round(x.ms / 60000), unlocks: x.unlocks, longest: Math.round(x.longest / 60000), hours: x.hours.map((m) => Math.round(m * 10) / 10), live: x.live };
  });
}

export async function screenEvent(env, state, now = Date.now()) {
  state = String(state || "").toLowerCase();
  if (!["on", "off", "unlock"].includes(state)) return "unknown state";
  await env.FEED.prepare("INSERT INTO screen_events (ts, state) VALUES (?, ?)").bind(now, state).run();
  // keep ~6 weeks
  if (Math.random() < 0.02) await env.FEED.prepare("DELETE FROM screen_events WHERE ts < ?").bind(now - 42 * 86400000).run().catch(() => {});
  return "ok";
}

export async function eventsBetween(env, from, to) {
  const r = await env.FEED.prepare("SELECT ts, state FROM screen_events WHERE ts >= ? AND ts < ? ORDER BY ts, id").bind(from, to).all();
  return r.results || [];
}

// Several days at once (one query). The window starts MAX_SESSION early so a session that began the
// evening before is counted on the right day.
export async function screenDays(env, dates, now = Date.now()) {
  const from = dayStart(dates[0]) - MAX_SESSION, to = Math.min(now, dayStart(dates[dates.length - 1]) + 86400000);
  return summarize(sessionsFrom(await eventsBetween(env, from, to), now), dates);
}
export async function screenDay(env, date = todayISO(), now = Date.now()) {
  return (await screenDays(env, [date], now))[0];
}
export async function screenWeek(env, today = todayISO()) {
  return screenDays(env, Array.from({ length: 7 }, (_, i) => addDaysISO(today, i - 6)));
}

export const hm = (min) => (min >= 60 ? `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, "0")}m` : `${min}m`);

// For her prompt.
export async function screenContext(env) {
  if (!(await env.DB.get("screen_setup"))) return "";
  const [y, t] = await screenDays(env, [addDaysISO(todayISO(), -1), todayISO()]);
  return `SCREEN TIME (from his phone): today ${hm(t.minutes)} so far, ${t.unlocks} unlocks${t.longest ? `, longest session ${hm(t.longest)}` : ""}; yesterday ${hm(y.minutes)}. Mention it only when it's useful (he asks, or it's clearly high late at night); never nag.`;
}
