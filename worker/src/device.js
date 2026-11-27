import { localHour, localMinute, todayISO } from "./dates.js";
import { eventsForDay } from "./schedule.js";

// ---------- Haneul Station: the physical face module ----------
// The PC bridge (station/bridge) asks for her state every few seconds and passes it to the Uno over USB:
//   GET  /device/state?key=DEVICE_KEY            → { mode, color, eyes, line1, line2, focusLeft, msgId, overdue }
//   POST /device/focus?key=…&min=45&label=AP     → starts a focus session (the knob + button)
//   POST /device/stop?key=…                      → ends it
// DEVICE_KEY lives in KV "device_key" and only opens these three routes (never the worker secret).

export async function deviceAuthorized(env, key) {
  const k = await env.DB.get("device_key");
  return !!k && typeof key === "string" && key.length >= 24 && key === k;
}

// The LCD1602 only has ASCII: drop accents and anything else, cut to 16.
export function lcd(s) {
  return String(s || "").normalize("NFD").replace(/\p{M}/gu, "").replace(/[^\x20-\x7E]/g, "").replace(/\s+/g, " ").trim().slice(0, 16);
}

// What she "feels" on the desk, in order of importance.
export function pickMode({ focus, hour, overdue, newMessage }) {
  if (focus) return "focus";
  if (hour >= 21 || hour < 5) return "sleep";
  if (newMessage) return "talk";
  if (overdue > 0) return "alert";
  return "idle";
}

// LED color per mode (soft, pleasant on a desk; the Uno dims it at night).
export const MODE_COLOR = { focus: [40, 200, 170], sleep: [20, 20, 70], talk: [230, 120, 200], alert: [255, 150, 30], idle: [170, 120, 255] };

const hhmm = (t) => t.slice(11, 16);
const mins = (t) => Number(t.slice(11, 13)) * 60 + Number(t.slice(14, 16));

export async function deviceState(env, now = Date.now()) {
  const nowMin = localHour() * 60 + localMinute(), hour = localHour();
  const { getFocus } = await import("./focus.js");
  const focus = await getFocus(env).catch(() => null);
  const todos = (await env.DB.get("todos", "json").catch(() => null)) || [];
  const overdue = todos.filter((t) => !t.done && t.due && t.due < todayISO()).length;
  let msgId = 0, msgAt = 0;
  if (env.FEED) {
    const r = await env.FEED.prepare("SELECT id, at FROM feed WHERE who = 'her' ORDER BY id DESC LIMIT 1").first().catch(() => null);
    if (r) { msgId = r.id; msgAt = r.at; }
  }
  const newMessage = msgAt && now - msgAt < 2 * 60000; // she texted in the last 2 minutes
  const mode = pickMode({ focus, hour, overdue, newMessage });
  let line1 = "", line2 = "";
  if (focus) {
    const left = Math.max(0, Math.round((focus.until - now) / 1000));
    line1 = lcd(`Focus: ${focus.label}`);
    line2 = lcd(`${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")} left`);
  } else {
    const events = ((await eventsForDay(env, todayISO()).catch(() => [])) || [])
      .filter((e) => !e.all_day && e.start && !/^cancel+ed\b/i.test(e.title) && mins(e.start) > nowMin)
      .sort((a, b) => a.start.localeCompare(b.start));
    const next = events[0];
    if (next) {
      const inMin = mins(next.start) - nowMin;
      line1 = lcd(next.title.replace(/^C\d+:\s*|^Velocity:\s*/i, ""));
      line2 = lcd(`${hhmm(next.start)}  in ${inMin >= 60 ? `${Math.floor(inMin / 60)}h${String(inMin % 60).padStart(2, "0")}` : `${inMin}m`}`);
    } else {
      line1 = lcd(hour >= 21 || hour < 5 ? "Good night Alex" : "Nothing else");
      line2 = lcd(overdue ? `${overdue} to-do overdue` : "today :)");
    }
  }
  return { mode, color: MODE_COLOR[mode], line1, line2, focusLeft: focus ? Math.max(0, Math.round((focus.until - now) / 1000)) : 0, msgId, overdue, hour };
}
