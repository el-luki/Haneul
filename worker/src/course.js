import { addDaysISO, localHour, todayISO } from "./dates.js";

// ---------- AP Physics 1A (online school course): finish Semester A by the deadline ----------
// The course's modules (from Canvas) are turned into tasks: one per lesson (Engage → Explain → Elaborate
// → practice quiz), one per graded assignment, exam prep and the proctored exams. Every day Haneul spreads
// what's LEFT over the days that are left (weekends lighter, Dec 24-25 off), so the plan always fits the
// deadline; and she compares his progress with the steady pace to say how far behind/ahead he is.
// 16:15: today's physics (start of homework time). 19:00: did you do it? He tells her (or ticks it in the
// app) and the plan updates.
// KV "course": { name, deadline, created, tasks: [{ id, unit, kind, title, items, min, done, doneOn }] }

const OFF = ["12-24", "12-25", "12-31", "01-01"];
const weightOf = (iso) => {
  if (OFF.includes(iso.slice(5))) return 0;
  const wd = new Date(`${iso}T12:00:00Z`).getUTCDay();
  return wd === 0 ? 0.5 : wd === 6 ? 0.6 : 1; // lighter weekends
};

export async function getCourse(env) {
  return env.DB.get("course", "json");
}
async function saveCourse(env, c) {
  await env.DB.put("course", JSON.stringify(c));
}

// Days the work is spread over: today (until the 19:00 check-in) … the day before the deadline.
function workDays(c, today, includeToday) {
  const days = [];
  const last = addDaysISO(c.deadline, -2); // done by deadline - 2: one spare day before it
  for (let d = includeToday ? today : addDaysISO(today, 1); d <= last; d = addDaysISO(d, 1)) if (weightOf(d) > 0) days.push(d);
  return days;
}

