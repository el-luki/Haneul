import { chat } from "./chat.js";
import { MODELS_SMART } from "./config.js";
import { gemini, geminiDelete, geminiFileReady, geminiUpload } from "./gemini.js";
import { memoryText } from "./memory.js";
import { addNote } from "./notes.js";
import { send, tg, typing } from "./telegram.js";

// ---------- Links + videos -> summary + project ideas ----------
// Articles/websites: Gemini opens the page itself (url_context tool).
// YouTube: Gemini watches the video from the link.
// Instagram: blocked for bots, so send the reel video itself instead.
// Videos sent to the bot: uploaded to Gemini's file storage, then watched.

export function summaryPrompt(kind, comment, memory = "") {
  return `Summarize this ${kind} for Alex, an 11th-grade TKS (The Knowledge Society) student who builds
engineering projects (e.g. a rocket landing simulator) and is collecting PROJECT IDEAS.
${memory ? `What you know about Alex and the projects:\n${memory}\n` : ""}${comment ? `Alex added: "${comment}"\n` : ""}
Reply in plain text (no markdown symbols like ** or #), in the language of the content, exactly:

TITLE: <short title of the content>

📝 Summary
• <3 short points>

💡 Project ideas this could spark
• <2-3 concrete ideas a high-school student could build, tied to Alex's interests: space tech, rockets, engineering, AI>

If you cannot open or see the content, reply only: CANNOT_ACCESS`;
}

export async function saveSummary(env, answer, url, source) {
  if (answer.includes("CANNOT_ACCESS")) {
    return send(env, "🔗 I couldn't open that. It may need a login or block bots. Try sending a screenshot, the text, or the video itself.");
  }
  const title = (answer.match(/^TITLE:\s*(.+)$/m) || [])[1]?.trim() || "Saved link";
  const body = answer.replace(/^TITLE:.*$/m, "").trim();
  const note = await addNote(env, `🔗 ${title}\n${body}${url ? `\n${url}` : ""} #link`, source);
  return send(env, `🔗 ${title}\n\n${body}\n\n💾 Saved as idea #${note.id} (/notes link to see your saved links)`, {
    link_preview_options: { is_disabled: true },
  });
}

export async function onLink(env, url, comment) {
  let host = "";
  try {
    host = new URL(url).hostname.replace(/^(www|m)\./, "");
  } catch {
    return chat(env, comment ? `${comment} ${url}` : url);
  }
  if (/(^|\.)instagram\.com$/.test(host)) {
    return send(
      env,
      "📸 Instagram doesn't let bots open reels or posts.\nSave the reel (or screen-record it) and send me the VIDEO: I'll watch it, summarize it and save it to your ideas."
    );
  }
  await typing(env);
  const isYoutube = /(^|\.)youtube\.com$|^youtu\.be$/.test(host);
  const memory = await memoryText(env);
  let answer;
  if (isYoutube) {
    answer = await gemini(env, [{ role: "user", parts: [{ fileData: { fileUri: url } }, { text: summaryPrompt("YouTube video", comment, memory) }] }], {
      models: MODELS_SMART,
      lowMedia: true,
    });
  } else {
    let extra = "";
    if (/(^|\.)tiktok\.com$/.test(host)) {
      // TikTok's public oEmbed gives the caption and author for free.
      const o = await fetch(`https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
      if (o) extra = `\nTikTok by ${o.author_name}. Caption: ${o.title}`;
    }
    answer = await gemini(env, [{ role: "user", parts: [{ text: `${summaryPrompt("web page", comment, memory)}\n\nURL: ${url}${extra}` }] }], {
      models: MODELS_SMART,
      tools: [{ url_context: {} }],
    });
  }
  return saveSummary(env, answer, url, "link");
}

// Videos (e.g. a saved Instagram reel): upload the raw bytes to Gemini's Files API
// (no base64 conversion, so it stays within the free CPU limit), wait until it's
// processed, then ask for the summary.
export async function onVideo(msg, env) {
  let part;
  if (msg.app_file) {
    // from the Haneul app: already uploaded to Gemini by the app route
    part = await geminiFileReady(env, msg.app_file);
  } else {
    const video = msg.video || msg.video_note || msg.document;
    if ((video.file_size || 0) > 20 * 1024 * 1024) {
      return send(env, "🎬 That video is over 20 MB (Telegram's limit for bots). Send a shorter or compressed one.");
    }
    await send(env, "🎬 Watching your video… (this can take a minute)");
    await typing(env);
    const file = await tg(env, "getFile", { file_id: video.file_id });
    const res = await fetch(`https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${file.file_path}`);
    if (!res.ok) throw new Error("couldn't download the video from Telegram");
    const bytes = await res.arrayBuffer();
    part = await geminiFileReady(env, await geminiUpload(env, bytes, { length: bytes.byteLength, mime: video.mime_type || "video/mp4", name: "telegram-video" }));
  }
  const answer = await gemini(
    env,
    [{ role: "user", parts: [part, { text: summaryPrompt("video", msg.caption || "", await memoryText(env)) }] }],
    { models: MODELS_SMART, lowMedia: true }
  );
  geminiDelete(env, part); // Gemini deletes uploads after 48 h anyway; now keeps things tidy
  return saveSummary(env, answer, "", "video");
}
