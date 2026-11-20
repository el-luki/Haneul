// Quick checks for the bot's logic. No test framework needed: `npm test`.
// They don't call Telegram, Gemini or Cloudflare: only the pure functions.
import { helpText, MENU_COMMANDS } from "../src/help.js";
import { scheduleQuestionDay } from "../src/schedule.js";
import { rememberPhrase } from "../src/memory.js";
import { parseDays, habitDue, habitStreak, habitWeek } from "../src/habits.js";
import { apPlan, apSummary } from "../src/ap.js";
import { classroomDue } from "../src/classroom.js";
import { rssItems } from "../src/space.js";
import { koreanStage } from "../src/korean.js";
import { isNoise } from "../src/whatsapp.js";
import { todayISO, addDaysISO, mondayOf, prettyDue } from "../src/dates.js";
import * as index from "../src/index.js";

let passed = 0;
let failed = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? passed++ : failed++;
  if (!ok) console.log(`FAIL ${name}\n     got:  ${JSON.stringify(got)}\n     want: ${JSON.stringify(want)}`);
}

// Entry point has the three handlers Cloudflare calls
check("index exports fetch/queue/scheduled", ["fetch", "queue", "scheduled"].map((k) => typeof index.default[k]), ["function", "function", "function"]);

// Help library
for (const [topic, title] of [["ap", "📘 AP Physics 1"], ["physics", "📘 AP Physics 1"], ["audio", "🎤 Voice notes"], ["fotos", "📸 Photos (agenda + TKS)"], ["hangul", "🇰🇷 Korean"], ["pronunciation", "🇰🇷 Korean"], ["hint", "🧑‍🏫 Homework tutor"], ["diario", "📓 Nightly journal"], ["reels", "🔗 Links + videos"]]) {
  check(`/help ${topic}`, helpText(topic).split("\n")[0], title);
}
check("/help unknown falls back", helpText("nonsense").startsWith("I don't have a help page"), true);
check("menu commands are valid", MENU_COMMANDS.every((c) => /^[a-z]{1,32}$/.test(c.command) && c.description.length <= 256), true);

// Schedule questions answered straight from the calendar
for (const [q, want] of [
  ["What classes do I have today?", 0], ["qué clases tengo mañana?", 1], ["que tengo hoy", 0],
  ["qué clases tengo en la mañana?", 0], ["what's on tomorrow", 1], ["what classes do I have on friday?", null],
  ["explain torque simply", null], ["help me plan my homework tonight", null],
  // statements that mention class/schedule are chat, not schedule questions
  ["I was the second in my class", null], ["I was the second in my class!", null], ["our physics class was so boring today", null],
  ["fui el segundo de mi clase", null], ["my schedule today was chaotic lol", null],
  ["which class do I have next?", 0], ["do I have classes tomorrow", 1], ["my schedule today?", 0], ["horario de mañana?", 1],
]) check(`schedule question "${q}"`, scheduleQuestionDay(q), want);

// Memory phrases
check("remember EN", rememberPhrase("remember that my rocket sim is in Python"), "my rocket sim is in Python");
check("remember ES", rememberPhrase("recuerda que mi colegio empieza a las 7:15"), "mi colegio empieza a las 7:15");
check("question is not a memory", rememberPhrase("do you remember my schedule?"), null);

// Habits
check("days EN", parseDays(["Gym", "mon", "wed", "fri"]), { days: [1, 3, 5], rest: ["Gym"] });
check("days ES", parseDays(["Leer", "martes", "jueves"]), { days: [2, 4], rest: ["Leer"] });
const t = todayISO();
const daily = { id: 1, name: "Music", days: [] };
const log = { [t]: [1], [addDaysISO(t, -1)]: [1], [addDaysISO(t, -2)]: [1] };
check("daily streak", habitStreak(daily, log), 3);
check("Tue/Thu habit not due on a Wednesday", habitDue({ id: 2, days: [2, 4] }, "2026-11-04"), false);
check("Tue/Thu habit due on a Thursday", habitDue({ id: 2, days: [2, 4] }, "2026-11-05"), true);
check("week score never above due", habitWeek(daily, log).done <= habitWeek(daily, log).due, true);

// AP Physics plan: 8 units back to back, review ends at the exam
const ap = { exam: "2027-05-05", start: "2026-11-02", created: "2026-11-02", done: [], logs: {} };
const plan = apPlan(ap);
check("AP plan has 8 units", plan.units.length, 8);
check("AP units are back to back", plan.units.every((u, i) => i === 0 || u.start === plan.units[i - 1].end), true);
check("AP review starts after unit 8", plan.reviewStart, plan.units[7].end);
check("AP summary mentions the exam", apSummary(ap).startsWith("📘 AP Physics 1:"), true);

// Classroom due dates: 23:59 Lima is 04:59 UTC the next day
check("classroom due time converted", classroomDue({ dueTime: "2026-11-07T04:59:00.000Z" }), "2026-11-06");
check("classroom date only", classroomDue({ dueDate: "2026-11-10" }), "2026-11-10");

// RSS parsing
const rss = `<rss><channel><item><title><![CDATA[Starship flies]]></title><link>https://x.test/a</link><description>Big <b>news</b></description></item></channel></rss>`;
check("rss item parsed", rssItems(rss), [{ title: "Starship flies", link: "https://x.test/a", text: "Big news", date: "" }]);

// Korean curriculum stages
check("korean lesson 1 = Hangul", koreanStage(1).startsWith("HANGUL"), true);
check("korean lesson 20 = words", koreanStage(20).startsWith("SURVIVAL WORDS"), true);
check("korean lesson 60 = grammar", koreanStage(60).startsWith("BASIC GRAMMAR"), true);

// WhatsApp noise filter
check("jajaja is noise", isNoise({ title: "Amigos", text: "jajajaja" }), true);
check("emoji-only is noise", isNoise({ title: "Amigos", text: "👍😂" }), true);
check("real message is not noise", isNoise({ title: "Mamá", text: "Hoy no puedo recogerte" }), false);

// Dates
check("monday of a Wednesday", mondayOf("2026-11-04"), "2026-11-02");
check("due tomorrow label", prettyDue(addDaysISO(todayISO(), 1)), " (due tomorrow)");

// Backups + health checks, with a fake in-memory database and no network
const store = new Map();
const env = {
  DB: {
    async get(key, type) { const v = store.get(key); return v === undefined ? null : type === "json" ? JSON.parse(v) : v; },
    async put(key, value) { store.set(key, value); },
    async delete(key) { store.delete(key); },
  },
  TELEGRAM_BOT_TOKEN: "test",
};
globalThis.fetch = async () => new Response(JSON.stringify({ ok: true, result: { pending_update_count: 0 } }));
const { exportData } = await import("../src/backup.js");
const { healthChecks, recordHeartbeat, recordGemini } = await import("../src/health.js");

