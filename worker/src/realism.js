import { addDaysISO, localHour, localMinute, todayISO, todayLong } from "./dates.js";
import { appMode, feedAddApp, feedLastMine, feedReact, pushAll, pushCount } from "./feed.js";
import { gemini } from "./gemini.js";
import { send, tg, tgRaw } from "./telegram.js";

// ---------- Making Haneul feel like a real person ----------
// voice notes (Gemini TTS in her call voice), pictures (NASA / Wikimedia, free), emoji reactions,
// a daily status line, and phone calls she starts herself (rung through web push).

const TTS_MODELS = ["gemini-3.1-flash-tts-preview", "gemini-2.5-flash-preview-tts"];
const VOICE_NOTES_PER_DAY = 4; // the free TTS quota is small
export const REACTIONS = ["❤️", "😂", "🔥", "😭", "👀", "🎉", "💯", "🥰", "👍", "😮"];
// Telegram only allows some emoji as bot reactions
const TELEGRAM_REACTION = { "❤️": "❤", "😂": "🤣", "🔥": "🔥", "😭": "😭", "👀": "👀", "🎉": "🎉", "💯": "💯", "🥰": "🥰", "👍": "👍", "😮": "🤯" };

export async function appVoice(env) {
  return (await env.DB.get("app_voice")) || "Kore";
}

// Text → 24 kHz PCM (base64), or null.
export async function ttsPcm(env, text, voice, style = "Say it like a warm, casual friend sending a voice note") {
  for (const model of TTS_MODELS) {
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
        body: JSON.stringify({
          contents: [{ parts: [{ text: `${style}: ${text}` }] }],
          generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } },
        }),
        signal: AbortSignal.timeout(30000),
      });
      const data = await res.json().catch(() => ({}));
      const audio = data.candidates?.[0]?.content?.parts?.find((p) => p.inlineData)?.inlineData?.data;
      if (audio) return audio;
    } catch {}
  }
  return null;
}

// Her texts as one voice note (if today's budget allows). Returns true if sent.
export async function sendVoiceNote(env, text) {
  const today = todayISO();
  const used = (await env.DB.get("voice_notes", "json")) || {};
  if (used.date === today && used.n >= VOICE_NOTES_PER_DAY) return false;
  const pcm = await ttsPcm(env, text.slice(0, 600), await appVoice(env));
  if (!pcm) return false;
  await env.DB.put("voice_notes", JSON.stringify({ date: today, n: used.date === today ? used.n + 1 : 1 }), { expirationTtl: 172800 });
  // Telegram gets the words (it can't play this audio format); the app plays her voice.
  await send(env, `🎤 ${text}`, { app_audio: pcm, app_audio_mime: "pcm24" });
  return true;
}

// ---------- Pictures ----------
const SPACEY = /\b(rocket|space|nasa|mars|moon|galaxy|nebula|planet|starship|falcon|saturn|jupiter|orbit|astronaut|telescope|eclipse|aurora|comet|iss)\b/i;
const UA = { "User-Agent": "HaneulBot/1.0 (personal assistant)" };

export async function findImage(query) {
  const q = String(query || "").slice(0, 100);
  if (!q) return null;
  if (SPACEY.test(q)) {
    try {
      const d = await fetch(`https://images-api.nasa.gov/search?media_type=image&q=${encodeURIComponent(q)}`, { headers: UA, signal: AbortSignal.timeout(6000) }).then((r) => r.json());
      const item = (d.collection?.items || []).find((i) => i.links?.[0]?.href);
      if (item) return { url: item.links[0].href.replace(/~thumb\.jpg$/, "~medium.jpg"), credit: "NASA" };
    } catch {}
  }
  try {
    const u = `https://commons.wikimedia.org/w/api.php?action=query&format=json&generator=search&gsrnamespace=6&gsrlimit=8&prop=imageinfo&iiprop=url|mime&iiurlwidth=1024&gsrsearch=${encodeURIComponent(q)}`;
    const d = await fetch(u, { headers: UA, signal: AbortSignal.timeout(6000) }).then((r) => r.json());
    const pages = Object.values(d.query?.pages || {}).sort((a, b) => (a.index || 0) - (b.index || 0));
    const hit = pages.map((p) => p.imageinfo?.[0]).find((i) => i && /image\/(jpeg|png|webp)/.test(i.mime) && i.thumburl);
    if (hit) return { url: hit.thumburl, credit: "Wikimedia Commons" };
  } catch {}
  return null;
}

