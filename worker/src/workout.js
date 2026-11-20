import { addDaysISO, localHour, localMinute, todayISO } from "./dates.js";
import { eventsForDay } from "./schedule.js";
import { send, tg } from "./telegram.js";

// ---------- Workout ----------
// Every workout day, the plan is fitted into the calendar:
//   weekend with a free morning → a run (endurance)
//   free gap of 30+ min in the afternoon → full 30-min session (strength and runs alternate)
//   only 15-29 min free → a quick routine;   less → a 10-min mini session (still counts)
// Haneul sends the routine 5 minutes before, with ✅ Done / ⏰ Later / ⏭️ Skip.
// No workouts on Friday (rest day).

export const WORKOUT_DAYS = [0, 1, 2, 3, 4, 6]; // Sun, Mon, Tue, Wed, Thu, Sat
const WINDOWS = {
  weekendMorning: ["08:30", "12:00"],
  weekendAfternoon: ["13:00", "19:45"],
  weekday: ["15:30", "20:00"], // after school and the bus, before bedtime
};
const FREE_TITLES = /buffer|free time|libre/i; // calendar blocks that can be used for a workout

const toMin = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const toHHMM = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

// Free gaps (in minutes since midnight) inside [from, to], given the day's events.
export function freeGaps(events, from, to) {
  const busy = (events || [])
    .filter((e) => !e.all_day && !FREE_TITLES.test(e.title))
    .map((e) => {
      const s = toMin(e.start.slice(11, 16));
      const end = e.end ? toMin(e.end.slice(11, 16)) : s + 60;
      return [s, end > s ? end : s + 60];
    })
    .sort((a, b) => a[0] - b[0]);
  const gaps = [];
  let cursor = toMin(from);
  const stop = toMin(to);
  for (const [s, e] of busy) {
    if (s > cursor) gaps.push([cursor, Math.min(s, stop)]);
    cursor = Math.max(cursor, e);
    if (cursor >= stop) break;
  }
  if (cursor < stop) gaps.push([cursor, stop]);
  return gaps.filter(([s, e]) => e - s >= 10);
}

// Decide today's workout from the calendar. sessions = workouts done so far (for alternating).
// notBefore = minutes since midnight: when planning later in the day, ignore slots that already passed.
export function planFor(events, iso, sessions, notBefore = 0) {
  const dow = new Date(`${iso}T12:00:00Z`).getUTCDay();
  if (!WORKOUT_DAYS.includes(dow)) return null;
  const weekend = dow === 0 || dow === 6;
  const clamp = ([from, to]) => [toHHMM(Math.max(toMin(from), notBefore)), to];
  const gapsIn = (window) => (toMin(window[1]) - Math.max(toMin(window[0]), notBefore) >= 10 ? freeGaps(events, ...clamp(window)) : []);
  const pick = (window, minLen) => gapsIn(window).find(([s, e]) => e - s >= minLen);

  if (weekend) {
    const morning = pick(WINDOWS.weekendMorning, 35);
    if (morning) return { start: toHHMM(morning[0]), minutes: 30, kind: "run" };
  }
  const gaps = gapsIn(weekend ? WINDOWS.weekendAfternoon : WINDOWS.weekday);
  const full = gaps.find(([s, e]) => e - s >= 30);
  if (full) return { start: toHHMM(full[0]), minutes: 30, kind: sessions % 2 === 0 ? "strength" : "run" };
  const quick = gaps.find(([s, e]) => e - s >= 15);
  if (quick) return { start: toHHMM(quick[0]), minutes: 15, kind: "quick" };
  const fallback = Math.max(toMin(weekend ? "17:00" : "18:00"), notBefore + 10);
  if (fallback > toMin("20:00")) return null; // too late for anything today
  return { start: toHHMM(fallback), minutes: 10, kind: "mini" };
}

export async function getWorkout(env) {
  return (await env.DB.get("workout", "json")) || { on: true, log: {}, plan: null };
}

async function saveWorkout(env, w) {
  for (const d of Object.keys(w.log)) if (d < addDaysISO(todayISO(), -200)) delete w.log[d];
  await env.DB.put("workout", JSON.stringify(w));
}

const sessionsDone = (w) => Object.values(w.log).filter((l) => l.status === "done").length;

export function workoutStreak(log, today = todayISO()) {
  let day = log[today]?.status === "done" ? today : addDaysISO(today, -1);
  let n = 0;
  for (let i = 0; i < 120; i++, day = addDaysISO(day, -1)) {
    const dow = new Date(`${day}T12:00:00Z`).getUTCDay();
    if (!WORKOUT_DAYS.includes(dow)) continue; // Fridays don't break the streak
    if (log[day]?.status === "done") n++;
    else break;
  }
  return n;
}

// Make (or remake) today's plan from the calendar.
export async function planToday(env) {
  const w = await getWorkout(env);
  const today = todayISO();
  const now = localHour() * 60 + localMinute();
  const plan = planFor(await eventsForDay(env, today), today, sessionsDone(w), now + 5);
  w.plan = plan ? { date: today, ...plan, reminded: false } : { date: today, rest: true };
  await saveWorkout(env, w);
  return w.plan;
}

const KIND_TEXT = {
  run: "a 30-min run (endurance)",
  strength: "a 30-min bodyweight strength session",
  quick: "a quick 15-min routine",
  mini: "a 10-min mini workout",
};