store.set("todos", JSON.stringify([{ id: 1, task: "test" }]));
store.set("spotify", JSON.stringify({ refresh_token: "SECRET" }));
const backup = await exportData(env);
check("backup includes to-dos", backup.data.todos, [{ id: 1, task: "test" }]);
check("backup never includes the Spotify token", "spotify" in backup.data || JSON.stringify(backup).includes("SECRET"), false);
{
  // the app database is exported page by page, without audio
  const { exportTable, TABLE_PAGE } = await import("../src/backup.js");
  const rows = Array.from({ length: TABLE_PAGE + 5 }, (_, i) => ({ id: i + 1, at: 1, who: "me", text: `m${i + 1}` }));
  let lastSql = "";
  const FEED = { prepare(sql) { lastSql = sql; return { bind: (after, limit) => ({ all: async () => ({ results: rows.filter((r) => r.id > after).slice(0, limit) }) }) }; } };
  const p1 = await exportTable({ FEED }, "feed", 0);
  const p2 = await exportTable({ FEED }, "feed", p1.next);
  check("backup: feed in pages", [p1.rows.length, p1.next, p2.rows.length, p2.next], [TABLE_PAGE, TABLE_PAGE, 5, null]);
  check("backup: no audio blobs", /\baudio\b(?!_)/.test(lastSql), false);
  check("backup: unknown table refused", !!(await exportTable({ FEED }, "push_subs")).error, true);
  // plain-text values (chat_lang = "es") used to crash the whole backup
  store.set("chat_lang", "es");
  const withText = await exportData(env);
  check("backup: plain-text keys kept as text", [withText.data.chat_lang, withText.raw.includes("chat_lang")], ["es", true]);
  store.delete("chat_lang");
}

let checks = await healthChecks(env);
check("first day: brief not flagged yet", checks.find((c) => c.id === "brief").ok, true);
check("no backup started yet is not flagged", checks.find((c) => c.id === "backup").ok, true);
store.set("backup_started", addDaysISO(todayISO(), -3));
checks = await healthChecks(env);
check("backup started 3 days ago but never finished is flagged", checks.find((c) => c.id === "backup").ok, false);
await recordHeartbeat(env, "backup");
checks = await healthChecks(env);
check("fresh backup is OK", checks.find((c) => c.id === "backup").ok, true);
store.set("github_token_expires", new Date(Date.now() + 5 * 86400000).toISOString());
checks = await healthChecks(env);
check("token expiring in 5 days is flagged", checks.find((c) => c.id === "token").ok, false);
await recordGemini(env, "gemini-flash-lite-latest", "ok");
await recordGemini(env, "gemini-flash-lite-latest", "ok");
check("gemini usage counted", JSON.parse(store.get("gemini_usage")).models["gemini-flash-lite-latest"].ok, 2);

// To-do numbering: always 1..n in due-date order, with a permanent hidden uid
const { renumber } = await import("../src/todos.js");
const list = [
  { id: 5, task: "no date", due: null, added: "2026-11-01" },
  { id: 2, task: "friday", due: "2026-11-06", added: "2026-11-02" },
  { id: 9, task: "tomorrow", due: "2026-11-05", added: "2026-11-03", uid: "keepme1" },
];
const r1 = renumber(list);
check("to-dos renumbered 1..n by due date", r1.map((t) => `${t.id} ${t.task}`), ["1 tomorrow", "2 friday", "3 no date"]);
check("existing uid is kept", r1[0].uid, "keepme1");
check("every to-do gets a uid", r1.every((t) => /^[0-9a-f-]{8}$/.test(t.uid) || t.uid === "keepme1"), true);
const uidOfFriday = r1[1].uid;
const r2 = renumber(r1.filter((t) => t.task !== "tomorrow")); // tick off #1
check("after ticking #1 off, numbers close the gap", r2.map((t) => `${t.id} ${t.task}`), ["1 friday", "2 no date"]);
check("uid never changes when numbers do", r2[0].uid, uidOfFriday);

// Chat language detection (decided in code, so Haneul answers in the language Alex used)
const { detectLanguage } = await import("../src/chat.js");
for (const [msg, want] of [
  ["What classes do I have tomorrow?", "en"], ["¿Qué clases tengo mañana?", "es"], ["que tengo que hacer hoy", "es"],
  ["can you help me with my physics homework", "en"], ["estoy cansado, ayúdame a organizar la tarde", "es"],
  ["I'm so tired today", "en"], ["ok", null], ["👍", null], ["jajaja", null],
]) check(`language of "${msg}"`, detectLanguage(msg), want);

// Slang glosses: exactly one in every 4 English messages
const { glossInstruction } = await import("../src/chat.js");
check("gloss on the 4th message", [1, 2, 3, 4, 5, 8].map((n) => glossInstruction(n).startsWith("GLOSS: yes")), [false, false, false, true, false, true]);

// Robust JSON: the answer that crashed the Saturday Korean lesson (JSON + extra text after it)
const { parseJson } = await import("../src/gemini.js");
check("JSON with a second object after it", parseJson('{"title":"Lesson","quiz":[1,2]}\n\n{"extra": true}'), { title: "Lesson", quiz: [1, 2] });
check("JSON in a ```json fence", parseJson('```json\n[{"i":0}]\n```'), [{ i: 0 }]);
check("braces inside strings don't confuse it", parseJson('{"t":"a } b { c","n":1} trailing'), { t: "a } b { c", n: 1 });

// Haneul's answers: 1-3 short texts, plain text still works
const { readAnswer, koreanInstruction } = await import("../src/chat.js");
check("split into texts", readAnswer('{"messages":["omg","wait really?"],"remember":[]}').messages, ["omg", "wait really?"]);
check("old single-reply format still works", readAnswer('{"reply":"hey"}').messages, ["hey"]);
check("plain text fallback", readAnswer("just text").messages, ["just text"]);
check("bare list of texts (the raw-JSON bug)", readAnswer(`[\n "aww don't sweat a B too much",\n "btw in korean that's 별 (byeol), star"\n]`).messages, ["aww don't sweat a B too much", "btw in korean that's 별 (byeol), star"]);
check("never sends raw JSON", readAnswer('[{"text":"hey"}]').messages, ["hey"]);
check("korean word every 3rd message", [1, 2, 3, 6].map((n) => koreanInstruction(n, []).startsWith("KOREAN: yes")), [false, false, true, true]);

// Workout planning from the calendar
const { freeGaps, planFor, workoutStreak } = await import("../src/workout.js");
const ev = (s, e, title, tag = "ROUTINE") => ({ start: `2026-11-07T${s}:00-05:00`, end: `2026-11-07T${e}:00-05:00`, title, tag, all_day: false });
const saturday = [ev("08:00", "09:00", "Homework"), ev("12:00", "13:00", "Lunch"), ev("16:30", "20:00", "TKS", "PERSONAL")];
check("Saturday free morning → run at 09:00", planFor(saturday, "2026-11-07", 0), { start: "09:00", minutes: 30, kind: "run" });
const weekday = [ev("15:00", "16:15", "Bus"), ev("16:15", "18:00", "Homework/Physics"), ev("18:00", "18:30", "Buffer (if hw is longer)"),
  ev("18:30", "19:30", "Explore Module"), ev("19:30", "20:00", "Buffer (free time)"), ev("20:00", "21:00", "Music Time")];
check("weekday: the 18:00-18:30 buffer → 30-min session", planFor(weekday, "2026-11-09", 0), { start: "18:00", minutes: 30, kind: "strength" });
check("strength and runs alternate", planFor(weekday, "2026-11-09", 1).kind, "run");
check("Friday → no workout (rest day)", planFor([], "2026-11-06", 0), null);
check("planned at 14:00 on Saturday → skips the passed morning", planFor(saturday, "2026-11-07", 0, 14 * 60).start, "14:00");
check("planned at 20:30 → nothing left today", planFor(weekday, "2026-11-09", 0, 20 * 60 + 30), null);
check("free gaps skip busy blocks", freeGaps([ev("10:00", "11:00", "x")], "09:00", "12:00"), [[540, 600], [660, 720]]);
check("Fridays don't break the workout streak", workoutStreak({ "2026-11-05": { status: "done" }, "2026-11-07": { status: "done" } }, "2026-11-07"), 2);

