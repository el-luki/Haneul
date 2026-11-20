import { notionIdea, toNotion } from "./notion.js";
import { shortDate } from "./ap.js";
import { todayISO } from "./dates.js";
import { send } from "./telegram.js";
import { nextId } from "./todos.js";

// ---------- Ideas inbox ----------
// /note <text> saves an idea (#hashtags become tags), /notes lists or searches them.

export async function getNotes(env) {
  return (await env.DB.get("notes", "json")) || [];
}

export async function addNote(env, text, source = "text") {
  const notes = await getNotes(env);
  const tags = [...new Set((text.match(/#[\p{L}\p{N}_-]+/gu) || []).map((t) => t.toLowerCase()))];
  const note = { id: nextId(notes), text: text.slice(0, 2000), tags, date: todayISO(), source };
  notes.push(note);
  await env.DB.put("notes", JSON.stringify(notes));
  await toNotion(env, notionIdea(env, note)); // also into the Notion "Ideas" table (if connected)
  return note;
}

export function plain(s) {
  return s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, ""); // "física" -> "fisica"
}

export function formatNote(n, full = false) {
  const text = full || n.text.length <= 140 ? n.text : `${n.text.slice(0, 140)}…`;
  return `#${n.id} · ${shortDate(n.date)}${n.source === "voice" ? " 🎤" : ""}\n${text}`;
}

export async function onNoteCommand(env, cmd, arg) {
  const notes = await getNotes(env);

  if (cmd === "/note" || cmd === "idea" || cmd === "idea:") {
    const [first, second] = arg.split(/\s+/);
    if ((first || "").toLowerCase() === "delete") {
      const id = Number(second);
      if (!notes.some((n) => n.id === id)) return send(env, `I couldn't find idea #${second}. /notes shows them.`);
      await env.DB.put("notes", JSON.stringify(notes.filter((n) => n.id !== id)));
      return send(env, `🗑️ Deleted idea #${id}.`);
    }
    if ((first || "").toLowerCase() === "show" && Number(second)) {
      const n = notes.find((x) => x.id === Number(second));
      return send(env, n ? formatNote(n, true) : `I couldn't find idea #${second}.`);
    }
    if (!arg) return send(env, "Write the idea after /note, e.g.: /note TKS project: bot that plans study time #tks");
    const note = await addNote(env, arg);
    return send(env, `💡 Saved as idea #${note.id}${note.tags.length ? ` (${note.tags.join(" ")})` : ""}.\n/notes to see them all.`);
  }

  // /notes [search words]
  if (!notes.length) return send(env, "💡 No ideas saved yet. Save one with /note <idea> or send a voice note.");
  const words = plain(arg).split(/\s+/).filter(Boolean);
  const matches = words.length ? notes.filter((n) => words.every((w) => plain(n.text).includes(w.replace(/^#/, "")))) : notes;
  if (!matches.length) return send(env, `No ideas match "${arg}". /notes shows all of them.`);
  const shown = [...matches].reverse().slice(0, 15);
  const header = words.length ? `🔎 ${matches.length} idea(s) matching "${arg}"` : `💡 Your ideas (${notes.length} total, newest first)`;
  const more = matches.length > shown.length ? `\n\n…and ${matches.length - shown.length} older. Search to narrow it down: /notes tks` : "";
  return send(env, `${header}\n\n${shown.map((n) => formatNote(n)).join("\n\n")}${more}\n\n/note show 3 · /note delete 3`);
}
