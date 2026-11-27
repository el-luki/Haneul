import { BADGE_96, ICON_192, ICON_512, ICON_MASKABLE } from "../app/icons.js";
import { skyNow } from "./weather.js";
import { saveFound } from "./agenda.js";
import { buildSystem } from "./chat.js";
import { daysBetween, localHour, localMinute, todayISO } from "./dates.js";
import { createCalendarEvent } from "./events.js";
import { gemini, geminiDelete, geminiFileReady, geminiUpload, parseJson } from "./gemini.js";
import { logChatDay, rememberMany } from "./memory.js";
import { Buffer } from "node:buffer";
import { APP_MID, appMode, feedAddApp, feedEditMarkup, feedLatestHers, feedList, feedReact, feedRow, feedSetMid, pushAll, pushCount, pushSubscribe, pushUnsubscribe, VAPID_PUBLIC } from "./feed.js";
import { notionOverview, notionPage, notionReady } from "./notion.js";
import { onButton } from "./photos.js";
import { startGithubJob } from "./reminders.js";
import { listeningContext, nowPlaying } from "./listening.js";
import { haneulStatus, REACTIONS, ringingNow } from "./realism.js";
import { addLog, approveDraft, cancelDraft, draftEmail, getContact, importContacts, markSent, outreachState, profile as outreachProfile, saveContact, saveDraftText, skipContact, syncGmail, updateContact, weeklySearch } from "./outreach.js";
import { onMessage } from "./router.js";
import { formatEvent } from "./schedule.js";
import { HiccupError, send } from "./telegram.js";
import { formatTodos, getTodos, markDone, sortTodos } from "./todos.js";
import { searchWeb } from "./web.js";

// ---------- The Haneul app (installable web app) ----------
// /app is a web app Alex installs on his phone ("Add to Home screen") and opens on his PC.
//  - Chat: the same Haneul as Telegram (same commands, memory, history, buttons). Her answers
//    come back to the app instead of Telegram (env.APP_SINK, see telegram.js).
//  - Call: a real-time voice call with Gemini Live. The worker makes a short-lived, single-use
//    token, so the Gemini key never reaches the phone. The browser talks to Google directly;
//    tools (to-dos, calendar, search) run here through /app/api/call/tool.
// Login: the app asks for a 6-digit code that Haneul sends to Alex's Telegram.

export const LIVE_MODELS = ["gemini-3.8-live", "gemini-3.1-flash-live-preview", "gemini-2.5-flash-native-audio-latest"];
export const LIVE_VOICE = "Kore"; // default; Alex can pick another in the app (KV app_voice)
// Gemini's 30 prebuilt voices (they work for Live calls and TTS), with Google's one-word vibe.
export const VOICES = {
  Zephyr: "Bright", Puck: "Upbeat", Charon: "Informative", Kore: "Firm", Fenrir: "Excitable", Leda: "Youthful",
  Orus: "Firm", Aoede: "Breezy", Callirrhoe: "Easy-going", Autonoe: "Bright", Enceladus: "Breathy", Iapetus: "Clear",
  Umbriel: "Easy-going", Algieba: "Smooth", Despina: "Smooth", Erinome: "Clear", Algenib: "Gravelly", Rasalgethi: "Informative",
  Laomedeia: "Upbeat", Achernar: "Soft", Alnilam: "Firm", Schedar: "Even", Gacrux: "Mature", Pulcherrima: "Forward",
  Achird: "Friendly", Zubenelgenubi: "Casual", Vindemiatrix: "Gentle", Sadachbia: "Lively", Sadaltager: "Knowledgeable", Sulafat: "Warm",
};
const TTS_MODELS = ["gemini-3.1-flash-tts-preview", "gemini-2.5-flash-preview-tts"];
const SESSION_DAYS = 180;
const CALL_MINUTES = 15; // Live API limit for one audio session

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