// Random check-ins: inside the windows, 2 h apart, never during school/events/TKS
const { pickTimes, busyAt } = await import("../src/checkins.js");
let ok = true;
for (let i = 0; i < 200; i++) {
  const t = pickTimes(false);
  if (!t.length || t.some((m) => m < 15 * 60 + 20 || m > 20 * 60 + 10) || (t.length === 2 && t[1] - t[0] < 120)) ok = false;
}
check("weekday check-ins only 15:20-20:10, 2 h apart", ok, true);
check("busy during school", busyAt([ev("07:15", "15:00", "School")], 10 * 60), true);
check("busy during a TKS session", busyAt(saturday, 17 * 60), true);
check("free during lunch routine", busyAt(saturday, 12 * 60 + 30), false);

// Reading: chapter from a reply
const { chapterFrom, readingStreak } = await import("../src/reading.js");
check("chapter from replies", ["chapter 5", "cap 3", "capítulo 12", "7", "ch. 2 loved it"].map(chapterFrom), [5, 3, 12, 7, 2]);
check("no chapter in random text", chapterFrom("idk yet"), null);
check("reading streak", readingStreak({ "2026-11-06": {}, "2026-11-07": {} }, "2026-11-07"), 2);

// Homework tutor buttons: next hint while hints remain; the solution only after the last hint
const { tutorButtonsForTest } = await import("../src/tutor.js");
const labels = (t) => tutorButtonsForTest(t).inline_keyboard.flat().map((b) => b.callback_data);
check("tutor: first hint → next + check, no solution", labels({ hints: [1, 2, 3, 4], shown: 1 }), ["tu:next", "tu:check"]);
check("tutor: after last hint → check + solution", labels({ hints: [1, 2, 3, 4], shown: 4 }), ["tu:check", "tu:solution"]);

// Auto-memory: saves new facts, skips ones already known (even with different accents/case)
const { rememberMany, memoryText } = await import("../src/memory.js");
store.delete("memory");
const first = await rememberMany(env, ["Alex got a 95 on the precalc test", "Alex loves Nova Lights"], "chat");
check("auto-memory saves new facts", first.length, 2);
const again = await rememberMany(env, ["alex got a 95 on the precalc test!", "Alex loves Nova Lights", "Alex is nervous about the TKS demo"], "chat");
check("auto-memory skips facts it already has", again.map((f) => f.text), ["Alex is nervous about the TKS demo"]);
check("memory in the prompt shows dates", /^- \([A-Z][a-z]{2} \d{1,2}\) Alex got a 95/.test(await memoryText(env)), true);

// Slack: sorting notifications
const { classify, isSlackNoise, onSlackBatch } = await import("../src/slack.js");
const c = (title, text) => classify({ title, text });
check("VIP channel", c("#cohort-general", "Ana: reminder, demo friday").vip, true);
check("DM is VIP", (({ dm, vip }) => [dm, vip])(c("Sofia Chen", "hey are u free tmrw?")), [true, true]);
check("Jordan anywhere is VIP", c("#general", "Jordan Lee: quick update").vip, true);
check("builders channel", (({ vip, builders }) => [vip, builders])(c("#builders-feedback", "Raj: I built a CubeSat sim")), [false, true]);
check("thread reply", c("Thread in #i-ml-life", "Leo replied: same!").thread, true);
check("ordinary channel", (({ vip, builders }) => [vip, builders])(c("#random", "Kai: lol")), [false, false]);
check("summary notification is noise", isSlackNoise({ title: "Slack", text: "5 new messages" }), true);
store.delete("slack_log");
await onSlackBatch([{ title: "#random", text: "Kai: hi" }, { title: "#random", text: "Kai: hi" }, { title: "Slack", text: "3 new messages" }], env);
check("slack: duplicates and noise dropped", JSON.parse(store.get("slack_log")).length, 1);

// Emoji limit (enforced in code)
const { limitEmojis } = await import("../src/chat.js");
check("keeps only the first emoji", limitEmojis(["omg yesss 😭🎉", "so proud ✨🫶"], 1), ["omg yesss 😭", "so proud"]);
check("zero emojis", limitEmojis(["captain 🚀 let's go 🔥", "ok 👍"], 0), ["captain let's go", "ok"]);
check("joined emojis count as one", limitEmojis(["hi 👨‍🚀 there 🇰🇷"], 1), ["hi 👨‍🚀 there"]);
check("plain text untouched", limitEmojis(["no bc that's so real, idk"], 1), ["no bc that's so real, idk"]);
check("emoji-only text is dropped", limitEmojis(["nice", "🎉🎉"], 0), ["nice"]);

// Slang safety net: filler slang at the end of sentences
const { limitTailSlang } = await import("../src/chat.js");
check("the screenshot case", limitTailSlang(["it's basically this massive, gorgeous stellar nursery where new stars are getting born ngl", "jwst took some insane pics of it recently, the cosmic cliffs look so surreal fr"]),
  ["it's basically this massive, gorgeous stellar nursery where new stars are getting born ngl", "jwst took some insane pics of it recently, the cosmic cliffs look so surreal"]);
check("slang at the start is fine", limitTailSlang(["ngl i forgot", "tbh the first one was better"]), ["ngl i forgot", "tbh the first one was better"]);
check("two tails in one text", limitTailSlang(["i need sleep fr. this is so real tbh!"]), ["i need sleep fr. this is so real!"]);
check("words containing fr are safe", limitTailSlang(["got it from friday", "ok fr"]), ["got it from friday", "ok fr"]);

// Hiccups: Telegram / Gemini sending an error page instead of JSON (the "error code: 504" crash)
{
  const { tg, HiccupError } = await import("../src/telegram.js");
  const { gemini } = await import("../src/gemini.js");
  const saved = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => (++calls === 1 ? new Response("error code: 504", { status: 504 }) : new Response(JSON.stringify({ ok: true, result: { file_path: "x.jpg" } })));
  check("Telegram 504 page → retried, then works", (await tg({ TELEGRAM_BOT_TOKEN: "t" }, "getFile", {})).file_path, "x.jpg");
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: false, description: "Bad Request: chat not found" }), { status: 400 });
  let err;
  try { await tg({ TELEGRAM_BOT_TOKEN: "t" }, "sendMessage", {}); } catch (e) { err = e; }
  check("a real Telegram error isn't retried or hidden", [err instanceof HiccupError, /chat not found/.test(err?.message)], [false, true]);
  calls = 0;
  globalThis.fetch = async (url) => {
    calls++;
    if (String(url).includes("model-a")) return new Response("error code: 504", { status: 200 }); // garbage with 200
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "hello" }] } }] }));
  };
  check("Gemini garbage answer → next model", await gemini({ DB: env.DB }, [{ role: "user", parts: [{ text: "hi" }] }], { models: ["model-a", "model-b"] }), "hello");
  globalThis.fetch = saved;
}

