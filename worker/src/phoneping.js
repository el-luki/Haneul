import { send, tgRaw } from "./telegram.js";
import { MAX_SESSION, eventsBetween, hm, sessionsFrom } from "./screen.js";

// ---------- From the PC to his phone ----------
// Everything goes to Telegram directly (force_telegram), never into Haneul's chat: on the phone it's its own
// notification, and a MacroDroid macro can watch for the ring text (see README → "Find my phone").

export const RING_TEXT = "📳 Find my phone";

export async function pingPhone(env) {
  await tgRaw(env, "sendMessage", { chat_id: env.TELEGRAM_CHAT_ID, text: `${RING_TEXT} · Haneul is ringing it from the PC` });
  return { ok: true };
}

// text and/or one image (base64 JPEG from the app, already shrunk to ≤1600 px)
export async function sendToPhone(env, { text, image } = {}) {
  text = String(text || "").trim().slice(0, 4000);
  image = typeof image === "string" ? image : "";
  if (!text && !image) return { error: "nothing to send" };
  if (image.length > 8_000_000) return { error: "that image is too big" };
  if (!image) {
    await tgRaw(env, "sendMessage", { chat_id: env.TELEGRAM_CHAT_ID, text: `💻 ${text}` });
    return { ok: true };
  }
  const bytes = Uint8Array.from(atob(image), (c) => c.charCodeAt(0));
  const form = new FormData();
  form.append("chat_id", String(env.TELEGRAM_CHAT_ID));
  form.append("photo", new Blob([bytes], { type: "image/jpeg" }), "from-pc.jpg");
  if (text && text.length <= 1000) form.append("caption", `💻 ${text}`); // captions max out at 1024
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendPhoto`, { method: "POST", body: form, signal: AbortSignal.timeout(30000) });
  if (!res.ok) return { error: `Telegram said ${res.status}` };
  if (text.length > 1000) await tgRaw(env, "sendMessage", { chat_id: env.TELEGRAM_CHAT_ID, text: `💻 ${text}` });
  return { ok: true };
}

// ---------- Put-it-down nudge ----------
// Every 5 minutes: if the phone has been on for `phone_nudge_min` minutes straight (screen time from MacroDroid),
// Haneul says so once for that stretch. KV phone_nudge_min: minutes, "0" = off, default 45.
export const NUDGE_DEFAULT = 45;
export async function nudgeMinutes(env) {
  const v = await env.DB.get("phone_nudge_min");
  return v === null ? NUDGE_DEFAULT : Number(v) || 0;
}
export async function setNudge(env, minutes) {
  const m = Math.max(0, Math.min(240, Math.round(Number(minutes) || 0)));
  await env.DB.put("phone_nudge_min", String(m));
  return { minutes: m };
}

// The open stretch (if any) → minutes on, and its start (to nudge once per stretch).
export function openStretch(events, now) {
  const last = sessionsFrom(events, now).at(-1);
  return last?.open ? { start: last.start, minutes: Math.floor((now - last.start) / 60000) } : null;
}

export async function screenNudge(env, now = Date.now()) {
  if (!(await env.DB.get("screen_setup"))) return;
  const limit = await nudgeMinutes(env);
  if (!limit) return;
  const s = openStretch(await eventsBetween(env, now - MAX_SESSION, now), now);
  if (!s || s.minutes < limit || (await env.DB.get("phone_nudge_at")) === String(s.start)) return;
  await env.DB.put("phone_nudge_at", String(s.start), { expirationTtl: 86400 });
  await send(env, `📵 ${hm(s.minutes)} straight on your phone. put it down for a bit?`);
}
