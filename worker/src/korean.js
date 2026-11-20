import { chat } from "./chat.js";
import { MODELS_SMART } from "./config.js";
import { gemini, parseJson } from "./gemini.js";
import { startGithubJob } from "./reminders.js";
import { send, tg, typing } from "./telegram.js";

// ---------- Korean mini-lessons ----------
// A short lesson on the morning bus (weekdays 6:30, weekends 9:00) that follows a
// curriculum: Hangul → survival words → basic grammar, with a 2-question quiz.
// Wrong answers come back for review in later lessons.

export function koreanStage(n) {
  if (n <= 14) {
    return `HANGUL stage, lesson ${n} of 14. Across the 14 lessons, teach Hangul in this order, 2-3 new letters per lesson:
basic vowels ㅏ ㅓ ㅗ ㅜ ㅡ ㅣ → consonants ㄱ ㄴ ㄷ ㄹ ㅁ ㅂ ㅅ ㅇ ㅈ ㅎ → ㅊ ㅋ ㅌ ㅍ → y-vowels ㅑ ㅕ ㅛ ㅠ → ㅐ ㅔ
→ double consonants ㄲ ㄸ ㅃ ㅆ ㅉ → final consonants (batchim). For lesson ${n}, teach the next letters in that order,
show how they form syllable blocks, and give 1-2 easy real words using ONLY letters learned so far.`;
  }
  if (n <= 45) {
    return `SURVIVAL WORDS stage (lesson ${n}). Teach 3 useful new words or short phrases (greetings, numbers, school,
food, feelings, and sometimes K-pop/fan words like 노래, 팬, 무대, 컴백), each with Hangul, romanization, meaning and a tiny example.`;
  }
  return `BASIC GRAMMAR stage (lesson ${n}). Teach ONE simple grammar point (in a sensible order: 이에요/예요, 은/는, 이/가,
을/를, -아요/-어요 present, 안 negation, -고 싶어요, past -았/었어요, -(으)ㄹ 거예요…) with 2 example sentences, plus 2 new words.`;
}

export async function runKoreanLesson(env) {
  await typing(env);
  const k = (await env.DB.get("korean", "json")) || { lesson: 0, learned: [], mistakes: [], on: true };
  const n = k.lesson + 1;
  const prompt = `You are a friendly, encouraging Korean tutor. Your student, Alex, is a TOTAL BEGINNER who speaks Spanish
and English and loves K-pop (lots of K-pop). Alex studies 3-5 minutes on a school bus, on a phone.

${koreanStage(n)}

Already learned (don't re-teach, but you can reuse): ${k.learned.slice(-40).join(", ") || "nothing yet"}
Review 1 of these past mistakes inside the lesson if any: ${k.mistakes.slice(-5).join(" | ") || "none"}
Never quote song lyrics. Explain in English (a Spanish comparison is welcome when it helps pronunciation).
ALWAYS write Korean letters as real Hangul (e.g. the silent circle is ㅇ, never the Latin letter "o"),
both in the lesson and in the quiz options. Keep words standard (no slang unless you say it's slang).

Return JSON:
{"title": "short lesson title",
 "lesson": "plain text, max 140 words, no markdown symbols, romanization in [brackets], short lines",
 "learned": ["short items taught today, e.g. 'ㅏ [a]' or '안녕하세요 = hello'"],
 "speak": "ONLY Korean, to be read aloud for pronunciation practice: today's sounds/words, each twice, separated by periods. Use full syllables (아, not the bare letter ㅏ), e.g. '아. 아. 어. 어. 아이. 아이.'",
 "quiz": [{"q": "question", "options": ["A", "B", "C"], "answer": 0, "explain": "one line"}, {…}]}
The quiz has exactly 2 questions about today's lesson (or the reviewed mistake).`;
  const r = parseJson((await gemini(env, [{ role: "user", parts: [{ text: prompt }] }], { json: true, models: MODELS_SMART })));
  k.lesson = n;
  k.learned = [...k.learned, ...(r.learned || [])].slice(-300);
  k.last_speak = (r.speak || "").slice(0, 1000);
  await env.DB.put("korean", JSON.stringify(k));
  await env.DB.put("korean_quiz", JSON.stringify({ n, quiz: r.quiz || [] }), { expirationTtl: 60 * 60 * 24 * 2 });

  await send(env, `🇰🇷 Korean · lesson ${n}: ${r.title}\n\n${r.lesson}`);
  for (const [qi, q] of (r.quiz || []).slice(0, 2).entries()) {
    await send(env, `❓ ${q.q}`, {
      reply_markup: { inline_keyboard: [q.options.slice(0, 4).map((o, oi) => ({ text: o.slice(0, 40), callback_data: `kq:${n}:${qi}:${oi}` }))] },
    });
  }
  // Pronunciation: a voice message made on GitHub (arrives about a minute later).
  if (k.last_speak) await sendKoreanAudio(env, k.last_speak, `🔊 Lesson ${n}: listen, then repeat out loud`);
}

