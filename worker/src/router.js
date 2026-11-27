import { latestTksNote, notionReady, notionStatus } from "./notion.js";
import { outreachBrief } from "./outreach.js";
import { scheduleCall } from "./realism.js";
import { onListeningCommand, sendWrapped } from "./listening.js";
import { addTyped } from "./agenda.js";
import { onApCommand } from "./ap.js";
import { chat, haneulSays } from "./chat.js";
import { showClassroom } from "./classroom.js";
import { todayISO } from "./dates.js";
import { onEvent } from "./events.js";
import { gemini } from "./gemini.js";
import { onHabitCommand } from "./habits.js";
import { showStatus } from "./health.js";
import { MENU_COMMANDS, helpOverview, helpText } from "./help.js";
import { onJournalCommand, saveJournal } from "./journal.js";
import { onKoreanCommand } from "./korean.js";
import { onLink, onVideo } from "./links.js";
import { onMemoryCommand, rememberPhrase } from "./memory.js";
import { runMusic, spotifyConnectLink } from "./music.js";
import { onNewsletterCommand } from "./newsletter.js";
import { onNoteCommand } from "./notes.js";
import { downloadImage, onButton, onPhoto } from "./photos.js";
import { startGithubJob } from "./reminders.js";
import { scheduleQuestionDay, showDay } from "./schedule.js";
import { runSpaceArticle } from "./space.js";
import { send, tg, typing } from "./telegram.js";
import { processTks } from "./tks.js";
import { markDone, showTodos } from "./todos.js";
import { checkTutorAnswer, onHintCommand } from "./tutor.js";
import { onVoice } from "./voice.js";
import { onWorkoutCommand } from "./workout.js";
import { slackDigest } from "./slack.js";
import { checkVelocity, replanVelocity } from "./velocity.js";
import { feedAdd, feedTextByMid } from "./feed.js";
import { chapterFrom, logReading, onReadingCommand } from "./reading.js";
import { weatherText } from "./weather.js";
import { onWaCommand } from "./whatsapp.js";

// ---------- Routing ----------

export async function handleUpdate(update, env) {
  // Telegram can resend an update if we were slow; skip ones we've already seen.
  const last = Number(await env.DB.get("last_update_id")) || 0;
  if (update.update_id <= last) return;
  await env.DB.put("last_update_id", String(update.update_id));

  // Private bot: ignore everyone except you.
  const chatId = update.message?.chat?.id ?? update.callback_query?.message?.chat?.id;
  if (String(chatId) !== String(env.TELEGRAM_CHAT_ID)) return;

  if (update.callback_query) return onButton(update.callback_query, env);

  const msg = update.message;
  if (!msg) return;
  await feedAdd(env, { who: "me", text: feedTextOf(msg), mid: msg.message_id, src: "telegram" });
  return onMessage(msg, env);
}

// How a message from Alex looks in the app's feed.
export function feedTextOf(msg) {
  const extra = msg.caption ? ` ${msg.caption}` : "";
  if (msg.photo || msg.document?.mime_type?.startsWith("image/")) return `📷 Photo${extra}`;
  if (msg.voice || msg.audio) return "🎤 Voice note";
  if (msg.video || msg.video_note || msg.document?.mime_type?.startsWith("video/")) return `🎬 Video${extra}`;
  if (msg.document) return `📎 ${msg.document.file_name || "File"}${extra}`;
  return msg.text || "(message)";
}

