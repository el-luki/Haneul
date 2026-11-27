import { localHour, localMinute, localWeekday, todayISO } from "./dates.js";
import { eventsForDay } from "./schedule.js";

// ---------- Random check-ins ----------
// Haneul texts first, 1-2 times a day at random times, like a friend would.
// Never during school, TKS sessions/meetings or other calendar events,
// never before/after the windows below, and not if Alex chatted in the last 45 minutes.

const WINDOWS = { weekday: [15 * 60 + 20, 20 * 60 + 10], weekend: [9 * 60 + 30, 20 * 60 + 10] };
const MIN_GAP = 120; // minutes between two check-ins on the same day
const BUSY = /school|colegio|church|iglesia|tks|meeting|reuni[oó]n|exam|test|class|clase|innovate|velocity/i;

const toMin = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

// Random times for today (minutes since midnight), at least MIN_GAP apart.
export function pickTimes(weekend, random = Math.random) {
  const [from, to] = weekend ? WINDOWS.weekend : WINDOWS.weekday;
  const count = random() < 0.5 ? 1 : 2;
  const times = [];
  for (let tries = 0; times.length < count && tries < 50; tries++) {
    const t = from + Math.floor(random() * (to - from));
    if (times.every((x) => Math.abs(x - t) >= MIN_GAP)) times.push(t);
  }
  return times.sort((a, b) => a - b);
}

// Is Alex in something right now? (school, church, a TKS session, any personal event…)
export function busyAt(events, minute) {
  return (events || []).some((e) => {
    if (e.all_day) return false;
    const s = toMin(e.start.slice(11, 16));
    const end = e.end ? toMin(e.end.slice(11, 16)) : s + 60;
    const important = e.tag === "PERSONAL" || e.tag === "SCHOOL" || BUSY.test(e.title);
    return important && minute >= s - 10 && minute < end;
  });
}

const TASK = `Send Alex a spontaneous text, like a close friend checking in out of nowhere. Pick ONE natural topic
from what you know: something he mentioned recently (a test, the TKS demo, a friend, a project), how his day is going,
his workout or the book he's reading, or a random space/K-pop thought you had. Not a reminder list, not a schedule.
1-2 very short texts, no emoji or just one.`;

// Called every 5 minutes.
export async function runCheckins(env) {
  const today = todayISO();
  const now = localHour() * 60 + localMinute();
  const weekend = ["Sat", "Sun"].includes(localWeekday());
  let plan = await env.DB.get("checkin_plan", "json");
  if (!plan || plan.date !== today) {
    plan = { date: today, times: pickTimes(weekend), sent: [] };
    await env.DB.put("checkin_plan", JSON.stringify(plan), { expirationTtl: 60 * 60 * 30 });
  }
  const due = plan.times.find((t) => t <= now && !plan.sent.includes(t));
  if (due === undefined) return;
  const [, windowEnd] = weekend ? WINDOWS.weekend : WINDOWS.weekday;

  const lastChat = Number(await env.DB.get("last_user_msg")) || 0;
  const busy = busyAt(await eventsForDay(env, today), now) || !!(await env.DB.get("focus"));
  if (busy || Date.now() - lastChat < 45 * 60000) {
    // try again in 30 minutes, if still inside today's window
    plan.times = plan.times.map((t) => (t === due ? now + 30 : t));
    if (now + 30 > windowEnd) plan.sent.push(now + 30);
    await env.DB.put("checkin_plan", JSON.stringify(plan), { expirationTtl: 60 * 60 * 30 });
    return;
  }
  plan.sent.push(due);
  await env.DB.put("checkin_plan", JSON.stringify(plan), { expirationTtl: 60 * 60 * 30 });
  await env.BG_JOBS.send({ kind: "say", task: TASK }); // Gemini runs in the background queue
}
