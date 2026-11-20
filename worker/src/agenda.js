import { MODELS_SMART } from "./config.js";
import { todayISO, todayLong } from "./dates.js";
import { gemini, parseJson } from "./gemini.js";
import { send } from "./telegram.js";
import { formatTodos, getTodos, nextId, saveTodos } from "./todos.js";

// ---------- Agenda -> to-dos ----------

export async function processAgenda(env, images, note) {
  const prompt = `Today is ${todayLong()} (${todayISO()}).
These are photos of a high-school student's physical school agenda/planner.
Extract every homework, assignment, test, quiz, project, reading or other to-do written on the pages.

Rules:
- Return a JSON array of objects: {"task": string, "due": "YYYY-MM-DD" or null}.
- "task" is short and starts with the subject, e.g. "Physics: lab report ch. 4". Keep the original language.
- Work out "due" from the day/date the item is written under, or a date written next to it.
  If only a weekday is given, use its next occurrence in the week shown on the page (or after today). If unsure, use null.
- Skip items that are crossed out, ticked or marked done. Skip timetables, doodles and notes that are not tasks.
- If nothing is found, return [].${note ? `\n\nThe student added this note: ${note}` : ""}`;

  const raw = await gemini(env, [{ role: "user", parts: [...images, { text: prompt }] }], { json: true, models: MODELS_SMART });
  const added = await saveFound(env, parseJsonList(raw));
  if (!added.length) {
    return send(env, "📒 I didn't find any new tasks on that page. (Tasks you already have are skipped.)");
  }
  return send(
    env,
    `📒 Added ${added.length} to-do${added.length > 1 ? "s" : ""}:\n\n${formatTodos(added)}\n\n` +
      `Wrong one? Send "done 3" to remove #3. /todos shows everything.`
  );
}

export async function addTyped(env, text) {
  if (!text) return send(env, 'Write the task after "add", e.g.: add Physics lab report friday');
  const prompt = `Today is ${todayLong()} (${todayISO()}).
Turn this text into to-do items. Return a JSON array of {"task": string, "due": "YYYY-MM-DD" or null}.
Resolve relative dates like "friday", "tomorrow" or "next week" to real dates (next occurrence). Keep the wording short, original language.

Text: ${text}`;
  const raw = await gemini(env, [{ role: "user", parts: [{ text: prompt }] }], { json: true });
  const added = await saveFound(env, parseJsonList(raw));
  if (!added.length) return send(env, "I couldn't turn that into a to-do (or you already have it).");
  return send(env, `➕ Added:\n\n${formatTodos(added)}`);
}

export function parseJsonList(raw) {
  let data;
  try {
    data = parseJson(raw);
  } catch {
    throw new Error("Gemini's answer wasn't readable. Try again");
  }
  if (Array.isArray(data)) return data;
  return data.tasks || data.items || [];
}

export async function saveFound(env, found) {
  const todos = await getTodos(env);
  const added = [];
  for (const f of found) {
    if (!f || !f.task) continue;
    const task = String(f.task).trim().slice(0, 200);
    const due = /^\d{4}-\d{2}-\d{2}$/.test(f.due || "") ? f.due : null;
    if (todos.some((t) => t.task.toLowerCase() === task.toLowerCase() && t.due === due)) continue; // duplicate
    const todo = { id: nextId(todos), task, due, done: false, added: todayISO() };
    todos.push(todo);
    added.push(todo);
  }
  if (added.length) await saveTodos(env, todos);
  return added;
}
