import { saveFound } from "./agenda.js";
import { sameFact } from "./memory.js";
import { MODELS_SMART } from "./config.js";
import { addDaysISO, localHour, localMinute, localWeekday, shortDateISO, todayISO, todayLong } from "./dates.js";
import { createCalendarEvent, deleteBotAllDayEvents } from "./events.js";
import { gemini, parseJson } from "./gemini.js";
import { ensureNotion, findChildPage, latestUnder, notionReady } from "./notion.js";
import { startGithubJob } from "./reminders.js";
import { calendarLookup, placeTasks } from "./slots.js";
import { send, tg, typing } from "./telegram.js";
import { formatTodos, getTodos } from "./todos.js";

// ---------- TKS Velocity weekly challenges ----------
// The challenge pages TKS sends live in TKS's Notion, so Alex duplicates each one into
// Haneul → TKS → Velocity. Every hour (or /velocity) Haneul looks there for a new or updated
// challenge, pulls out the tasks and deadlines, and offers: ➕ to-dos / 📅 + calendar / ✖ skip.
// Accountability: tasks become "Velocity: …" to-dos, she knows the progress in chat, and
// there's a mid-week check-in on Wednesday if tasks are still open.

const PREFIX = "Velocity: ";
const dayNum = (t) => (String(t).match(/\b(?:day|d[ií]a)\s*(\d+)/i) || [])[1] || "";
export function sameTask(a, b) {
  // the opening verb is the AI's wording, not the task: "Conduct" = "Set up and run" = "Complete"
  const core = (t) => String(t).replace(PREFIX, "").replace(/^(?:complete|conduct|perform|do|finish|run|hold|attend|lead|join|participate in|set up and run|set up|start|host)\s+(?:the\s+)?/i, "");
  const x = core(a), y = core(b);
  return dayNum(x) === dayNum(y) && sameFact(x, y);
}
const CHECKIN = { weekday: "Wed", hour: 17, minute: 30 };

async function velocityPage(env) {
  const ids = await ensureNotion(env);
  if (!ids?.tks) return null;
  if (ids.velocity) return ids.velocity;
  // Prefer the page called exactly "Velocity" ("Weekly velocity checkup" also contains the word).
  const id = (await findChildPage(env, ids.tks, /^\s*velocity\s*$/i)) || (await findChildPage(env, ids.tks, /velocity/i));
  if (id) await env.DB.put("notion", JSON.stringify({ ...ids, velocity: id }));
  return id;
}

export function extractPrompt(title, text) {
  return `Today is ${todayLong()} (${todayISO()}), timezone UTC-5. This is a TKS "Velocity" weekly challenge
that Alex has to complete. Pull out EVERY concrete thing he has to do, with its deadline.

Return JSON:
{"challenge": "short name of the challenge", "summary": "one sentence on what it's about",
 "tasks": [{"task": "short, starts with a verb", "due": "YYYY-MM-DD" or null,
            "time": "HH:MM" or null (only if a time is given, e.g. a live session), "minutes": number or null}]}
Rules: only tasks that are really in the page (no invented ones). Resolve weekdays and relative dates
("by Friday", "day 3") to real dates from today. If there's a daily task (e.g. "5-day plank challenge"),
make one task per day. If the page isn't a challenge at all, return {"tasks": []}.

PAGE: ${title}
${text.slice(0, 12000)}`;
}

