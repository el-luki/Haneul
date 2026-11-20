import { addDaysISO, todayISO } from "./dates.js";
import { send } from "./telegram.js";

// ---------- Schedule (/today, /tomorrow) ----------

export async function eventsForDay(env, iso) {
  const schedule = await env.DB.get("schedule", "json");
  if (!schedule) return null;
  return schedule.events.filter((e) => e.start.slice(0, 10) === iso);
}

export function formatEvent(e) {
  const when = e.all_day ? "all day" : e.start.slice(11, 16);
  return `${when} ${e.title}`;
}

// Returns 0 (today), 1 (tomorrow) or null (not a simple schedule question).
export function scheduleQuestionDay(text) {
  const q = text.toLowerCase();
  if (q.length > 90) return null; // long messages go to the assistant
  // "class"/"schedule" only counts in a QUESTION about it: "I was the second in my class"
  // used to get the timetable instead of a congratulations.
  const scheduleWord = /\b(class(es)?|clases?|schedule|horario|calendar|calendario)\b/.test(q);
  const asking = /\?|^(what|which|when|do i|have i|is there|any|show|qu[eé]|cu[aá]l(es)?|cu[aá]ndo|a qu[eé] hora|tengo|hay)\b/.test(q) ||
    /\b(what|which|when|qu[eé]|cu[aá]l(es)?|cu[aá]ndo)\b.*\b(class(es)?|clases?|schedule|horario|calendar|calendario)\b/.test(q);
  const asksSchedule =
    (scheduleWord && asking) ||
    /\b(what do i have|what('s| is) on|qu[eé] tengo|tengo algo)\b/.test(q);
  if (!asksSchedule) return null;
  // other days of the week aren't in the synced calendar: let the assistant handle those
  if (/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo|next week|semana)\b/.test(q)) return null;
  const morning = /\b(en|por|de|esta) la ma[nñ]ana\b/.test(q); // "la mañana" = the morning, not tomorrow
  if (/\btomorrow\b/.test(q) || (/\bma[nñ]ana\b/.test(q) && !morning)) return 1;
  return 0;
}

export async function showDay(env, offset) {
  const iso = addDaysISO(todayISO(), offset);
  const events = await eventsForDay(env, iso);
  if (!events) return send(env, "I don't have your calendar yet. It syncs every hour from GitHub.");
  const weekday = new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", day: "numeric", month: "short", timeZone: "UTC" });
  const label = `${offset === 0 ? "Today" : "Tomorrow"}, ${weekday}`;
  if (!events.length) return send(env, `📅 ${label}: nothing on the calendar.`);

  const important = events.filter((e) => e.tag === "PERSONAL");
  const classes = events.filter((e) => e.tag === "SCHOOL");
  const routine = events.filter((e) => e.tag === "ROUTINE");
  const parts = [`📅 ${label}`];
  if (important.length) parts.push(`⭐ Important\n${important.map(formatEvent).join("\n")}`);
  if (classes.length) parts.push(`🏫 Classes\n${classes.map(formatEvent).join("\n")}`);
  if (routine.length) parts.push(`🔄 Routine\n${routine.map(formatEvent).join("\n")}`);
  return send(env, parts.join("\n\n"));
}
