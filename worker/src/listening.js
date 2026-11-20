import { spotifyToken } from "./music.js";
import { send } from "./telegram.js";

// ---------- What Alex is listening to (Spotify) ----------
// - nowPlaying(): the song on right now (any device), read live when Haneul answers.
// - Every 5 minutes the cron saves newly finished songs (Spotify "recently played") into D1
//   table `listens`, so she knows today's repeats and top artists, not just the last 50 songs.
// Needs the scopes user-read-currently-playing, user-read-playback-state, user-read-recently-played
// (added 2026-11-10: an older connection gets "reconnect with /spotify").

const NEEDS_RECONNECT = /scope|permission|403|401/i;
// { token, exp, connection } per worker instance, so a chat message doesn't always refresh the login.
// Tied to the connection (a reconnect with new permissions gets a new login right away).
let cached = null;

async function token(env) {
  const s = (await env.DB.get("spotify", "json")) || {};
  const connection = s.connected_at || s.refresh_token || "";
  if (cached && cached.exp > Date.now() && cached.connection === connection) return cached.token;
  const t = await spotifyToken(env);
  cached = { token: t, exp: Date.now() + 50 * 60 * 1000, connection };
  return t;
}

async function api(env, path, retry = true) {
  const res = await fetch(`https://api.spotify.com/v1${path}`, {
    headers: { Authorization: `Bearer ${await token(env)}` },
    signal: AbortSignal.timeout(4000),
  });
  // a remembered login can be from before a reconnect (missing permissions) or expired: get a fresh one once
  if ((res.status === 401 || res.status === 403) && retry && cached) {
    cached = null;
    return api(env, path, false);
  }
  if (res.status === 204) return null; // nothing playing
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${res.status} ${data.error?.message || ""}`.trim());
  return data;
}

const artistsOf = (t) => (t?.artists || []).map((a) => a.name).join(", ");
const mmss = (ms) => `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")}`;

export async function nowPlaying(env) {
  const d = await api(env, "/me/player/currently-playing?additional_types=episode");
  if (!d || !d.item) return { playing: false };
  const t = d.item;
  return {
    playing: !!d.is_playing,
    kind: d.currently_playing_type === "episode" ? "podcast" : "song",
    title: t.name,
    artist: t.type === "episode" ? t.show?.name || "" : artistsOf(t),
    album: t.album?.name || "",
    progress: d.progress_ms || 0,
    duration: t.duration_ms || 0,
    url: t.external_urls?.spotify || "",
    image: (t.album?.images || t.images || []).slice(-1)[0]?.url || "",
  };
}

// Saves songs finished since the last check (called by the 5-minute cron).
export async function logListens(env) {
  if (!env.FEED || !(await env.DB.get("spotify"))) return 0;
  const last = Number(await env.DB.get("listens_after")) || Date.now() - 6 * 3600 * 1000;
  let d;
  try {
    d = await api(env, `/me/player/recently-played?limit=50&after=${last}`);
  } catch (err) {
    if (NEEDS_RECONNECT.test(err.message)) return 0; // old connection without the new scopes
    throw err;
  }
  const items = (d?.items || []).filter((i) => i.track && Date.parse(i.played_at) > last);
  if (!items.length) return 0;
  const stmt = env.FEED.prepare("INSERT INTO listens (at, track, artist, album, track_id, ms) VALUES (?, ?, ?, ?, ?, ?)");
  await env.FEED.batch(items.map((i) => stmt.bind(Date.parse(i.played_at), i.track.name, artistsOf(i.track), i.track.album?.name || "", i.track.id || "", i.track.duration_ms || null)));
  await env.DB.put("listens_after", String(Math.max(...items.map((i) => Date.parse(i.played_at)))));
  // keep ~90 days
  await env.FEED.prepare("DELETE FROM listens WHERE at < ?").bind(Date.now() - 90 * 86400000).run();
  return items.length;
}

async function listenStats(env, sinceMs) {
  if (!env.FEED) return null;
  const songs = (await env.FEED.prepare("SELECT track, artist, COUNT(*) AS n FROM listens WHERE at > ? GROUP BY track, artist ORDER BY n DESC LIMIT 5").bind(sinceMs).all()).results || [];
  const artists = (await env.FEED.prepare("SELECT artist, COUNT(*) AS n FROM listens WHERE at > ? GROUP BY artist ORDER BY n DESC LIMIT 5").bind(sinceMs).all()).results || [];
  const total = (await env.FEED.prepare("SELECT COUNT(*) AS n FROM listens WHERE at > ?").bind(sinceMs).first())?.n || 0;
  return { songs, artists, total };
}

const startOfTodayLima = () => {
  const now = new Date(Date.now() - 5 * 3600 * 1000); // UTC-5
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) + 5 * 3600 * 1000;
};

