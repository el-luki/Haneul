import { MODELS_SMART } from "./config.js";
import { todayISO } from "./dates.js";
import { gemini } from "./gemini.js";
import { memoryText } from "./memory.js";
import { send, typing } from "./telegram.js";

// ---------- TKS Mindset of the Week ----------

export async function processTks(env, images, typedNotes) {
  const source = images.length ? "photos of Alex's handwritten notes" : "Alex's typed notes";
  const prompt = `These are ${source} from a TKS (The Knowledge Society) session.
Alex has to post a reflection on the "Mindset of the Week" on TKS.life and wants a DRAFT to get ideas from.

Reply in plain text (no markdown symbols like ** or #), in exactly this format:

🧠 MINDSET OF THE WEEK
<the mindset in one line>

📝 KEY POINTS FROM THE NOTES
<3-6 short points starting with "•", faithful to the notes>

✍️ DRAFT FOR TKS.LIFE
<150-250 words, first person, sounds like a thoughtful high-school student, not corporate.
Structure: what this mindset means to me, the idea or moment from the session that made it click,
and one concrete way I'll apply it this week.>

💡 OTHER ANGLES I COULD TAKE
<two one-line alternative angles>

Use only ideas that are in the notes. Write [unclear] for words you can't read instead of guessing.
IMPORTANT: if the notes don't contain real content from a TKS session (empty, only a title or template,
a few random words, or clearly not about a session), DON'T write a draft. Reply with exactly:
NOT_ENOUGH: <one short sentence saying what you found instead>`;
  const guard = `
For the "apply it this week" part, you may connect it to what you know about Alex:
${await memoryText(env)}${
    typedNotes ? `\n\nNOTES / EXTRA CONTEXT FROM ALEX:\n${typedNotes}` : ""
  }`;
  await typing(env);
  const draft = await gemini(env, [{ role: "user", parts: [...images, { text: prompt + guard }] }], { models: MODELS_SMART });
  // Never invent a draft from (almost) nothing.
  const refused = draft.match(/NOT_ENOUGH:?\s*(.*)/i);
  if (refused) {
    return send(env, `there's not enough in there to write a draft from, so i won't make stuff up. (${refused[1].trim() || "the notes look empty"})\nadd ur session notes and try again`);
  }
  // Keep drafts for the monthly TKS update.
  const drafts = (await env.DB.get("tks_drafts", "json")) || [];
  await env.DB.put("tks_drafts", JSON.stringify([...drafts, { date: todayISO(), text: draft.slice(0, 3000) }].slice(-20)));
  return send(env, draft);
}