// Finds the newest challenge and, if it's new or changed, offers its tasks. manual = /velocity
export async function checkVelocity(env, { manual = false } = {}) {
  if (!notionReady(env)) return manual ? send(env, "Notion isn't connected, so I can't read your Velocity challenges.") : null;
  const pageId = await velocityPage(env);
  if (!pageId) {
    return manual ? send(env, "I couldn't find a \"Velocity\" page inside Haneul → TKS. Make one (or check the name) and duplicate the challenge into it.") : null;
  }
  const page = await latestUnder(env, pageId, { includeSelf: true });
  if (!page || page.tooShort) {
    return manual ? send(env, "no challenge in your Velocity page yet. on the TKS challenge page: ⋯ → Duplicate, then move the copy into Haneul → TKS → Velocity") : null;
  }
  const seen = (await env.DB.get("velocity_seen", "json")) || {};
  if (!manual && seen[page.id] === page.edited) return null; // nothing new
  seen[page.id] = page.edited;
  await env.DB.put("velocity_seen", JSON.stringify(seen));

  await typing(env);
  const r = parseJson(await gemini(env, [{ role: "user", parts: [{ text: extractPrompt(page.title, page.text) }] }], { json: true, models: MODELS_SMART }));
  const all = (r.tasks || []).filter((t) => t && t.task);
  if (!all.length) return manual ? send(env, `I read "${page.title}" but didn't find any tasks in it.`) : null;
  // a copy of the same challenge (or the same page edited) must not add everything again
  const open = (await getTodos(env)).filter((t) => t.task.startsWith(PREFIX)).map((t) => t.task);
  const done = ((await env.DB.get("done_log", "json")) || []).filter((d) => d.task.startsWith(PREFIX) && d.date >= addDaysISO(todayISO(), -21)).map((d) => d.task);
  const tasks = all.filter((t) => ![...open, ...done].some((k) => sameTask(k, t.task)));
  if (!tasks.length) return manual ? send(env, `"${page.title}" has nothing new: you already track all ${all.length} of its tasks.`) : null;
  await env.DB.put("velocity_pending", JSON.stringify({ challenge: r.challenge || page.title, tasks }), { expirationTtl: 60 * 60 * 24 * 3 });

  const lines = tasks.map((t) => `• ${t.task}${t.due ? ` (${shortDateISO(t.due)}${t.time ? ` ${t.time}` : ""})` : ""}`);
  const skipped = all.length - tasks.length;
  return send(env, `🚀 ${skipped ? "New tasks in" : "New Velocity challenge:"} ${r.challenge || page.title}\n${r.summary || ""}\n\n${lines.join("\n")}${skipped ? `\n\n(${skipped} you already track are left out)` : ""}\n\nwant me to track these?`, {
    reply_markup: {
      inline_keyboard: [
        [{ text: "➕ Add as to-dos", callback_data: "vl:todos" }, { text: "📅 To-dos + calendar", callback_data: "vl:both" }],
        [{ text: "✖ Skip", callback_data: "vl:skip" }],
      ],
    },
  });
}

export async function onVelocityButton(env, q, action) {
  await tg(env, "editMessageReplyMarkup", { chat_id: q.message.chat.id, message_id: q.message.message_id }).catch(() => {});
  const pending = await env.DB.get("velocity_pending", "json");
  await env.DB.delete("velocity_pending");
  if (action === "skip") return send(env, "ok, not tracking that one");
  if (!pending) return send(env, "that challenge expired. /velocity to read it again");

  const added = await saveFound(env, pending.tasks.map((t) => ({ task: `${PREFIX}${t.task}`, due: t.due || null })));
  // remember each task's length + time, so /velocity calendar can re-place them later
  const info = (await env.DB.get("velocity_info", "json")) || {};
  for (const t of pending.tasks) info[t.task] = { minutes: t.minutes || null, time: t.time || null };
  await env.DB.put("velocity_info", JSON.stringify(info), { expirationTtl: 60 * 60 * 24 * 30 });
  const parts = [added.length ? `➕ Added to your to-dos:\n${formatTodos(added)}` : "(those were already on your list)"];

  if (action === "both") parts.push(await addToCalendar(env, pending.tasks));
  parts.push("I'll check in on Wednesday to see how it's going");
  return send(env, parts.join("\n\n"));
}