// One message from Alex, from Telegram or the app (the app builds the same shape:
// { text, reply_to_message: { message_id } } or { app_images: [...] }).
export async function onMessage(msg, env) {
  // A reply to "which chapter did you get to?" logs the reading.
  if (msg.reply_to_message && msg.text) {
    const ask = await env.DB.get("reading_ask");
    if (ask && Number(ask) === msg.reply_to_message.message_id) {
      const chapter = chapterFrom(msg.text);
      if (!chapter) return send(env, "just the chapter number pls, like 5");
      await env.DB.delete("reading_ask");
      return logReading(env, chapter, msg.text.replace(/^\D*\d+\s*/, "").trim(), haneulSays);
    }
  }

  // A reply to the tutor's "What's your answer?" gets checked.
  if (msg.reply_to_message && msg.text) {
    const tutor = await env.DB.get("tutor", "json");
    if (tutor && tutor.check_message_id === msg.reply_to_message.message_id) return checkTutorAnswer(env, tutor, msg.text);
  }

  // A reply to the "how was your chat with …?" question (text or voice) becomes a debrief + thank-you draft.
  if (msg.reply_to_message) {
    const dp = await env.DB.get("debrief_pending", "json");
    if (dp && dp.message_id === msg.reply_to_message.message_id && (msg.text || msg.voice || msg.audio)) {
      await typing(env);
      let answer = msg.text || "";
      if (!answer) {
        const f = msg.voice || msg.audio;
        const audio = msg.app_part || (await downloadImage(env, { fileId: f.file_id, mime: f.mime_type || "audio/ogg" }));
        answer = (await gemini(env, [{ role: "user", parts: [audio, { text: "Transcribe this voice note exactly, in its original language. Reply with only the transcript." }] }])).trim();
      }
      return (await import("./debrief.js")).saveDebrief(env, answer, dp);
    }
  }

  // A reply to tonight's journal question (text or voice) is saved as the answer.
  if (msg.reply_to_message) {
    const pending = await env.DB.get("journal_pending", "json");
    if (pending && pending.message_id === msg.reply_to_message.message_id) {
      if (msg.text) return saveJournal(env, msg.text, pending);
      if (msg.voice || msg.audio) {
        await typing(env);
        const f = msg.voice || msg.audio;
        const audio = msg.app_part || (await downloadImage(env, { fileId: f.file_id, mime: f.mime_type || "audio/ogg" }));
        const text = await gemini(env, [{ role: "user", parts: [audio, { text: "Transcribe this voice note exactly, in its original language. Reply with only the transcript." }] }]);
        await send(env, `🎤 "${text.trim()}"`);
        return saveJournal(env, text.trim(), pending);
      }
    }
  }

  if (msg.app_images || msg.photo || msg.document?.mime_type?.startsWith("image/")) return onPhoto(msg, env);
  if (msg.voice || msg.audio) return onVoice(msg, env);
  if (msg.video || msg.video_note || msg.document?.mime_type?.startsWith("video/")) return onVideo(msg, env);
  // A reply to one of her messages (not one of the special ones above): she gets the quoted message,
  // so "Awwww" under "watching the sunset and thought of u" makes sense to her.
  if (msg.text && msg.reply_to_message && !commandOf(msg.text).cmd) {
    const quoted = msg.reply_to_message.text || msg.reply_to_message.caption || (await feedTextByMid(env, msg.reply_to_message.message_id));
    if (quoted) return chat(env, msg.text.trim(), { quote: quoted });
  }
  if (msg.text) return onText(msg.text.trim(), env);
}

