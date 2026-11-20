import { addDaysISO, localHour, localMinute, todayISO } from "./dates.js";
import { freeGaps, getWorkout } from "./workout.js";

// ---------- Finding a free spot in the calendar ----------
// Used for tasks that have a deadline but no time (e.g. Velocity challenge tasks):
// each one goes into the first free gap on its due day (or, if that day is full, the day before…),
// inside the hours Alex is actually free. Tasks placed earlier in the same batch count as busy.

export const SLOT_WINDOWS = {
  weekday: ["15:30", "21:00"], // after school + bus, before bed
  weekend: ["09:00", "20:00"],
};
// Calendar days that aren't synced yet: a sensible default time (still avoiding other placed tasks).
const DEFAULT_START = { weekday: "18:00", weekend: "10:00" };

const toMin = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const toHHMM = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const isWeekend = (iso) => [0, 6].includes(new Date(`${iso}T12:00:00Z`).getUTCDay());
const at = (iso, min) => `${iso}T${toHHMM(min)}:00-05:00`;

// One spot on one day, or null. known = the calendar for that day is synced.
function spotOn(iso, minutes, busy, { known, notBefore }) {
  const kind = isWeekend(iso) ? "weekend" : "weekday";
  const [from, to] = SLOT_WINDOWS[kind];
  const start = Math.max(toMin(from), notBefore);
  if (toMin(to) - start < minutes) return null;
  const events = known ? busy : busy.filter((e) => e.placed); // unknown day: only our own tasks
  if (!known) {
    // default time, pushed later past anything already placed there
    const s = Math.max(toMin(DEFAULT_START[kind]), start);
    for (const [gs, ge] of freeGaps(events, toHHMM(s), to)) {
      if (ge - gs >= minutes) return gs;
    }
    return null;
  }
  for (const [gs, ge] of freeGaps(events, toHHMM(start), to)) {
    const s = Math.ceil(gs / 5) * 5; // start on a round-ish time
    if (ge - s >= minutes) return s;
  }
  return null;
}

// tasks: [{task, due, time?, minutes?}] → same tasks with {start, end} (timed), or {noSlot: true} (no free
// time left before it's due: it stays a to-do only; Alex doesn't want all-day events), or {past: true}.
// eventsOn(iso) → that day's calendar events (or null if the day isn't synced).
export function placeTasks(tasks, { today, nowMin, eventsOn }) {
  const placed = [];
  const out = [];
  for (const t of tasks) {
    if (!t.due) {
      out.push({ ...t, skip: true });
      continue;
    }
    if (t.due < today) {
      out.push({ ...t, past: true }); // its day is over: no calendar event
      continue;
    }
    const minutes = Math.min(Math.max(Number(t.minutes) || 30, 10), 120);
    if (t.time && /^\d{2}:\d{2}$/.test(t.time)) {
      const s = toMin(t.time);
      placed.push({ start: at(t.due, s), end: at(t.due, s + minutes), title: t.task, placed: true });
      out.push({ ...t, start: at(t.due, s), end: at(t.due, s + minutes), fixed: true });
      continue;
    }
    let found = null;
    // the due day first, then the days before it (never before today). A "Day 3" of a daily
    // challenge stays on its day (doing day 5 on day 4 makes no sense): all-day if it's full.
    const daily = /\b(day|d[ií]a)\s*\d+\b/i.test(t.task);
    const last = daily ? (t.due < today ? today : t.due) : today;
    for (let day = t.due < today ? today : t.due; day >= last && !found; day = addDaysISO(day, -1)) {
      const cal = eventsOn(day);
      const busy = [...(cal || []), ...placed.filter((p) => p.start.slice(0, 10) === day)];
      const s = spotOn(day, minutes, busy, { known: !!cal, notBefore: day === today ? nowMin + 15 : 0 });
      if (s !== null) found = { day, s };
    }
    if (!found) {
      out.push({ ...t, noSlot: true });
      continue;
    }
    const start = at(found.day, found.s);
    const end = at(found.day, found.s + minutes);
    placed.push({ start, end, title: t.task, placed: true });
    out.push({ ...t, start, end, moved: found.day !== t.due });
  }
  return out;
}

// The synced calendar (+ today's planned workout) as an eventsOn() function for placeTasks.
export async function calendarLookup(env) {
  const schedule = await env.DB.get("schedule", "json");
  const today = todayISO();
  const until = schedule?.until || (schedule ? addDaysISO(schedule.synced_at.slice(0, 10), 1) : null);
  const w = await getWorkout(env).catch(() => null);
  const workout =
    w?.plan?.date === today && !w.plan.rest && w.plan.start
      ? [{ start: at(today, toMin(w.plan.start)), end: at(today, toMin(w.plan.start) + (w.plan.minutes || 30)), title: "Workout" }]
      : [];
  return {
    today,
    nowMin: localHour() * 60 + localMinute(),
    eventsOn: (iso) => {
      if (!schedule || !until || iso > until || iso < today) return null;
      const events = schedule.events.filter((e) => e.start.slice(0, 10) === iso);
      return iso === today ? [...events, ...workout] : events;
    },
  };
}