// Notion helpers
const { pageIdFrom, paragraphs } = await import("../src/notion.js");
check("page id from a Notion link", pageIdFrom("https://www.notion.so/Haneul-2a1b3c4d5e6f47a8b9c0d1e2f3a4b5c6?pvs=4"), "2a1b3c4d-5e6f-47a8-b9c0-d1e2f3a4b5c6");
check("page id from a dashed id", pageIdFrom("2a1b3c4d-5e6f-47a8-b9c0-d1e2f3a4b5c6"), "2a1b3c4d-5e6f-47a8-b9c0-d1e2f3a4b5c6");
check("bad link → null", pageIdFrom("https://notion.so/nothing"), null);
check("long text split into Notion-sized paragraphs", paragraphs(`a\n\n${"x".repeat(4000)}`).map((b) => b.paragraph.rich_text[0].text.content.length), [1, 1900, 1900, 200]);

// Two-way memory sync with a fake Notion
{
  const saved = globalThis.fetch;
  const page = "2a1b3c4d5e6f47a8b9c0d1e2f3a4b5c6";
  const nenv = { ...env, NOTION_TOKEN: "ntn_test", NOTION_PAGE: `https://www.notion.so/Haneul-${page}` };
  const dashed = "2a1b3c4d-5e6f-47a8-b9c0-d1e2f3a4b5c6";
  store.set("notion", JSON.stringify({ parent: dashed, tks: "t", ideas: "i", reading: "r", journal: "j", drafts: "d", memory: "m", diary: "y" }));
  store.set("memory", JSON.stringify([
    { id: 1, text: "Alex likes Nova Lights", date: "2026-11-01", source: "chat", np: "aaa" },
    { id: 2, text: "Alex plays piano", date: "2026-11-02", source: "chat", np: "bbb" },
    { id: 3, text: "Alex has a TKS demo", date: "2026-11-03", source: "chat" },
  ]));
  let created = 0;
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    const title = (t) => ({ Name: { type: "title", title: [{ plain_text: t }] }, Date: { date: { start: "2026-11-05" } } });
    if (u.endsWith("/databases/m/query")) return new Response(JSON.stringify({ results: [
      { id: "aaa", properties: title("Alex loves Nova Lights and Echo Park") }, // edited in Notion
      { id: "ddd", properties: title("Alex's favorite food is ceviche") }, // added by Alex
    ], has_more: false })); // "bbb" was deleted in Notion
    if (u.endsWith("/pages") && opts.method === "POST") return new Response(JSON.stringify({ id: `new${++created}` }));
    return new Response(JSON.stringify({}));
  };
  const { syncMemoryWithNotion } = await import("../src/memory.js");
  const r = await syncMemoryWithNotion(nenv);
  const after = JSON.parse(store.get("memory")).map((f) => f.text);
  check("sync result", r, { removed: 1, edited: 1, added: 1, uploaded: 1, duplicates: 0 });
  check("memory after sync", after, ["Alex loves Nova Lights and Echo Park", "Alex has a TKS demo", "Alex's favorite food is ceviche"]);
  globalThis.fetch = saved;
}

// TKS notes: a list of dates isn't a note
{
  const { realWords, MIN_TKS_WORDS } = await import("../src/notion.js");
  const dates = ["November 2026", ...Array.from({ length: 30 }, (_, i) => `• 2026-11-${String(i + 1).padStart(2, "0")}`)].join(`\n`);
  check("a list of dates has no real words", realWords(dates) < MIN_TKS_WORDS, true);
  const notes = "Mindset of the week: first principles thinking. Jordan explained that most people reason by analogy, copying what others do, while first principles means breaking a problem down to the basic truths and building up from there. Example: battery costs and SpaceX rockets. Action: apply it to my landing sim.";
  check("real session notes pass", realWords(notes) >= MIN_TKS_WORDS, true);
}

// Commands without a slash: only when the message is clearly just the command
{
  const { commandOf } = await import("../src/router.js");
  const c = (t) => commandOf(t).cmd;
  for (const [msg, want] of [
    ["Today our director told us his life story!", ""],
    ["today", "/today"], ["Today?", "/today"], ["tomorrow", "/tomorrow"], ["/today", "/today"],
    ["todos", "/todos"], ["todos en el cohort estaban felices", ""],
    ["done 3", "/done"], ["done 3 5", "/done"], ["done with physics for today!", ""],
    ["ap 45 kinematics", "/ap"], ["ap plan", "/ap"], ["ap physics is so hard", ""],
    ["idea: rocket landing app", "/note"], ["idea for TKS maybe later", ""],
    ["event: dentist friday 3pm", "/event"], ["evento genial hoy", ""], ["add event meeting with Jordan friday 5pm", "/event"],
    ["add Physics lab report friday", "/add"], ["help", "/help"], ["help me with my essay", ""],
    ["Velocity was amazing! It's a whole new level", ""],
  ]) check(`command of "${msg}"`, c(msg), want);
  check("idea text kept", commandOf("idea: rocket landing app").arg, "rocket landing app");
  check("event text kept", commandOf("add event meeting with Jordan friday 5pm").arg, "meeting with Jordan friday 5pm");
}

// Memory: the same fact in other words is a duplicate; different facts aren't
{
  const { sameFact, dedupeMemory, rememberMany } = await import("../src/memory.js");
  check("reworded fact is the same (screenshot)", sameFact("Alex shared that Jensen Huang founded Nvidia in 1993", "Alex told Haneul that Jensen Huang founded Nvidia in 1993"), true);
  check("braindate wording variants", sameFact("Alex had a braindate with Sam about rockets", "Alex finished his braindate with Sam about rockets"), true);
  check("different facts stay separate", sameFact("Alex had a braindate with Sam", "Alex loves the song Paper Planes by The Satellites"), false);
  store.delete("notion");
  store.set("memory", JSON.stringify([
    { id: 1, text: "Alex's favorite song by The Satellites is Paper Planes", date: "2026-11-08" },
    { id: 2, text: "Alex loves the song Paper Planes by The Satellites", date: "2026-11-08" },
    { id: 3, text: "Alex is reading Start With Why", date: "2026-11-08" },
  ]));
  check("cleanup removes the reworded duplicate", await dedupeMemory(env), 1);
  check("cleanup keeps the different fact", JSON.parse(store.get("memory")).length, 2);
  const saved = await rememberMany(env, ["Alex told Haneul he is reading Start With Why"], "chat");
  check("a new rewording isn't saved again", saved.length, 0);
}

// Haneul's actions are read from her answer
{
  const { readAnswer } = await import("../src/chat.js");
  const a = readAnswer('{"messages":["on it"],"actions":{"add_todos":[{"task":"TKS: feedback on Maya article","due":null}],"complete_todos":["3"],"add_event":"","search":""}}').actions;
  check("actions: add + complete", [a.add_todos.length, a.complete_todos], [1, [3]]);
  check("no actions → empty", readAnswer('{"messages":["hey"]}').actions, { add_todos: [], complete_todos: [], add_event: "", search: "", call: null, music: "", add_work: [], bible: [], course_done: [], social_posted: [], phone_unlock: null });
}

// Weekend brief: starts inside a window (the timer runs every 5 min, 7:58 never matched)
{
  const { briefTime } = await import("../src/reminders.js");
  const t = briefTime("Sun");
  const due = (h, m) => h * 60 + m >= t.hour * 60 + t.minute && h * 60 + m < t.hour * 60 + t.minute + 60;
  check("Sunday brief starts at 7:55 or 8:00", [due(7, 50), due(7, 55), due(8, 0)], [false, true, true]);
}

