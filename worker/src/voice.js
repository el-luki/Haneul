import { saveFound } from "./agenda.js";
import { todayISO, todayLong } from "./dates.js";
import { onEvent } from "./events.js";
import { gemini, parseJson } from "./gemini.js";
import { getHabits } from "./habits.js";
import { remember } from "./memory.js";
import { addNote } from "./notes.js";
import { downloadImage } from "./photos.js";
import { onText } from "./router.js";
import { send, typing } from "./telegram.js";
import { formatTodos, getTodos } from "./todos.js";

// ---------- Voice notes ----------
// A voice message is transcribed and turned into the right action:
// to-dos, an idea, AP study time, or a question for the assistant.

export async function onVoice(msg, env) {
  const file = msg.voice || msg.audio;
  if ((file.duration || 0) > 300) return send(env, "🎤 That's over 5 minutes. Send a shorter voice note.");
  await typing(env);
  // from the app the recording is already uploaded to Gemini (msg.app_part)
  const audio = msg.app_part || (await downloadImage(env, { fileId: file.file_id, mime: file.mime_type || "audio/ogg" }));

  const todos = await getTodos(env);
  const prompt = `Today is ${todayLong()} (${todayISO()}). This is a voice note Alex sent to the assistant bot.
It may be in Spanish or English. Transcribe it, then decide what Alex wants:

- "todos": things to do or remember (homework, tasks, "remind me to...", "tengo que...")
- "event": put something on the CALENDAR at a day/time ("meeting with Jordan Friday at 5", "agenda el dentista el 12 a las 3")
- "note": an idea, thought or plan to save for later (projects, TKS ideas, reflections)
- "remember": a FACT about Alex to remember long-term ("remember that…", "recuerda que mi proyecto…")
- "command": something one of the bot commands below does
- "question": asking something else, or chatting

Commands (pick the exact text):
/today · /tomorrow · /weather · /todos · done <to-do number> · /ap · /ap plan · /ap <minutes> <topic> · /ap rest
/ap done <unit 1-8> · /notes · /notes <search words> · /review · /music · /space · /monthly · /wa on · /wa off · /help
/habits · /habit <habit number> (tick a habit for today) · /korean · /korean words · /journal · /memory · /classroom
Open to-dos (for "done"): ${todos.map((t) => `#${t.id} ${t.task}`).join("; ") || "none"}
Habits (for "/habit <number>"): ${(await getHabits(env)).list.map((h) => `#${h.id} ${h.name}`).join("; ")}

Return JSON:
{"transcript": "exact words", "type": "todos" | "event" | "note" | "remember" | "command" | "question",
 "memory": "the fact to remember, as a short sentence about Alex",
 "todos": [{"task": "short, starts with subject if any", "due": "YYYY-MM-DD" or null}],
 "event": "the event in one line, with day and time",
 "note": "the idea, cleaned up but faithful",
 "command": "the exact command text"}
Resolve relative dates ("el viernes", "tomorrow") to real dates.`;

  const raw = await gemini(env, [{ role: "user", parts: [audio, { text: prompt }] }], { json: true });
  let r;
  try {
    r = parseJson(raw);
    if (Array.isArray(r)) r = r[0];
  } catch {
    throw new Error("couldn't understand the voice note. Try again");
  }
  const heard = `🎤 "${(r.transcript || "").trim()}"`;

  if (r.type === "todos" && r.todos?.length) {
    const added = await saveFound(env, r.todos);
    return send(env, added.length ? `${heard}\n\n➕ Added:\n${formatTodos(added)}` : `${heard}\n\n(You already have those to-dos.)`);
  }
  if (r.type === "note") {
    const note = await addNote(env, r.note || r.transcript, "voice");
    return send(env, `${heard}\n\n💡 Saved as idea #${note.id}. /notes to see them all.`);
  }
  if (r.type === "event" && r.event) {
    await send(env, heard);
    return onEvent(env, r.event);
  }
  if (r.type === "remember" && r.memory) {
    const f = await remember(env, r.memory);
    return send(env, `${heard}\n\n🧠 Got it, I'll remember: ${f.text} (#${f.id})`);
  }
  // Commands run exactly as if typed; only known commands are allowed.
  const allowed = /^(\/(today|tomorrow|weather|todos|ap|notes|review|music|space|monthly|wa|help|habits|habit \d+|korean|journal|memory|classroom)\b|done \d)/i;
  if (r.type === "command" && allowed.test((r.command || "").trim())) {
    await send(env, `${heard}\n▶️ ${r.command.trim()}`);
    return onText(r.command.trim(), env);
  }
  await send(env, heard);
  return onText(r.transcript || "", env); // also catches schedule questions ("¿qué tengo mañana?")
}
