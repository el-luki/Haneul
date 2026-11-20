import { notionJournal, toNotion } from "./notion.js";
import { shortDate } from "./ap.js";
import { JOURNAL_HOUR, JOURNAL_MINUTE } from "./config.js";
import { addDaysISO, daysBetween, todayISO } from "./dates.js";
import { eventsForDay } from "./schedule.js";
import { send } from "./telegram.js";

// ---------- Nightly journal ----------
// One question at JOURNAL_HOUR:JOURNAL_MINUTE. Reply to it (text or voice) to answer.

export const JOURNAL_QUESTIONS = [
  "What's one thing you learned today?",
  "What was the best part of your day?",
  "What's something that challenged you today, and how did you handle it?",
  "What are you grateful for today?",
  "What's one idea you had today that's worth exploring?",
  "What's one thing you'd do differently today?",
  "What made you curious today?",
  "Who helped you today, or who did you help?",
  "What progress did you make on a project or goal today?",
  "What's one small win from today?",
  "What drained your energy today, and what gave you energy?",
  "If tomorrow goes perfectly, what happens?",
  "What did you notice about how you study or work today?",
  "What's a question you can't stop thinking about?",
];

export async function sendJournalQuestion(env) {
  const today = todayISO();
  const events = (await eventsForDay(env, today)) || [];
  const tksToday = events.some((e) => e.tag === "PERSONAL" && /tks|innovate|velocity|jordan/i.test(e.title));
  const q = tksToday
    ? "What's one thing from today's TKS session you want to remember?"
    : JOURNAL_QUESTIONS[daysBetween("2026-01-01", today) % JOURNAL_QUESTIONS.length];
  const msg = await send(env, `📓 Journal · ${q}\n\nReply to this message (text or voice). /journal skip to skip tonight.`, {
    reply_markup: { force_reply: true, input_field_placeholder: "Your answer…" },
  });
  await env.DB.put("journal_pending", JSON.stringify({ date: today, q, message_id: msg.message_id }), { expirationTtl: 60 * 60 * 16 });
}

export async function saveJournal(env, answer, pending) {
  const journal = (await env.DB.get("journal", "json")) || [];
  const date = pending?.date || todayISO();
  const q = pending?.q || "Free entry";
  journal.push({ date, q, a: answer.slice(0, 3000) });
  await env.DB.put("journal", JSON.stringify(journal.slice(-400)));
  await toNotion(env, notionJournal(env, { date, q, a: answer })); // also into the Notion "Journal" table
  await env.DB.delete("journal_pending");
  const streak = (() => {
    let d = date, n = 0;
    const days = new Set(journal.map((j) => j.date));
    while (days.has(d)) { n++; d = addDaysISO(d, -1); }
    return n;
  })();
  return send(env, `📓 Saved. ${streak > 1 ? `🔥 ${streak}-day journal streak.` : ""}\nGood night! 🌙`);
}

export async function onJournalCommand(env, arg) {
  const pending = await env.DB.get("journal_pending", "json");
  if (arg.toLowerCase() === "skip") {
    await env.DB.delete("journal_pending");
    return send(env, "📓 Skipped tonight. See you tomorrow!");
  }
  if (arg) return saveJournal(env, arg, pending); // "/journal <answer>"
  const journal = (await env.DB.get("journal", "json")) || [];
  if (!journal.length) return send(env, `📓 No journal entries yet. Tonight's question comes at ${JOURNAL_HOUR}:${JOURNAL_MINUTE}, or write one now: /journal <text>`);
  const last = journal.slice(-7).reverse().map((j) => `${shortDate(j.date)} · ${j.q}\n${j.a}`);
  return send(env, `📓 Your last ${last.length} entries:\n\n${last.join("\n\n")}`);
}
