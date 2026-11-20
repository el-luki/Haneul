import { shortDate } from "./ap.js";
import { chat } from "./chat.js";
import { dayName, todayISO, todayLong } from "./dates.js";
import { gemini, parseJson } from "./gemini.js";
import { startGithubJob } from "./reminders.js";
import { send, tg, typing } from "./telegram.js";

// ---------- Add events to Google Calendar ----------
// Uses a small Google Apps Script in your personal Google account (see
// calendar-script/Code.gs). The bot asks for confirmation before adding anything.

export async function onEvent(env, text) {
  if (!env.CALENDAR_SCRIPT_URL) return send(env, "📅 Adding events isn't set up yet (the calendar script is missing).");
  if (!text) return send(env, "Tell me the event, e.g.: /event Meeting with Jordan friday 5pm");
  await typing(env);
  const prompt = `Today is ${todayLong()} (${todayISO()}), timezone UTC-5 (Lima).
Turn this into ONE calendar event: "${text}"
Return JSON: {"title": "...", "date": "YYYY-MM-DD", "start": "HH:MM" or null, "end": "HH:MM" or null,
"all_day": true/false, "location": "" }
Resolve relative dates ("friday", "mañana", "next week") to real dates. If there's a start but no end, end = start + 1 hour.
If there's no time at all, all_day = true. Keep the title short and in the original language.`;
  const e = parseJson((await gemini(env, [{ role: "user", parts: [{ text: prompt }] }], { json: true })));
  if (!e.title || !/^\d{4}-\d{2}-\d{2}$/.test(e.date || "")) return send(env, "I couldn't work out the date. Try e.g.: /event Dentist 12 Nov 3pm");
  const allDay = e.all_day || !e.start;
  const event = {
    title: e.title,
    allDay,
    start: allDay ? e.date : `${e.date}T${e.start}:00-05:00`,
    end: allDay ? e.date : `${e.date}T${e.end || e.start}:00-05:00`,
    location: e.location || "",
  };
  if (!allDay && event.end <= event.start) event.end = `${e.date}T${String(Number(e.start.slice(0, 2)) + 1).padStart(2, "0")}${e.start.slice(2)}:00-05:00`;
  await env.DB.put("pending_event", JSON.stringify(event), { expirationTtl: 3600 });
  const when = allDay ? `${shortDate(e.date)} (all day)` : `${dayName(e.date).split(",").slice(0, 2).join(",")}, ${e.start}–${event.end.slice(11, 16)}`;
  return send(env, `📅 Add this to your calendar?\n\n${event.title}\n🕐 ${when}${event.location ? `\n📍 ${event.location}` : ""}`, {
    reply_markup: { inline_keyboard: [[{ text: "✅ Add it", callback_data: "event:add" }, { text: "✖ Cancel", callback_data: "event:cancel" }]] },
  });
}

export async function confirmEvent(env, q, choice) {
  const edit = (text) => tg(env, "editMessageText", { chat_id: q.message.chat.id, message_id: q.message.message_id, text }).catch(() => {});
  const event = await env.DB.get("pending_event", "json");
  await env.DB.delete("pending_event");
  if (choice !== "add") return edit("✖ Not added.");
  if (!event) return edit("That expired. Send the event again.");
  const result = await createCalendarEvent(env, event);
  if (!result.ok) return edit(`⚠️ Couldn't add it: ${result.error}`);
  await edit(`✅ Added to your calendar: ${event.title}`);
  // Sync now so reminders and /today know about it in a minute.
  await startGithubJob(env, "sync-schedule.yml").catch(() => {});
}

// Sends one event to the Apps Script in Alex's Google account. event = {title, allDay, start, end, location}
// Removes the all-day events the bot made whose title starts with `prefix`, between two dates.
export async function deleteBotAllDayEvents(env, { from, to, prefix }) {
  return createCalendarEvent(env, { action: "delete_all_day", from, to, prefix });
}

export async function createCalendarEvent(env, event) {
  if (!env.CALENDAR_SCRIPT_URL) return { ok: false, error: "the calendar script isn't set up" };
  const res = await fetch(env.CALENDAR_SCRIPT_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...event, secret: env.CALENDAR_SCRIPT_SECRET }),
  }).catch((err) => ({ ok: false, json: async () => ({ error: err.message }) }));
  const data = await res.json().catch(() => ({}));
  return data.ok ? { ...data, ok: true } : { ok: false, error: data.error || `the calendar script answered ${res.status}` };
}
