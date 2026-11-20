import { prettyDue, todayISO } from "./dates.js";
import { send } from "./telegram.js";

// ---------- To-do list ----------

// Numbers are always 1, 2, 3… in due-date order (no gaps), so #1 is always the most urgent.
// Each to-do also has a hidden permanent "uid", used by the ✅ buttons: numbers shift when
// something is ticked off, so an old button must never tick off the wrong task.
export function renumber(todos) {
  const sorted = [...todos].sort(
    (a, b) =>
      (a.due || "9999").localeCompare(b.due || "9999") ||
      (a.added || "").localeCompare(b.added || "") ||
      (a.id || 0) - (b.id || 0)
  );
  sorted.forEach((t, i) => {
    t.uid ||= crypto.randomUUID().slice(0, 8);
    t.id = i + 1; // updated in place, so lists of just-added to-dos show their final numbers
  });
  return sorted;
}

export async function getTodos(env) {
  return renumber((await env.DB.get("todos", "json")) || []);
}

export async function saveTodos(env, todos) {
  await env.DB.put("todos", JSON.stringify(renumber(todos)));
}

export function nextId(todos) {
  return todos.reduce((max, t) => Math.max(max, t.id || 0), 0) + 1;
}

export function sortTodos(todos) {
  return [...todos].sort((a, b) => (a.due || "9999").localeCompare(b.due || "9999") || a.id - b.id);
}

export function formatTodos(todos) {
  return sortTodos(todos)
    .map((t) => `#${t.id} ${t.task}${prettyDue(t.due)}`)
    .join("\n");
}

export async function showTodos(env, header) {
  const todos = sortTodos(await getTodos(env));
  if (!todos.length) return send(env, "✅ No open to-dos! Send a photo of your agenda to add some.");
  const buttons = todos.slice(0, 16).map((t) => ({ text: `✅ #${t.id}`, callback_data: `done:u:${t.uid}` }));
  const rows = [];
  for (let i = 0; i < buttons.length; i += 4) rows.push(buttons.slice(i, i + 4));
  return send(env, `${header ? header + "\n\n" : ""}📋 Your to-dos:\n\n${formatTodos(todos)}\n\nTap one to tick it off:`, {
    reply_markup: { inline_keyboard: rows },
  });
}

// ids = the numbers you see (e.g. "done 3"); uids = the hidden ids from the ✅ buttons
export async function markDone(env, ids, { uids } = {}) {
  const todos = await getTodos(env);
  const hit = (t) => (uids ? uids.includes(t.uid) : ids.includes(t.id));
  const removed = todos.filter(hit);
  if (uids && !removed.length) return showTodos(env, "That one is already done. Here's your current list:");
  if (!removed.length) return send(env, `I couldn't find ${ids.map((i) => "#" + i).join(", ")}. /todos shows the list.`);
  const left = todos.filter((t) => !hit(t));
  await saveTodos(env, left);
  // Classroom to-dos you tick off yourself shouldn't come back at the next sync.
  const cids = removed.filter((t) => t.cid).map((t) => t.cid);
  if (cids.length) {
    const dismissed = (await env.DB.get("classroom_dismissed", "json")) || [];
    await env.DB.put("classroom_dismissed", JSON.stringify([...dismissed, ...cids].slice(-500)));
  }
  // Remember finished tasks for the monthly update.
  const log = (await env.DB.get("done_log", "json")) || [];
  await env.DB.put("done_log", JSON.stringify([...log, ...removed.map((t) => ({ task: t.task, date: todayISO() }))].slice(-300)));
  const done = `✅ Done: ${removed.map((t) => t.task).join(", ")}`;
  if (!left.length) return send(env, `${done}\n\n🎉 No to-dos left!`);
  return showTodos(env, `${done}\n${left.length} left, renumbered:`);
}