// Which command is this message? With a "/" it's always a command. WITHOUT a slash, a word
// only counts when the message is clearly just that command: "Today our director told us…"
// used to show the schedule, and "todos" is Spanish for "everyone".
const EXACT_ONLY = { help: "/help", ayuda: "/help", todos: "/todos", today: "/today", tomorrow: "/tomorrow", ap: "/ap" };
export function commandOf(text) {
  const t = text.trim();
  const [first, ...rest] = t.split(/\s+/);
  const word = first.toLowerCase().replace(/@\w+$/, ""); // "/todos@MyBot" -> "/todos"
  const arg = rest.join(" ").trim();
  if (word.startsWith("/")) return { cmd: word, arg };
  const bare = t.toLowerCase().replace(/[?!.¡¿\s]+$/g, "").replace(/^[¿¡]/, "");
  if (EXACT_ONLY[bare]) return { cmd: EXACT_ONLY[bare], arg: "" };
  if (/^done(\s+#?\d+)+$/i.test(bare)) return { cmd: "/done", arg };
  if (/^ap\s+(\d+|plan|rest|done|undo|exam|status)\b/i.test(t)) return { cmd: "/ap", arg };
  if (/^idea:\s*\S/i.test(t)) return { cmd: "/note", arg: t.replace(/^idea:\s*/i, "") };
  if (/^(event|evento):\s*\S/i.test(t)) return { cmd: "/event", arg: t.replace(/^(event|evento):\s*/i, "") };
  if (/^add\s+(event|evento)\b/i.test(t)) return { cmd: "/event", arg: t.replace(/^add\s+(event|evento):?\s*/i, "") };
  if (/^add\s+\S/i.test(t)) return { cmd: "/add", arg };
  return { cmd: "", arg: t }; // not a command: chat, links, schedule questions…
}

export async function onText(text, env) {
  const { cmd, arg } = commandOf(text);

  if (cmd === "/start") {
    await tg(env, "setMyCommands", { commands: MENU_COMMANDS }).catch(() => {});
    return send(env, helpOverview());
  }
  if (["/help", "help", "/commands", "/ayuda", "ayuda"].includes(cmd)) return send(env, helpText(arg));
  if (cmd === "/todos" || cmd === "todos") return showTodos(env);
  if (["/wa", "/vip", "/words", "/smart"].includes(cmd)) return onWaCommand(env, cmd, arg);
  if (cmd === "/ap" || cmd === "ap") return onApCommand(env, arg);
  if (["/note", "/notes", "idea", "idea:"].includes(cmd)) return onNoteCommand(env, cmd, arg);
  if (cmd === "/weather" || cmd === "/clima") {
    return send(env, await weatherText().catch((err) => `🌦️ Couldn't get the weather (${err.message}).`));
  }
  if (cmd === "/review") return send(env, "🗓️ Your Sunday review is written on GitHub; starting it now, it arrives in about a minute.").then(() => startGithubJob(env, "weekly-review.yml"));
  if (cmd === "/spotify") return spotifyConnectLink(env);
  if (["/np", "/nowplaying", "/listening"].includes(cmd)) return onListeningCommand(env);
  if (["/wrapped", "/week", "/musicweek"].includes(cmd)) return sendWrapped(env, haneulSays, { manual: true });
  if (cmd === "/outreach" || cmd === "/mentors") {
    const text = await outreachBrief(env);
    return send(env, text ? `${text}\n\nOpen the Outreach tab in the app to draft, approve and send.` : "No mentor contacts yet. Open Outreach in the app to add some.");
  }
  if (cmd === "/callme" || cmd === "/llamame") {
    // "/callme" (now) or "/callme 19:30 quiz me on physics"
    const m = arg.match(/^(\d{1,2}:\d{2})\s*(.*)$/);
    return send(env, await scheduleCall(env, m ? { time: m[1], reason: m[2] || "you asked me to call" } : { time: "now", reason: arg || "you asked me to call" }));
  }
  if (cmd === "/music") return runMusic(env);
  if (cmd === "/today" || cmd === "today") return showDay(env, 0);
  if (cmd === "/tomorrow" || cmd === "tomorrow") return showDay(env, 1);
  if (cmd === "/done" || cmd === "done") {
    const ids = (arg.match(/\d+/g) || []).map(Number);
    if (!ids.length) return showTodos(env, 'Which one? Tap a button, or send e.g. "done 2".');
    return markDone(env, ids);
  }
  // Calendar events: "/event ...", "event ...", "evento ...", "add event ..."
  if (["/event", "event", "evento", "/evento"].includes(cmd)) return onEvent(env, arg);
  if ((cmd === "/add" || cmd === "add") && /^(event|evento)\b/i.test(arg)) return onEvent(env, arg.replace(/^(event|evento)\s*/i, ""));
  if (cmd === "/add" || cmd === "add") return addTyped(env, arg);
  if (cmd === "/space") return runSpaceArticle(env);
  if (cmd === "/classroom") return showClassroom(env);
  if (cmd === "/status") return showStatus(env);
  if (cmd === "/workout" || cmd === "/ejercicio") return onWorkoutCommand(env, arg, haneulSays);
  if (cmd === "/slack") {
    await send(env, "reading ur slack rn, one sec");
    return slackDigest(env, haneulSays, { manual: true });
  }
  if (["/book", "/read", "/reading", "/libro", "/leer"].includes(cmd)) {
    const map = { "/libro": "/book", "/leer": "/read" };
    return onReadingCommand(env, map[cmd] || cmd, arg, haneulSays);
  }
  if (cmd === "/hint" || cmd === "/tutor") return onHintCommand(env, arg);
  if (cmd === "/backup") {
    await send(env, "💾 Starting a backup on GitHub. /status will show it in about a minute.");
    await env.DB.put("backup_started", todayISO());
    return startGithubJob(env, "backup.yml");
  }
  if (cmd === "/remember" || cmd === "/memory") return onMemoryCommand(env, cmd, arg);
  const fact = rememberPhrase(text);
  if (fact) return onMemoryCommand(env, "/remember", fact);
  if (cmd === "/journal") return onJournalCommand(env, arg);
  if (cmd === "/habits" || cmd === "/habit") return onHabitCommand(env, cmd, arg);
  if (cmd === "/korean" || cmd === "/coreano") return onKoreanCommand(env, arg);
  if (cmd === "/newsletter" || cmd === "/boletin") return onNewsletterCommand(env, arg);
  if (cmd === "/substack") return (await import("./work.js")).onSubstackCommand(env, arg);
  if (cmd === "/focus" || cmd === "/enfoque") return (await import("./focus.js")).onFocusCommand(env, arg);
  if (cmd === "/week" || cmd === "/semana") return send(env, "📊 Your week in review is in the app: open Today → This week (or Haneul's menu → This week).");
  if (cmd === "/monthly") {
    await send(env, "📰 Writing your monthly TKS update draft on GitHub. It arrives in about a minute.");
    return startGithubJob(env, "monthly-update.yml");
  }
  // A message with a link: summarize it and save it to your ideas.
  const link = text.match(/https?:\/\/[^\s]+/);
  if (link && !cmd.startsWith("/")) return onLink(env, link[0], text.replace(link[0], "").trim());
  if (cmd === "/tks") {
    if (arg) return processTks(env, [], arg);
    if (!notionReady(env)) return send(env, "Send /tks followed by your typed notes, or just send photos of your notes.");
    const tks = await latestTksNote(env);
    if (!tks) return send(env, "ur TKS page in Notion is still empty! write ur session notes in a page inside TKS (or send photos), then /tks again");
    if (tks.tooShort) {
      return send(env, `the newest note in TKS ("${tks.title}") is almost empty, and i don't wanna make stuff up. add ur session notes there, then /tks again`);
    }
    await send(env, `reading "${tks.title || "your latest TKS note"}" from Notion…`);
    return processTks(env, [], `${tks.title}
${tks.text}`);
  }
  if (cmd === "/notion") return send(env, await notionStatus(env));
  if (cmd === "/velocity") {
    if (/^(calendar|calendario|replan|redo)$/i.test(arg)) return replanVelocity(env);
    await send(env, "checking your Velocity page…");
    return checkVelocity(env, { manual: true });
  }
  // Schedule questions ("what classes do I have today?", "¿qué tengo mañana?") are
  // answered straight from the calendar: the AI sometimes mixed up today and tomorrow.
  const day = scheduleQuestionDay(text);
  if (day !== null) return showDay(env, day);

  if (cmd === "/forget") {
    await env.DB.delete("chat");
    return send(env, "🧹 Chat memory cleared.");
  }
  return chat(env, text);
}
