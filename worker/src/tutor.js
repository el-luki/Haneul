import { MODELS_LIGHT, MODELS_SMART } from "./config.js";
import { gemini, parseJson } from "./gemini.js";
import { send, tg, typing } from "./telegram.js";

// ---------- Homework tutor ----------
// A photo (or typed problem) becomes step-by-step HINTS, not answers:
// 💡 next hint · ✍️ check my answer · 🔓 full solution only after the last hint.

function parse(raw) {
  return parseJson(raw);
}

export { tutorButtons as tutorButtonsForTest };

function tutorButtons(t) {
  const rows = [];
  if (t.shown < t.hints.length) rows.push([{ text: `💡 Next hint (${t.shown + 1}/${t.hints.length})`, callback_data: "tu:next" }]);
  rows.push([{ text: "✍️ Check my answer", callback_data: "tu:check" }]);
  if (t.shown >= t.hints.length) rows.push([{ text: "🔓 Show the full solution", callback_data: "tu:solution" }]);
  return { inline_keyboard: rows };
}

// parts: image parts from photos, and/or the typed problem as text
export async function startTutor(env, parts, note) {
  await typing(env);
  const prompt = `You are a patient tutor for Alex, an 11th-grade student (AP Physics 1 self-study, Physics,
Pre-Calculus Honors). Alex wants to LEARN to solve this, so you give HINTS, not the answer.
${note ? `Alex says: "${note}"\n` : ""}
Return JSON:
{"subject": "e.g. Physics: projectile motion",
 "problem": "the problem restated in 1-2 lines",
 "hints": ["4 hints, each more specific than the last:
            1) which concept or principle applies (no numbers),
            2) how to set it up (what's known, what's unknown, which equation),
            3) the key step,
            4) almost there (but still not the final number)"],
 "answer": "the final answer with units, short",
 "solution": "the full worked solution, step by step, max 200 words",
 "check": "one quick way to sanity-check the answer (units, size, limiting case)"}
Rules: never reveal the final answer inside a hint. Plain-text math only (v = d/t, x^2, sqrt(x), pi, theta),
no LaTeX, no markdown. If there are several problems, use the one Alex mentions, otherwise the first.
Write in the same language as the problem.`;
  const t = parse(await gemini(env, [{ role: "user", parts: [...parts, { text: prompt }] }], { json: true, models: MODELS_SMART }));
  if (!Array.isArray(t.hints) || !t.hints.length) throw new Error("couldn't read a problem there. Try a clearer photo or type it with /hint");
  const tutor = { ...t, shown: 1, started: Date.now() };
  await env.DB.put("tutor", JSON.stringify(tutor), { expirationTtl: 60 * 60 * 24 });
  return send(env, `🧑‍🏫 ${t.subject}\n${t.problem}\n\n💡 Hint 1/${t.hints.length}: ${t.hints[0]}`, { reply_markup: tutorButtons(tutor) });
}

export async function onTutorButton(env, q, action) {
  const t = await env.DB.get("tutor", "json");
  await tg(env, "editMessageReplyMarkup", { chat_id: q.message.chat.id, message_id: q.message.message_id }).catch(() => {});
  if (!t) return send(env, "🧑‍🏫 That problem expired. Send it again (photo, then 🧑‍🏫, or /hint <problem>).");

  if (action === "next" && t.shown < t.hints.length) {
    t.shown++;
    await env.DB.put("tutor", JSON.stringify(t), { expirationTtl: 60 * 60 * 24 });
    return send(env, `💡 Hint ${t.shown}/${t.hints.length}: ${t.hints[t.shown - 1]}`, { reply_markup: tutorButtons(t) });
  }
  if (action === "check") {
    const msg = await send(env, "✍️ What's your answer? Reply to this message (with units if it has them).", {
      reply_markup: { force_reply: true, input_field_placeholder: "Your answer…" },
    });
    t.check_message_id = msg.message_id;
    await env.DB.put("tutor", JSON.stringify(t), { expirationTtl: 60 * 60 * 24 });
    return;
  }
  if (action === "solution") {
    return send(env, `🔓 Solution\n\n${t.solution}\n\n✅ Answer: ${t.answer}\n🔎 Check: ${t.check}\n\nTry the next problem on your own, then send it to check!`);
  }
}

// Called when Alex replies to the "What's your answer?" message.
export async function checkTutorAnswer(env, t, answer) {
  await typing(env);
  const prompt = `A student solved this problem: ${t.problem}
Correct final answer: ${t.answer}
Worked solution (for you only): ${t.solution}
The student's answer: "${answer}"

Is it correct? Accept equivalent forms, reasonable rounding and equivalent units.
Return JSON: {"correct": true or false, "feedback": "1-2 sentences. If wrong, say what kind of mistake it looks like
(sign, units, wrong formula, arithmetic…) WITHOUT giving the correct answer."}`;
  const r = parse(await gemini(env, [{ role: "user", parts: [{ text: prompt }] }], { json: true, models: MODELS_LIGHT }));
  delete t.check_message_id;
  await env.DB.put("tutor", JSON.stringify(t), { expirationTtl: 60 * 60 * 24 });
  if (r.correct) return send(env, `✅ Correct! ${r.feedback || ""}\n🔎 Quick check: ${t.check}`);
  return send(env, `❌ Not yet. ${r.feedback || ""}`, { reply_markup: tutorButtons(t) });
}

// "/hint <problem>" types a problem; "/hint" alone gives the next hint for the current one.
export async function onHintCommand(env, arg) {
  if (arg) return startTutor(env, [{ text: `The problem: ${arg}` }], "");
  const t = await env.DB.get("tutor", "json");
  if (!t) return send(env, "🧑‍🏫 Send a photo of the problem and tap 🧑‍🏫 Homework, or type: /hint <the problem>");
  if (t.shown >= t.hints.length) return send(env, "💡 That was the last hint.", { reply_markup: tutorButtons(t) });
  t.shown++;
  await env.DB.put("tutor", JSON.stringify(t), { expirationTtl: 60 * 60 * 24 });
  return send(env, `💡 Hint ${t.shown}/${t.hints.length}: ${t.hints[t.shown - 1]}`, { reply_markup: tutorButtons(t) });
}
