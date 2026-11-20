import { APP_MID, appMode, feedAdd, feedAddApp, feedEditMarkup, feedEditText, pushAll } from "./feed.js";

// ---------- Telegram ----------

const OUTGOING = ["sendMessage", "sendPhoto", "sendVoice", "sendAudio", "sendDocument"];
const textOf = (method, body) => (method === "sendMessage" ? body.text : body.caption || "(sent a file)");

// Every message to Alex also goes into the app's feed (feed.js). Three cases:
//  - env.APP_SINK (a request from the app): collected for the app's answer, nothing to Telegram
//  - app-only mode: into the feed + a push notification, nothing to Telegram
//  - normal: Telegram, and a copy in the feed
// body.force_telegram (login codes): always Telegram, never the feed.
// App-only extras on a message (stripped before Telegram sees it): app_audio + app_audio_mime
// (her voice note; Telegram gets the text), app_reply_mid. A sendPhoto with a URL is kept as image.
function splitExtras(method, body) {
  if (!body || typeof body !== "object") return [body, {}];
  const extras = {
    audio: body.app_audio || null,
    audioMime: body.app_audio_mime || null,
    replyMid: body.app_reply_mid || null,
    image: method === "sendPhoto" && typeof body.photo === "string" ? body.photo : null,
  };
  if (!("app_audio" in body || "app_audio_mime" in body || "app_reply_mid" in body)) return [body, extras];
  const clean = { ...body };
  delete clean.app_audio;
  delete clean.app_audio_mime;
  delete clean.app_reply_mid;
  return [clean, extras];
}

export async function tg(env, method, body) {
  const outgoing = OUTGOING.includes(method);
  const force = body?.force_telegram;
  if (force) {
    body = { ...body };
    delete body.force_telegram;
  }
  let extras;
  [body, extras] = splitExtras(method, body);
  if (!force && env.APP_SINK) return appSink(env, method, body, extras);
  if (!force && (outgoing || method === "sendChatAction") && (await appMode(env)) === "app") {
    if (!outgoing) return true; // no "typing…" in a Telegram chat nobody is looking at
    const mid = await feedAddApp(env, { who: "her", text: textOf(method, body), markup: body.reply_markup, src: "app", ...extras });
    await pushAll(env).catch((err) => console.error("push:", err.message));
    return { message_id: mid, chat: { id: Number(env.TELEGRAM_CHAT_ID) || 0 } };
  }
  if (method === "editMessageReplyMarkup") await feedEditMarkup(env, body.message_id, body.reply_markup);
  if (method === "editMessageText") await feedEditText(env, body.message_id, body.text, body.reply_markup);
  if (body?.message_id >= APP_MID) return true; // a message that only exists in the app
  const result = await tgRaw(env, method, body);
  if (outgoing && !force) await feedAdd(env, { who: "her", text: textOf(method, body), markup: body.reply_markup, mid: result?.message_id, src: "telegram", ...extras });
  return result;
}

// Retries when Telegram is briefly down or slow (5xx, 429, network errors, or a plain-text
// error page like "error code: 504" instead of JSON), instead of crashing on it.
export async function tgRaw(env, method, body) {
  let last = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 1500 * attempt));
    let res;
    try {
      res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30000),
      });
    } catch (err) {
      last = `couldn't reach Telegram (${err.name === "TimeoutError" ? "timed out" : err.message})`;
      continue;
    }
    const raw = await res.text();
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      last = `Telegram had a hiccup (${res.status})`;
      continue; // an error page, not JSON: try again
    }
    if (data.ok) return data.result;
    if (res.status === 429 || res.status >= 500) {
      last = `Telegram is busy (${res.status})`;
      if (data.parameters?.retry_after) await new Promise((r) => setTimeout(r, Math.min(10, data.parameters.retry_after) * 1000));
      continue;
    }
    throw new Error(`Telegram ${method}: ${data.description}`); // a real error (e.g. bad request): don't retry
  }
  throw new HiccupError(last);
}

// An answer to a request from the app: kept in the feed (with an app message id) and
// returned to the app in env.APP_SINK.
async function appSink(env, method, body, extras = {}) {
  const buttons = (body.reply_markup?.inline_keyboard || []).map((row) => row.map((b) => ({ text: b.text, data: b.callback_data || "", url: b.url || "" })));
  if (method === "editMessageReplyMarkup") {
    await feedEditMarkup(env, body.message_id, body.reply_markup);
    return true;
  }
  if (method === "editMessageText") {
    await feedEditText(env, body.message_id, body.text, body.reply_markup);
    env.APP_SINK.push({ text: body.text, buttons, mid: body.message_id });
    return true;
  }
  if (!OUTGOING.includes(method)) return true; // typing, answerCallbackQuery…: nothing to show
  const mid = await feedAddApp(env, { who: "her", text: textOf(method, body), markup: body.reply_markup, src: "app", ...extras });
  env.APP_SINK.push({ text: textOf(method, body), buttons, mid, image: extras.image || "", voice: extras.audioMime === "pcm24" });
  return { message_id: mid, chat: { id: Number(env.TELEGRAM_CHAT_ID) || 0 } };
}

// A temporary problem on Telegram's or Google's side (not a bug): shown to Alex as a short, calm message.
export class HiccupError extends Error {}

export async function send(env, text, extra = {}) {
  text = text || "(empty)";
  let result;
  for (let i = 0; i < text.length; i += 4000) {
    const isLast = i + 4000 >= text.length;
    result = await tg(env, "sendMessage", {
      chat_id: env.TELEGRAM_CHAT_ID,
      text: text.slice(i, i + 4000),
      ...(isLast ? extra : {}),
    });
  }
  return result;
}

export function typing(env) {
  return tg(env, "sendChatAction", { chat_id: env.TELEGRAM_CHAT_ID, action: "typing" }).catch(() => {});
}
