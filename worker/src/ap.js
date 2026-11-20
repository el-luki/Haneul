import { addDaysISO, daysBetween, mondayOf, todayISO } from "./dates.js";
import { send } from "./telegram.js";

// ---------- AP Physics 1 accountability ----------
//
// A study plan from now to exam day (units get weeks in proportion to their
// exam weight, then 6 weeks of review), a daily evening check-in with a streak,
// and a status line for the morning brief.

export const AP_UNITS = [
  // weights = middle of the College Board exam-weight range for each unit
  { n: 1, name: "Kinematics", weight: 12.5 },
  { n: 2, name: "Force and Translational Dynamics", weight: 20.5 },
  { n: 3, name: "Work, Energy, and Power", weight: 20.5 },
  { n: 4, name: "Linear Momentum", weight: 12.5 },
  { n: 5, name: "Torque and Rotational Dynamics", weight: 12.5 },
  { n: 6, name: "Energy and Momentum of Rotating Systems", weight: 6.5 },
  { n: 7, name: "Oscillations", weight: 6.5 },
  { n: 8, name: "Fluids", weight: 12.5 },
];
export const AP_DEFAULT_EXAM = "2027-05-05"; // AP Physics 1, afternoon. Change with /ap exam YYYY-MM-DD
export const AP_REVIEW_WEEKS = 6;

export async function getAp(env) {
  const ap = (await env.DB.get("ap", "json")) || {};
  return {
    exam: ap.exam || AP_DEFAULT_EXAM,
    start: ap.start || mondayOf(todayISO()),
    created: ap.created || todayISO(), // the day tracking began (no "missed" warnings before it)
    done: ap.done || [],
    logs: ap.logs || {}, // { "YYYY-MM-DD": { minutes, rest, missed, notes: [] } }
  };
}

export async function saveAp(env, ap) {
  await env.DB.put("ap", JSON.stringify(ap));
}

export function apPlan(ap) {
  const totalWeeks = Math.max(1, Math.floor(daysBetween(ap.start, ap.exam) / 7));
  const contentWeeks = Math.max(AP_UNITS.length, totalWeeks - AP_REVIEW_WEEKS);
  const totalWeight = AP_UNITS.reduce((s, u) => s + u.weight, 0);
  const exact = AP_UNITS.map((u) => (u.weight / totalWeight) * contentWeeks);
  const weeks = exact.map((x) => Math.max(1, Math.floor(x)));
  // hand out the leftover weeks to the units with the biggest remainders
  const order = exact.map((x, i) => ({ i, r: x - Math.floor(x) })).sort((a, b) => b.r - a.r);
  for (let k = 0; weeks.reduce((s, w) => s + w, 0) < contentWeeks; k++) weeks[order[k % order.length].i]++;

  let cursor = ap.start;
  const units = AP_UNITS.map((u, i) => {
    const start = cursor;
    cursor = addDaysISO(cursor, weeks[i] * 7);
    return { ...u, start, end: cursor }; // end is exclusive
  });
  return { units, reviewStart: cursor };
}

export function apStreak(ap) {
  let day = todayISO();
  if (!ap.logs[day]) day = addDaysISO(day, -1); // today not logged yet: count from yesterday
  let streak = 0;
  while (ap.logs[day] && (ap.logs[day].minutes > 0 || ap.logs[day].rest)) {
    streak++;
    day = addDaysISO(day, -1);
  }
  return streak;
}

export function apWeekMinutes(ap) {
  const monday = mondayOf(todayISO());
  return Object.entries(ap.logs)
    .filter(([d]) => d >= monday)
    .reduce((s, [, l]) => s + (l.minutes || 0), 0);
}

export function shortDate(iso) {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { day: "numeric", month: "short", timeZone: "UTC" });
}

export function hours(minutes) {
  return minutes >= 60 ? `${Math.round((minutes / 60) * 10) / 10} h` : `${minutes} min`;
}

// Short status, used by /ap, the check-in and the morning brief.
export function apSummary(ap) {
  const today = todayISO();
  const { units, reviewStart } = apPlan(ap);
  const daysLeft = daysBetween(today, ap.exam);
  const expected = units.filter((u) => u.end <= today).length;
  const done = ap.done.length;
  const next = units.find((u) => !ap.done.includes(u.n));
  const planned = today >= reviewStart ? null : units.find((u) => today >= u.start && today < u.end);

  let pace = "✅ on track";
  if (done < expected) pace = `⚠️ ${expected - done} unit${expected - done > 1 ? "s" : ""} behind`;
  if (done > expected) pace = `🚀 ${done - expected} unit${done - expected > 1 ? "s" : ""} ahead`;

  const lines = [`📘 AP Physics 1: ${daysLeft} days to the exam (${shortDate(ap.exam)})`];
  if (planned) lines.push(`📍 Plan: Unit ${planned.n} ${planned.name} (until ${shortDate(addDaysISO(planned.end, -1))})`);
  else if (today >= reviewStart) lines.push("📍 Plan: REVIEW + practice exams");
  if (next && (!planned || next.n !== planned.n)) lines.push(`➡️ Next to finish: Unit ${next.n} ${next.name}`);
  if (!next) lines.push("🎉 All 8 units done. Practice exams now!");
  lines.push(`📊 Units done: ${done}/8 · ${pace}`);
  lines.push(`🔥 Streak: ${apStreak(ap)} day(s) · this week: ${hours(apWeekMinutes(ap))}`);

  const yesterday = addDaysISO(today, -1);
  const y = ap.logs[yesterday];
  if (yesterday >= ap.created && (!y || y.missed)) lines.push("😬 No AP Physics yesterday.");
  return lines.join("\n");
}

