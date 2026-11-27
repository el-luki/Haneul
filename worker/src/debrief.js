import { MODELS_SMART } from "./config.js";
import { addDaysISO, localHour, localMinute, todayISO } from "./dates.js";
import { gemini, parseJson } from "./gemini.js";
import { rememberMany } from "./memory.js";
import { eventsForDay } from "./schedule.js";
import { send } from "./telegram.js";

// ---------- After a mentor chat / braindate: 3 quick questions ----------
// 15 minutes after a 1:1 on his calendar ends ("Priya Shah and Alex Rivera"), Haneul asks:
// what did you learn, what surprised you, what will you try. He replies to that message (text or voice).
// The answer becomes: a debrief (KV "debriefs", used by the "Collaborate in public" newsletter issues),
// a fact in her memory, and a thank-you note DRAFT that he copies and sends himself (nothing is sent).
// KV: debrief_pending {name, title, date, message_id}, debrief_asked [event keys].

const AFTER_MIN = 15, WINDOW_MIN = 180;

// "Priya Shah and Alex Rivera" → "Priya Shah"; "Alex Rivera and Lena Kowalski" → "Lena Kowalski"
export function meetingWith(title) {
  const t = String(title || "").replace(/\s+/g, " ").trim();
  if (!t || /^cancel+ed\b/i.test(t)) return null;
  const m = t.match(/^(.+?) and (.+)$/i);
  if (!m) return null;
  const [a, b] = [m[1].trim(), m[2].trim()];
  const isMe = (s) => /^alex\b/i.test(s);
  if (isMe(b) && !isMe(a)) return a;
  if (isMe(a) && !isMe(b)) return b;
  return null;
}

const toMin = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

// Every tick: ask about a 1:1 that ended 15 min ago (once per meeting).
export async function runDebrief(env) {
  const today = todayISO();
  const now = localHour() * 60 + localMinute();
  const events = (await eventsForDay(env, today)) || [];
  const asked = (await env.DB.get("debrief_asked", "json")) || [];
  for (const e of events) {
    if (e.all_day || !e.end) continue;
    const name = meetingWith(e.title);
    if (!name) continue;
    const end = toMin(e.end.slice(11, 16));
    const key = `${today}|${e.title}`;
    if (now < end + AFTER_MIN || now > end + WINDOW_MIN || asked.includes(key)) continue;
    asked.push(key);
    await env.DB.put("debrief_asked", JSON.stringify(asked.slice(-60)), { expirationTtl: 86400 * 10 });
    const first = name.split(" ")[0];
    const msg = await send(env, `🤝 How was your chat with ${first}? Reply to this message (text or voice):\n1. One thing you learned\n2. What surprised you\n3. One thing you'll try\n\nI'll save it for your newsletter and draft a thank-you note for you to send.`, {
      reply_markup: { force_reply: true, input_field_placeholder: `About ${first}…` },
    });
    await env.DB.put("debrief_pending", JSON.stringify({ name, title: e.title, date: today, message_id: msg?.message_id }), { expirationTtl: 60 * 60 * 30 });
    return; // one at a time
  }
}

export function debriefPrompt(name, answer) {
  return `Alex (16, TKS student into space tech / GNC) just had a 1:1 chat with ${name} and answered three questions
(what he learned, what surprised him, what he'll try). His answer:
"""${answer.slice(0, 3000)}"""
Return JSON:
{"learned": "one sentence", "surprised": "one sentence", "try": "one sentence",
 "newsletter": "2-3 sentences he could use in a 'what I learned from someone in the field' newsletter section, in his voice; refer to the person as [ask first: ${name}] since he must ask before naming them",
 "thanks": "a short thank-you message from Alex to ${name.split(" ")[0]} (3-4 sentences, warm, specific to what he learned, mentions the one thing he'll try; no emoji; signed Alex)"}
Only use what he said. If a part is missing, leave that field "".`;
}

export async function saveDebrief(env, answer, pending) {
  const r = parseJson(await gemini(env, [{ role: "user", parts: [{ text: debriefPrompt(pending.name, answer) }] }], { json: true, models: MODELS_SMART })) || {};
  const d = { date: pending.date || todayISO(), name: pending.name, answer: answer.slice(0, 3000), learned: String(r.learned || "").slice(0, 300), surprised: String(r.surprised || "").slice(0, 300), try: String(r.try || "").slice(0, 300), newsletter: String(r.newsletter || "").slice(0, 800), thanks: String(r.thanks || "").slice(0, 1200) };
  const all = (await env.DB.get("debriefs", "json")) || [];
  all.push(d);
  await env.DB.put("debriefs", JSON.stringify(all.slice(-80)));
  await env.DB.delete("debrief_pending");
  if (d.learned) await rememberMany(env, [`On ${d.date} Alex had a chat with ${d.name}: he learned ${d.learned.replace(/\.$/, "")}${d.try ? `, and plans to ${d.try.replace(/^(i'?ll|i will)\s+/i, "").replace(/\.$/, "")}` : ""}.`], "debrief").catch(() => {});
  await send(env, `🤝 Saved for your newsletter.${d.try ? `\nYour try: ${d.try}` : ""}`);
  if (d.thanks) await send(env, `✉️ Thank-you draft for ${d.name.split(" ")[0]} (copy it and send it yourself):\n\n${d.thanks}`);
  return d;
}

// Recent debriefs, for the newsletter draft.
export async function debriefText(env, days = 21) {
  const from = addDaysISO(todayISO(), -days);
  const all = ((await env.DB.get("debriefs", "json")) || []).filter((d) => d.date >= from);
  return all.map((d) => `- ${d.date}, chat with [ask first: ${d.name}]: learned ${d.learned} / surprised: ${d.surprised} / will try: ${d.try}${d.newsletter ? ` / note: ${d.newsletter}` : ""}`).join("\n");
}