// For Haneul's prompt (chat, check-ins, calls). Never slows her down much: 4 s timeout, errors → "".
export async function listeningContext(env) {
  if (!(await env.DB.get("spotify"))) return "";
  const lines = [];
  try {
    const np = await nowPlaying(env);
    if (np.title) {
      lines.push(`Spotify ${np.playing ? "RIGHT NOW" : "(paused)"}: "${np.title}" by ${np.artist}${np.album && np.kind === "song" ? ` (album ${np.album})` : ""}${np.kind === "podcast" ? " [podcast]" : ""}, ${mmss(np.progress)} of ${mmss(np.duration)}.`);
    } else lines.push("Spotify: nothing playing right now.");
  } catch (err) {
    if (NEEDS_RECONNECT.test(err.message)) return "Spotify: connected without the listening permission (he needs to reconnect with /spotify).";
    return "";
  }
  try {
    const s = await listenStats(env, startOfTodayLima());
    if (s?.total) {
      const repeats = s.songs.filter((x) => x.n >= 3).map((x) => `"${x.track}" by ${x.artist} (${x.n}x)`);
      lines.push(`Today he played ${s.total} song(s). Top artists today: ${s.artists.map((a) => `${a.artist} (${a.n})`).join(", ")}.${repeats.length ? ` On repeat: ${repeats.join(", ")}.` : ""}`);
    }
    const w = await listenStats(env, Date.now() - 7 * 86400000);
    if (w?.total) lines.push(`This week's top artists: ${w.artists.map((a) => a.artist).join(", ")}.`);
  } catch {}
  return lines.join("\n");
}

// /np: what's on + today's music
export async function onListeningCommand(env) {
  if (!(await env.DB.get("spotify"))) return send(env, "Spotify isn't connected. Send /spotify first.");
  let np;
  try {
    np = await nowPlaying(env);
  } catch (err) {
    if (NEEDS_RECONNECT.test(err.message)) return send(env, "I need one more Spotify permission to see what you're playing. Send /spotify and tap the link to reconnect.");
    throw err;
  }
  const parts = [np.title ? `🎧 ${np.playing ? "Now playing" : "Paused"}: ${np.title} · ${np.artist}${np.url ? `\n${np.url}` : ""}` : "🎧 Nothing playing right now."];
  const s = await listenStats(env, startOfTodayLima()).catch(() => null);
  if (s?.total) parts.push(`Today: ${s.total} songs · top: ${s.artists.slice(0, 3).map((a) => a.artist).join(", ")}`);
  return send(env, parts.join("\n\n"), { link_preview_options: { is_disabled: true } });
}