// Sync: an extra Notion row with the same fact is deleted, not imported again (the duplicate bug)
{
  const saved = globalThis.fetch;
  const nenv = { ...env, NOTION_TOKEN: "ntn_test", NOTION_PAGE: "https://www.notion.so/Haneul-2a1b3c4d5e6f47a8b9c0d1e2f3a4b5c6" };
  store.set("notion", JSON.stringify({ parent: "2a1b3c4d-5e6f-47a8-b9c0-d1e2f3a4b5c6", tks: "t", ideas: "i", reading: "r", journal: "j", drafts: "d", memory: "m", diary: "y" }));
  store.set("memory", JSON.stringify([{ id: 17, text: "Alex shared that Jensen Huang visited Taipei", date: "2026-11-09", source: "chat", np: "row1" }]));
  const archived = [];
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    const title = (t) => ({ Name: { type: "title", title: [{ plain_text: t }] }, Date: { date: { start: "2026-11-09" } } });
    if (u.endsWith("/databases/m/query")) return new Response(JSON.stringify({ results: [
      { id: "row1", properties: title("Alex shared that Jensen Huang visited Taipei") },
      { id: "row2", properties: title("Alex shared that Jensen Huang visited Taipei") }, // orphan copy
    ], has_more: false }));
    if (opts.method === "PATCH") archived.push(u.split("/").pop());
    return new Response(JSON.stringify({}));
  };
  const { syncMemoryWithNotion } = await import("../src/memory.js");
  const r = await syncMemoryWithNotion(nenv);
  check("orphan copy not imported", JSON.parse(store.get("memory")).length, 1);
  check("orphan row deleted in Notion", [r.duplicates, archived], [1, ["row2"]]);
  globalThis.fetch = saved;
}