// Each task with a deadline goes into a free spot in the calendar (see slots.js); a timed
// task (e.g. a live session) keeps its time. All-day only if no spot is free at all.
export async function addToCalendar(env, tasks) {
  const lookup = await calendarLookup(env);
  const schedule = (await env.DB.get("schedule", "json"))?.events || [];
  const already = (t) => schedule.some((e) => e.start.slice(0, 10) === t.due && sameTask(e.title, t.task));
  const fresh = tasks.filter((t) => !already(t));
  const plan = placeTasks(fresh, lookup).filter((t) => !t.skip);
  const noSpot = plan.filter((t) => t.noSlot).map((t) => t.task);
  const timed = plan.filter((t) => t.start);
  if (!timed.length) {
    return fresh.length < tasks.length && !noSpot.length ? "📅 those are already on your calendar" : `📅 nothing went on the calendar${noSpot.length ? ` (no free spot before it's due: ${noSpot.join("; ")})` : ""}`;
  }
  const lines = [];
  let failed = "";
  for (const t of timed) {
    const res = await createCalendarEvent(env, { title: `${PREFIX}${t.task}`, allDay: false, start: t.start, end: t.end, location: "" });
    if (!res.ok) {
      failed = res.error;
      continue;
    }
    const when = `${shortDateISO(t.start.slice(0, 10))} ${t.start.slice(11, 16)}–${t.end.slice(11, 16)}`;
    lines.push(`• ${when} ${t.task}`);
  }
  if (lines.length) await startGithubJob(env, "sync-schedule.yml").catch(() => {});
  if (!lines.length) return `📅 Couldn't add to the calendar (${failed})`;
  return `📅 Put in your calendar:\n${lines.join("\n")}${noSpot.length ? `\n(no free spot for: ${noSpot.join("; ")}, kept as to-dos)` : ""}${failed ? `\n(some failed: ${failed})` : ""}`;
}

// /velocity calendar: remove the all-day Velocity events I made and put the open
// Velocity to-dos (due today or later) into free spots instead.
export async function replanVelocity(env) {
  const today = todayISO();
  const open = (await getTodos(env)).filter((t) => t.task.startsWith(PREFIX) && t.due && t.due >= today);
  if (!open.length) return send(env, "no open Velocity to-dos with a date from today on, so nothing to place");
  const schedule = await env.DB.get("schedule", "json");
  if (!schedule?.until) {
    // the calendar sync still only covers 2 days: get the whole week first
    await startGithubJob(env, "sync-schedule.yml").catch(() => {});
    return send(env, "grabbing your whole week from the calendar first, send /velocity calendar again in ~2 min (if I say this again, push the latest code in GitHub Desktop)");
  }
  const del = await deleteBotAllDayEvents(env, { from: today, to: addDaysISO(today, 21), prefix: PREFIX });
  if (!del.ok || typeof del.deleted !== "number") {
    return send(env, `I couldn't clear the all-day events first (${del.error || "the calendar script needs the new version"}). Update the calendar Apps Script (Deploy → Manage deployments → ✏️ → New version), then /velocity calendar again`);
  }
  await typing(env);
  const info = (await env.DB.get("velocity_info", "json")) || {};
  const tasks = open.map((t) => {
    const task = t.task.slice(PREFIX.length);
    return { task, due: t.due, minutes: info[task]?.minutes || 20, time: info[task]?.time || null };
  });
  const placed = await addToCalendar(env, tasks);
  return send(env, `🧹 removed ${del.deleted} all-day Velocity event(s)\n\n${placed}`);
}

// For Haneul's prompt: how the current challenge is going.
export async function velocityContext(env) {
  const open = (await getTodos(env)).filter((t) => t.task.startsWith(PREFIX));
  const done = ((await env.DB.get("done_log", "json")) || []).filter((d) => d.task.startsWith(PREFIX) && d.date >= addDaysISO(todayISO(), -10));
  if (!open.length && !done.length) return "Velocity challenge: nothing tracked right now.";
  return `Velocity challenge: ${done.length} task(s) done recently, ${open.length} open: ${open.map((t) => `#${t.id} ${t.task.slice(PREFIX.length)}${t.due ? ` (due ${t.due})` : ""}`).join("; ") || "none"}.`;
}

// Called every 5 minutes: hourly check for new challenges, Wednesday check-in.
export async function runVelocity(env, haneulSays) {
  if (!notionReady(env)) return;
  const slot = `${todayISO()}T${localHour()}`;
  if (localMinute() >= 40 && (await env.DB.get("velocity_check_slot")) !== slot) {
    await env.DB.put("velocity_check_slot", slot);
    await env.BG_JOBS.send({ kind: "velocity" });
  }
  const now = localHour() * 60 + localMinute();
  const at = CHECKIN.hour * 60 + CHECKIN.minute;
  if (localWeekday() === CHECKIN.weekday && now >= at && now < at + 30 && (await env.DB.get("velocity_checkin")) !== todayISO()) {
    await env.DB.put("velocity_checkin", todayISO());
    const open = (await getTodos(env)).filter((t) => t.task.startsWith(PREFIX));
    if (open.length) await env.BG_JOBS.send({ kind: "say", task: `Mid-week Velocity check-in. Alex still has these Velocity challenge tasks open:
${open.map((t) => `#${t.id} ${t.task}${t.due ? ` (due ${t.due})` : ""}`).join("\n")}
Ask how it's going like a friend who's holding him accountable: notice what's due soonest, one gentle push or tease,
and offer to tick off any he already did (he can say "done 3"). 1-2 short texts.` });
  }
}