// "Put on some music": Spotify hides playlists from search for new developer apps (every result
// comes back null), so Haneul makes the mix herself: she picks songs for the moment + his taste,
// checks each one exists, puts them in his "Lock in · Haneul" playlist, then starts it on his
// active device (Spotify Premium + user-modify-playback-state) or sends the link.
const LOCKIN_NAME = "Lock in · Haneul";
export async function putOnMusic(env, query) {
  if (!(await env.DB.get("spotify"))) return send(env, "🎧 Spotify isn't connected yet, so I can't put music on. Send /spotify to connect it.");
  const want = String(query || "lofi focus").slice(0, 80);
  const tk = await token(env);
  const sp = async (path, options = {}) => {
    const res = await fetch(`https://api.spotify.com/v1${path}`, { ...options, headers: { Authorization: `Bearer ${tk}`, "Content-Type": "application/json" }, signal: AbortSignal.timeout(8000) });
    if (res.status === 204) return {};
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error?.message || String(res.status)), { status: res.status });
    return data;
  };
  const top = await sp("/me/top/artists?time_range=short_term&limit=8").then((r) => (r.items || []).map((x) => x.name)).catch(() => []);
  const { gemini } = await import("./gemini.js");
  const { parseJsonList } = await import("./agenda.js");
  const norm = (x) => String(x || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  // a song counts if Spotify finds it and one of its artists matches (loosely: "The Satellites" = "the satellites", "Mira" in "Mira, Jae")
  const check = async (x) => {
    try {
      const items = (await sp(`/search?type=track&limit=3&q=${encodeURIComponent(`${x.track} ${x.artist}`)}`)).tracks?.items || [];
      const want = norm(x.artist).split(/ (?:and|feat|ft|x) | /)[0];
      const t = items.find((it) => it.artists.some((a) => { const n = norm(a.name); return n.includes(want) || want.includes(n); }));
      return t?.uri || null;
    } catch { return null; }
  };
  const uris = [];
  // round 1: the mix; round 2 (if too few were real): well-known songs, which Spotify always has
  for (const round of [1, 2]) {
    if (uris.length >= 8) break;
    let picks = [];
    try {
      picks = parseJsonList(await gemini(env, [{ role: "user", parts: [{ text: `Pick ${round === 1 ? 18 : 20} real, existing songs (exact titles, main artist only) for: "${want}".
If it names artists, include them. If it mixes styles (e.g. lo-fi + K-pop + an artist), mix them. For focus/study prefer calm
tracks with few lyrics. Lean toward this listener's taste where it fits: ${top.join(", ") || "K-pop, lo-fi"}.${round === 2 ? "\nOnly well-known, popular songs this time (they must exist on Spotify)." : ""}
Already picked: ${uris.length} songs.
Return JSON: [{"track": "...", "artist": "..."}]` }] }], { json: true }));
    } catch {}
    for (const u of await Promise.all(picks.slice(0, 20).map(check))) if (u && !uris.includes(u)) uris.push(u);
  }
  uris.splice(15);
  if (uris.length < 4) return send(env, `🎧 Couldn't put together a "${want}" mix right now. Tell me an artist or a genre and I'll try again.`);

  // the playlist (made once, refilled every time)
  const saved = (await env.DB.get("spotify", "json")) || {};
  let pl = saved.lockin;
  const create = async () => {
    const c = await sp("/me/playlists", { method: "POST", body: JSON.stringify({ name: LOCKIN_NAME, public: false, description: "Music Haneul puts on when you ask her. Refilled every time." }) });
    pl = { id: c.id, url: c.external_urls?.spotify, uri: c.uri || `spotify:playlist:${c.id}` };
    await env.DB.put("spotify", JSON.stringify({ ...((await env.DB.get("spotify", "json")) || {}), lockin: pl }));
  };
  if (!pl) await create();
  try {
    await sp(`/playlists/${pl.id}/items`, { method: "PUT", body: JSON.stringify({ uris }) });
  } catch (err) {
    if (err.status !== 404) throw err;
    await create(); // deleted on Spotify: make a new one
    await sp(`/playlists/${pl.id}/items`, { method: "PUT", body: JSON.stringify({ uris }) });
  }
  // play it (Spotify Premium only); otherwise the link
  const play = (t) => fetch("https://api.spotify.com/v1/me/player/play", {
    method: "PUT", headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" },
    body: JSON.stringify({ context_uri: pl.uri || `spotify:playlist:${pl.id}` }), signal: AbortSignal.timeout(8000),
  });
  try {
    let res = await play(tk);
    if (res.status === 401 || res.status === 403) { cached = null; res = await play(await token(env)); } // a login from before the reconnect
    if (!(res.ok || res.status === 204)) {
      const why = await res.json().catch(() => ({}));
      console.error("spotify play:", res.status, why.error?.reason || why.error?.message || "");
      throw Object.assign(new Error(why.error?.message || String(res.status)), { status: res.status, reason: why.error?.reason });
    }
    return send(env, `▶️ Playing your "${want}" mix (${uris.length} songs) on Spotify. Lock in 🔒`);
  } catch (err) {
    const how = err.status === 404 ? "open Spotify on your phone or PC first, then tap" : err.reason === "PREMIUM_REQUIRED" ? "playing it for you needs Spotify Premium, so tap" : "tap to play";
    return send(env, `🎧 Made you a "${want}" mix (${uris.length} songs), ${how}:\n${pl.url}`, { link_preview_options: { is_disabled: true } });
  }
}