// Haneul app: login with a Telegram code, commands answer into the app (not Telegram), call tools
{
  const saved = globalThis.fetch;
  const telegram = [];
  globalThis.fetch = async (url, opts = {}) => {
    if (String(url).includes("api.telegram.org")) telegram.push(JSON.parse(opts.body || "{}"));
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }));
  };
  const { appRoutes } = await import("../src/app.js");
  const call = async (path, body, token) => {
    const req = new Request(`https://x.dev${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const res = await appRoutes(req, env, new URL(req.url));
    return { status: res.status, data: await res.json().catch(() => null) };
  };
  check("app: api needs login", (await call("/app/api/send", { text: "hi" })).status, 401);
  check("app: icon served", (await appRoutes(new Request("https://x.dev/app/icon-192.png"), env, new URL("https://x.dev/app/icon-192.png"))).headers.get("Content-Type"), "image/png");
  await call("/app/api/login/start", {});
  const code = telegram.at(-1).text.match(/\d{6}/)[0];
  check("app: wrong code refused", (await call("/app/api/login", { code: code === "000000" ? "111111" : "000000" })).status, 400);
  const { data } = await call("/app/api/login", { code, device: "test" });
  check("app: right code gives a session", typeof data.token === "string" && data.token.length > 60, true);
  const before = telegram.length;
  store.set("todos", JSON.stringify([{ id: 1, uid: "a", task: "Physics lab", due: null }]));
  const todos = await call("/app/api/send", { text: "/todos" }, data.token);
  check("app: /todos answered in the app", /Physics lab/.test(todos.data.messages.map((m) => m.text).join(" ")), true);
  check("app: nothing sent to Telegram", telegram.length - before, 0);
  const { callTool } = await import("../src/app.js");
  const r = await callTool(env, "add_todos", { tasks: [{ task: "Buy milk", due: "" }] });
  check("call tool: to-do added", /Buy milk/.test(r.result) && JSON.parse(store.get("todos")).some((t) => t.task === "Buy milk"), true);
  const list = await callTool(env, "list_todos", {});
  check("call tool: list", /Physics lab/.test(list.result) && /Buy milk/.test(list.result), true);
  const { history } = await import("../src/app.js");
  store.set("chat", JSON.stringify([
    { role: "user", parts: [{ text: "hi" }] },
    { role: "model", parts: [{ text: "hey!" }] },
    { role: "user", parts: [{ text: "(Voice call in the Haneul app at 19:42, 4:12. What we talked about: plank challenge.)" }] },
    { role: "model", parts: [{ text: "(that was our call)" }] },
  ]));
  check("app: a call shows as one note", (await history(env)).map((m) => `${m.who}:${m.text}`), ["me:hi", "her:hey!", "note:📞 Call · 4:12 · 19:42"]);
  globalThis.fetch = saved;
}

// Broken JSON from Gemini never reaches Alex (seen 2026-11-10: ="text" inside the messages list)
{
  const { readAnswer: ra, brokenAnswer } = await import("../src/chat.js");
  const seen = `{
 "messages": [
 ="yesss it's actually so good",
 ="btw in korean that's 노래 (norae), song"
 ],
 "remember": [
 "Alex connected his Spotify account to Haneul on November 10, 2026."
 ],
 "korean": "노래 (norae) = song",
 "actions": {
 "add_todos": [],
 "complete_todos": [],
 "add_event": "",
 "search": ""
 }
}`;
  const a = ra(seen);
  check("broken JSON: repaired", [a.messages, a.korean, a.remember.length], [["yesss it's actually so good", "btw in korean that's 노래 (norae), song"], "노래 (norae) = song", 1]);
  const b = ra('{"messages": ["hey there", "second one"], "remember": [oops not json], "korean": ""}');
  check("hopeless JSON: texts salvaged", [b.messages, !!b.broken], [["hey there", "second one"], false]);
  check("nothing to salvage → broken (asked again)", !!brokenAnswer('{"mess').broken, true);
  check("plain text answer still works", ra("just a normal reply").messages, ["just a normal reply"]);
}

// TKS mentor outreach: next moves (ported from Mentor Radar) and the approval-only send
{
  const { nextMove, score, approveDraft, overviewText } = await import("../src/outreach.js");
  const T = "2026-11-20";
  const mv = (c) => nextMove({ fit: 3, followUps: 0, ...c }, 7, T);
  check("outreach: unverified research → confirm first", mv({ stage: "research", emailQuality: "unverified" }).t, "Confirm the person and address, then draft");
  check("outreach: wrong address → find the right person", mv({ stage: "research", emailQuality: "wrong" }).t, "Find the right person or address");
  check("outreach: sent 3 days ago → wait", [mv({ stage: "sent", lastContact: "2026-11-17" }).wait, mv({ stage: "sent", lastContact: "2026-11-17" }).t], [true, "Wait. Follow up in 4d"]);
  check("outreach: sent 8 days ago → follow-up due", [mv({ stage: "sent", lastContact: "2026-11-12" }).due, mv({ stage: "sent", lastContact: "2026-11-12" }).kind], [true, "followup"]);
  check("outreach: 2 follow-ups, 21+ days → close", mv({ stage: "sent", lastContact: "2026-10-30", followUps: 2 }).t, "No reply after 2 follow-ups. Close or try another channel");
  check("outreach: replied → answer within a day", [mv({ stage: "replied" }).due, mv({ stage: "replied" }).w], [true, 90]);
  check("outreach: mentor 31 days → monthly update", mv({ stage: "mentor", lastContact: "2026-10-20" }).kind, "monthly");
  check("outreach: a reply outranks a follow-up", score({ stage: "replied", fit: 3 }) > score({ stage: "sent", fit: 3, lastContact: "2026-10-01" }), true);
  check("outreach: overview line", overviewText([{ stage: "replied", move: { due: true } }, { stage: "sent", move: { due: false } }, { stage: "research", move: {} }]), "1 due · 1 to research · 1 reply to answer · 1 waiting on them");
  // approving needs a real address; nothing is sent here (sending only happens in the cron, for approved rows)
  const FEED = { prepare: () => ({ bind: () => ({ first: async () => ({ id: 1, status: "draft", contact_id: "x" }), run: async () => ({}) }) }) };
  check("outreach: bad address refused", (await approveDraft({ FEED }, 1, { to: "not an email", subject: "Hi", body: "Hello" })).error, "that email address doesn't look right");
  check("outreach: empty text refused", (await approveDraft({ FEED }, 1, { to: "a@b.com", subject: "", body: "" })).error, "subject and text can't be empty");
}

// The worker's own routes really run (a missing import once crashed /outreach-brief in production)
{
  const authed = (path) => new Request(`https://x.dev${path}`, { headers: { Authorization: `Bearer ${env.WORKER_SECRET}` } });
  for (const path of ["/outreach-brief", "/backup", "/backup-table?table=feed"]) {
    let status;
    try { status = (await index.default.fetch(authed(path), env)).status; } catch (err) { status = `crash: ${err.message}`; }
    check(`route ${path} answers`, status, 200);
  }
}

// Velocity tasks go into free calendar spots, not all-day events
{
  const { placeTasks } = await import("../src/slots.js");
  const day = (iso, list) => list.map(([s, e, title]) => ({ start: `${iso}T${s}:00-05:00`, end: `${iso}T${e}:00-05:00`, title, all_day: false }));
  const mon = "2026-11-09";
  const tue = "2026-11-10";
  const cal = {
    [mon]: day(mon, [["15:00", "16:15", "Bus"], ["16:15", "18:00", "Homework"], ["19:15", "19:45", "Call"], ["20:00", "21:00", "Music"]]),
    [tue]: day(tue, [["15:00", "16:15", "Bus"], ["16:15", "18:00", "Homework"], ["18:00", "21:00", "Busy"]]),
  };
  const eventsOn = (iso) => cal[iso] || null;
  const out = placeTasks(
    [
      { task: "Plank day 1", due: mon, minutes: 10 },
      { task: "Courage sprint", due: mon, minutes: 30 },
      { task: "Squad sync", due: tue, time: "19:00", minutes: 30 },
      { task: "Reflection", due: tue, minutes: 30 },
      { task: "Plank day 4", due: "2026-11-12", minutes: 10 },
      { task: "No date" },
    ],
    { today: mon, nowMin: 9 * 60, eventsOn }
  );
  check("slot: first free gap after homework", out[0].start, `${mon}T18:00:00-05:00`);
  check("slot: next task after the first", out[1].start, `${mon}T18:10:00-05:00`);
  check("slot: fixed time kept", out[2].start, `${tue}T19:00:00-05:00`);
  check("slot: full day → day before", out[3].start.slice(0, 10), mon);
  check("slot: unsynced day → default time", out[4].start, "2026-11-12T18:00:00-05:00");
  check("slot: no date skipped", !!out[5].skip, true);
  const late = placeTasks([{ task: "x", due: mon, minutes: 30 }], { today: mon, nowMin: 20 * 60 + 40, eventsOn });
  check("slot: nothing left today → no event (to-do only)", !!late[0].noSlot, true);
  const daily = placeTasks([{ task: "Plank Day 2", due: tue, minutes: 20 }], { today: mon, nowMin: 9 * 60, eventsOn });
  check("slot: daily task never moves to another day", !!daily[0].noSlot, true);
}

// GitHub workflow files must be valid YAML with a workflow_dispatch trigger,
// because the bot starts every job with workflow_dispatch.
const { readdirSync, readFileSync } = await import("node:fs");
const { parseDocument } = await import("yaml");
const wfDir = new URL("../../.github/workflows/", import.meta.url);
for (const f of readdirSync(wfDir).filter((x) => x.endsWith(".yml"))) {
  const doc = parseDocument(readFileSync(new URL(f, wfDir), "utf8"));
  check(`workflow ${f} is valid YAML`, doc.errors.map((e) => e.message.split("\n")[0]), []);
  check(`workflow ${f} can be started by the bot`, Boolean(doc.toJS()?.on && "workflow_dispatch" in doc.toJS().on), true);
}

// Velocity: a copy of the same challenge (reworded by the AI) isn't added twice (Nov 13 duplicates)
{
  const { sameTask } = await import("../src/velocity.js");
  const pairs = [
    ["Velocity: Complete Day 4 of the 5-Day Plank Challenge", "Perform Day 4 of the 5-Day Plank Challenge", true],
    ["Velocity: Complete Mindset Challenge - Courage Sprint", "Complete the Mindset Challenge - Courage Sprint", true],
    ["Velocity: Conduct Weekly Squad Sync", "Set up and run the Weekly Squad Sync", true],
    ["Velocity: Complete Training: Professional Meetings", "Complete Training: Professional Meetings", true],
    ["Velocity: Complete Day 4 of the 5-Day Plank Challenge", "Perform Day 5 of the 5-Day Plank Challenge", false],
    ["Velocity: Conduct Weekly Squad Sync", "Review the Velocity Reference Guide and Requirements", false],
  ];
  for (const [a, b, want] of pairs) check(`velocity same task: "${b}"`, sameTask(a, b), want);
}

// No hidden control characters in the code (a shell patch once turned \\b into a backspace, so the
// lyrics check never matched)
{
  const { readdirSync: rd, readFileSync: rf } = await import("node:fs");
  const bad = [];
  for (const f of [...rd(new URL("../src/", import.meta.url)).map((x) => `../src/${x}`), "../app/index.html"]) {
    const lines = rf(new URL(f, import.meta.url), "utf8").split("\n");
    lines.forEach((line, i) => { if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(line.replace(/\r$/, ""))) bad.push(`${f}:${i + 1}`); });
  }
  check("no control characters in the source", bad, []);
  const { readFileSync: rf2 } = await import("node:fs");
  const chatSrc = rf2(new URL("../src/chat.js", import.meta.url), "utf8");
  check("lyrics link only when he asks for a link", /link\|enlace/.test(chatSrc), true);
}