const png = (b64) => {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return new Response(bytes, { headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=604800" } });
};

const MANIFEST = {
  name: "Haneul",
  short_name: "Haneul",
  description: "Alex's assistant: chat and voice calls",
  start_url: "/app",
  scope: "/app",
  display: "standalone",
  background_color: "#181e4e",
  theme_color: "#181e4e",
  icons: [
    { src: "/app/icon-192.png?v=3", sizes: "192x192", type: "image/png", purpose: "any" },
    { src: "/app/icon-512.png?v=3", sizes: "512x512", type: "image/png", purpose: "any" },
    { src: "/app/icon-maskable.png?v=3", sizes: "512x512", type: "image/png", purpose: "maskable" },
  ],
  // long-press the app icon (or "Hey Google, open Haneul") → straight to a call / hands-free
  shortcuts: [
    { name: "Call Haneul", short_name: "Call", url: "/app#call", icons: [{ src: "/app/icon-192.png?v=3", sizes: "192x192", type: "image/png" }] },
    { name: "Hey Haneul (hands-free)", short_name: "Hands-free", url: "/app#handsfree", icons: [{ src: "/app/icon-192.png?v=3", sizes: "192x192", type: "image/png" }] },
  ],
};

// Network first; the cached page only shows when the phone is offline.
const SERVICE_WORKER = `const C = "haneul-v6";
self.addEventListener("install", (e) => { self.skipWaiting(); e.waitUntil(caches.open(C).then((c) => c.addAll(["/app"]))); });
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET" || u.pathname.startsWith("/app/api/")) return;
  e.respondWith(fetch(e.request).then((r) => { if (u.pathname === "/app") caches.open(C).then((c) => c.put("/app", r.clone())); return r; }).catch(() => caches.match(e.request).then((r) => r || caches.match("/app"))));
});
// Push (no payload): fetch Haneul's newest messages with the login the page saved, then notify.
const authToken = async () => { const t = await (await caches.open("haneul-auth")).match("/app/__token"); return t ? await t.text() : ""; };
async function unread(delta) {
  const c = await caches.open("haneul-auth");
  const r = await c.match("/app/__unread");
  const n = delta === 0 ? 0 : (r ? Number(await r.text()) || 0 : 0) + delta;
  await c.put("/app/__unread", new Response(String(n)));
  try { n ? await self.navigator.setAppBadge(n) : await self.navigator.clearAppBadge(); } catch {}
  return n;
}
self.addEventListener("message", (e) => { if (e.data === "read") e.waitUntil(unread(0)); });
self.addEventListener("push", (e) => e.waitUntil((async () => {
  const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  wins.forEach((w) => w.postMessage("refresh"));
  const open = wins.some((w) => w.focused && w.visibilityState === "visible");
  let body = "New message", ringing = null;
  try {
    const r = await fetch("/app/api/latest", { headers: { Authorization: "Bearer " + (await authToken()) } });
    const d = await r.json();
    ringing = d.ringing || null;
    const fresh = d.messages.filter((m) => Date.now() - m.at < 120000).map((m) => m.voice ? "🎤 Voice message" : m.image ? "📷 Photo" : m.text);
    body = (fresh.length ? fresh : d.messages.slice(-1).map((m) => m.text)).join("\\n").slice(0, 400) || body;
  } catch {}
  if (ringing) {
    // she's calling: a loud, sticky notification (the app shows the incoming call screen)
    wins.forEach((w) => w.postMessage("ring"));
    if (open) return;
    return self.registration.showNotification("📞 Haneul is calling…", { body: ringing.reason || "tap to answer", icon: "/app/icon-192.png?v=3", badge: "/app/badge.png?v=3",
      tag: "haneul-call", renotify: true, requireInteraction: true, vibrate: [600, 300, 600, 300, 600, 300, 600],
      actions: [{ action: "answer", title: "Answer" }, { action: "decline", title: "Decline" }], data: { url: "/app#incoming", ring: ringing.id } });
  }
  if (open) return; // app is open: no notification needed
  await unread(1);
  await self.registration.showNotification("Haneul", { body, icon: "/app/icon-192.png?v=3", badge: "/app/badge.png?v=3", tag: "haneul", renotify: true, data: { url: "/app" } });
})()));
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil((async () => {
    const d = e.notification.data || {};
    if (e.action === "decline") {
      await fetch("/app/api/call/decline", { method: "POST", headers: { Authorization: "Bearer " + (await authToken()), "Content-Type": "application/json" }, body: JSON.stringify({ id: d.ring }) }).catch(() => {});
      return;
    }
    const url = d.url || "/app";
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const w = wins.find((x) => new URL(x.url).pathname.startsWith("/app"));
    if (w) { await w.focus(); w.postMessage(url.includes("incoming") ? "ring" : "refresh"); } else await self.clients.openWindow(url);
  })());
});`;

async function sessionOk(request, env) {
  const token = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!/^[a-f0-9-]{60,80}$/.test(token)) return false;
  return !!(await env.DB.get(`app_session:${token}`));
}

// The app tags what it sends with a random nonce, so the sending device can skip its own
// messages when it polls (it already shows them) while other devices still see them.
const nonceOf = (body) => String(body.nonce || "").replace(/[^a-z0-9]/gi, "").slice(0, 24);

// A copy of env whose Telegram messages are collected for the app.
const appEnv = (env) => ({ ...env, APP_SINK: [] });

export async function appRoutes(request, env, url) {
  const p = url.pathname.replace(/\/+$/, "") || "/app";
  if (request.method === "GET") {
    if (p === "/app") {
      const page = (await import("../app/index.html")).default;
      return new Response(page, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" } });
    }
    if (p === "/app/manifest.webmanifest") return new Response(JSON.stringify(MANIFEST), { headers: { "Content-Type": "application/manifest+json" } });
    if (p === "/app/sw.js") return new Response(SERVICE_WORKER, { headers: { "Content-Type": "text/javascript", "Cache-Control": "no-cache", "Service-Worker-Allowed": "/app" } });
    if (p === "/app/icon-192.png") return png(ICON_192);
    if (p === "/app/icon-512.png") return png(ICON_512);
    if (p === "/app/icon-maskable.png") return png(ICON_MASKABLE);
    if (p === "/app/badge.png") return png(BADGE_96);
    // The NASA background photos, served from Haneul's own address: images-assets.nasa.gov sends no CORS header,
    // so WebGL (the PC liquid glass) can't sample them directly. Only the three backgrounds, cached a week.
    const nasa = p.match(/^\/app\/nasa\/(iss073e0982261|iss072e159172|iss067e141213)\.jpg$/);
    if (nasa) {
      const cache = caches.default, key = new Request(url.toString());
      const hit = await cache.match(key);
      if (hit) return hit;
      const r = await fetch(`https://images-assets.nasa.gov/image/${nasa[1]}/${nasa[1]}~large.jpg`);
      if (!r.ok) return new Response("not found", { status: 404 });
      const res = new Response(r.body, { headers: { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=604800" } });
      await cache.put(key, res.clone()).catch(() => {});
      return res;
    }
  }
  if (!p.startsWith("/app/api/")) return new Response("not found", { status: 404 });
  const route = p.slice("/app/api/".length);
  const GETS = ["setup", "week", "focus", "phone", "history", "feed", "latest", "audio", "notion", "settings", "now", "profile", "ringing", "outreach", "today", "bgimg", "sky", "bible", "course", "social", "social/xcheck", "tks"];
  if (request.method !== (GETS.includes(route) ? "GET" : "POST")) return new Response("method not allowed", { status: 405 });

  if (route === "login/start") return loginStart(env);
  if (route === "login") return login(env, await request.json().catch(() => ({})));
  if (!(await sessionOk(request, env))) return json({ error: "login" }, 401);

  try {
    if (route === "upload") return json({ messages: await appUpload(env, request, url.searchParams) });
    const body = request.method === "POST" ? await request.json().catch(() => ({})) : {};
    const q = url.searchParams;
    if (route === "history") return json({ messages: await history(env), ...(await settings(env)) });
    if (route === "settings") return json(await settings(env));
    if (route === "feed") {
      const now = Date.now();
      const messages = (await feedList(env, { after: Number(q.get("after")) || 0, since: Number(q.get("since")) || 0, limit: 100 })) || [];
      return json({ messages, now, ringing: await ringingNow(env) });
    }
    if (route === "latest") return json({ messages: await feedLatestHers(env, 3), ringing: await ringingNow(env) });
    if (route === "ringing") return json({ ringing: await ringingNow(env) });
    if (route === "profile") return json(await profile(env));
    if (route === "today") return json(await todayPanel(env));
    if (route === "course") { const m = await import("./course.js"); const c = await m.getCourse(env); return json(c ? { course: c, plan: m.coursePlan(c) } : { course: null }); }
    if (route === "social") { const m = await import("./social.js"); const s = await m.getSocial(env); const { xReady } = await import("./xpost.js"); const { liStatus } = await import("./lipost.js"); return json({ ...s, today: todayISO(), streak: m.socialStreak(s), streakX: m.socialStreak(s, todayISO(), "x"), xReady: xReady(env) && (await env.DB.get("x_mode")) !== "share", xShareMode: xReady(env) && (await env.DB.get("x_mode")) === "share", li: await liStatus(env), newsletter: await (await import("./newsletter.js")).getNewsletter(env) }); }
    if (route === "week") return json(await (await import("./week.js")).weekStats(env));
    if (route === "setup") return json(await setupSteps(env));
    if (route === "setup/spotify") { const { spotifyConnectLink } = await import("./music.js"); await spotifyConnectLink(env); return json({ ok: true }); }
    if (route === "focus") return json({ focus: await (await import("./focus.js")).getFocus(env) });
    if (route === "focus/start") { const f = await (await import("./focus.js")).startFocus(env, { minutes: body.minutes, label: body.label }); return json({ focus: f }); }
    if (route === "focus/stop") return json(await (await import("./focus.js")).stopFocus(env));
    if (route === "phone") return json({ nudge: await (await import("./phoneping.js")).nudgeMinutes(env), screenOn: !!(await env.DB.get("screen_setup")) });
    if (route === "phone/ping") return json(await (await import("./phoneping.js")).pingPhone(env));
    if (route === "phone/send") return json(await (await import("./phoneping.js")).sendToPhone(env, body));
    if (route === "phone/nudge") return json(await (await import("./phoneping.js")).setNudge(env, body.minutes));
    if (route === "tks") { const { tksStatus } = await import("./tkslife.js"); return json(await tksStatus(env)); }
    if (route.startsWith("tks/")) {
      const m = await import("./tkslife.js");
      if (route === "tks/connect") return json(await m.tksConnect(env, body));
      if (route === "tks/disconnect") return json(await m.tksDisconnect(env));
      if (route === "tks/post") return json(await m.tksPost(env, body).catch((err) => ({ error: err.message })));
      if (route === "tks/skip") return json(await m.tksSkip(env, body));
      if (route === "tks/sync") { await env.BG_JOBS.send({ kind: "tks_sync" }); return json({ queued: true }); } // drafts take ~30 s
      if (route === "tks/backfill") { const { tksBackfill } = await import("./tkslife.js"); return json(await tksBackfill(env)); } // first batch now, the rest in the background
    }
    if (route === "social/x_mode") { if (body.mode === "api") await env.DB.delete("x_mode"); else await env.DB.put("x_mode", "share"); return json({ ok: true }); }
    if (route === "social/li_start") { const { liStart } = await import("./lipost.js"); return json(await liStart(env)); }
    if (route === "social/unpost") { const { unmarkPosted } = await import("./social.js"); return json(await unmarkPosted(env, body)); }
    if (route === "social/lipost") { const { approveLinkedIn } = await import("./social.js"); return json(await approveLinkedIn(env, body)); }
    if (route === "social/xcheck") { const { xWhoAmI } = await import("./xpost.js"); return json(await xWhoAmI(env)); }
    if (route === "social/xpost") { const { approveX } = await import("./social.js"); return json(await approveX(env, body)); }
    if (route === "social/posted") { const { markPosted } = await import("./social.js"); return json(await markPosted(env, body)); }
    if (route === "social/text") { const { saveSocialText } = await import("./social.js"); return json(await saveSocialText(env, body)); }
    if (route === "social/new") { const { draftSocial } = await import("./social.js"); return json({ day: await draftSocial(env, { again: true }) }); } // ~10 s: written right away
    if (route === "course/mark") { const { markCourse } = await import("./course.js"); return json({ changed: await markCourse(env, [String(body.id || "")], body.done !== false) }); }
    if (route === "course/import") { const { importCourse } = await import("./course.js"); return json(await importCourse(env, body)); }
    if (route === "bible") { const { bibleMonth } = await import("./bible.js"); return json(await bibleMonth(env, q.get("m"))); }
    if (route === "bible/save") { const { setBibleDay } = await import("./bible.js"); return json(await setBibleDay(env, String(body.date || ""), body.day || {})); }
    if (route === "sky") return json(await skyNow().catch((err) => ({ error: err.message })));
    if (route === "bgimg") {
      const img = await env.DB.get("app_bg_img");
      return img ? new Response(Buffer.from(img, "base64"), { headers: { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=86400" } }) : new Response("none", { status: 404 });
    }
    if (route === "bg") return json(await setBackground(env, body));
    if (route === "react") return json(await appReact(env, Number(body.id), String(body.emoji || "")));
    if (route.startsWith("outreach")) return json(await outreachRoute(env, route, body));
    if (route === "call/decline") return json(await declineCall(env));
    if (route === "now") return json(await nowPlaying(env).catch(() => ({ playing: false })));
    if (route === "audio") return audioFile(env, Number(q.get("id")));
    if (route === "notion") return json(q.get("id") ? await notionPage(env, q.get("id")) : await notionOverview(env));
    if (route === "voice") return json(await setVoice(env, String(body.voice || "")));
    if (route === "voice/preview") return json(await previewVoice(env, String(body.voice || "")));
    if (route === "mode") return json(await setMode(env, body.mode));
    if (route === "push/subscribe") return json(await pushSubscribe(env, body.sub, body.device));
    if (route === "push/unsubscribe") return json(await pushUnsubscribe(env, body.endpoint));
    if (route === "push/test") return json({ sent: await pushAll(env) });
    if (route === "send") return json({ messages: await appSend(env, String(body.text || "").slice(0, 4000), Number(body.reply_to) || null, nonceOf(body)) });
    if (route === "photo") return json({ messages: await appPhoto(env, body.images || [], String(body.caption || "").slice(0, 1000), nonceOf(body)) });
    if (route === "button") return json({ messages: await appButton(env, String(body.data || ""), Number(body.mid) || 0, String(body.label || "").slice(0, 100), nonceOf(body)) });
    if (route === "call/start") return json(await callStart(env, String(body.reason || ""), String(body.ring || "")));
    if (route === "call/tool") return json(await callTool(env, body.name, body.args || {}));
    if (route === "call/end") return json(await callEnd(env, body.transcript || [], body.seconds || 0, nonceOf(body)));
    return json({ error: "unknown" }, 404);
  } catch (err) {
    console.error("app:", err);
    const text = err instanceof HiccupError ? "ugh, Google had a hiccup just now (not you). try again in a minute?" : `⚠️ Something went wrong: ${err.message}`;
    return json({ messages: [{ text, buttons: [] }], error: err.message }, err instanceof HiccupError ? 503 : 500);
  }
}

// ---------- Login with a code sent to Telegram ----------
async function loginStart(env) {
  if (await env.DB.get("app_login_wait")) return json({ ok: true, again: true }); // one code per minute
  const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, "0");
  await env.DB.put("app_login_code", JSON.stringify({ code, tries: 0 }), { expirationTtl: 300 });
  await env.DB.put("app_login_wait", "1", { expirationTtl: 60 });
  // always Telegram (even in app-only mode), so Alex can't lock himself out
  await send(env, `🔐 Haneul app login code: ${code}\n(valid 5 min. If you didn't just open the app, ignore this.)`, { force_telegram: true });
  return json({ ok: true });
}

async function login(env, body) {
  const saved = await env.DB.get("app_login_code", "json");
  if (!saved) return json({ error: "That code expired. Ask for a new one." }, 400);
  if (String(body.code || "").trim() !== saved.code) {
    saved.tries++;
    if (saved.tries >= 5) await env.DB.delete("app_login_code");
    else await env.DB.put("app_login_code", JSON.stringify(saved), { expirationTtl: 300 });
    return json({ error: saved.tries >= 5 ? "Too many tries. Ask for a new code." : "Wrong code, try again." }, 400);
  }
  await env.DB.delete("app_login_code");
  const token = `${crypto.randomUUID()}${crypto.randomUUID()}`.replace(/-/g, "");
  const device = String(body.device || "device").slice(0, 60);
  await env.DB.put(`app_session:${token}`, JSON.stringify({ device, since: new Date().toISOString() }), { expirationTtl: 60 * 60 * 24 * SESSION_DAYS });
  await send(env, `📱 New login to the Haneul app (${device}).`).catch(() => {});
  return json({ token });
}

// ---------- Chat ----------
// The last messages from the shared chat history (Telegram + app), oldest first.
// A voice call is stored as a summary (so Haneul remembers it) but shown as one small note.
export const CALL_MARK = /^\(Voice call in the Haneul app at (\d{2}:\d{2}), ([\d:]+)\./;
const OLD_CALL_MARK = /^\(We just had a (\d+)-min voice call/;
export async function history(env) {
  const feed = await feedList(env, { limit: 150 });
  if (feed?.length) return feed;
  return chatHistory(env); // before the feed existed: the chat history
}

// Background photo for the app: a NASA preset (public domain), his own photo, or none.
export const BG_PRESETS = ["night", "aurora", "sunrise", "custom", "none", "gradient"];
async function setBackground(env, body) {
  if (body.image) {
    const img = String(body.image);
    if (img.length > 2_500_000) return { error: "that photo is too big, try a smaller one" };
    await env.DB.put("app_bg_img", img);
    await env.DB.put("app_bg", "custom");
    return { ok: true, bg: "custom", v: Date.now() };
  }
  if (!BG_PRESETS.includes(body.bg)) return { error: "unknown background" };
  await env.DB.put("app_bg", body.bg);
  return { ok: true, bg: body.bg };
}

// The "Set up Haneul" checklist in her menu: which connections are done (no secrets, just yes/no).
async function setupSteps(env) {
  const safe = (p) => p.catch(() => null);
  const [spotify, tks, li, substack, phone, pushes] = await Promise.all([
    safe(env.DB.get("spotify", "json")), safe(env.DB.get("tks_auth", "json")), safe((async () => (await import("./lipost.js")).liStatus(env))()),
    safe(env.DB.get("substack_feed")), safe(env.DB.get("phone_setup")), safe(pushCount(env)),
  ]);
  const screen = await safe(env.DB.get("screen_setup"));
  return { steps: [
    { id: "push", title: "Turn on notifications", done: (pushes || 0) > 0 },
    { id: "notion", title: "Connect Notion", done: notionReady(env) },
    { id: "spotify", title: "Connect Spotify", done: !!spotify?.refresh_token },
    { id: "tks", title: "Connect TKS.life", done: !!tks?.access && !tks.expired },
    { id: "linkedin", title: "Connect LinkedIn", done: !!li?.connected },
    { id: "substack", title: "Add your Substack", done: !!substack },
    { id: "phone", title: "Phone focus (MacroDroid)", done: !!phone },
    { id: "screen", title: "Screen time (MacroDroid)", done: !!screen },
  ] };
}

async function settings(env) {
  return {
    bg: (await env.DB.get("app_bg")) || "night",
    voice: await currentVoice(env),
    voices: VOICES,
    mode: await appMode(env),
    vapid: VAPID_PUBLIC,
    pushDevices: await pushCount(env),
    notion: notionReady(env),
  };
}

async function setMode(env, mode) {
  if (mode !== "app" && mode !== "both") return { error: "bad mode" };
  await env.DB.put("app_mode", mode);
  // tell Telegram too, so the switch is never a mystery there
  await send(env, mode === "app"
    ? "📱 From now on I'll text you in the Haneul app (with notifications) instead of here. Switch back anytime in the app's settings. Login codes still come here."
    : "💬 I'm back to texting you here in Telegram (and in the app).", { force_telegram: true }).catch(() => {});
  return { ok: true, mode };
}

function wavHeader(dataLength, rate) {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + dataLength, 4); h.write("WAVE", 8); h.write("fmt ", 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(dataLength, 40);
  return h;
}

async function audioFile(env, id) {
  if (!env.FEED || !id) return new Response("not found", { status: 404 });
  const row = await env.FEED.prepare("SELECT audio, audio_mime FROM feed WHERE id = ?").bind(id).first();
  if (!row?.audio) return new Response("not found", { status: 404 });
  const bytes = Buffer.from(row.audio, "base64");
  if (row.audio_mime === "pcm24") return new Response(Buffer.concat([wavHeader(bytes.length, 24000), bytes]), { headers: { "Content-Type": "audio/wav", "Cache-Control": "private, max-age=604800" } });
  return new Response(bytes, { headers: { "Content-Type": "audio/ogg", "Cache-Control": "private, max-age=604800" } });
}

// Korean pronunciation audio (from the GitHub job): to Telegram as a voice message (unless
// app-only), and into the feed so the app can play it.
export async function relayVoice(env, b64, caption) {
  const text = `🔊 ${caption || "Voice message"}`;
  if ((await appMode(env)) === "app") {
    const id = await feedAddRow(env, { who: "her", text, audio: b64, src: "app" });
    if (id) await feedSetMid(env, id, APP_MID + id);
    await pushAll(env).catch(() => {});
    return;
  }
  const form = new FormData();
  form.append("chat_id", String(env.TELEGRAM_CHAT_ID));
  form.append("caption", caption.slice(0, 1000));
  form.append("voice", new Blob([Buffer.from(b64, "base64")], { type: "audio/ogg" }), "korean.ogg");
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendVoice`, { method: "POST", body: form });
  const data = await res.json().catch(() => ({}));
  await feedAddRow(env, { who: "her", text, audio: b64, mid: data.result?.message_id || null, src: "telegram" });
}

async function feedAddRow(env, { who, text, audio, mid = null, src }) {
  if (!env.FEED) return null;
  const r = await env.FEED.prepare("INSERT INTO feed (at, who, text, buttons, mid, src, audio) VALUES (?, ?, ?, NULL, ?, ?, ?)")
    .bind(Date.now(), who, text, mid, src, audio).run().catch((err) => (console.error("feed audio:", err.message), null));
  return r?.meta?.last_row_id ?? null;
}

async function chatHistory(env) {
  const h = (await env.DB.get("chat", "json")) || [];
  const out = [];
  for (const m of h) {
    const text = m.parts.map((x) => x.text).join("\n");
    const call = text.match(CALL_MARK);
    const old = text.match(OLD_CALL_MARK);
    if (call) out.push({ who: "note", text: `📞 Call · ${call[2]} · ${call[1]}` });
    else if (old) out.push({ who: "note", text: `📞 Call · ${old[1]} min` });
    else if (m.role === "model" && text === "(that was our call)") continue;
    else out.push({ who: m.role === "user" ? "me" : "her", text });
  }
  return out;
}

// ---------- the Today panel (desktop app): what's left today, to-dos, outreach ----------
async function todayPanel(env) {
  const today = todayISO();
  const nowHHMM = `${String(localHour()).padStart(2, "0")}:${String(localMinute()).padStart(2, "0")}`;
  const schedule = await env.DB.get("schedule", "json");
  const events = (schedule?.events || [])
    .filter((e) => e.start.slice(0, 10) === today && !e.all_day)
    .map((e) => ({ time: e.start.slice(11, 16), end: (e.end || "").slice(11, 16), title: e.title, tag: e.tag, past: (e.end || e.start).slice(11, 16) < nowHHMM }));
  const todos = sortTodos(await getTodos(env)).slice(0, 10).map((t) => ({ id: t.id, uid: t.uid, task: t.task, due: t.due || null, overdue: !!t.due && t.due < today }));
  let outreach = null;
  if (env.FEED) {
    const o = await outreachState(env).catch(() => null);
    if (o?.contacts?.length) outreach = { overview: o.overview, due: o.contacts.filter((c) => c.move?.due).slice(0, 3).map((c) => ({ id: c.id, name: c.name || c.org, org: c.org, move: c.move.t })) };
  }
  // "This week" at the bottom of the panel: the next newsletter issue and the LinkedIn streak
  let newsletter = null, streak = null;
  try {
    const nm = await import("./newsletter.js");
    const cur = nm.currentIssue(await nm.getNewsletter(env));
    if (cur) newsletter = { n: cur.n, date: cur.date, title: cur.title, status: cur.status, days: daysBetween(today, cur.date) };
  } catch {}
  try {
    const sm = await import("./social.js");
    const s = await sm.getSocial(env);
    streak = { linkedin: sm.socialStreak(s), postedToday: !!s.days[today]?.posted?.linkedin };
  } catch {}
  const focus = await (await import("./focus.js")).getFocus(env).catch(() => null);
  const screen = (await env.DB.get("screen_setup")) ? await (await import("./screen.js")).screenDay(env).catch(() => null) : null;
  return { date: today, now: nowHHMM, events, todos, outreach, newsletter, streak, focus, screen };
}

// ---------- Outreach tab (outreach.js) ----------
async function outreachRoute(env, route, body) {
  const id = String(body.id || "");
  const draft = Number(body.draft) || 0;
  switch (route) {
    case "outreach": { const { trackerStatus } = await import("./tracker.js"); return { ...(await outreachState(env)), tracker: await trackerStatus(env).catch(() => null) }; }
    case "outreach/save": return { contact: await updateContact(env, id || null, body.fields || {}) };
    case "outreach/delete": await env.FEED.prepare("DELETE FROM outreach WHERE id = ?").bind(id).run(); return { ok: true };
    case "outreach/log": {
      const c = await getContact(env, id);
      if (!c) return { error: "no such contact" };
      await saveContact(env, addLog(c, String(body.text || "").slice(0, 300)));
      return { ok: true };
    }
    case "outreach/draft": return { draft: await draftEmail(env, id, String(body.kind || "")) };
    case "outreach/text": return saveDraftText(env, draft, body);
    case "outreach/approve": return approveDraft(env, draft, body);
    case "outreach/cancel": return cancelDraft(env, draft, { discard: !!body.discard });
    case "outreach/mark": return markSent(env, draft, body);
    case "outreach/hunter_find": { const { hunterFind } = await import("./outreach.js"); return hunterFind(env, id); }
    case "outreach/hunter_verify": { const { hunterVerify } = await import("./outreach.js"); return hunterVerify(env, id); }
    case "outreach/skip": return skipContact(env, draft);
    case "outreach/prep": await env.BG_JOBS.send({ kind: "outreach_prep" }); return { queued: true }; // research + drafts take ~1 min
    case "outreach/discover": await env.BG_JOBS.send({ kind: "outreach_discover" }); return { queued: true };
    case "outreach/discover_web": await env.BG_JOBS.send({ kind: "outreach_discover_web", want: Math.min(20, Number(body.want) || 10) }); return { queued: true };
    case "outreach/research_all": await env.BG_JOBS.send({ kind: "outreach_research_all" }); return { queued: true };
    case "outreach/import": return importContacts(env, body.list);
    case "outreach/work_add": { const { addWork } = await import("./work.js"); return { added: await addWork(env, [body.item], "app") }; }
    case "outreach/work_del": { const { removeWork } = await import("./work.js"); return removeWork(env, body.id); }
    case "outreach/feeds": {
      const { toFeedUrl } = await import("./work.js");
      const feeds = (Array.isArray(body.feeds) ? body.feeds : []).map(toFeedUrl).filter(Boolean).slice(0, 5);
      await env.DB.put("work_feeds", JSON.stringify(feeds));
      if (typeof body.substack === "string") {
        const { substackFeedUrl } = await import("./work.js");
        const sf = substackFeedUrl(body.substack);
        if (sf) await env.DB.put("substack_feed", sf); else if (!body.substack.trim()) await env.DB.delete("substack_feed");
      }
      await env.DB.delete("work_feed_slot"); // check them on the next cron run
      return { feeds };
    }
    case "outreach/profile": {
      const p = await outreachProfile(env);
      if (body.signature !== undefined) p.signature = String(body.signature).slice(0, 400);
      if (body.cadence !== undefined) p.cadence = Math.max(3, Math.min(21, Number(body.cadence) || 7));
      if (body.age !== undefined) p.age = String(body.age).replace(/\D/g, "").slice(0, 2);
      if (body.published !== undefined) p.published = String(body.published).slice(0, 300);
      if (body.goal !== undefined) p.goal = Math.max(1, Math.min(30, Number(body.goal) || 10));
      await env.DB.put("outreach_profile", JSON.stringify(p));
      return { profile: p };
    }
    case "outreach/tracker_sync": { const { syncTracker } = await import("./tracker.js"); return syncTracker(env); }
    case "outreach/braindates_sync": { const { syncBraindates } = await import("./tracker.js"); return syncBraindates(env); }
    case "outreach/sync": return syncGmail(env);
    case "outreach/search": await env.BG_JOBS.send({ kind: "outreach_weekly" }); return { queued: true }; // can take > 100 s
    case "outreach/sync_now": return syncGmail(env);
    case "outreach/seen": await env.FEED.prepare("UPDATE outreach_updates SET seen = 1").run(); return { ok: true };
    default: return { error: "unknown" };
  }
}

// Alex reacts to one of Haneul's messages (long-press in the app). She sees it next time she answers.
async function appReact(env, id, emoji) {
  const row = await feedRow(env, id);
  if (!row) return { error: "no such message" };
  const e = REACTIONS.includes(emoji) ? emoji : "";
  await feedReact(env, id, "react_me", e);
  if (e && row.who === "her") {
    const notes = ((await env.DB.get("user_reactions", "json")) || []).slice(-4);
    notes.push(`${e} on "${String(row.text).slice(0, 80)}"`);
    await env.DB.put("user_reactions", JSON.stringify(notes), { expirationTtl: 86400 });
  }
  return { ok: true };
}

async function declineCall(env) {
  const r = await ringingNow(env);
  if (!r) return { ok: true };
  await env.DB.delete("ringing");
  await feedAddApp(env, { who: "note", text: "📞 Declined", src: "app" });
  return { ok: true };
}

// Haneul's profile: today's status, her voice, how long they've talked, shared photos.
async function profile(env) {
  const memory = (await env.DB.get("memory", "json")) || [];
  const first = memory.map((m) => m.date).filter(Boolean).sort()[0] || null;
  const photos = env.FEED ? ((await env.FEED.prepare("SELECT id, image, at FROM feed WHERE image IS NOT NULL ORDER BY id DESC LIMIT 24").all()).results || []) : [];
  const voiceNotes = env.FEED ? (await env.FEED.prepare("SELECT COUNT(*) AS n FROM feed WHERE audio_mime = 'pcm24'").first())?.n || 0 : 0;
  const songs = env.FEED ? (await env.FEED.prepare("SELECT COUNT(*) AS n FROM listens").first().catch(() => ({ n: 0 })))?.n || 0 : 0;
  const music = await listeningContext(env).catch(() => "");
  const status = await haneulStatus(env, music ? `Alex's music: ${music.split("\n").slice(-1)[0]}` : "");
  return { status: status.text, voice: await currentVoice(env), memories: memory.length, since: first, photos: photos.map((p) => p.image), voiceNotes, songs };
}

// ---------- Voice ----------
async function currentVoice(env) {
  const v = await env.DB.get("app_voice");
  return VOICES[v] ? v : LIVE_VOICE;
}

async function setVoice(env, voice) {
  if (!VOICES[voice]) return { error: "unknown voice" };
  await env.DB.put("app_voice", voice);
  return { ok: true, voice };
}

// A short sample in that voice (Gemini TTS, 24 kHz PCM as base64), cached so each voice costs one request ever.
async function previewVoice(env, voice) {
  if (!VOICES[voice]) return { error: "unknown voice" };
  const cached = await env.DB.get(`voice_sample:${voice}`);
  if (cached) return { audio: cached };
  let last = "";
  for (const model of TTS_MODELS) {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
      body: JSON.stringify({
        contents: [{ parts: [{ text: "Say warmly, like a friend picking up the phone: Hey Alex! It's Haneul. This is what I'd sound like on our calls." }] }],
        generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } },
      }),
    }).catch((err) => ({ status: err.message, json: async () => ({}) }));
    const data = await res.json().catch(() => ({}));
    const audio = data.candidates?.[0]?.content?.parts?.find((p) => p.inlineData)?.inlineData?.data;
    if (audio) {
      await env.DB.put(`voice_sample:${voice}`, audio, { expirationTtl: 60 * 60 * 24 * 90 });
      return { audio };
    }
    last = data.error?.message || String(res.status);
  }
  return { error: /quota|exhausted|429/i.test(last) ? "out of free previews for today, try tomorrow" : `couldn't make a preview (${last.slice(0, 80)})` };
}

// Same as typing in Telegram: commands work, replies (to "which chapter?", the tutor, the
// journal question) work, everything else goes to chat().
async function appSend(env, text, replyTo, nonce) {
  if (!text.trim()) return [];
  const e = appEnv(env);
  await feedAddApp(env, { who: "me", text, src: `app:${nonce}`, replyMid: replyTo || null });
  await onMessage({ text, ...(replyTo ? { reply_to_message: { message_id: replyTo } } : {}) }, e);
  return e.APP_SINK;
}

// Photos from the app (already shrunk to JPEG by the app): same flow as photos in Telegram.
async function appPhoto(env, images, caption, nonce) {
  const ok = images.filter((i) => typeof i?.data === "string" && i.data.length < 3_000_000).slice(0, 6);
  if (!ok.length) return [{ text: "That photo didn't come through, try again?", buttons: [] }];
  const e = appEnv(env);
  await feedAddApp(env, { who: "me", text: `📷 ${ok.length > 1 ? `${ok.length} photos` : "Photo"}${caption ? ` ${caption}` : ""}`, src: `app:${nonce}` });
  await onMessage({ app_images: ok.map((i) => ({ data: i.data, mime: i.mime || "image/jpeg" })), caption }, e);
  return e.APP_SINK;
}

// Voice notes and videos from the app: the raw bytes stream straight to Gemini's Files API
// (no base64, no JSON), then the same handlers as Telegram run on them.
const UPLOAD_LIMITS = { voice: 10 * 1024 * 1024, video: 60 * 1024 * 1024 };
async function appUpload(env, request, q) {
  const kind = q.get("kind");
  const length = Number(request.headers.get("Content-Length")) || 0;
  if (!UPLOAD_LIMITS[kind]) return [{ text: "I can't open that kind of file.", buttons: [] }];
  if (!length) return [{ text: "That file came through empty, try again?", buttons: [] }];
  if (length > UPLOAD_LIMITS[kind]) return [{ text: kind === "voice" ? "🎤 That voice note is too long. Keep it under 3 minutes." : "🎬 That video is over 60 MB. Send a shorter one?", buttons: [] }];
  const mime = String(q.get("mime") || (kind === "voice" ? "audio/wav" : "video/mp4")).slice(0, 60);
  const caption = String(q.get("caption") || "").slice(0, 1000);
  const nonce = nonceOf({ nonce: q.get("nonce") });
  const e = appEnv(env);
  const info = await geminiUpload(env, request.body, { length, mime, name: `haneul-app-${kind}` });
  if (kind === "voice") {
    const seconds = Math.round(Number(q.get("seconds")) || 0);
    const replyTo = Number(q.get("reply_to")) || null;
    await feedAddApp(env, { who: "me", text: `🎤 Voice note${seconds ? ` · ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}` : ""}`, src: `app:${nonce}` });
    const part = await geminiFileReady(env, info, 10);
    await onMessage({ voice: { duration: seconds, mime_type: mime }, app_part: part, ...(replyTo ? { reply_to_message: { message_id: replyTo } } : {}) }, e);
    geminiDelete(env, part);
    return e.APP_SINK;
  }
  // video: Gemini needs a minute to watch it, so the summary comes later through the feed
  await feedAddApp(env, { who: "me", text: `🎬 Video${caption ? ` ${caption}` : ""}`, src: `app:${nonce}` });
  await send(e, "🎬 Watching your video… (this can take a minute)");
  await env.BG_JOBS.send({ kind: "app_video", file: info, caption });
  return e.APP_SINK;
}

async function appButton(env, data, mid, label, nonce) {
  const e = appEnv(env);
  if (label) await feedAddApp(env, { who: "me", text: label, src: `app:${nonce}` });
  if (mid) await feedEditMarkup(env, mid, null); // a used button disappears (like in Telegram)
  await onButton({ id: "app", data, message: { chat: { id: Number(env.TELEGRAM_CHAT_ID) || 0 }, message_id: mid || 0 } }, e);
  return e.APP_SINK;
}

// ---------- Voice call ----------
export const CALL_TOOLS = [
  {
    name: "add_todos",
    description: "Add one or more tasks to Alex's to-do list. Use when he asks you to add / remember to do something.",
    parameters: {
      type: "OBJECT",
      properties: {
        tasks: {
          type: "ARRAY",
          items: { type: "OBJECT", properties: { task: { type: "STRING" }, due: { type: "STRING", description: "YYYY-MM-DD or empty" } }, required: ["task"] },
        },
      },
      required: ["tasks"],
    },
  },
  {
    name: "complete_todos",
    description: "Tick off to-dos by their #number (from the list in your instructions).",
    parameters: { type: "OBJECT", properties: { numbers: { type: "ARRAY", items: { type: "INTEGER" } } }, required: ["numbers"] },
  },
  {
    name: "list_todos",
    description: "Get Alex's current to-do list with numbers.",
    parameters: { type: "OBJECT", properties: {} },
  },
  {
    name: "get_schedule",
    description: "Get Alex's calendar for one day (up to a week ahead).",
    parameters: { type: "OBJECT", properties: { date: { type: "STRING", description: "YYYY-MM-DD" } }, required: ["date"] },
  },
  {
    name: "add_calendar_event",
    description: "Put an event in Alex's Google Calendar. Say the title, day and time out loud and get a yes from him BEFORE calling this.",
    parameters: {
      type: "OBJECT",
      properties: {
        title: { type: "STRING" },
        date: { type: "STRING", description: "YYYY-MM-DD" },
        start: { type: "STRING", description: "HH:MM (24 h), empty for an all-day event" },
        minutes: { type: "INTEGER", description: "length in minutes (default 60)" },
      },
      required: ["title", "date"],
    },
  },
  {
    name: "now_playing",
    description: "What Alex is listening to on Spotify right now (song, artist, paused or playing).",
    parameters: { type: "OBJECT", properties: {} },
  },
  {
    name: "search_web",
    description: "Search the news and Wikipedia for anything recent or current (news, launches, scores, releases) or anything you're unsure about.",
    parameters: { type: "OBJECT", properties: { query: { type: "STRING" } }, required: ["query"] },
  },
];

export const CALL_RULES = `YOU ARE ON A LIVE VOICE CALL WITH ALEX (in the Haneul app). These rules replace the texting rules above:
- Talk like a friend on the phone: natural, warm, short turns (usually 1-3 sentences). Let him talk.
- No emojis, no lists, no markdown, no "text 1 / text 2". Never read out symbols or #numbers in a robotic way.
- Speak whatever language he speaks (English or Spanish, or Korean words when practising).
- Tools: add_todos, complete_todos, list_todos, get_schedule (up to a week), add_calendar_event, search_web,
  now_playing (his Spotify, if the song may have changed since the call started).
  Use them for real; only say something is done after the tool answered. For a calendar event, say it back and
  wait for his yes first. For anything current, use search_web instead of guessing.
- If he goes quiet for long or says bye, wrap up warmly in one sentence.`;

async function callStart(env, reason = "", ring = "") {
  const lang = (await env.DB.get("chat_lang")) || "en";
  const ringing = await ringingNow(env);
  const theyCalled = ring && ringing?.id === ring;
  if (theyCalled) await env.DB.delete("ringing");
  const why = theyCalled ? `\n\nYOU called Alex and he just picked up. Why you called: ${ringing.reason || reason || "to check in"}. Open with that (briefly, warmly).` : "";
  const system = await buildSystem(env, lang, CALL_RULES + why);
  const now = Date.now();
  const res = await fetch("https://generativelanguage.googleapis.com/v1beta/auth_tokens", {
    method: "POST",
    headers: { "x-goog-api-key": env.GEMINI_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      uses: 1,
      expireTime: new Date(now + (CALL_MINUTES + 2) * 60000).toISOString(),
      newSessionExpireTime: new Date(now + 2 * 60000).toISOString(),
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.name) throw new Error(`couldn't start the call (${data.error?.message || res.status})`);
  return {
    token: data.name,
    models: LIVE_MODELS,
    voice: await currentVoice(env),
    maxMinutes: CALL_MINUTES,
    system,
    tools: CALL_TOOLS,
  };
}

// Runs a tool Haneul called during a voice call; the answer goes back to her.
export async function callTool(env, name, args) {
  const e = appEnv(env); // receipts from markDone etc. stay out of Telegram
  if (name === "add_todos") {
    const tasks = (args.tasks || []).filter((t) => t?.task).map((t) => ({ task: String(t.task), due: /^\d{4}-\d{2}-\d{2}$/.test(t.due || "") ? t.due : null }));
    const added = await saveFound(e, tasks);
    return { result: added.length ? `Added: ${formatTodos(added)}` : "Those were already on the list." };
  }
  if (name === "complete_todos") {
    const before = await getTodos(env);
    const nums = (args.numbers || []).map(Number).filter((n) => before.some((t) => t.id === n));
    if (!nums.length) return { result: "No to-dos with those numbers. Use list_todos to check." };
    await markDone(e, nums);
    return { result: `Ticked off. Still open: ${formatTodos(await getTodos(env)) || "nothing"}` };
  }
  if (name === "list_todos") {
    const todos = await getTodos(env);
    return { result: todos.length ? formatTodos(todos) : "No open to-dos." };
  }
  if (name === "get_schedule") {
    const iso = /^\d{4}-\d{2}-\d{2}$/.test(args.date || "") ? args.date : todayISO();
    const schedule = await env.DB.get("schedule", "json");
    if (!schedule) return { result: "The calendar hasn't synced yet." };
    if (schedule.until && iso > schedule.until) return { result: `I can only see the calendar until ${schedule.until}.` };
    const events = schedule.events.filter((x) => x.start.slice(0, 10) === iso);
    return { result: events.length ? events.map((x) => `[${x.tag}] ${formatEvent(x)}${x.end ? `-${x.end.slice(11, 16)}` : ""}`).join("\n") : "Nothing on the calendar that day." };
  }
  if (name === "add_calendar_event") {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(args.date || "") ? args.date : null;
    if (!date || !args.title) return { result: "Need a title and a date." };
    const timed = /^\d{2}:\d{2}$/.test(args.start || "");
    const startIso = timed ? `${date}T${args.start}:00-05:00` : date;
    const end = timed ? new Date(Date.parse(startIso) + (Number(args.minutes) || 60) * 60000).toISOString() : date;
    const r = await createCalendarEvent(env, { title: String(args.title), allDay: !timed, start: startIso, end, location: "" });
    if (r.ok) await startGithubJob(env, "sync-schedule.yml").catch(() => {});
    return { result: r.ok ? "Added to the calendar." : `Couldn't add it: ${r.error}` };
  }
  if (name === "now_playing") {
    const np = await nowPlaying(env).catch((err) => ({ error: err.message }));
    if (np.error) return { result: "Couldn't read Spotify right now." };
    return { result: np.title ? `${np.playing ? "Playing" : "Paused"}: \"${np.title}\" by ${np.artist}` : "Nothing playing." };
  }
  if (name === "search_web") {
    const lang = (await env.DB.get("chat_lang")) || "en";
    const found = await searchWeb(String(args.query || ""), lang).catch(() => "");
    return { result: (found || "No results found.").slice(0, 4000) };
  }
  return { result: `Unknown tool ${name}` };
}

// After the call: a summary goes into the chat history (so Telegram chat continues from it),
// the full transcript into the chat diary, and new facts into her long-term memory.
async function callEnd(env, transcript, seconds, nonce = "") {
  const lines = transcript
    .filter((t) => t && t.text && String(t.text).trim())
    .map((t) => `${t.who === "me" ? "Alex" : "Haneul"}: ${String(t.text).trim()}`)
    .slice(-200);
  if (!lines.length) return { ok: true };
  const text = lines.join("\n").slice(-12000);
  let summary = "";
  let facts = [];
  try {
    const r = parseJson(
      await gemini(env, [{ role: "user", parts: [{ text: `This is a voice call between Alex and his assistant Haneul.
Return JSON: {"summary": "2-3 sentences: what they talked about and anything decided or promised",
"remember": ["long-term facts about Alex worth remembering (preferences, plans, people, goals); [] if none"]}

${text}` }] }], { json: true })
    );
    summary = String(r.summary || "");
    facts = Array.isArray(r.remember) ? r.remember.filter((x) => typeof x === "string") : [];
  } catch (err) {
    console.error("call summary:", err.message);
  }
  const s = Math.max(0, Math.round(seconds));
  const length = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  const at = `${String(localHour()).padStart(2, "0")}:${String(localMinute()).padStart(2, "0")}`;
  const h = (await env.DB.get("chat", "json")) || [];
  h.push({ role: "user", parts: [{ text: `(Voice call in the Haneul app at ${at}, ${length}. What we talked about: ${summary || lines.slice(-6).join(" / ")})` }] });
  h.push({ role: "model", parts: [{ text: "(that was our call)" }] });
  await env.DB.put("chat", JSON.stringify(h.slice(-30)), { expirationTtl: 60 * 60 * 24 * 7 });
  await logChatDay(env, transcript.filter((t) => t?.text).map((t) => ({ who: t.who === "me" ? "Alex" : "Haneul", text: `(call) ${t.text}` }))).catch(() => {});
  if (facts.length) await rememberMany(env, facts, "call").catch(() => {});
  await feedAddApp(env, { who: "note", text: `📞 Call · ${length} · ${at}`, src: `app:${nonce}` });
  const calls = (await env.DB.get("app_calls", "json")) || [];
  calls.push({ at: new Date().toISOString(), seconds });
  await env.DB.put("app_calls", JSON.stringify(calls.slice(-100)));
  return { ok: true, summary };
}
