import { TZ } from "./config.js";
import { prettyDue, todayISO } from "./dates.js";
import { send } from "./telegram.js";
import { getTodos, nextId, saveTodos } from "./todos.js";

// ---------- Google Classroom ----------
// A script in the SCHOOL Google account (classroom-script/Classroom.gs) sends the
// assignments here every hour. Pending ones become to-dos; turned-in ones are removed.

export function classroomDue(a) {
  if (a.dueTime) return new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date(a.dueTime)); // UTC -> Lima date
  return a.dueDate || null;
}

export async function onClassroomSync(env, assignments) {
  const DONE = ["TURNED_IN", "RETURNED"];
  const firstSync = !(await env.DB.get("classroom"));
  const seen = new Set((await env.DB.get("classroom_seen", "json")) || []);
  const dismissed = new Set((await env.DB.get("classroom_dismissed", "json")) || []);
  const todos = await getTodos(env);
  const newOnes = [];
  let added = 0;
  let removed = 0;

  for (const a of assignments) {
    const due = classroomDue(a);
    const existing = todos.find((t) => t.cid === a.id);
    if (DONE.includes(a.state)) {
      if (existing) {
        todos.splice(todos.indexOf(existing), 1);
        removed++;
      }
    } else if (existing) {
      existing.due = due; // teacher may have moved the date
    } else if (!dismissed.has(a.id)) {
      todos.push({ id: nextId(todos), task: `${a.course}: ${a.title}`.slice(0, 200), due, done: false, added: todayISO(), cid: a.id, link: a.link });
      added++;
    }
    if (!seen.has(a.id)) {
      seen.add(a.id);
      if (!DONE.includes(a.state)) newOnes.push({ ...a, due });
    }
  }
  await saveTodos(env, todos);
  await env.DB.put("classroom", JSON.stringify({ synced_at: new Date().toISOString(), assignments }));
  await env.DB.put("classroom_seen", JSON.stringify([...seen].slice(-500)));

  if (firstSync) {
    await send(env, `📚 Google Classroom connected! ${added} pending assignment${added === 1 ? "" : "s"} added to your to-dos.\n/classroom to see them.`);
  } else if (newOnes.length) {
    const lines = newOnes.map((a) => `• ${a.course}: ${a.title}${prettyDue(a.due)}\n  ${a.link}`);
    await send(env, `📚 New in Classroom:\n\n${lines.join("\n")}`, { link_preview_options: { is_disabled: true } });
  }
  return { added, removed, total: assignments.length };
}

export async function showClassroom(env) {
  const c = await env.DB.get("classroom", "json");
  if (!c) return send(env, "📚 Classroom isn't connected yet (the script in your school account hasn't synced).");
  const pending = c.assignments
    .filter((a) => !["TURNED_IN", "RETURNED"].includes(a.state))
    .map((a) => ({ ...a, due: classroomDue(a) }))
    .sort((a, b) => (a.due || "9999").localeCompare(b.due || "9999"));
  const ago = Math.round((Date.now() - Date.parse(c.synced_at)) / 60000);
  if (!pending.length) return send(env, `📚 Nothing pending in Classroom. 🎉\n(synced ${ago} min ago)`);
  const lines = pending.map((a) => `• ${a.course}: ${a.title}${prettyDue(a.due)}${a.late ? " (late)" : ""}\n  ${a.link}`);
  return send(env, `📚 Pending in Classroom (${pending.length}):\n\n${lines.join("\n")}\n\n(synced ${ago} min ago)`, {
    link_preview_options: { is_disabled: true },
  });
}