// For Haneul's prompt.
export async function workoutContext(env) {
  const w = await getWorkout(env);
  if (!w.on) return "Workout: tracking paused.";
  const today = todayISO();
  const p = w.plan?.date === today ? w.plan : null;
  const status = w.log[today]?.status;
  const plan = !p ? "not planned yet" : p.rest ? "rest day (Friday)" : `${KIND_TEXT[p.kind]} at ${p.start}`;
  return `Workout today: ${plan}${status ? ` (${status})` : ""}. Workout streak: ${workoutStreak(w.log)} day(s).`;
}

function buttons() {
  return {
    inline_keyboard: [[
      { text: "✅ Done", callback_data: "wk:done" },
      { text: "⏰ In 1 h", callback_data: "wk:later" },
      { text: "⏭️ Skip", callback_data: "wk:skip" },
    ]],
  };
}

// Haneul writes the routine (in her voice), then the buttons.
export async function sendWorkout(env, haneulSays) {
  const w = await getWorkout(env);
  const p = w.plan;
  if (!p || p.rest) return send(env, "No workout today (Friday rest day). Enjoy your day!");
  const done = sessionsDone(w);
  await haneulSays(
    env,
    `It's almost workout time (${p.start}). Send Alex today's routine: ${KIND_TEXT[p.kind]}.
Goal: build endurance and some muscle (he's not trying to lose weight). No equipment, at home or outside.
He has done ${done} workout(s) so far, so make it a bit harder than a pure beginner plan as that number grows
(more reps, longer intervals), but keep it doable. For runs: warm-up, the main part (e.g. intervals or an easy pace
with times), cool-down. For strength: a short circuit with exercises, reps and rounds.
Send exactly 2 texts:
1) one short hype line (no emoji needed).
2) the routine as a list, one step per line, with exact numbers. For a run, e.g.:
   "5 min easy jog to warm up / 4 x (3 min faster + 2 min easy) / 5 min walk + stretch".
   For strength, e.g. "3 rounds: 15 squats / 10 push-ups / 30 s plank / 12 lunges each leg / 1 min rest".
   The steps must add up to about ${p.minutes} minutes. This text is the exception to "keep texts short".`
  );
  return send(env, `🏃 ${KIND_TEXT[p.kind]} · ${p.start}`, { reply_markup: buttons() });
}

export async function onWorkoutButton(env, q, action) {
  await tg(env, "editMessageReplyMarkup", { chat_id: q.message.chat.id, message_id: q.message.message_id }).catch(() => {});
  const w = await getWorkout(env);
  const today = todayISO();
  if (action === "done" || action === "skip") {
    w.log[today] = { status: action === "done" ? "done" : "skipped", kind: w.plan?.kind, minutes: w.plan?.minutes };
    await saveWorkout(env, w);
    if (action === "skip") return send(env, "ok, skipped today. tomorrow we go again");
    const streak = workoutStreak(w.log);
    return send(env, `logged it! ${streak > 1 ? `${streak} workouts in a row` : "first one in the streak"}. proud of u fr`);
  }
  // later: move it 1 hour (not past 20:15)
  const next = toMin(w.plan?.start || toHHMM(localHour() * 60 + localMinute())) + 60;
  const nowMin = localHour() * 60 + localMinute();
  const start = Math.max(next, nowMin + 60);
  if (start > toMin("20:15")) return send(env, "it's getting late for that, let's call today a rest day. /workout done if you squeeze one in");
  w.plan = { ...w.plan, start: toHHMM(start), reminded: false };
  await saveWorkout(env, w);
  return send(env, `bet, I'll remind you at ${toHHMM(start)}`);
}

// Called every 5 minutes: plan at 6:00, remind 5 minutes before the start (via the background queue).
export async function runWorkout(env) {
  const w = await getWorkout(env);
  if (!w.on) return;
  const today = todayISO();
  const nowMin = localHour() * 60 + localMinute();
  if (nowMin >= 6 * 60 && w.plan?.date !== today) await planToday(env);
  const fresh = await getWorkout(env);
  const p = fresh.plan;
  if (!p || p.rest || p.reminded || fresh.log[today]) return;
  if (nowMin >= toMin(p.start) - 5 && nowMin <= toMin(p.start) + 30) {
    fresh.plan.reminded = true;
    await saveWorkout(env, fresh);
    await env.BG_JOBS.send({ kind: "workout" });
  }
}

export async function onWorkoutCommand(env, arg, haneulSays) {
  const a = (arg || "").toLowerCase().trim();
  const w = await getWorkout(env);
  if (a === "off" || a === "on") {
    w.on = a === "on";
    await saveWorkout(env, w);
    return send(env, `Workout reminders ${w.on ? "ON" : "paused (/workout on to resume)"}.`);
  }
  if (a === "done" || a === "skip") return onWorkoutButton(env, { message: { chat: {}, message_id: 0 } }, a);
  if (a === "status") {
    const days = Object.entries(w.log).filter(([d, l]) => d >= addDaysISO(todayISO(), -6) && l.status === "done").length;
    return send(env, `🏃 ${sessionsDone(w)} workouts total · ${days} in the last 7 days · streak ${workoutStreak(w.log)}`);
  }
  // /workout: today's plan (re-fitted to the calendar) and the routine now
  const p = await planToday(env);
  if (p.rest) return send(env, "Friday is a rest day. See you tomorrow!");
  return sendWorkout(env, haneulSays);
}
