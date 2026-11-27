import { todayISO } from "./dates.js";
import { send } from "./telegram.js";

// ---------- Focus sessions ----------
// "/focus 45 AP physics" (or the Focus buttons in the app) starts a session:
//   - a focus playlist on his Spotify (or just resumes what he had), if Spotify is connected
//   - Haneul holds her random texts until it ends, and phone focus blocks distracting apps
//   - at the end the minutes are logged (AP Physics minutes go to the AP log too) and she checks in
// "/focus stop" ends it early (logs what he did if it was 5+ minutes). "/focus playlist <spotify link>" picks the music.
// KV: focus {start, until, min, label}, focus_log [{date, min, label}], focus_playlist "spotify:playlist:…"

export const DEFAULT_PLAYLIST = "spotify:playlist:37i9dQZF1DWZeKCadgRdKQ"; // Spotify's "Deep Focus"
const MAX_MIN = 180;

export async function getFocus(env) {
  const f = await env.DB.get("focus", "json");
  return f && f.until > Date.now() ? f : null;
}
export async function focusActive(env) {
  return !!(await getFocus(env));
}

// "spotify:playlist:…", or a playlist link → the uri
export function playlistUri(s) {
  s = String(s || "").trim();
  if (/^spotify:playlist:[A-Za-z0-9]+$/.test(s)) return s;
  const m = s.match(/open\.spotify\.com\/(?:intl-[a-z-]+\/)?playlist\/([A-Za-z0-9]+)/);
  return m ? `spotify:playlist:${m[1]}` : null;
}

// What is the session for? AP Physics minutes also go to the AP log.
export const isAp = (label) => /\b(ap|physics|f[ií]sica)\b/i.test(String(label || ""));

async function playMusic(env) {
  try {
    const { spotifyToken, sp } = await import("./music.js");
    const token = await spotifyToken(env);
    const uri = (await env.DB.get("focus_playlist")) || DEFAULT_PLAYLIST;
    try {
      await sp(token, "/me/player/play", { method: "PUT", body: JSON.stringify({ context_uri: uri }) });
      return "playing your focus playlist";
    } catch (err) {
      if (/no active device|NO_ACTIVE_DEVICE|404/i.test(err.message)) return "open Spotify on a device and I'll handle the music next time";
      await sp(token, "/me/player/play", { method: "PUT" }); // the playlist isn't playable: just resume
      return "resumed your music";
    }
  } catch {
    return ""; // Spotify not connected (or not Premium): no music, no fuss
  }
}

export async function startFocus(env, { minutes, label } = {}) {
  const min = Math.max(5, Math.min(MAX_MIN, Math.round(Number(minutes) || 45)));
  const f = { start: Date.now(), until: Date.now() + min * 60000, min, label: String(label || "Deep work").slice(0, 60) };
  await env.DB.put("focus", JSON.stringify(f), { expirationTtl: min * 60 + 3600 });
  f.music = await playMusic(env);
  return f;
}

async function logFocus(env, f, minutes) {
  if (minutes < 5) return 0;
  const log = (await env.DB.get("focus_log", "json")) || [];
  log.push({ date: todayISO(), min: minutes, label: f.label });
  await env.DB.put("focus_log", JSON.stringify(log.slice(-400)));
  if (isAp(f.label)) {
    const { apLog } = await import("./ap.js");
    await apLog(env, minutes, { note: "focus session" }).catch(() => {});
  }
  return minutes;
}

export async function stopFocus(env) {
  const f = await env.DB.get("focus", "json");
  if (!f) return { minutes: 0 };
  await env.DB.delete("focus");
  const minutes = Math.min(f.min, Math.round((Math.min(Date.now(), f.until) - f.start) / 60000));
  return { minutes: await logFocus(env, f, minutes), label: f.label };
}

// Every tick: a session that ran out is logged, and she checks in.
export async function runFocus(env) {
  const f = await env.DB.get("focus", "json");
  if (!f || f.until > Date.now()) return;
  await env.DB.delete("focus");
  const minutes = await logFocus(env, f, f.min);
  await env.BG_JOBS.send({ kind: "say", task: `Alex just finished a ${minutes}-minute focus session (${f.label}). Text him 1 short message like a friend: nice work, ${isAp(f.label) ? "the minutes went to his AP log, " : ""}suggest a 5-10 minute break (water, stretch, no doomscrolling).` });
}

export function focusLine(f) {
  if (!f) return "";
  const left = Math.max(1, Math.ceil((f.until - Date.now()) / 60000));
  return `FOCUS SESSION: Alex is in a focus session right now (${f.label}, ${left} min left). Keep replies very short, and nudge him back to work if he's just chatting.`;
}

export async function focusMinutes(env, from) {
  return ((await env.DB.get("focus_log", "json")) || []).filter((x) => x.date >= from);
}

// /focus · /focus 45 AP physics · /focus stop · /focus playlist <link>
export async function onFocusCommand(env, arg) {
  const a = String(arg || "").trim();
  if (/^(stop|end|done|para|parar)\b/i.test(a)) {
    const r = await stopFocus(env);
    return send(env, r.minutes ? `✅ Focus done: ${r.minutes} min of ${r.label} logged.` : "No focus session was running (or it was under 5 minutes, so nothing was logged).");
  }
  if (/^playlist\b/i.test(a)) {
    const uri = playlistUri(a.replace(/^playlist\s*/i, ""));
    if (!uri) return send(env, "Send /focus playlist followed by a Spotify playlist link.");
    await env.DB.put("focus_playlist", uri);
    return send(env, "🎧 Got it: that's your focus playlist now.");
  }
  const cur = await getFocus(env);
  if (cur && !a) return send(env, `🎯 Focus: ${cur.label}, ${Math.ceil((cur.until - Date.now()) / 60000)} min left. /focus stop to end it.`);
  const m = a.match(/^(\d{1,3})\s*(?:m|min|mins|minutes|minutos)?\s*(.*)$/i);
  const f = await startFocus(env, { minutes: m ? m[1] : 45, label: (m ? m[2] : a) || "Deep work" });
  const end = new Date(f.until).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/Lima" });
  return send(env, `🎯 Focus on: ${f.label} · ${f.min} min (until ${end}).\nI'll hold my texts and block distracting apps.${f.music ? ` 🎧 ${f.music[0].toUpperCase() + f.music.slice(1)}.` : ""}\n/focus stop to end early.`);
}
