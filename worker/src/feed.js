// ---------- The message feed (Telegram + app in one place) ----------
// Every message Haneul sends and every message Alex sends (in Telegram or the app) is kept in D1
// (env.FEED), so the app shows the whole conversation: briefs, reminders, check-ins, buttons…
// Mode "app" (set in the app): Haneul stops texting in Telegram; messages only go to the feed and
// a push notification wakes the phone. Login codes always go to Telegram.
// Messages that only exist in the app get a fake message id (APP_MID + feed row id), so replies
// and buttons work the same way as Telegram message ids.

export const APP_MID = 2_000_000_000;
export const VAPID_PUBLIC = "BGYAWIbarSkUMU9wOqZPvKsMu7ZDZjz1SHeJ5rILr8qXb4ox2FsAATQaFUKC0Vp6ndUspbANTLufEYKX8yby6Ck";
const KEEP_ROWS = 3000;

const buttonsOf = (markup) =>
  (markup?.inline_keyboard || []).map((row) => row.map((b) => ({ text: b.text, data: b.callback_data || "", url: b.url || "" })));

// Adds a row; returns its id (null without D1 or on error: the feed must never break messaging).
// Extras: replyMid (the message this one answers), image (a picture URL), audio + audioMime
// (her voice note: base64, "pcm24" = raw 24 kHz PCM from Gemini TTS, or ogg).
export async function feedAdd(env, { who, text, markup = null, mid = null, src, replyMid = null, image = null, audio = null, audioMime = null }) {
  if (!env.FEED) return null;
  try {
    const buttons = buttonsOf(markup);
    const r = await env.FEED.prepare("INSERT INTO feed (at, who, text, buttons, mid, src, reply_mid, image, audio, audio_mime) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(Date.now(), who, String(text || "").slice(0, 8000), buttons.length ? JSON.stringify(buttons) : null, mid, src || null, replyMid, image, audio, audioMime)
      .run();
    const id = r.meta?.last_row_id ?? null;
    if (id && id % 200 === 0) await env.FEED.prepare("DELETE FROM feed WHERE id < ?").bind(id - KEEP_ROWS).run();
    return id;
  } catch (err) {
    console.error("feed:", err.message);
    return null;
  }
}

// A row added in app-only mode: its message id is derived from the row id.
export async function feedAddApp(env, row) {
  const id = await feedAdd(env, row);
  if (id && env.FEED) await env.FEED.prepare("UPDATE feed SET mid = ? WHERE id = ?").bind(APP_MID + id, id).run().catch(() => {});
  return id ? APP_MID + id : Math.floor(Math.random() * 1e9);
}

export async function feedSetMid(env, id, mid) {
  if (!env.FEED || !id) return;
  await env.FEED.prepare("UPDATE feed SET mid = ? WHERE id = ?").bind(mid, id).run().catch(() => {});
}

// Buttons used (Telegram editMessageReplyMarkup or a press in the app) disappear in the feed too.
export async function feedEditMarkup(env, mid, markup) {
  if (!env.FEED || !mid) return;
  const buttons = buttonsOf(markup);
  await env.FEED.prepare("UPDATE feed SET buttons = ? WHERE mid = ?").bind(buttons.length ? JSON.stringify(buttons) : null, mid).run().catch(() => {});
}

export async function feedEditText(env, mid, text, markup) {
  if (!env.FEED || !mid) return;
  const buttons = buttonsOf(markup);
  await env.FEED.prepare("UPDATE feed SET text = ?, buttons = ? WHERE mid = ?").bind(String(text || ""), buttons.length ? JSON.stringify(buttons) : null, mid).run().catch(() => {});
}

const COLS = `id, at, who, text, buttons, mid, src, (audio IS NOT NULL) AS has_audio, audio_mime, image, react_me, react_her, updated, reply_mid,
  (SELECT f2.text FROM feed f2 WHERE f2.mid = feed.reply_mid AND feed.reply_mid IS NOT NULL ORDER BY f2.id DESC LIMIT 1) AS reply_text`;
const rowOut = (r) => ({
  id: r.id, at: r.at, who: r.who, text: r.text, buttons: r.buttons ? JSON.parse(r.buttons) : [], mid: r.mid, src: r.src || "",
  audio: !!r.has_audio, voice: r.audio_mime === "pcm24", image: r.image || "", reactMe: r.react_me || "", reactHer: r.react_her || "",
  updated: r.updated || 0, replyText: r.reply_text ? String(r.reply_text).slice(0, 160) : "",
});

// after = newest id the app has; since = also rows changed (reactions…) after this time.
export async function feedList(env, { after = 0, since = 0, limit = 150 } = {}) {
  if (!env.FEED) return null;
  const q = after
    ? env.FEED.prepare(`SELECT ${COLS} FROM feed WHERE id > ? OR (? > 0 AND updated > ?) ORDER BY id ASC LIMIT ?`).bind(after, since, since, limit)
    : env.FEED.prepare(`SELECT * FROM (SELECT ${COLS} FROM feed ORDER BY id DESC LIMIT ?) ORDER BY id ASC`).bind(limit);
  return ((await q.all()).results || []).map(rowOut);
}

// A reaction on a message. field: "react_me" (Alex reacted) or "react_her" (Haneul did). "" removes it.
export async function feedReact(env, id, field, emoji) {
  if (!env.FEED || !id || !["react_me", "react_her"].includes(field)) return;
  await env.FEED.prepare(`UPDATE feed SET ${field} = ?, updated = ? WHERE id = ?`).bind(emoji || null, Date.now(), id).run();
}

// Alex's newest message (for Haneul's reaction to it).
export async function feedLastMine(env) {
  if (!env.FEED) return null;
  return env.FEED.prepare("SELECT id, mid, src FROM feed WHERE who = 'me' ORDER BY id DESC LIMIT 1").first();
}

export async function feedRow(env, id) {
  if (!env.FEED || !id) return null;
  return env.FEED.prepare("SELECT id, who, text, mid, src FROM feed WHERE id = ?").bind(id).first();
}

// Haneul's newest messages (for the push notification text).
export async function feedLatestHers(env, n = 3) {
  if (!env.FEED) return [];
  const rows = (await env.FEED.prepare(`SELECT ${COLS} FROM feed WHERE who = 'her' ORDER BY id DESC LIMIT ?`).bind(n).all()).results || [];
  return rows.reverse().map(rowOut);
}

// "both" (default): Telegram + app. "app": only the app (with push notifications).
export async function appMode(env) {
  if (!env.DB) return "both";
  return (await env.DB.get("app_mode").catch(() => null)) === "app" ? "app" : "both";
}

// ---------- Web push (no payload: the phone then fetches the newest messages itself) ----------
const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const jwtCache = new Map();

async function vapidJwt(env, audience) {
  const hit = jwtCache.get(audience);
  if (hit && hit.exp - 600 > Date.now() / 1000) return hit.jwt;
  const key = await crypto.subtle.importKey("jwk", JSON.parse(env.VAPID_JWK), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const exp = Math.floor(Date.now() / 1000) + 12 * 3600;
  const enc = (o) => b64url(new TextEncoder().encode(JSON.stringify(o)));
  const unsigned = `${enc({ typ: "JWT", alg: "ES256" })}.${enc({ aud: audience, exp, sub: env.PUBLIC_URL || "https://example.com" })}`;
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(unsigned));
  const jwt = `${unsigned}.${b64url(sig)}`;
  jwtCache.set(audience, { jwt, exp });
  return jwt;
}

export async function pushAll(env) {
  if (!env.FEED || !env.VAPID_JWK) return 0;
  const subs = (await env.FEED.prepare("SELECT endpoint FROM push_subs").all()).results || [];
  let sent = 0;
  for (const { endpoint } of subs) {
    try {
      const jwt = await vapidJwt(env, new URL(endpoint).origin);
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { TTL: "86400", Urgency: "high", Topic: "haneul", Authorization: `vapid t=${jwt}, k=${VAPID_PUBLIC}`, "Content-Length": "0" },
      });
      if (res.status === 404 || res.status === 410) await env.FEED.prepare("DELETE FROM push_subs WHERE endpoint = ?").bind(endpoint).run();
      else if (res.ok) sent++;
      else console.error("push:", res.status, (await res.text()).slice(0, 200));
    } catch (err) {
      console.error("push:", err.message);
    }
  }
  return sent;
}

export async function pushSubscribe(env, sub, device) {
  if (!env.FEED || !sub?.endpoint || !/^https:\/\//.test(sub.endpoint)) return { error: "bad subscription" };
  await env.FEED.prepare("INSERT OR REPLACE INTO push_subs (endpoint, sub, device, at) VALUES (?, ?, ?, ?)")
    .bind(sub.endpoint, JSON.stringify(sub), String(device || "").slice(0, 60), Date.now()).run();
  return { ok: true };
}

export async function pushUnsubscribe(env, endpoint) {
  if (!env.FEED || !endpoint) return { ok: true };
  await env.FEED.prepare("DELETE FROM push_subs WHERE endpoint = ?").bind(endpoint).run();
  return { ok: true };
}

export async function pushCount(env) {
  if (!env.FEED) return 0;
  return (await env.FEED.prepare("SELECT COUNT(*) AS n FROM push_subs").first())?.n || 0;
}

// The text of a message by its message id (what Alex replied to in the app).
export async function feedTextByMid(env, mid) {
  if (!env.FEED || !mid) return "";
  const r = await env.FEED.prepare("SELECT text FROM feed WHERE mid = ? ORDER BY id DESC LIMIT 1").bind(mid).first().catch(() => null);
  return r?.text || "";
}