// The plan from today: { days: [{ date, tasks, min }], perUnit (minutes per weight unit), left, done, behind }.
export function coursePlan(c, today = todayISO(), hour = localHour()) {
  const doneToday = c.tasks.filter((t) => t.done && t.doneOn === today);
  const left = c.tasks.filter((t) => !t.done);
  const includeToday = hour < 21 || !doneToday.length; // late at night with today's work done: start tomorrow
  const days = workDays(c, today, includeToday);
  const total = left.reduce((s, t) => s + t.min, 0);
  const weights = days.reduce((s, d) => s + weightOf(d), 0) || 1;
  const perUnit = total / weights;
  const plan = days.map((date) => ({ date, tasks: [], min: 0 }));
  // in order, each task goes on the first day whose running share of the work covers the task's middle
  const capEnd = []; let acc = 0;
  for (const d of plan) { acc += perUnit * weightOf(d.date); capEnd.push(acc); }
  let used = 0, di = 0;
  for (const t of left) {
    const mid = used + t.min / 2;
    while (di < plan.length - 1 && capEnd[di] < mid) di++;
    if (!plan[di]) break;
    plan[di].tasks.push(t);
    plan[di].min += t.min;
    used += t.min;
  }
  // steady pace since the plan started: where he "should" be by now
  const allMin = c.tasks.reduce((s, t) => s + t.min, 0);
  const doneMin = c.tasks.filter((t) => t.done).reduce((s, t) => s + t.min, 0);
  const startDays = []; for (let d = c.created; d < c.deadline; d = addDaysISO(d, 1)) startDays.push(d);
  const wAll = startDays.reduce((s, d) => s + weightOf(d), 0) || 1;
  const wPast = startDays.filter((d) => d < today).reduce((s, d) => s + weightOf(d), 0);
  const shouldMin = Math.round((allMin - (c.startDoneMin || 0)) * (wPast / wAll) + (c.startDoneMin || 0));
  return {
    days: plan.filter((d) => d.tasks.length),
    perWeekday: Math.round(perUnit),
    leftMin: total, leftTasks: left.length, doneTasks: c.tasks.length - left.length, allTasks: c.tasks.length,
    pct: Math.round((doneMin / allMin) * 100),
    behindMin: shouldMin - doneMin, // > 0: behind the steady pace
    daysLeft: Math.max(0, Math.round((Date.parse(`${c.deadline}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / 86400000)),
  };
}

export async function importCourse(env, data) {
  if (!data?.tasks?.length) return { error: "no tasks" };
  const old = await getCourse(env);
  const doneBefore = new Set((old?.tasks || []).filter((t) => t.done).map((t) => t.title));
  const tasks = data.tasks.map((t, i) => ({ id: `p${i + 1}`, unit: t.unit || null, kind: String(t.kind || "lesson"), title: String(t.title).slice(0, 160),
    items: (t.items || []).map((x) => String(x).slice(0, 160)).slice(0, 20), min: Math.max(10, Math.min(300, Number(t.min) || 60)),
    done: !!t.done || doneBefore.has(t.title), doneOn: t.done ? "before" : null }));
  const c = { name: String(data.name || "AP Physics").slice(0, 80), deadline: data.deadline || "2026-12-31", created: old?.created || todayISO(), tasks };
  c.startDoneMin = tasks.filter((t) => t.done).reduce((s, t) => s + t.min, 0);
  await saveCourse(env, c);
  return { tasks: tasks.length, left: tasks.filter((t) => !t.done).length };
}

// Mark tasks done/undone by id ("p7") or by words from the title ("graded 02", "newton's 2nd law").
export async function markCourse(env, refs, done = true) {
  const c = await getCourse(env);
  if (!c) return [];
  const changed = [];
  for (const ref of refs || []) {
    const r = String(ref).toLowerCase().trim();
    const t = c.tasks.find((x) => x.id === r) || c.tasks.find((x) => x.title.toLowerCase() === r)
      || c.tasks.filter((x) => x.done !== done).find((x) => r.length > 4 && x.title.toLowerCase().includes(r));
    if (!t || t.done === done) continue;
    t.done = done;
    t.doneOn = done ? todayISO() : null;
    changed.push(t);
  }
  if (changed.length) await saveCourse(env, c);
  return changed;
}

const fmt = (t) => `[${t.id}] ${t.title} (~${t.min} min)`;

// For her prompt: today's physics, how he's doing against the deadline, task ids to mark.
export async function courseContext(env) {
  const c = await getCourse(env);
  if (!c) return "";
  const p = coursePlan(c);
  const today = p.days[0]?.date === todayISO() ? p.days[0] : null;
  const doneToday = c.tasks.filter((t) => t.doneOn === todayISO());
  const next = c.tasks.filter((t) => !t.done).slice(0, 6);
  return `AP PHYSICS 1A (online course, Semester A must be finished by ${c.deadline}; he's behind and asked you to keep him accountable):
${p.doneTasks}/${p.allTasks} tasks done (${p.pct}%), ${Math.round(p.leftMin / 60)} h of work left, ${p.daysLeft} days left. ${p.behindMin > 30 ? `He's about ${Math.round(p.behindMin / 60 * 10) / 10} h BEHIND the steady pace.` : p.behindMin < -30 ? "He's ahead of the steady pace." : "He's on pace."}
Today's plan: ${today ? today.tasks.map(fmt).join("; ") : "nothing (rest day)"}.${doneToday.length ? ` Done today: ${doneToday.map((t) => t.title).join("; ")}.` : ""}
Next tasks in order: ${next.map(fmt).join("; ")}.
When he says he finished a lesson / assignment / exam, fill "course_done" with the task ids. Be a firm, caring study buddy: celebrate
each one, and if he's behind, say it honestly and give the next small step (not a lecture).`;
}

// 16:15 on school days (11:00 weekends): today's physics. 19:00 (16:00 weekends): the check.
export async function courseNudge(env, haneulSays, kind) {
  const c = await getCourse(env);
  if (!c) return;
  const p = coursePlan(c);
  const today = p.days[0]?.date === todayISO() ? p.days[0] : null;
  if (!today) return;
  const doneToday = c.tasks.filter((t) => t.doneOn === todayISO());
  const left = today.tasks.filter((t) => !t.done);
  if (kind === "check" && !left.length) return; // all done: no nagging
  const status = `${p.pct}% done, ${p.daysLeft} days to the ${c.deadline} deadline, ${p.behindMin > 30 ? `about ${Math.round(p.behindMin / 6) / 10} h behind` : "on pace"}`;
  await haneulSays(env, kind === "start"
    ? `Start of Alex's homework time: tell him today's AP Physics (online course) in 1-2 short texts: ${left.map((t) => `"${t.title}" (~${t.min} min)`).join(" + ")}.
Status: ${status}. Motivating and concrete (open the module, start with the first page). No lists.`
    : `It's the AP Physics check-in. Today's plan was: ${today.tasks.map((t) => `"${t.title}"`).join(" + ")}; ${doneToday.length ? `he already finished ${doneToday.map((t) => `"${t.title}"`).join(", ")}` : "nothing is marked done yet"}.
Status: ${status}. Ask him in 1-2 short texts whether he did it. If he didn't start, push kindly but firmly: even the first lesson page now.`);
}