export async function sendKoreanAudio(env, speak, caption) {
  try {
    await startGithubJob(env, "korean-audio.yml", { speak, caption });
  } catch (err) {
    console.error("korean audio:", err.message); // the lesson still works without audio
  }
}

export async function answerKorean(env, q, data) {
  const [, n, qi, oi] = data.split(":").map(Number);
  await tg(env, "editMessageReplyMarkup", { chat_id: q.message.chat.id, message_id: q.message.message_id }).catch(() => {});
  const stored = await env.DB.get("korean_quiz", "json");
  const question = stored?.n === n ? stored.quiz[qi] : null;
  if (!question) return send(env, "That quiz expired. /korean for a new lesson.");
  if (oi === question.answer) return send(env, `✅ 정답! [jeong-dap] Correct!\n${question.explain || ""}`);
  const k = (await env.DB.get("korean", "json")) || { lesson: 0, learned: [], mistakes: [] };
  k.mistakes = [...(k.mistakes || []), `${question.q} → ${question.options[question.answer]}`].slice(-30);
  await env.DB.put("korean", JSON.stringify(k));
  return send(env, `❌ Not quite. It's "${question.options[question.answer]}".\n${question.explain || ""}\n(I'll bring this back in a later lesson.)`);
}

export async function onKoreanCommand(env, arg) {
  const a = arg.toLowerCase();
  const k = (await env.DB.get("korean", "json")) || { lesson: 0, learned: [], mistakes: [], on: true };
  if (["daily on", "daily off", "on", "off"].includes(a)) {
    k.daily = a.endsWith("on");
    await env.DB.put("korean", JSON.stringify(k));
    return send(env, k.daily
      ? "🇰🇷 Daily Korean lessons ON (weekdays 6:30, weekends 9:00), on top of the words I teach you in chat."
      : "🇰🇷 Daily lessons off. I'll keep teaching you words while we chat. /korean for a full lesson any time.");
  }
  if (a === "words" || a === "vocab") {
    if (!k.learned.length) return send(env, "🇰🇷 Nothing learned yet. /korean for your first lesson!");
    return send(env, `🇰🇷 What you've learned (${k.lesson} lessons):\n\n${k.learned.slice(-60).join("\n")}`);
  }
  if (a === "audio") {
    if (!k.last_speak) return send(env, "🔊 No lesson audio yet. /korean for a lesson first.");
    await send(env, "🔊 Making the audio for your last lesson. It arrives in about a minute.");
    return sendKoreanAudio(env, k.last_speak, `🔊 Lesson ${k.lesson}: listen, then repeat out loud`);
  }
  if (a.startsWith("say ")) {
    const text = arg.slice(4).trim();
    if (!/[가-힣ㄱ-ㆎ]/.test(text)) return send(env, "🔊 Write it in Hangul, e.g.: /korean say 안녕하세요");
    await send(env, "🔊 Recording it… about a minute.");
    return sendKoreanAudio(env, `${text}. ${text}.`, `🔊 ${text.slice(0, 200)}`);
  }
  if (a === "status") {
    return send(env, `🇰🇷 Lesson ${k.lesson} done · stage: ${k.lesson < 14 ? "Hangul" : k.lesson < 45 ? "survival words" : "basic grammar"} · ${(k.mistakes || []).length} items to review`);
  }
  return runKoreanLesson(env);
}
