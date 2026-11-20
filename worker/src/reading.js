import { chapterNotes, notionReading, notionReady, toNotion } from "./notion.js";
import { addDaysISO, todayISO } from "./dates.js";
import { send, tg } from "./telegram.js";

// ---------- Reading buddy ----------
// At READING_HOUR:READING_MINUTE Haneul asks how reading went. Tell her the chapter and she
// reacts like she's reading the same book: her favorite part of THAT chapter (no spoilers
// ahead) and a question to think about. Streak + progress for accountability.

export const READING_HOUR = 19;
export const READING_MINUTE = 30;
const DEFAULT_BOOK = { book: "Start With Why", author: "Simon Sinek" };

export async function getReading(env) {
  return (await env.DB.get("reading", "json")) || { ...DEFAULT_BOOK, chapter: 0, log: {}, on: true, started: todayISO() };
}

async function saveReading(env, r) {
  for (const d of Object.keys(r.log)) if (d < addDaysISO(todayISO(), -200)) delete r.log[d];
  await env.DB.put("reading", JSON.stringify(r));
}

export function readingStreak(log, today = todayISO()) {
  let day = log[today] ? today : addDaysISO(today, -1);
  let n = 0;
  while (log[day] && n < 400) {
    n++;
    day = addDaysISO(day, -1);
  }
  return n;
}

// For Haneul's prompt.
export async function readingContext(env) {
  const r = await getReading(env);
  if (!r.on) return "Reading: paused.";
  const today = r.log[todayISO()] ? `read today (chapter ${r.log[todayISO()].chapter})` : "hasn't read yet today";
  return `Reading: "${r.book}" by ${r.author}, currently at chapter ${r.chapter || "the start"}; ${today}; reading streak ${readingStreak(r.log)} day(s). Never spoil anything after chapter ${r.chapter}.`;
}

// "chapter 5", "cap 5", "capítulo 5", "ch. 5", or just "5"
export function chapterFrom(text) {
  const m = String(text).toLowerCase().match(/(?:chapter|chap|ch\.?|cap[ií]tulo|cap\.?)\s*(\d{1,3})/) || String(text).trim().match(/^(\d{1,3})\b/);
  return m ? Number(m[1]) : null;
}

// Alex read: log it, then Haneul reacts as a reading buddy.
export async function logReading(env, chapter, note, haneulSays) {
  const r = await getReading(env);
  const before = r.chapter;
  r.chapter = Math.max(r.chapter, chapter);
  r.log[todayISO()] = { chapter: r.chapter };
  await saveReading(env, r);
  await toNotion(env, notionReading(env, r.book, r.chapter, note));
  // If Alex wrote his own notes on this chapter in Notion, she reacts to those too.
  const own = notionReady(env) ? await chapterNotes(env, r.book, r.chapter).catch(() => "") : "";
  if (own) note = `${note ? `${note}
` : ""}His own notes on this chapter (react to what HE highlighted):
${own}`;
  await haneulSays(
    env,
    `Alex just read "${r.book}" by ${r.author} and is now at chapter ${r.chapter} (was at ${before || "the start"}).
${note ? `He said: "${note}"\n` : ""}React like you're reading the same book with him:
- Share YOUR favorite part of chapter ${r.chapter}: name ONE specific idea, example or story from THAT chapter
  (e.g. a company, person or concept the author uses there), in your own words (no long quotes), and why you liked it.
- Absolutely no spoilers from later chapters.
- If it fits naturally, connect it to his life (TKS, his rocket projects, school).
- End with ONE short question about the chapter to think about.
If you don't know what chapter ${r.chapter} covers, say so honestly and ask him what it was about.
2-3 short texts. Reading streak is now ${readingStreak(r.log)} day(s); mention it only if it's 3 or more.`
  );
}

// 19:30 nudge
export async function readingReminder(env, haneulSays) {
  const r = await getReading(env);
  if (!r.on || r.log[todayISO()]) return;
  await haneulSays(
    env,
    `It's reading time. Remind Alex to read "${r.book}" (he's at chapter ${r.chapter || "the start"}).
One or two short texts, friendly, not naggy. If his reading streak is going (${readingStreak(r.log)} days), mention it.`
  );
  const msg = await send(env, `📖 ${r.book} · chapter ${r.chapter || "—"}`, {
    reply_markup: { inline_keyboard: [[{ text: "📖 I read today", callback_data: "rd:read" }, { text: "⏭️ Not today", callback_data: "rd:skip" }]] },
  });
  return msg;
}

export async function onReadingButton(env, q, action) {
  await tg(env, "editMessageReplyMarkup", { chat_id: q.message.chat.id, message_id: q.message.message_id }).catch(() => {});
  if (action === "skip") return send(env, "no worries, tomorrow then");
  const r = await getReading(env);
  const msg = await send(env, `which chapter did you get to? (reply with the number, you were at ${r.chapter || 0})`, {
    reply_markup: { force_reply: true, input_field_placeholder: "e.g. 5" },
  });
  await env.DB.put("reading_ask", String(msg.message_id), { expirationTtl: 60 * 60 * 12 });
}

export async function onReadingCommand(env, cmd, arg, haneulSays) {
  const r = await getReading(env);
  if (cmd === "/book") {
    if (!arg) return send(env, `📖 You're reading "${r.book}" by ${r.author}, chapter ${r.chapter || "—"}.\nNew book: /book Title by Author`);
    const [title, author] = arg.split(/\s+by\s+|\s+de\s+/i);
    const fresh = { book: title.trim(), author: (author || "unknown author").trim(), chapter: 0, log: r.log, on: true, started: todayISO() };
    await saveReading(env, fresh);
    return send(env, `📖 New book: "${fresh.book}" by ${fresh.author}. Tell me your chapter with /read 1 as you go!`);
  }
  // /read <chapter> [what you thought]
  if (cmd === "/read") {
    const chapter = chapterFrom(arg);
    if (!chapter) return send(env, "Which chapter? e.g. /read 3 (you can add what you thought after it)");
    return logReading(env, chapter, arg.replace(/^\D*\d+\s*/, "").trim(), haneulSays);
  }
  // /reading [off|on]
  const a = (arg || "").toLowerCase();
  if (a === "off" || a === "on") {
    r.on = a === "on";
    await saveReading(env, r);
    return send(env, `Reading reminders ${r.on ? `ON (${READING_HOUR}:${READING_MINUTE})` : "paused (/reading on to resume)"}.`);
  }
  const days = Object.keys(r.log).filter((d) => d >= addDaysISO(todayISO(), -6)).length;
  return send(env, `📖 "${r.book}" by ${r.author}\nChapter ${r.chapter || "—"} · read ${days} of the last 7 days · streak ${readingStreak(r.log)}\n/read 4 to log · /book Title by Author for a new one`);
}