// A lyrics link for the song he's playing (Genius search; Spotify also shows lyrics under Now Playing).
export async function sendLyricsLink(env) {
  if (!(await env.DB.get("spotify"))) return;
  const np = await nowPlaying(env).catch(() => null);
  if (!np?.title || np.kind === "podcast") return;
  const q = encodeURIComponent(`${np.artist.split(",")[0]} ${np.title.replace(/\s*[-(].*$/, "")}`);
  return send(env, `🎤 "${np.title}" by ${np.artist}: lyrics
https://genius.com/search?q=${q}
(Spotify shows them too: scroll down on the Now Playing screen)`, { link_preview_options: { is_disabled: true } });
}

// ---------- Weekly "Wrapped" (Sundays) ----------
// From the songs logged every 5 minutes (D1 listens): plays, minutes, top songs/artists, new artists,
// busiest day, compared with the week before; refills his "Your week · Haneul" playlist with the top songs.
const WEEK_PLAYLIST = "Your week · Haneul";
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export async function weekStats(env, endMs = Date.now()) {
  const from = endMs - 7 * 86400000;
  const rows = (await env.FEED.prepare("SELECT at, track, artist, track_id FROM listens WHERE at > ? AND at <= ? ORDER BY at").bind(from, endMs).all()).results || [];
  const before = (await env.FEED.prepare("SELECT COUNT(*) AS n FROM listens WHERE at > ? AND at <= ?").bind(from - 7 * 86400000, from).first())?.n || 0;
  const older = (await env.FEED.prepare("SELECT DISTINCT artist FROM listens WHERE at <= ? AND at > ?").bind(from, from - 28 * 86400000).all()).results || [];
  const firstLog = (await env.FEED.prepare("SELECT MIN(at) AS first FROM listens WHERE at > ?").bind(0).first().catch(() => null))?.first || from;
  const enoughHistory = firstLog <= from - 6 * 86400000; // logging started at least a week before this week
  const count = (key) => {
    const m = new Map();
    for (const r of rows) m.set(key(r), (m.get(key(r)) || 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  };
  const songs = count((r) => `${r.track}|${r.artist}|${r.track_id}`).map(([k, n]) => { const [track, artist, id] = k.split("|"); return { track, artist, id, n }; });
  const artists = count((r) => r.artist.split(",")[0].trim()).map(([artist, n]) => ({ artist, n }));
  const oldSet = new Set(older.map((o) => o.artist.split(",")[0].trim()));
  const newArtists = enoughHistory ? artists.filter((a) => !oldSet.has(a.artist)).slice(0, 5) : [];
  const byDay = count((r) => new Date(r.at - 5 * 3600000).getUTCDay()).map(([d, n]) => ({ day: DAY_NAMES[d], n }));
  const late = rows.filter((r) => { const h = new Date(r.at - 5 * 3600000).getUTCHours(); return h >= 22 || h < 5; }).length;
  return { plays: rows.length, before, songs, artists, newArtists, busiest: byDay[0] || null, late, ids: [...new Set(rows.map((r) => r.track_id).filter(Boolean))] };
}

async function minutesFor(env, endMs = Date.now()) {
  // each song's logged length; songs logged before lengths were saved count ~3.3 min
  const r = await env.FEED.prepare("SELECT SUM(ms) AS ms, COUNT(ms) AS known, COUNT(*) AS plays FROM listens WHERE at > ? AND at <= ?").bind(endMs - 7 * 86400000, endMs).first();
  return Math.round((r?.ms || 0) / 60000 + ((r?.plays || 0) - (r?.known || 0)) * 3.3);
}

async function fillWeekPlaylist(env, uris) {
  if (uris.length < 3) return "";
  const tk = await token(env);
  const sp = async (path, options = {}) => {
    const res = await fetch(`https://api.spotify.com/v1${path}`, { ...options, headers: { Authorization: `Bearer ${tk}`, "Content-Type": "application/json" }, signal: AbortSignal.timeout(8000) });
    if (res.status === 204) return {};
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error?.message || String(res.status)), { status: res.status });
    return data;
  };
  const saved = (await env.DB.get("spotify", "json")) || {};
  let pl = saved.week;
  const create = async () => {
    const c = await sp("/me/playlists", { method: "POST", body: JSON.stringify({ name: WEEK_PLAYLIST, public: false, description: "Your most played songs of the week, refilled every Sunday by Haneul." }) });
    pl = { id: c.id, url: c.external_urls?.spotify };
    await env.DB.put("spotify", JSON.stringify({ ...((await env.DB.get("spotify", "json")) || {}), week: pl }));
  };
  if (!pl) await create();
  try {
    await sp(`/playlists/${pl.id}/items`, { method: "PUT", body: JSON.stringify({ uris }) });
  } catch (err) {
    if (err.status !== 404) throw err;
    await create();
    await sp(`/playlists/${pl.id}/items`, { method: "PUT", body: JSON.stringify({ uris }) });
  }
  return pl.url || "";
}

