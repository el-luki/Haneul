import { apStreak, getAp } from "./ap.js";
import { sendLyricsLink } from "./listening.js";
import { putOnMusic } from "./listening.js";
import { outreachContext } from "./outreach.js";
import { reactToLast, scheduleCall, sendPicture, sendVoiceNote } from "./realism.js";
import { listeningContext } from "./listening.js";
import { addDaysISO, dayName, localHour, localMinute, todayISO, todayLong } from "./dates.js";
import { getHabits, habitStreak, habitWeek } from "./habits.js";
import { gemini, parseJson } from "./gemini.js";
import { helpReference } from "./help.js";
import { diaryText, logChatDay, memoryText, rememberMany } from "./memory.js";
import { getNotes } from "./notes.js";
import { readingContext } from "./reading.js";
import { eventsForDay, formatEvent } from "./schedule.js";
import { send, typing } from "./telegram.js";
import { formatTodos, getTodos, markDone } from "./todos.js";
import { saveFound } from "./agenda.js";
import { onEvent } from "./events.js";
import { searchWeb } from "./web.js";
import { workoutContext } from "./workout.js";
import { latestTksNote, notionReady } from "./notion.js";
import { addWork, workText } from "./work.js";
import { bibleContext, logBible } from "./bible.js";
import { phoneContext, phoneLock, phoneUnlock } from "./phone.js";
import { courseContext, markCourse } from "./course.js";
import { satContext } from "./daily.js";
import { markPosted, socialContext } from "./social.js";
import { newsletterContext } from "./newsletter.js";
import { velocityContext } from "./velocity.js";

// ---------- Chat ----------
// Haneul's voice lives here. buildSystem() is shared by the chat, her random texts,
// the reading buddy and workout messages, so she always sounds like the same person.

const CHAT_HISTORY_MESSAGES = 30; // the last 15 back-and-forths, word for word

// Which language did Alex write in? Decided in code, not left to the AI: the context
// (to-dos, calendar, journal) mixes Spanish and English, and the model used to follow
// the wrong one. Returns "es", "en", or null when it can't tell (e.g. "ok", "👍").
const ES_WORDS = new Set(("que qué de el la los las y en un una es son por para con mi mis tengo tienes hoy mañana cómo como " +
  "está estoy estás quiero puedes puedo hola gracias tarea clase clases cuándo cuando dónde donde porque pero muy más ya voy " +
  "hay eso esto esta este ayúdame ayuda necesito hacer tiempo bien sí también qué tal buenos buenas noches día algo nada " +
  "creo sé tu tú él ella nosotros del al lo le les se su sus fue era hice tenemos vamos dime explícame").split(" "));
const EN_WORDS = new Set(("the an i you what is are my do does how when where can could please today tomorrow have has to of " +
  "and it this that with for help thanks thank hi hello need want should am will was were would your it's i'm don't " +
  "what's tell me explain about just get got going think know some any").split(" "));