// Weekly music recap: top songs/artists, new artists, busiest day
{
  const { weekStats } = await import("../src/listening.js");
  const end = Date.parse("2026-11-15T23:00:00Z"); // Sunday 18:00 Lima
  const at = (iso) => Date.parse(iso);
  const rows = [
    { at: at("2026-11-13T23:00:00Z"), track: "Starlight", artist: "Nova Lights", track_id: "a" },
    { at: at("2026-11-13T23:05:00Z"), track: "Starlight", artist: "Nova Lights", track_id: "a" },
    { at: at("2026-11-13T23:10:00Z"), track: "Starlight", artist: "Nova Lights", track_id: "a" },
    { at: at("2026-11-12T22:00:00Z"), track: "Echoes", artist: "Mira", track_id: "b" },
    { at: at("2026-11-14T04:30:00Z"), track: "Orbit", artist: "The Satellites", track_id: "c" }, // 23:30 Lima: late
  ];
  const FEED = { prepare: (sql) => ({ bind: () => ({
    all: async () => ({ results: /DISTINCT artist/.test(sql) ? [{ artist: "Mira" }] : rows }),
    first: async () => (/MIN\(at\)/.test(sql) ? { first: end - 30 * 86400000 } : { n: 2 }),
  }) }) };
  const s = await weekStats({ FEED }, end);
  check("wrapped: plays", s.plays, 5);
  check("wrapped: top song", [s.songs[0].track, s.songs[0].n], ["Starlight", 3]);
  check("wrapped: top artist", s.artists[0].artist, "Nova Lights");
  check("wrapped: new artists (Mira was heard before)", s.newArtists.map((a) => a.artist), ["Nova Lights", "The Satellites"]);
  check("wrapped: busiest day", s.busiest.day, "Friday");
  check("wrapped: late-night songs", s.late, 1);
  const young = { prepare: (sql) => ({ bind: () => ({ all: async () => ({ results: /DISTINCT artist/.test(sql) ? [] : rows }), first: async () => (/MIN\(at\)/.test(sql) ? { first: end - 3 * 86400000 } : { n: 0 }) }) }) };
  check("wrapped: no 'new artists' without a week of earlier history", (await weekStats({ FEED: young }, end)).newArtists, []);
}

// TKS questions in chat make her read his newest TKS note in Notion
{
  const { ASKS_TKS, tksNoteFor } = await import("../src/chat.js");
  for (const q of ["what was this tks session's mindset?", "what did jordan say today", "cuál fue el mindset de la sesión?", "what's in my notes from cohort"]) check(`tks question: ${q}`, ASKS_TKS.test(q), true);
  for (const q of ["what time is it", "add it to my calendar pls", "play some music"]) check(`not a tks question: ${q}`, ASKS_TKS.test(q), false);
  check("tks note: nothing without Notion", await tksNoteFor({}, "what was the tks mindset?"), "");
}

// Outreach channels: email > booking link > LinkedIn; only emails are ever sent by Haneul
{
  const { channelOf, dayStart } = await import("../src/outreach.js");
  check("channel: email", channelOf({ email: "a@b.com", emailQuality: "verified", meeting: "https://calendly.com/x" }), "email");
  check("channel: wrong email -> booking", channelOf({ email: "a@b.com", emailQuality: "wrong", meeting: "https://calendly.com/x" }), "meeting");
  check("channel: linkedin", channelOf({ linkedin: "https://www.linkedin.com/in/x" }), "linkedin");
  check("channel: none", channelOf({ meeting: "[pausing for the next month]" }), "none");
  check("day starts at Lima midnight", new Date(dayStart("2026-11-16")).toISOString(), "2026-11-16T05:00:00.000Z");
}

// His work list: feeds, chat, dedupe
{
  const { feedItems, toFeedUrl, addWork, getWork } = await import("../src/work.js");
  const xml = '<rss><channel><title>x</title><item><title><![CDATA[How I filtered EEG blinks]]></title><link>https://example.substack.com/p/eeg</link><pubDate>Mon, 16 Nov 2026 17:57:18 GMT</pubDate></item></channel></rss>';
  check("feed: items", feedItems(xml), [{ title: "How I filtered EEG blinks", url: "https://example.substack.com/p/eeg", date: "2026-11-16" }]);
  check("feed: medium username", toFeedUrl("@alexrivera"), "https://medium.com/feed/@alexrivera");
  check("feed: medium profile link", toFeedUrl("https://medium.com/@alexrivera"), "https://medium.com/feed/@alexrivera");
  check("feed: substack link", toFeedUrl("https://foo.substack.com/p/x"), "https://foo.substack.com/feed");
  const kv = new Map();
  const env = { DB: { async get(k, ty) { const v = kv.get(k); return v === undefined ? null : ty === "json" ? JSON.parse(v) : v; }, async put(k, v) { kv.set(k, v); }, async delete(k) { kv.delete(k); } } };
  await addWork(env, [{ kind: "project", title: "EEG BCI project", note: "blink detection", status: "in progress" }], "test");
  await addWork(env, [{ kind: "project", title: "eeg bci project!", status: "done" }], "test");
  const w = await getWork(env);
  check("work: same title updates, not duplicates", [w.length, w[0].status], [1, "done"]);
}

// Bible sheet (Monthly) + phone focus
{
  const { dayFields, logBible, getBible, bibleStreak, bibleCsv } = await import("../src/bible.js");
  const { phoneCheck, phoneUnlock } = await import("../src/phone.js");
  check("bible: Sunday has culto + virtual + oré", [dayFields("2026-11-15").ore, !!dayFields("2026-11-15").culto, dayFields("2026-11-15").virtual], [true, true, true]);
  check("bible: Tuesday has «la oración», no oré", [dayFields("2026-11-17").ore, dayFields("2026-11-17").oracion], [false, true]);
  check("bible: Saturday cultos", dayFields("2026-11-21").culto, ["1:00 p. m.", "3:00 p. m.", "5:00 p. m.", "7:00 p. m."]);
  const kv = new Map();
  const env = { DB: { async get(k, ty) { const v = kv.get(k); return v === undefined ? null : ty === "json" ? JSON.parse(v) : v; }, async put(k, v) { kv.set(k, v); }, async delete(k) { kv.delete(k); } } };
  await logBible(env, [{ date: "2026-11-15", lei: "Juan 3", ore: "15", culto_modo: "virtual", culto_hora: "9:30 a. m." }]);
  await logBible(env, [{ date: "2026-11-15", por_que_virtual: "estaba enfermo" }, { date: "2026-11-16", lei: "Salmos 23" }]);
  const log = await getBible(env);
  check("bible: merge keeps earlier fields", log["2026-11-15"], { ore: 15, lei: "Juan 3", culto_modo: "conecté", culto_hora: "9:30 a. m.", por_que_virtual: "estaba enfermo" });
  check("bible: streak", bibleStreak(log, "2026-11-16"), 2);
  check("bible: streak counts from yesterday when today is empty", bibleStreak(log, "2026-11-17"), 2);
  const csv = bibleCsv({ month: "2026-11", entries: log }).split("\r\n");
  check("bible: csv has a row per day", csv.length, 31);
  check("bible: csv row", csv[15], "2026-11-15,Domingo,Juan 3,15,,,,,conecté,9:30 a. m.,estaba enfermo");
  check("phone: blocked by default", await phoneCheck(env, "Instagram"), "block");
  await phoneUnlock(env, { app: "instagram", minutes: 999, reason: "school group" });
  check("phone: unlock is capped at 30 min", Math.round(((await env.DB.get("phone_unlock", "json")).until - Date.now()) / 60000), 30);
  check("phone: unlocked app opens", await phoneCheck(env, "Instagram"), "ok");
  check("phone: other apps stay blocked", await phoneCheck(env, "TikTok"), "block");
}