export async function sendWrapped(env, haneulSays, { manual = false } = {}) {
  if (!env.FEED || !(await env.DB.get("spotify"))) return manual ? send(env, "Spotify isn't connected, so I have no music to wrap. Send /spotify first.") : null;
  const s = await weekStats(env);
  if (s.plays < 5) return manual ? send(env, "🎧 Not enough music logged this week for a wrap-up yet. Keep listening!") : null;
  const minutes = await minutesFor(env);
  const diff = s.before ? Math.round(((s.plays - s.before) / s.before) * 100) : null;
  const playlistUrl = await fillWeekPlaylist(env, s.songs.slice(0, 25).map((x) => x.id).filter(Boolean).map((id) => `spotify:track:${id}`)).catch((err) => (console.error("week playlist:", err.message), ""));
  const lines = [
    "🎧 Your week in music",
    `${s.plays} songs · ~${minutes >= 120 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${minutes} min`}${diff !== null ? ` · ${diff >= 0 ? "▲" : "▼"} ${Math.abs(diff)}% vs last week` : ""}`,
    "",
    "🔁 Top songs",
    ...s.songs.slice(0, 5).map((x, i) => `${i + 1}. ${x.track} · ${x.artist} (${x.n}×)`),
    "",
    "🎤 Top artists",
    ...s.artists.slice(0, 5).map((x, i) => `${i + 1}. ${x.artist} (${x.n})`),
  ];
  if (s.newArtists.length) lines.push("", `✨ New this week: ${s.newArtists.map((a) => a.artist).join(", ")}`);
  if (s.busiest) lines.push(`📅 Busiest day: ${s.busiest.day} (${s.busiest.n} songs)${s.late ? ` · 🌙 ${s.late} after 22:00` : ""}`);
  if (playlistUrl) lines.push("", `▶️ ${WEEK_PLAYLIST}: your top songs, in one playlist\n${playlistUrl}`);
  await send(env, lines.join("\n"), { link_preview_options: { is_disabled: true } });
  await env.DB.put("wrapped_last", JSON.stringify({ at: Date.now(), plays: s.plays, top: s.songs[0]?.track || "" }));
  if (haneulSays) {
    await haneulSays(env, `Alex just got his weekly music recap. Top songs: ${s.songs.slice(0, 3).map((x) => `${x.track} by ${x.artist} (${x.n}x)`).join("; ")}. Top artists: ${s.artists.slice(0, 3).map((x) => x.artist).join(", ")}. New artists: ${s.newArtists.map((a) => a.artist).join(", ") || "none"}. ${s.late ? `${s.late} songs after 22:00 (past his bedtime).` : ""} ${diff !== null ? `${diff}% vs last week.` : ""}
React to THIS WEEK'S recap (his top song and artists above), NOT to whatever is playing on Spotify right now, in 1-2 short
texts like a music-loving friend: one fun observation or tease about the week (his most-played song, his top artist, late-night
listening), maybe a question. No lists, no repeating the numbers.`, { maxTexts: 2 }).catch(() => {});
  }
}