export async function sendPicture(env, query) {
  const img = await findImage(query);
  if (!img) return false;
  await tgSendPhoto(env, img.url);
  return true;
}

async function tgSendPhoto(env, url) {
  return tg(env, "sendPhoto", { chat_id: env.TELEGRAM_CHAT_ID, photo: url }).catch((err) => console.error("photo:", err.message));
}

// ---------- Reactions ----------
// Haneul reacts to Alex's newest message (in the app; also in Telegram when it came from there).
export async function reactToLast(env, emoji) {
  if (!REACTIONS.includes(emoji)) return;
  const row = await feedLastMine(env);
  if (!row) return;
  await feedReact(env, row.id, "react_her", emoji);
  if (row.src === "telegram" && row.mid && (await appMode(env)) === "both" && !env.APP_SINK) {
    await tgRaw(env, "setMessageReaction", { chat_id: env.TELEGRAM_CHAT_ID, message_id: row.mid, reaction: [{ type: "emoji", emoji: TELEGRAM_REACTION[emoji] }] }).catch(() => {});
  }
}

// ---------- Her daily status (profile) ----------
export async function haneulStatus(env, extra = "") {
  const saved = await env.DB.get("haneul_status", "json");
  if (saved?.date === todayISO()) return saved;
  let text = "looking at the sky ☁️";
  try {
    text = (await gemini(env, [{ role: "user", parts: [{ text: `You are Haneul (하늘, "sky"): an assistant and close friend who loves the sky, space, rocket launches and K-pop (K-pop).
Write TODAY's status line for your profile, like a WhatsApp/Instagram note: max 7 words plus exactly one emoji at the end.
Make it about your own vibe today. Sometimes nod to something in Alex's day or music. No hashtags, no quotes.
Today is ${todayLong()}.
${extra}
Reply with only the status line.` }] }])).trim().replace(/^["']|["']$/g, "").slice(0, 80);
  } catch {}
  const status = { date: todayISO(), text };
  await env.DB.put("haneul_status", JSON.stringify(status), { expirationTtl: 172800 });
  return status;
}

// ---------- She calls Alex ----------
// Scheduled calls live in KV calls_scheduled; the 5-minute cron rings them (push notification
// → "Haneul is calling" → the app's incoming call screen).
const pad = (n) => String(n).padStart(2, "0");

export async function scheduleCall(env, { time, reason }) {
  const why = String(reason || "just to talk").slice(0, 200);
  if (!time || /^now$/i.test(time)) {
    await ring(env, why);
    return "📞 calling you now…";
  }
  const m = String(time).match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return "";
  const nowMin = localHour() * 60 + localMinute();
  const at = Number(m[1]) * 60 + Number(m[2]);
  const day = at > nowMin ? todayISO() : addDaysISO(todayISO(), 1);
  const ms = Date.parse(`${day}T${pad(m[1])}:${m[2]}:00-05:00`);
  const list = ((await env.DB.get("calls_scheduled", "json")) || []).filter((c) => c.at > Date.now() - 3600000);
  list.push({ id: crypto.randomUUID().slice(0, 8), at: ms, reason: why });
  await env.DB.put("calls_scheduled", JSON.stringify(list.slice(-10)));
  return `📞 I'll call you ${day === todayISO() ? "at" : "tomorrow at"} ${pad(m[1])}:${m[2]}`;
}

export async function runCalls(env) {
  const list = (await env.DB.get("calls_scheduled", "json")) || [];
  if (!list.length) return;
  const due = list.filter((c) => c.at <= Date.now() + 60000);
  if (!due.length) return;
  await env.DB.put("calls_scheduled", JSON.stringify(list.filter((c) => c.at > Date.now() + 60000)));
  for (const c of due.slice(-1)) await ring(env, c.reason);
}

export async function ring(env, reason) {
  if (!(await pushCount(env))) {
    await send(env, "📞 tried to call you but I can't ring your phone yet. Turn on notifications in the Haneul app (settings), then I can.");
    return;
  }
  const id = crypto.randomUUID().slice(0, 8);
  await env.DB.put("ringing", JSON.stringify({ id, reason, at: Date.now() }), { expirationTtl: 180 });
  await feedAddApp(env, { who: "note", text: `📞 Haneul called · ${pad(localHour())}:${pad(localMinute())}`, src: "app" });
  await pushAll(env);
}

export async function ringingNow(env) {
  const r = await env.DB.get("ringing", "json");
  return r && Date.now() - r.at < 120000 ? r : null;
}