export async function apLog(env, minutes, { rest = false, missed = false, note = "" } = {}) {
  const ap = await getAp(env);
  const today = todayISO();
  const log = ap.logs[today] || { minutes: 0, notes: [] };
  if (missed) Object.assign(log, { missed: true });
  else if (rest) Object.assign(log, { rest: true, missed: false });
  else Object.assign(log, { minutes: (log.minutes || 0) + minutes, missed: false });
  if (note) log.notes = [...(log.notes || []), note];
  ap.logs[today] = log;
  // keep ~6 months of history
  for (const d of Object.keys(ap.logs)) if (daysBetween(d, today) > 200) delete ap.logs[d];
  await saveAp(env, ap);

  const next = apPlan(ap).units.find((u) => !ap.done.includes(u.n));
  if (missed) {
    return send(env, `Logged as a miss. No streak today.\nTomorrow: ${next ? `Unit ${next.n} ${next.name}` : "practice exam"}. Even 20 minutes counts. 💪`);
  }
  if (rest) {
    const restDays = Object.entries(ap.logs).filter(([d, l]) => d >= mondayOf(today) && l.rest).length;
    const warn = restDays > 1 ? `\n⚠️ That's ${restDays} rest days this week. Don't make it a habit.` : "";
    return send(env, `😴 Rest day logged. Your streak is safe.${warn}`);
  }
  return send(
    env,
    `✅ ${hours(minutes)} logged${note ? ` (${note})` : ""}. Today: ${hours(log.minutes)}.\n` +
      `🔥 Streak: ${apStreak(ap)} day(s) · this week: ${hours(apWeekMinutes(ap))}\n` +
      (next ? `Finished Unit ${next.n}? Send /ap done ${next.n}` : "")
  );
}

export async function onApCommand(env, arg) {
  const [first = "", ...rest] = arg.split(/\s+/).filter(Boolean);
  const value = rest.join(" ");
  const act = first.toLowerCase();
  const ap = await getAp(env);

  if (/^\d+$/.test(act)) return apLog(env, Number(act), { note: value }); // "/ap 45 newton's laws"
  if (act === "rest") return apLog(env, 0, { rest: true });

  if (act === "done" || act === "undo") {
    const n = Number(value);
    if (!AP_UNITS.some((u) => u.n === n)) return send(env, `Which unit? e.g. /ap ${act} 1 (units 1-8, see /ap plan)`);
    ap.done = act === "done" ? [...new Set([...ap.done, n])] : ap.done.filter((x) => x !== n);
    await saveAp(env, ap);
    const unit = AP_UNITS.find((u) => u.n === n);
    return send(env, `${act === "done" ? "🎉 Unit done" : "↩️ Unmarked"}: ${n}. ${unit.name}\n\n${apSummary(ap)}`);
  }

  if (act === "exam") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return send(env, "Send the date like: /ap exam 2027-05-05");
    ap.exam = value;
    await saveAp(env, ap);
    return send(env, `📅 Exam date set to ${shortDate(value)}. The plan is updated.\n\n${apSummary(ap)}`);
  }

  if (act === "plan") {
    const { units, reviewStart } = apPlan(ap);
    const today = todayISO();
    const lines = units.map((u) => {
      const mark = ap.done.includes(u.n) ? "✅" : today >= u.start && today < u.end ? "👉" : "▫️";
      return `${mark} ${u.n}. ${u.name}\n     ${shortDate(u.start)} – ${shortDate(addDaysISO(u.end, -1))}`;
    });
    lines.push(`${today >= reviewStart ? "👉" : "▫️"} Review + practice exams\n     ${shortDate(reviewStart)} – ${shortDate(ap.exam)}`);
    return send(env, `📘 AP Physics 1 plan\n\n${lines.join("\n")}\n\nMark a unit with /ap done <number>.`);
  }

  if (act && act !== "status") {
    return send(env, "AP commands:\n/ap: status\n/ap plan: full plan\n/ap 45 kinematics: log 45 min\n/ap rest: rest day\n/ap done 1 · /ap undo 1\n/ap exam 2027-05-05");
  }

  // first time: save the start date so the plan doesn't move every week
  if (!(await env.DB.get("ap"))) await saveAp(env, ap);
  return send(env, `${apSummary(ap)}\n\n/ap plan · /ap 45 <topic> · /ap done <unit>`);
}

export async function apCheckin(env) {
  const ap = await getAp(env);
  const today = todayISO();
  if (ap.logs[today]) return; // already logged today, no need to ask
  const next = apPlan(ap).units.find((u) => !ap.done.includes(u.n));
  await send(
    env,
    `📘 AP Physics check-in: did you study today?\n` +
      (next ? `Current focus: Unit ${next.n} ${next.name}\n` : "") +
      `🔥 Streak: ${apStreak(ap)} day(s)\n\n(Or type e.g. "/ap 45 projectile motion")`,
    {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "✅ 30 min", callback_data: "ap:30" },
            { text: "✅ 1 h", callback_data: "ap:60" },
            { text: "✅ 2 h", callback_data: "ap:120" },
          ],
          [
            { text: "😴 Rest day", callback_data: "ap:rest" },
            { text: "❌ Didn't study", callback_data: "ap:miss" },
          ],
        ],
      },
    }
  );
}