// Action notes in her texts become real actions; course plan; SAT answers
{
  const { salvageActionNotes } = await import("../src/chat.js");
  const a = salvageActionNotes({ messages: ["on it", "queueing up some lofi (put on music: chill lofi beats)"], actions: { music: "" }, react: "" }, "");
  check("notes: music note becomes the action", [a.messages, a.actions.music], [["on it", "queueing up some lofi"], "chill lofi beats"]);
  const b = salvageActionNotes({ messages: ["finish that build (react: 🔥)"], actions: { music: "" }, react: "" }, "");
  check("notes: react note becomes a reaction", [b.messages, b.react], [["finish that build"], "🔥"]);
  const d = salvageActionNotes({ messages: ["the eclipse (2024) was wild"], actions: { music: "" }, react: "" }, "");
  check("notes: normal parentheses stay", d.messages, ["the eclipse (2024) was wild"]);
  const e2 = salvageActionNotes({ messages: ["let me check today's calendar for u", "[app: search calendar]"], actions: { music: "" }, react: "" }, "");
  check("notes: any [app: …] note is cut", e2.messages, ["let me check today's calendar for u"]);

  const { coursePlan, importCourse, markCourse, getCourse } = await import("../src/course.js");
  const kv = new Map();
  const env = { DB: { async get(k, ty) { const v = kv.get(k); return v === undefined ? null : ty === "json" ? JSON.parse(v) : v; }, async put(k, v) { kv.set(k, v); }, async delete(k) { kv.delete(k); } } };
  const tasks = Array.from({ length: 20 }, (_, i) => ({ title: `Task ${i + 1}`, kind: "lesson", min: 60 }));
  await importCourse(env, { name: "x", deadline: "2026-12-31", tasks });
  const c = await getCourse(env);
  const p = coursePlan({ ...c, created: "2026-11-17" }, "2026-11-17", 10);
  const all = p.days.flatMap((d) => d.tasks.map((t) => t.id));
  check("course: every task is planned once, in order", all, c.tasks.map((t) => t.id));
  check("course: nothing planned after Dec 29 or on Christmas", p.days.some((d) => d.date > "2026-12-29" || d.date.endsWith("12-24") || d.date.endsWith("12-25")), false);
  check("course: mark by id", (await markCourse(env, ["p1"])).map((t) => t.id), ["p1"]);
  check("course: mark by title words", (await markCourse(env, ["task 2"])).map((t) => t.id), ["p2"]);

  const { answerSat } = await import("../src/daily.js");
  kv.set("sat", JSON.stringify({ n: 1, total: 0, correct: 0, recent: [], skills: {}, current: { n: 1, skill: "percentages", answer: 2, options: ["a", "b", "c", "d"], explanation: "because" } }));
  const sent = [];
  const tgEnv = { ...env, TELEGRAM_BOT_TOKEN: "x", TELEGRAM_CHAT_ID: "1" };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, o) => { if (String(url).includes("telegram")) { sent.push(JSON.parse(o.body).text); return new Response('{"ok":true,"result":{"message_id":1}}'); } return realFetch(url, o); };
  await answerSat(tgEnv, null, "sat:1:2");
  await answerSat(tgEnv, null, "sat:1:0");
  globalThis.fetch = realFetch;
  const s = JSON.parse(kv.get("sat"));
  check("sat: right answer counted once", [s.total, s.correct, s.skills.percentages], [1, 1, { tries: 1, right: 1 }]);
  check("sat: second tap is refused", sent.filter(Boolean)[1]?.startsWith("You already answered"), true);
}

// Hunter.io (API v2 docs): credits pool, LinkedIn handle, opted-out people, pending checks, webmail
{
  const { hunterCredits, findEmail, verifyEmail } = await import("../src/hunter.js");
  const kv = new Map();
  const env = { HUNTER_API_KEY: "k", DB: { async get(k, ty) { const v = kv.get(k); return v === undefined ? null : ty === "json" ? JSON.parse(v) : v; }, async put(k, v) { kv.set(k, v); }, async delete(k) { kv.delete(k); } } };
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = new URL(String(url)); calls.push(u);
    const J = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers });
    if (u.pathname.endsWith("/account")) return J(200, { data: { reset_date: "2026-11-24", requests: { credits: { used: 3, available: 50, remaining: 47 }, searches: { used: 3, available: 50, remaining: 47 }, verifications: { used: 6, available: 100, remaining: 94 } } } });
    if (u.pathname.endsWith("/email-finder")) {
      if (u.searchParams.get("last_name") === "Optout") return J(451, { errors: [{ id: "claimed_email", code: 451, details: "claimed" }] });
      return J(200, { data: { email: "ada@acme.com", score: 93, provenance: "inferred", verification: { status: "valid" } } }, { "X-Credits-Used": "1", "X-Credits-Unit": "credit" });
    }
    if (u.pathname.endsWith("/email-verifier")) return u.searchParams.get("email").startsWith("slow") ? J(202, { data: {} }) : J(200, { data: { status: "invalid" } }, { "X-Credits-Used": "0.5", "X-Credits-Unit": "credit" });
    return J(404, {});
  };
  check("hunter: remaining credits from the account call", (await hunterCredits(env)).credits, 47);
  const f = await findEmail(env, { name: "Dr. Ada Lovelace", org: "Acme", linkedin: "https://www.linkedin.com/in/ada-l/" });
  const fq = calls.find((u) => u.pathname.endsWith("/email-finder")).searchParams;
  check("hunter: finder sends name + company + LinkedIn handle", [fq.get("first_name"), fq.get("last_name"), fq.get("company"), fq.get("linkedin_handle")], ["Ada", "Lovelace", "Acme", "ada-l"]);
  check("hunter: found email", f.email, "ada@acme.com");
  check("hunter: the reported cost is subtracted", (await hunterCredits(env)).credits, 46);
  check("hunter: opted-out person (451) is never stored", await findEmail(env, { name: "Bob Optout", org: "Acme" }), { claimed: true });
  check("hunter: pending check (202)", (await verifyEmail(env, "slow@acme.com")).pending, true);
  check("hunter: invalid → wrong", (await verifyEmail(env, "x@acme.com")).quality, "wrong");
  const before = calls.length;
  check("hunter: Gmail isn't checked (no credit)", [(await verifyEmail(env, "someone@gmail.com")).skipped, calls.length === before], [true, true]);
  globalThis.fetch = realFetch;
}

// No markdown in her texts
{
  const { stripMarkdown } = await import("../src/chat.js");
  check("markdown: italics", stripMarkdown(["jensen huang got *ousted*?? what did i miss"]), ["jensen huang got ousted?? what did i miss"]);
  check("markdown: bold + underscores", stripMarkdown(["**big** news and _really_ cool"]), ["big news and really cool"]);
  check("markdown: math and snake_case stay", stripMarkdown(["2*3*4 = 24", "my_file_name"]), ["2*3*4 = 24", "my_file_name"]);
}

// LinkedIn / X streak
{
  const { socialStreak } = await import("../src/social.js");
  const s = { days: { "2026-11-16": { posted: { linkedin: true } }, "2026-11-17": { posted: { linkedin: true, x: true } }, "2026-11-18": { posted: {} } } };
  check("social: streak counts up to yesterday while today is open", socialStreak(s, "2026-11-18"), 2);
  check("social: X streak", socialStreak(s, "2026-11-18", "x"), 1);
  s.days["2026-11-18"].posted.linkedin = true;
  check("social: today counts once posted", socialStreak(s, "2026-11-18"), 3);
}

// Bedtime is spelled out (she told him to sleep at 18:21)
{
  const { bedtimeLine } = await import("../src/chat.js");
  check("bedtime: 18:21 → don't mention sleep", /Do NOT mention sleep/.test(bedtimeLine(18, 21)), true);
  check("bedtime: 19:45 → wind down soon", /in 45 min/.test(bedtimeLine(19, 45)), true);
  check("bedtime: 21:10 → past bedtime", /past his bedtime/.test(bedtimeLine(21, 10)), true);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