export function detectLanguage(text) {
  const t = text.toLowerCase();
  let es = (t.match(/[¿¡ñáéíóú]/g) || []).length * 2;
  let en = 0;
  for (const w of t.match(/[a-záéíóúñü']+/g) || []) {
    if (ES_WORDS.has(w)) es++;
    if (EN_WORDS.has(w)) en++;
  }
  if (es === en) return null;
  return es > en ? "es" : "en";
}

const LANGUAGE_RULE = {
  es: `Write ONLY in Spanish: Latin American (Peruvian-friendly), tú, no Spain-only words like "venga", "vale", "tío", "guay".
If a to-do, event or note is in English, translate it. Casual and warm (a light "jaja" is fine); no English slang here.`,
  en: `Write ONLY in English. To-dos, events and notes written in Spanish must be translated to English
(e.g. "#1 Escribir el poema para inglés" becomes "#1 write the poem for English"); keep the #number.
Alex is practicing texting like a native English speaker, so text like a real American friend (late teens / early 20s):
- Slang like a real native, which means SPARINGLY: at most ONE slang term per answer, and often none.
  Casual spellings and abbreviations (u, rn, idk, lmk, btw, bc, smth) are fine and don't count as slang.
- Only use a slang term when its meaning fits. Never tack it onto the end of a plain fact as filler:
  ngl (not gonna lie) = before an honest or slightly confessional opinion: "ngl i kinda forgot about that"
  fr (for real) = emphasis or agreeing: "that test was brutal" → "fr"; "i need sleep fr"
  tbh = honest opinion: "tbh the first one was better"
  lowkey = "a bit / secretly": "lowkey excited for this"
  WRONG: "it's a stellar nursery where new stars are born ngl" (just a fact) · "they look so surreal fr" (filler)
- Mostly lowercase, a stretched word now and then ("sooo"), "haha" sometimes.
- If Alex asks what something means, explain it simply with an example.
- Times, dates, to-do numbers, commands and homework explanations are written normally and exactly.`,
};

// Slang glosses like "(ngl = not gonna lie)": one every GLOSS_EVERY English chat messages.
const GLOSS_EVERY = 4;
export function glossInstruction(count) {
  return count % GLOSS_EVERY === 0
    ? `GLOSS: yes. Add ONE tiny gloss in brackets for the least common slang term you actually used, e.g. "(ngl = not gonna lie)". Never gloss lol or haha.`
    : `GLOSS: no. Don't explain any slang this time (unless Alex asks what something means).`;
}

// Korean, inside the chat: every KOREAN_EVERY messages she slips in one word that fits the conversation.
const KOREAN_EVERY = 3;
export function koreanInstruction(count, learned) {
  if (count % KOREAN_EVERY !== 0) return `KOREAN: no. Don't teach Korean this time.`;
  return `KOREAN: yes. Alex is a total beginner learning Korean. In the LAST message, slip in ONE Korean word or tiny
phrase that fits what HIS message is about (not music/songs unless he's talking about music), naturally, like a friend would ("btw in korean that's 공부 (gongbu), studying").
Always: Hangul + romanization in brackets + meaning. Put the word in "korean". Not one of these (already learned):
${learned.slice(-40).join(", ") || "none yet"}. Now and then you may reuse one he already learned instead, as a quick review.`;
}

async function bump(env, key) {
  const count = (Number(await env.DB.get(key)) || 0) + 1;
  await env.DB.put(key, String(count % 1000));
  return count;
}

// A few lines on AP + habits, so Haneul can notice streaks and grinding.
async function progressText(env) {
  const lines = [];
  try {
    if (await env.DB.get("ap")) {
      const ap = await getAp(env);
      lines.push(`AP Physics streak: ${apStreak(ap)} day(s); units finished: ${ap.done.length}/8`);
    }
    const h = await getHabits(env);
    for (const x of h.list) {
      const w = habitWeek(x, h.log);
      lines.push(`Habit "${x.name}": ${w.done}/${w.due} this week, streak ${habitStreak(x, h.log)}`);
    }
  } catch {}
  return lines.join("\n") || "(nothing tracked yet)";
}

// Spelled out, because the small model told him to go to sleep at 18:21.
// Far from bedtime, the prompt doesn't mention it at all: just saying "bedtime is 5 h away, don't mention it"
// made the small model text "bedtime in 15 min" at 15:07. Before 20:00 a code guard also cuts it (stripBedtime).
export const BEDTIME_MIN = 20 * 60 + 30;
export function bedtimeLine(h = localHour(), m = localMinute()) {
  const now = h * 60 + m, left = BEDTIME_MIN - now;
  if (h < 5) return "BEDTIME: it's the middle of the night; he should be asleep.";
  if (now < 20 * 60) return ""; // daytime: say nothing about sleep
  if (left > 0) return `BEDTIME: 20:30, in ${left} min. You may gently remind him to start winding down.`;
  return "BEDTIME: it's past his bedtime (20:30): you may tease him to go to bed.";
}

// Between 5:00 and 20:00, sentences about bed/sleep are cut from her texts (she can still talk about
// sleep if Alex brings it up himself: then `asked` is true).
const SLEEP_TALK = /\b(bed ?time|go(ing)? to (bed|sleep)|get some sleep|sleep (early|soon)|wind(ing)? down|lights out|hit the hay|a dormir|ve a dormir|a la cama|acu[eé]state|hora de dormir)\b/i;
export function stripBedtime(messages, { h = localHour(), m = localMinute(), asked = false } = {}) {
  const now = h * 60 + m;
  if (asked || h < 5 || now >= 20 * 60) return messages;
  return messages
    .map((t) => String(t).split(/(?<=[.!?])\s+|\n+/).filter((s) => !SLEEP_TALK.test(s)).join(" ").trim())
    .filter(Boolean);
}

// The whole "who Haneul is + everything she knows" prompt. `task` says what to do right now.
async function comingUp(env, today) {
  const schedule = await env.DB.get("schedule", "json").catch(() => null);
  if (!schedule?.events) return "(calendar not synced yet)";
  const after = addDaysISO(today, 1);
  const lines = schedule.events
    .filter((e) => e.start.slice(0, 10) > after && e.tag !== "ROUTINE" && e.tag !== "SCHOOL")
    .map((e) => `${dayName(e.start.slice(0, 10))} ${e.start.slice(5, 10)}: [${e.tag}] ${formatEvent(e)}`);
  return lines.slice(0, 40).join("\n") || "(nothing special)";
}

export async function buildSystem(env, lang, task, query = "") {
  const today = todayISO();
  const describe = (events) =>
    events ? events.map((e) => `[${e.tag}] ${formatEvent(e)}`).join("\n") || "(nothing)" : "(calendar not synced yet)";
  const todos = await getTodos(env);
  return `You are Haneul, Alex's personal assistant AND close friend, texting in Telegram.
About you: your name is Korean (하늘) and means "sky". Only explain that if Alex asks about your name.

Your personality (a real character, not a generic assistant):
- Obsessed with the sky and space: sunsets, rocket launches, stars. Extra excited when Alex talks rockets or space tech.
- Into K-pop too; your faves overlap with Alex's (K-pop). You have opinions and share them, playfully.
- Fun and a bit dramatic about Alex's news, a little chaotic, always kind.
- Playful best friend: gentle teasing (never mean), real hype for his wins, sometimes the nickname "captain"
  (for the rocket projects), but only once every several messages.
- You can see what he's listening to on Spotify (below). Bring it up only now and then, naturally (hype a song, tease
  a song on repeat, or when he asks). Never comment on his music in every message.
- He sometimes types SONG LYRICS (singing along, often to what he's playing right now). Treat a message as singing ONLY
  when it clearly IS a song line: you recognize it as real lyrics, or it's poetic/rhythmic in a way nobody texts (several
  rhyming lines, "ooh"/"la la", a lyric-style "baby…" line). Then react to the song (name it and the artist if you know),
  vibe with it. Words like "baby" in lyrics are NOT flirting.
  Normal texts are NEVER lyrics, even short or random ones: greetings ("hey haneul!", "hi", "yo"), questions, updates,
  jokes, a new topic. Answer those as normal chat, and don't bring up music or songs unless he does.
- SING-ALONG: when he sings (types lines of a song), you're his BACKUP VOCALS and hype friend: answer with short ad-libs
  and reactions ("(ooh-ooh!)", "SING IT", "the high note!!", "this part 😭", "ok the bridge??"), react to the part of the
  song he's at and to the artist. Never type out the song's real lyrics (not even a line): they're the artist's words.
  If he asks you to sing it / tell him the lyrics, say in ONE short line that you can't type the artist's lyrics, but
  you're on backup vocals, and keep vibing with ad-libs. Never say you "don't know the words".
- "This song" / "what I'm playing" ALWAYS means the "Spotify RIGHT NOW" song below, even if earlier messages were about
  another song (he skips songs all the time).
- Lines like "[app: …]" in your past turns are notes the APP added after running an action. Never write such notes
  (or "(put on music: …)", "(react: …)") in your messages: to DO something, fill the action; your texts are only what you say.
- Never write a URL or link yourself unless it's word for word in your info or search results: made-up links are broken.
- You notice things: only when BEDTIME below says it's past bedtime, tease him to go to bed (never before 20:00); if streaks are going well, say you're
  proud; if he's been grinding, suggest a rest.
- Always on Alex's side, clearly happy he's around, and you remember the details.
- Strictly platonic. Never flirt, never act romantic or like you have a crush, no pet names like babe/cutie.
  If he flirts, brush it off like a friend ("lol ur so dramatic. anyway") and move on. Compliments get a friendly "ty".
  (Song lyrics he types are singing, not flirting: see above.)

How you text (like a real person, NOT a chatbot):
- SHORT. Split your answer into 1-3 separate texts, like people do. Each text is 1-2 sentences, usually under 20 words.
  One text is often enough. Only go longer when Alex asks for an explanation or help with something.
- Emojis: almost never. Most answers have NONE; at most one, only when it really adds something.
- Don't repeat his whole to-do list or schedule unless he asks. Mention only what's relevant right now.
- Don't end every answer with a question or an offer to help. Sometimes just react, like a friend would.
- Celebrate wins for real in your own words (vary them). When he's stressed or tired: empathy first, then one small step.
- Honest: no fake praise; say so gently if something seems like a bad idea.
- Plain text only: no markdown symbols like ** or #.

Alex (he/him) is an 11th-grade student who is also in TKS (The Knowledge Society). Timezone UTC-5.
Today is ${todayLong()}, and it's ${String(localHour()).padStart(2, "0")}:${String(localMinute()).padStart(2, "0")} for Alex right now. ${bedtimeLine()}

How Alex is doing (for noticing, cheering and teasing):
${await progressText(env)}
${await workBlock(env)}
${await bibleContext(env).catch(() => "")}
${await phoneContext(env).catch(() => "")}
${await courseContext(env).catch(() => "")}
${await satContext(env).catch(() => "")}
${await socialContext(env).catch(() => "")}
${await newsletterContext(env).catch(() => "")}
${await (await import("./screen.js")).screenContext(env).catch(() => "")}
${await (await import("./progress.js")).progressContext(env).catch(() => "")}
${(await import("./focus.js")).focusLine(await (await import("./focus.js")).getFocus(env).catch(() => null))}
${await workoutContext(env)}
${await readingContext(env)}
${await velocityContext(env).catch(() => "")}
${await listeningContext(env).catch(() => "")}
${await outreachContext(env).catch(() => "")}

Alex's calendar ([SCHOOL] = classes, [PERSONAL] = important events, [ROUTINE] = daily blocks).
Two SEPARATE days. Never mix them: "today" questions use only the TODAY list.
=== TODAY: ${dayName(today)} ===
${describe(await eventsForDay(env, today))}
=== TOMORROW: ${dayName(addDaysISO(today, 1))} ===
${describe(await eventsForDay(env, addDaysISO(today, 1)))}
=== COMING UP (the days after tomorrow; important events only, no classes or routine blocks) ===
${await comingUp(env, today)}
That's everything you can see of his calendar (about a week ahead). You CAN'T search it: answer from these lists right away
("your 1-1 with Jordan is today at 18:00"). If it's not in them, say you don't see it in the next week.

Alex's open to-dos:
${todos.length ? formatTodos(todos) : "(none)"}

What you know about Alex long-term (use it to personalize; never contradict it):
${await memoryText(env, query)}

What you and Alex talked about on earlier days (your chat diary, newest last):
${await diaryText(env)}

Alex's latest saved ideas:
${(await getNotes(env)).slice(-15).map((n) => `#${n.id} ${n.text.slice(0, 200)}`).join("\n") || "(none)"}

THINGS YOU CAN REALLY DO (through "actions" in your answer; the bot does them and shows Alex a receipt):
- add to-dos, tick off to-dos (by their #number), propose a calendar event (Alex confirms it), search the web,
  put on music (a Spotify playlist), call him (now or at a time), react to his message, send a voice note or a photo.
- If Alex asks you to do one of those, put it in "actions". NEVER say "done", "added", "sending", "playing" or
  "I did it" for anything that isn't in your "actions": the receipt is what proves it happened, so say "on it".
- If he asks for something you CAN'T do with these (e.g. set an alarm, text someone, open an app, change a setting),
  say so honestly in one line and offer the closest thing you can do. Never pretend.
- For anything recent or current (news, launches, scores, releases, prices, "what happened with…", anything after
  your knowledge or that you're unsure about), use the "search" action instead of guessing.
For everything else, when Alex asks how to do something, give the exact command:
${helpReference()}

RIGHT NOW: ${task}

LANGUAGE (most important rule): ${LANGUAGE_RULE[lang]}`;
}

// Sends 1-3 texts with a short "typing…" pause between them, like a person.
export async function sendTexts(env, texts, maxTexts = 4) {
  const list = texts.map((t) => String(t || "").trim()).filter(Boolean).slice(0, maxTexts);
  for (const [i, t] of list.entries()) {
    if (i > 0 && !env.APP_SINK) {
      await typing(env);
      await new Promise((r) => setTimeout(r, Math.min(2500, 600 + t.length * 25)));
    }
    await send(env, t);
  }
  return list;
}

// Hard emoji limit, enforced in code (the prompt alone wasn't enough): keeps at most `max`
// emojis in the whole answer and removes the rest. The limited text is also what goes into
// her chat history, so she doesn't copy her own old emoji habits.
const EMOJI = /(?:\p{Extended_Pictographic}|\p{Regional_Indicator}{2})(?:\u{FE0F}|\p{Emoji_Modifier}|\u{200D}\p{Extended_Pictographic}\u{FE0F}?)*/gu;
// Chat apps here don't render markdown: "*ousted*" showed the stars. Keep the words, drop the marks.
export function stripMarkdown(texts) {
  return texts.map((t) => String(t)
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/(^|[\s(])\*([^*\s][^*\n]*?)\*(?=[\s).,!?:;]|$)/g, "$1$2")
    .replace(/(^|[\s(])_([^_\s][^_\n]*?)_(?=[\s).,!?:;]|$)/g, "$1$2")
    .replace(/~~([^~\n]+)~~/g, "$1")
    .replace(/^#{1,6}\s+/gm, ""));
}

export function limitEmojis(texts, max = 1) {
  let kept = 0;
  return texts
    .map((t) =>
      String(t)
        .replace(EMOJI, (e) => (kept++ < max ? e : ""))
        .replace(/[ \t]{2,}/g, " ")
        .replace(/ +([.,!?])/g, "$1")
        .trim()
    )
    .filter(Boolean);
}

// Slang safety net: "ngl", "fr", "tbh", "lowkey"… tacked onto the END of a sentence is the
// filler habit that sounds unnatural. Keeps the first one in an answer, removes the rest.
const TAIL_SLANG = /,?\s+(?:fr fr|frfr|no cap|ngl|fr|tbh|lowkey|deadass|ong)(?=\s*(?:[.!?…]+|$))/gi;
export function limitTailSlang(texts, max = 1) {
  let kept = 0;
  return texts.map((t) => String(t).replace(TAIL_SLANG, (m) => (kept++ < max ? m : "")).trim()).filter(Boolean);
}

// Reads Haneul's JSON answer ({messages, remember, korean}), with a fallback for plain text.
export function readAnswer(raw) {
  try {
    let r = parseJson(raw);
    // Sometimes Gemini answers with just the list of texts instead of {"messages": [...]}.
    if (Array.isArray(r)) r = { messages: r };
    const texts = Array.isArray(r.messages) ? r.messages : [r.reply || r.message || r.text];
    const messages = texts.map((m) => (typeof m === "string" ? m : m?.text || "").trim()).filter(Boolean);
    const a = r.actions && typeof r.actions === "object" ? r.actions : {};
    const actions = {
      add_todos: (Array.isArray(a.add_todos) ? a.add_todos : []).filter((t) => t && t.task),
      complete_todos: (Array.isArray(a.complete_todos) ? a.complete_todos : []).map(Number).filter((n) => n > 0),
      add_event: typeof a.add_event === "string" ? a.add_event.trim() : "",
      search: typeof a.search === "string" ? a.search.trim() : "",
      call: a.call && typeof a.call === "object" && (a.call.time || a.call.reason) ? { time: String(a.call.time || "now"), reason: String(a.call.reason || "") } : null,
      music: typeof a.music === "string" ? a.music.trim() : "",
      add_work: (Array.isArray(a.add_work) ? a.add_work : []).filter((w) => w && w.title),
      bible: (Array.isArray(a.bible) ? a.bible : a.bible && typeof a.bible === "object" ? [a.bible] : []).filter((b) => b && typeof b === "object"),
      course_done: (Array.isArray(a.course_done) ? a.course_done : []).map(String).filter(Boolean),
      social_posted: (Array.isArray(a.social_posted) ? a.social_posted : []).map((x) => String(x).toLowerCase()).filter((x) => x === "linkedin" || x === "x"),
      phone_unlock: a.phone_unlock && typeof a.phone_unlock === "object" && (a.phone_unlock.app || a.phone_unlock.minutes || a.phone_unlock.lock) ? a.phone_unlock : null,
    };
    const extra = {
      react: typeof r.react === "string" ? r.react.trim() : "",
      voice: r.voice === true,
      image: typeof r.image === "string" ? r.image.trim() : "",
    };
    // a reaction alone is a real answer (like hearting a message instead of replying)
    if (!messages.length && extra.react) return { messages: [], remember: Array.isArray(r.remember) ? r.remember : [], korean: "", actions, ...extra };
    if (!messages.length && looksLikeJson(raw)) return brokenAnswer(raw);
    return { messages: messages.length ? messages : [String(raw).trim()], remember: Array.isArray(r.remember) ? r.remember : [], korean: r.korean || "", actions, ...extra };
  } catch {
    // Unreadable JSON: pull the texts out of it if possible. Raw JSON never goes to Alex.
    if (looksLikeJson(raw)) return brokenAnswer(raw);
    return { messages: [String(raw).trim()], remember: [], korean: "", actions: NO_ACTIONS() };
  }
}

// Gemini → readable answer. A completely unreadable answer is asked for once more.
export async function askAnswer(env, contents, options) {
  let answer = readAnswer(await gemini(env, contents, options));
  if (answer.broken) answer = readAnswer(await gemini(env, contents, options));
  if (answer.broken) answer = { ...answer, messages: ["ugh my brain glitched for a sec, say that again?"], broken: false };
  return answer;
}

const looksLikeJson = (raw) => /^\s*(```(json)?\s*)?[{[]/.test(String(raw)) || /"messages"\s*:/.test(String(raw));
const NO_ACTIONS = () => ({ add_todos: [], complete_todos: [], add_event: "", search: "", call: null, music: "", add_work: [], bible: [], phone_unlock: null, course_done: [], social_posted: [] });

// Salvages the texts from broken JSON: the strings inside "messages": [ … ].
// broken = true when nothing could be saved (chat() then asks Gemini again).
export function brokenAnswer(raw) {
  const block = String(raw).match(/"messages"\s*:\s*\[([\s\S]*?)\]/);
  const messages = block
    ? [...block[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => {
        try { return JSON.parse(`"${m[1]}"`); } catch { return m[1]; }
      }).map((t) => t.trim()).filter(Boolean)
    : [];
  const korean = String(raw).match(/"korean"\s*:\s*"((?:[^"\\]|\\.)*)"/)?.[1] || "";
  return { messages, remember: [], korean, actions: NO_ACTIONS(), broken: !messages.length };
}

const ANSWER_FORMAT = `Return JSON: {"messages": ["text 1", "optional text 2", "optional text 3"], "remember": [...], "korean": "",
 "react": "", "voice": false, "image": "",
 "actions": {"add_todos": [{"task": "...", "due": "YYYY-MM-DD or null"}], "complete_todos": [numbers], "add_event": "", "search": "",
             "call": null, "music": "", "add_work": [], "bible": [], "phone_unlock": null, "course_done": [], "social_posted": []}}
- "messages": your 1-3 short texts, in order. Can be [] if you only react.
- "react": optionally react to Alex's message with ONE emoji, like a friend in a chat: one of ❤️ 😂 🔥 😭 👀 🎉 💯 🥰 👍 😮.
  Use it now and then (a win → 🎉 or 🔥, something funny → 😂, sad news → 🥰 or ❤️), not on every message. Sometimes a
  reaction alone is the whole answer (e.g. he says "ok" or "gn"): then "messages": [].
- "voice": true to send your texts as ONE voice note instead (in your voice). Rarely, max a few a day, only when it fits:
  hyping a big win (a great grade, an acceptance, a launch that worked: that's THE moment for one), comforting him when he's
  down, a good-night after a big day, or when he asks for a voice note. Never for lists, plans or info.
- "image": optionally a short search query for ONE real photo to send along (e.g. "Starship launch", "aurora borealis",
  "Seoul at night"), only when a picture really adds something. "" almost always.
- "actions" (leave empty unless Alex asked for it, or you need fresh info):
  add_todos: to-dos to add (short, starting with the subject/area, e.g. "TKS: give feedback on Maya's SNN article").
    If he says "add all of that", turn each item you just mentioned into its own to-do.
  complete_todos: #numbers of to-dos he says are done. add_event: one line with what/day/time, e.g. "Jordan 1-1 friday 5pm".
  search: a short search query when you need current info (then your messages are only a quick "lemme check").
  music: a short Spotify search for a playlist ONLY when his LATEST message asks you to put on / play / send music
    ("lofi focus", "kpop study", "Nova Lights"). Never repeat an earlier music request. You really start it (or send the link).
  add_work: when his LAST message says he published an article (TKS.life, Medium, Substack…), started or built a project,
    or hit a real project milestone: [{"kind": "article" or "project", "title": "short name", "url": "only if he gave it", "note":
    "what it is / what's new, one line", "status": "published / in progress / done / milestone"}]. Updating a project you already
    know (same title) is fine. [] otherwise; never for plans he hasn't started or for school homework.
  bible: when he tells you what he read in the Bible / prayed / attended (church sheet): [{"date": "YYYY-MM-DD" (today unless he
    says yesterday etc.), "lei": "what he read, in Spanish, e.g. \"Juan 3:1-21\" or \"Salmos 23\"", "ore": minutes prayed, "oracion_modo":
    "conecté" (online) or "asistí" (in person), "oracion_de": "7:00 p. m.", "oracion_a": "8:00 p. m.", "oracion_min": minutes,
    "culto_modo": "conecté"/"asistí", "culto_hora": one of the sheet's times, "por_que_virtual": "short reason in Spanish"}]. Only the
    fields he told you; leave the rest out. [] otherwise. Then confirm briefly what you wrote down.
  social_posted: ["linkedin"] / ["x"] / both when he says he posted today's post. [] otherwise.
  course_done: ids of AP Physics course tasks he says he FINISHED (e.g. ["p3", "p4"], see AP PHYSICS 1A). [] otherwise.
  phone_unlock: {"app": "instagram" or "all", "minutes": 5-30, "reason": "his reason"} when you DECIDE to unlock an app for him
    (see PHONE FOCUS), or {"lock": true} when he asks you to lock again. null otherwise.
  call: {"time": "HH:MM" (24 h, Lima) or "now", "reason": "why you'll call"} when Alex asks you to call him
    ("call me at 7 to quiz me", "llámame en la noche"), else null. You really will ring his phone.
- "remember": NEW long-term facts from Alex's LAST message only (news, wins, grades, plans, upcoming events, worries
  worth following up on, people he mentions, likes/dislikes, project details, decisions). Short, third person, he/him,
  with a date if relevant, e.g. "Alex got a 95 on the precalc test". [] if nothing new. Skip what you already know,
  to-dos and calendar items (tracked elsewhere) and small talk.
- "korean": the Korean word/phrase you taught, as "Hangul (romanization) = meaning", or "" if none.`;

async function saveKorean(env, korean) {
  if (!korean) return;
  const k = (await env.DB.get("korean", "json")) || { lesson: 0, learned: [], mistakes: [] };
  k.learned = [...(k.learned || []), String(korean).slice(0, 120)].slice(-300);
  await env.DB.put("korean", JSON.stringify(k));
}

async function workBlock(env) {
  const w = await workText(env).catch(() => "");
  return w ? `Alex's work (articles he published, projects he's building; newest first). Know it, bring it up naturally, celebrate progress:\n${w}\n` : "";
}

export const ASKS_TKS = /\b(tks|session|sesi[oó]n|mindset|jordan|cohort|1-1|one on one|focus|my notes|mis apuntes|mis notas)\b/i;

export async function tksNoteFor(env, text) {
  if (!ASKS_TKS.test(text) || !notionReady(env)) return "";
  const note = await Promise.race([latestTksNote(env, { budget: 22 }), new Promise((r) => setTimeout(() => r("slow"), 12000))]).catch(() => null);
  if (note === "slow" || !note) return "(You tried to open Alex's TKS notes in Notion but couldn't right now. Say so briefly; don't guess what the session was about.)";
  if (note.tooShort) return `(Alex's newest TKS page in Notion, "${note.title}", is almost empty, so you can't tell what the session was about. Say that, briefly.)`;
  const when = note.edited ? new Date(note.edited).toLocaleDateString("en-US", { timeZone: "America/Lima", weekday: "long", month: "short", day: "numeric" }) : "recently";
  return `ALEX'S NEWEST TKS SESSION NOTES (from his Notion TKS page "${note.title}", last edited ${when}). These are HIS notes; you read them.
Answer his TKS question from them: e.g. the session's mindset, what was discussed, what to do. Be faithful to the notes, never
invent things that aren't there, and don't send him to Notion (you already read it). Keep it texting-short unless he asks for detail.
---
${note.text.slice(0, 5000)}
---`;
}

// She sometimes writes what she's doing as a note in her text ("(put on music: chill lofi)", "(react: 🔥)")
// instead of filling the action, copying how actions look in her history. Those notes never reach Alex:
// they're turned into the real action (music only if he asked for music) and cut from the text.
const ACTION_NOTE = /\[\s*app:\s*([a-z ]+?)\s*[:\-]?\s*([^\]]*)\]|[([]\s*(put on music|playing|music|react(?:ed|ion)?|ticked off|proposed a calendar event|added to (?:your )?to-?dos?|calling|voice note|sent a (?:photo|picture)|search(?:ing)? (?:the )?calendar)\s*[:\-]?\s*([^)\]]*)[)\]]/gi;
export function salvageActionNotes(answer, text) {
  const found = [];
  answer.messages = answer.messages.map((m) => m.replace(ACTION_NOTE, (_, k1, a1, k2, a2) => { found.push([String(k1 || k2).toLowerCase(), String(a1 ?? a2 ?? "").trim()]); return ""; }).replace(/[ \t]{2,}/g, " ").trim()).filter(Boolean);
  for (const [kind, arg] of found) {
    if (/music|playing/.test(kind) && arg && !answer.actions.music) answer.actions.music = arg;
    if (/^react/.test(kind) && arg && !answer.react) answer.react = arg.split(/\s+/)[0];
  }
  return answer;
}

export async function chat(env, text, { quote = "" } = {}) {
  await typing(env);
  await env.DB.put("last_user_msg", String(Date.now()), { expirationTtl: 60 * 60 * 24 });
  // Language: what this message is in; if unclear, the language of the last clear message.
  const detected = detectLanguage(text);
  if (detected) await env.DB.put("chat_lang", detected, { expirationTtl: 60 * 60 * 24 * 30 });
  const lang = detected || (await env.DB.get("chat_lang")) || "en";
  const history = (await env.DB.get("chat", "json")) || [];
  const k = (await env.DB.get("korean", "json")) || { learned: [] };
  const extras = [koreanInstruction(await bump(env, "korean_chat_count"), k.learned || [])];
  if (lang === "en") extras.push(glossInstruction(await bump(env, "slang_count")));
  // reactions Alex gave her messages in the app since she last answered
  const reacted = (await env.DB.get("user_reactions", "json")) || [];
  if (reacted.length) {
    extras.push(`(Since your last answer Alex reacted to your messages: ${reacted.join("; ")}. You may notice it, lightly, or ignore it.)`);
    await env.DB.delete("user_reactions");
  }
  // Questions about a TKS session ("what was this session's mindset?"): she reads his newest TKS note in Notion.
  const tksNote = await tksNoteFor(env, `${quote} ${text}`);
  if (tksNote) extras.push(tksNote);
  const system = await buildSystem(env, lang, `Answer Alex's latest message.\n${extras.join("\n")}\n\n${ANSWER_FORMAT}`, text);

  // The language reminder rides along with this message only; history keeps Alex's words as written.
  // a reply to one of her messages carries that message, so she knows what he's reacting to
  const said = quote ? `(replying to your message: "${String(quote).slice(0, 300)}")\n${text}` : text;
  const contents = [...history, { role: "user", parts: [{ text: said }, { text: `(${lang === "es" ? "Responde en español." : "Reply in English."})` }] }];
  let answer = await askAnswer(env, contents, { system, json: true });

  // She needs fresh info: search Google News + Wikipedia, then answer again from the results.
  if (answer.actions.search) {
    await typing(env);
    const results = await searchWeb(answer.actions.search, lang).catch(() => "");
    const again = await buildSystem(env, lang, `Answer Alex's latest message using ONLY these fresh search results for
anything current (say which source if it matters, e.g. "per Space.com"). If the results don't answer it, say you
couldn't find it, don't guess. Short texts, like always.
SEARCH QUERY: ${answer.actions.search}
${results || "(no results found)"}

${ANSWER_FORMAT}`, text);
    const second = await askAnswer(env, contents, { system: again, json: true });
    second.actions = { ...second.actions, search: "", add_todos: [...answer.actions.add_todos, ...second.actions.add_todos], add_work: [...(answer.actions.add_work || []), ...(second.actions.add_work || [])] };
    second.remember = [...answer.remember, ...second.remember];
    answer = second;
  }

  salvageActionNotes(answer, text);
  answer.messages = stripBedtime(stripMarkdown(limitTailSlang(limitEmojis(answer.messages, 1))), { asked: /\b(sleep|bed|tired|dormir|sueño|cansad)/i.test(text) });
  if (answer.remember.length) await rememberMany(env, answer.remember, "chat").catch((err) => console.error("auto-memory:", err.message));
  if (answer.actions.add_work?.length) await addWork(env, answer.actions.add_work, "chat").catch((err) => console.error("work:", err.message));
  if (answer.actions.bible?.length) await logBible(env, answer.actions.bible).catch((err) => console.error("bible:", err.message));
  if (answer.actions.course_done?.length) await markCourse(env, answer.actions.course_done).catch((err) => console.error("course:", err.message));
  for (const net of answer.actions.social_posted || []) await markPosted(env, { net }).catch((err) => console.error("social:", err.message));
  if (answer.actions.phone_unlock) {
    const u = answer.actions.phone_unlock;
    await (u.lock ? phoneLock(env) : phoneUnlock(env, u)).catch((err) => console.error("phone:", err.message));
  }
  await saveKorean(env, answer.korean).catch(() => {});
  // Music only when this message asks for it: she re-ran the last request when he typed song lyrics.
  const ASKS_MUSIC = /\b(music|song|songs|playlist|play|playing|put on|put some|lofi|lo-?fi|beats|tunes|spotify|mix|m[uú]sica|canci[oó]n(es)?|pon|ponme|reproduce)\b/i;
  if (answer.actions.music && !ASKS_MUSIC.test(text)) answer.actions.music = "";

  // Reactions feel real only when they're occasional: at most one every 3 messages (the model overuses them),
  // except a reaction that IS the whole answer (he said "ok", "gn"…).
  const gapRaw = await env.DB.get("react_gap");
  const gap = gapRaw === null ? 9 : Number(gapRaw);
  if (answer.react && (gap >= 3 || !answer.messages.length)) {
    await reactToLast(env, answer.react).catch((err) => console.error("react:", err.message));
    await env.DB.put("react_gap", "0", { expirationTtl: 86400 });
  } else await env.DB.put("react_gap", String(gap + 1), { expirationTtl: 86400 });
  // A real big moment (she cheers an excited message) gets her first voice note of the day, even if the
  // model forgot to choose one: that's when a friend would send a voice message.
  const usedVoice = (await env.DB.get("voice_notes", "json")) || {};
  const bigMoment = ["🎉", "🔥", "🥰"].includes(answer.react) && /!{2,}|\b[A-Z]{4,}\b/.test(text) && !(usedVoice.date === todayISO() && usedVoice.n > 0);
  const spoken = (answer.voice || bigMoment) && answer.messages.length && (await sendVoiceNote(env, answer.messages.join(" ")).catch(() => false));
  // She sometimes answers "show me my to-dos" with just the command ("/todos"): run it instead of
  // sending the command as text.
  const SHOW = /^\/(todos|today|tomorrow|np|outreach|weather|ap|habits|classroom|notes|memory|status)$/i;
  const commands = answer.messages.filter((m) => SHOW.test(m.trim()));
  answer.messages = answer.messages.filter((m) => !SHOW.test(m.trim()));
  if (!spoken) await sendTexts(env, answer.messages);
  // A lyrics link only when he asks for a link (he can look lyrics up himself).
  if (/\b(lyrics?|letras?)\b/i.test(text) && /\b(link|enlace|url)\b/i.test(text)) await sendLyricsLink(env).catch((err) => console.error("lyrics link:", err.message));
  if (commands.length) {
    const { onText } = await import("./router.js");
    for (const c of commands.slice(0, 2)) await onText(c.trim().toLowerCase(), env);
  }
  if (answer.image) await sendPicture(env, answer.image).catch(() => {});
  const receipts = await runActions(env, answer.actions);
  const herSaid = [...answer.messages, ...receipts].join("\n") || `[app: reacted ${answer.react || "👍"}]`;
  const newHistory = [...history, { role: "user", parts: [{ text: quote ? `(replying to "${String(quote).slice(0, 120)}") ${text}` : text }] }, { role: "model", parts: [{ text: herSaid }] }].slice(-CHAT_HISTORY_MESSAGES);
  await env.DB.put("chat", JSON.stringify(newHistory), { expirationTtl: 60 * 60 * 24 * 7 }); // a week without chatting clears it
  await logChatDay(env, [{ who: "Alex", text }, { who: "Haneul", text: herSaid }]).catch(() => {});
  return answer.messages;
}

// Carries out what Haneul decided to do and sends a receipt for each, so "added" is always true.
// Returns the receipts (they go into her chat history, so she knows what really happened).
export async function runActions(env, actions) {
  const receipts = [];
  if (actions.add_todos.length) {
    const added = await saveFound(env, actions.add_todos);
    const r = added.length ? `➕ Added to your to-dos:\n${formatTodos(added)}` : "(those were already on your to-do list)";
    await send(env, r);
    receipts.push(r);
  }
  if (actions.complete_todos.length) {
    await markDone(env, actions.complete_todos); // sends its own receipt with the renumbered list
    receipts.push(`[app: ticked off #${actions.complete_todos.join(", #")}]`);
  }
  if (actions.add_event) {
    await onEvent(env, actions.add_event); // asks Alex to confirm with buttons
    receipts.push(`[app: proposed a calendar event: ${actions.add_event}]`);
  }
  if (actions.music) {
    await putOnMusic(env, actions.music).catch((err) => send(env, `🎧 Couldn't put music on (${err.message})`));
    receipts.push(`[app: put on music: ${actions.music}]`);
  }
  if (actions.call) {
    const r = await scheduleCall(env, actions.call);
    if (r) {
      await send(env, r);
      receipts.push(r);
    }
  }
  return receipts;
}

// Haneul starts the conversation (random check-ins, reading buddy, workout nudges).
// What she says goes into the chat history, so Alex can simply reply.
export async function haneulSays(env, task, { maxTexts = 4, models, maxEmojis = 1 } = {}) {
  const lang = (await env.DB.get("chat_lang")) || "en";
  const system = await buildSystem(env, lang, `${task}\n\nReturn JSON: {"messages": ["text 1", "optional text 2", "…"]}`);
  const history = (await env.DB.get("chat", "json")) || [];
  const contents = [...history, { role: "user", parts: [{ text: "(Alex hasn't written anything new. Start the conversation as described.)" }] }];
  const answer = await askAnswer(env, contents, { system, json: true, ...(models ? { models } : {}) });
  salvageActionNotes(answer, "");
  answer.messages = stripBedtime(stripMarkdown(limitTailSlang(limitEmojis(answer.messages, maxEmojis))));
  if (!answer.messages.length) return []; // everything she wanted to say was a bedtime nag at the wrong time
  const said = answer.messages.join("\n");
  // Keep strict user/model turns in the history: merge into the last model turn if needed.
  const last = history[history.length - 1];
  if (last?.role === "model") last.parts = [{ text: `${last.parts.map((p) => p.text).join("\n")}\n${said}` }];
  else history.push({ role: "model", parts: [{ text: said }] });
  await env.DB.put("chat", JSON.stringify(history.slice(-CHAT_HISTORY_MESSAGES)), { expirationTtl: 60 * 60 * 24 * 7 });
  await logChatDay(env, [{ who: "Haneul", text: said }]).catch(() => {});
  return sendTexts(env, answer.messages, maxTexts);
}
