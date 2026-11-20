import { Buffer } from "node:buffer";
import { processAgenda } from "./agenda.js";
import { apLog } from "./ap.js";
import { chat } from "./chat.js";
import { PHOTO_TTL_MS } from "./config.js";
import { confirmEvent } from "./events.js";
import { toggleHabit } from "./habits.js";
import { answerKorean } from "./korean.js";
import { HiccupError, send, tg, tgRaw, typing } from "./telegram.js";
import { processTks } from "./tks.js";
import { markDone, showTodos } from "./todos.js";
import { onTutorButton, startTutor } from "./tutor.js";
import { onWorkoutButton } from "./workout.js";
import { onReadingButton } from "./reading.js";
import { onVelocityButton } from "./velocity.js";

// ---------- Photos ----------

export async function onPhoto(msg, env) {
  const pending = (await getPending(env));
  if (msg.app_images) {
    // from the Haneul app: the image itself (base64, already shrunk by the app) instead of a Telegram file id
    for (const img of msg.app_images.slice(0, 6)) pending.push({ data: img.data, mime: img.mime || "image/jpeg", group: null, caption: msg.caption || "", at: Date.now() });
    await env.DB.put("pending_photos", JSON.stringify(pending.slice(-6)));
    return askWhatPhoto(env);
  }
  const photo = msg.photo ? msg.photo[msg.photo.length - 1] : msg.document; // largest size
  const mime = msg.photo ? "image/jpeg" : msg.document.mime_type;

  // An album (several photos sent together) arrives as separate messages with the
  // same media_group_id: collect them all but only show the buttons once.
  const sameAlbum = msg.media_group_id && pending.some((p) => p.group === msg.media_group_id);
  pending.push({
    fileId: photo.file_id,
    mime,
    group: msg.media_group_id || null,
    caption: msg.caption || "",
    at: Date.now(),
  });
  await env.DB.put("pending_photos", JSON.stringify(pending.slice(-10)));
  if (sameAlbum) return;
  return askWhatPhoto(env);
}

function askWhatPhoto(env) {
  return send(env, "📸 Got it. (More pages? Send them now.) What is this?", {
    reply_markup: {
      inline_keyboard: [
        [{ text: "📒 Agenda → to-dos", callback_data: "agenda" }],
        [{ text: "🧠 TKS notes → Mindset draft", callback_data: "tks" }],
        [{ text: "🧑‍🏫 Homework problem → hints", callback_data: "hw" }],
        [{ text: "✖ Cancel", callback_data: "cancel" }],
      ],
    },
  });
}

export async function onButton(q, env) {
  await tg(env, "answerCallbackQuery", { callback_query_id: q.id }).catch(() => {});
  const data = q.data || "";
  if (data.startsWith("done:u:")) return markDone(env, [], { uids: [data.slice(7)] });
  // Buttons from before renumbering existed: their number may point to another task now.
  if (data.startsWith("done:")) return showTodos(env, "That button is from an old list (numbers have changed). Here's the current one:");
  if (data.startsWith("event:")) return confirmEvent(env, q, data.slice(6));
  if (data.startsWith("hb:")) {
    const [, iso, id] = data.split(":");
    return toggleHabit(env, q, iso, Number(id));
  }
  if (data.startsWith("kq:")) return answerKorean(env, q, data);
  if (data.startsWith("sat:")) return (await import("./daily.js")).answerSat(env, q, data);
  if (data.startsWith("tu:")) return onTutorButton(env, q, data.slice(3));
  if (data.startsWith("wk:")) return onWorkoutButton(env, q, data.slice(3));
  if (data.startsWith("rd:")) return onReadingButton(env, q, data.slice(3));
  if (data.startsWith("vl:")) return onVelocityButton(env, q, data.slice(3));
  if (data.startsWith("ap:")) {
    const choice = data.slice(3);
    await tg(env, "editMessageReplyMarkup", { chat_id: q.message.chat.id, message_id: q.message.message_id }).catch(() => {});
    if (choice === "rest") return apLog(env, 0, { rest: true });
    if (choice === "miss") return apLog(env, 0, { missed: true });
    return apLog(env, Number(choice));
  }

  const edit = (text) =>
    tg(env, "editMessageText", { chat_id: q.message.chat.id, message_id: q.message.message_id, text }).catch(() => {});

  const pending = await getPending(env);
  if (data === "cancel") {
    await env.DB.delete("pending_photos");
    return edit("✖ Cancelled.");
  }
  if (!pending.length) return edit("That photo expired. Send it again.");
  if (!["agenda", "tks", "hw"].includes(data)) return;

  const pages = pending.length === 1 ? "1 page" : `${pending.length} pages`;
  const reading = { tks: `🧠 Reading your TKS notes (${pages})…`, hw: "🧑‍🏫 Reading the problem…", agenda: `📒 Reading your agenda (${pages})…` };
  await edit(reading[data]);
  await typing(env);

  // The photos are only forgotten once the job worked, so a hiccup never loses them.
  try {
    const images = await Promise.all(pending.map((p) => downloadImage(env, p)));
    const note = pending.map((p) => p.caption).filter(Boolean).join("\n");
    if (data === "agenda") await processAgenda(env, images, note);
    if (data === "tks") await processTks(env, images, note);
    if (data === "hw") await startTutor(env, images, note);
    await env.DB.delete("pending_photos");
  } catch (err) {
    console.error("photo job failed:", err.message);
    // keep the photos a little longer and offer a retry with the same ones
    await env.DB.put("pending_photos", JSON.stringify(pending.map((p) => ({ ...p, at: Date.now() }))));
    const what = { tks: "your TKS notes", hw: "that problem", agenda: "your agenda" }[data];
    const why = err instanceof HiccupError ? "Google or Telegram had a hiccup (not you)" : `something broke (${err.message})`;
    await send(env, `couldn't finish reading ${what}: ${why}. ur photos are still saved`, {
      reply_markup: { inline_keyboard: [[{ text: "🔄 Try again", callback_data: data }, { text: "✖ Cancel", callback_data: "cancel" }]] },
    });
  }
}

export async function getPending(env) {
  const list = (await env.DB.get("pending_photos", "json")) || [];
  return list.filter((p) => Date.now() - p.at < PHOTO_TTL_MS);
}

export async function downloadImage(env, p) {
  if (p.data) return { inlineData: { mimeType: p.mime, data: p.data } }; // sent from the app
  const file = await tgRaw(env, "getFile", { file_id: p.fileId });
  // the download itself can hiccup too: try up to 3 times
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 1500 * attempt));
    try {
      const res = await fetch(`https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${file.file_path}`, { signal: AbortSignal.timeout(30000) });
      if (!res.ok) continue;
      const data = Buffer.from(await res.arrayBuffer()).toString("base64");
      return { inlineData: { mimeType: p.mime, data } };
    } catch {}
  }
  throw new HiccupError("couldn't download the photo from Telegram");
}
