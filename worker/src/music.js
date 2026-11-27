import { parseJsonList } from "./agenda.js";
import { shortDate } from "./ap.js";
import { MODELS_SMART } from "./config.js";
import { addDaysISO, todayISO } from "./dates.js";
import { gemini } from "./gemini.js";
import { send, typing } from "./telegram.js";

// ---------- Spotify: weekly music ----------
//
// Every Friday at MUSIC_HOUR: new releases (last 14 days) from the artists you
// listen to most, plus ~12 picks Gemini chooses from your taste. Every pick is
// checked against Spotify search (so no made-up songs) and saved into a private
// playlist "Weekly Picks · Haneul".
//
// Note: Spotify no longer gives new apps its own recommendation API, which is why
// Gemini picks the songs and Spotify only confirms they exist.

export const PLAYLIST_NAME = "Weekly Picks · Haneul";
// listening scopes (2026-11-10): Haneul knows what Alex is playing (listening.js)
export const SPOTIFY_SCOPES = "user-top-read playlist-modify-private playlist-modify-public user-read-currently-playing user-read-playback-state user-read-recently-played user-modify-playback-state";

export async function spotifyConnectLink(env) {
  if (!env.SPOTIFY_CLIENT_ID || !env.SPOTIFY_CLIENT_SECRET) {
    return send(env, "Spotify isn't set up on the bot yet (the Spotify app keys are missing).");
  }
  const t = crypto.randomUUID();
  await env.DB.put("spotify_state", t, { expirationTtl: 600 });
  return send(env, `🎧 Tap to connect Spotify (link works for 10 minutes):\n${env.PUBLIC_URL}/spotify/login?t=${t}`, {
    link_preview_options: { is_disabled: true },
  });
}

export async function spotifyRoutes(url, env) {
  const redirectUri = `${env.PUBLIC_URL}/spotify/callback`;
  const state = await env.DB.get("spotify_state");

  if (url.pathname === "/spotify/login") {
    if (!state || url.searchParams.get("t") !== state) return htmlPage("This link expired. Send /spotify to the bot again.");
    const auth = new URL("https://accounts.spotify.com/authorize");
    auth.search = new URLSearchParams({
      client_id: env.SPOTIFY_CLIENT_ID,
      response_type: "code",
      redirect_uri: redirectUri,
      scope: SPOTIFY_SCOPES,
      state,
    }).toString();
    return Response.redirect(auth.toString(), 302);
  }

  // /spotify/callback
  if (!state || url.searchParams.get("state") !== state) return htmlPage("This link expired. Send /spotify to the bot again.");
  if (url.searchParams.get("error")) return htmlPage(`Spotify said: ${url.searchParams.get("error")}. Send /spotify to try again.`);
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${btoa(`${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`)}`,
    },
    body: new URLSearchParams({ grant_type: "authorization_code", code: url.searchParams.get("code") || "", redirect_uri: redirectUri }),
  });
  const data = await res.json();
  if (!res.ok || !data.refresh_token) return htmlPage(`Couldn't connect (${data.error_description || data.error || res.status}).`);
  // keep her playlists (Weekly Picks, Lock in) when reconnecting; connected_at resets remembered logins
  const before = (await env.DB.get("spotify", "json")) || {};
  await env.DB.put("spotify", JSON.stringify({ ...before, refresh_token: data.refresh_token, scope: data.scope || "", connected_at: Date.now() }));
  await env.DB.delete("spotify_state");
  await send(env, "🎧 Spotify connected! I can see what you're listening to now (/np), and your weekly music arrives on Fridays at 15:00. Send /music to get it now.");
  return htmlPage("✅ Spotify connected. You can close this tab and go back to Telegram.");
}

export function htmlPage(message) {
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">` +
      `<body style="font-family:sans-serif;padding:40px;text-align:center;font-size:20px">${message}</body>`,
    { headers: { "Content-Type": "text/html; charset=utf-8" } }
  );
}

export async function spotifyToken(env) {
  const s = await env.DB.get("spotify", "json");
  if (!s?.refresh_token) throw new Error("Spotify isn't connected yet. Send /spotify");
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${btoa(`${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`)}`,
    },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: s.refresh_token }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Spotify login expired (${data.error}). Send /spotify to reconnect`);
  if (data.refresh_token && data.refresh_token !== s.refresh_token) {
    await env.DB.put("spotify", JSON.stringify({ ...s, refresh_token: data.refresh_token }));
  }
  return data.access_token;
}

export async function sp(token, path, options = {}) {
  const res = await fetch(`https://api.spotify.com/v1${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(options.headers || {}) },
  });
  if (res.status === 204) return {};
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Spotify ${path.split("?")[0]}: ${data.error?.message || res.status}`);
  return data;
}

export async function runMusic(env) {
  await typing(env);
  const token = await spotifyToken(env);
  const history = (await env.DB.get("music_history", "json")) || { albums: [], tracks: [] };

  // 1. Your taste: top artists (last month + last 6 months) and top tracks.
  const [shortArtists, midArtists, topTracks] = await Promise.all([
    sp(token, "/me/top/artists?time_range=short_term&limit=10"),
    sp(token, "/me/top/artists?time_range=medium_term&limit=15"),
    sp(token, "/me/top/tracks?time_range=short_term&limit=20"),
  ]);
  const artists = [];
  for (const a of [...(shortArtists.items || []), ...(midArtists.items || [])]) {
    if (!artists.some((x) => x.id === a.id)) artists.push(a);
  }
  if (!artists.length) return send(env, "🎧 Spotify doesn't have enough listening history for you yet. Try again next week!");
  const known = (topTracks.items || []).map((t) => `${t.name} — ${t.artists.map((a) => a.name).join(", ")}`);

  // 2. New releases from your top 8 artists in the last 14 days.
  const since = addDaysISO(todayISO(), -14);
  const albumLists = await Promise.all(
    artists.slice(0, 8).map((a) =>
      sp(token, `/artists/${a.id}/albums?include_groups=album,single&limit=5`).then(
        (r) => (r.items || []).map((al) => ({ ...al, mainArtist: a.name })),
        () => []
      )
    )
  );
  const releases = [];
  for (const al of albumLists.flat()) {
    if ((al.release_date || "") < since || history.albums.includes(al.id) || releases.some((r) => r.id === al.id)) continue;
    releases.push({ id: al.id, name: al.name, artist: al.mainArtist, type: al.album_type, date: al.release_date, url: al.external_urls?.spotify });
  }

  // 3. Picks: Gemini suggests, Spotify search confirms each one is real.
  const prompt = `You are a music curator. Suggest 14 songs this listener will probably love but likely hasn't heard.

Their top artists right now: ${artists.slice(0, 15).map((a) => a.name + (a.genres?.length ? ` (${a.genres.slice(0, 2).join(", ")})` : "")).join("; ")}
Songs they're playing a lot: ${known.join("; ")}
Already recommended before (don't repeat): ${history.tracks.slice(-80).join("; ") || "none"}

Rules:
- Mostly artists NOT in their top list, with a similar sound or vibe. At most 3 songs by artists from the list.
- Mix well-known and lesser-known songs, and include several from 2025-2026.
- Real, existing songs only, with exact titles.
Return JSON: [{"track": "...", "artist": "...", "why": "max 10 words"}]`;
  let suggestions = [];
  try {
    suggestions = parseJsonList(
      await gemini(env, [{ role: "user", parts: [{ text: prompt }] }], { json: true, models: MODELS_SMART })
    );
  } catch (err) {
    console.error("music picks failed:", err.message);
  }
  const found = await Promise.all(
    suggestions.slice(0, 14).map(async (s) => {
      try {
        const q = encodeURIComponent(`track:${s.track} artist:${s.artist}`);
        const t = (await sp(token, `/search?type=track&limit=1&q=${q}`)).tracks?.items?.[0];
        const artistOk = t && t.artists.some((a) => a.name.toLowerCase().includes(String(s.artist).toLowerCase().split(/[,&]/)[0].trim()));
        return artistOk ? { uri: t.uri, url: t.external_urls?.spotify, name: t.name, artist: t.artists[0].name, why: s.why } : null;
      } catch {
        return null;
      }
    })
  );
  const picks = found.filter(Boolean).filter((p, i, all) => all.findIndex((x) => x.uri === p.uri) === i).slice(0, 12);

  // 4. Put the picks in a private playlist (replaced every week).
  let playlistUrl = "";
  let playlistError = "";
  if (picks.length) {
    try {
      const s = (await env.DB.get("spotify", "json")) || {};
      let playlist = s.playlist;
      if (!playlist) {
        // New Spotify apps must use /me/playlists (the older /users/{id}/playlists returns 403).
        const created = await sp(token, "/me/playlists", {
          method: "POST",
          body: JSON.stringify({ name: PLAYLIST_NAME, public: false, description: "New songs picked for you every Friday by Haneul." }),
        });
        playlist = { id: created.id, url: created.external_urls?.spotify, name: PLAYLIST_NAME };
        await env.DB.put("spotify", JSON.stringify({ ...s, playlist }));
      } else if (playlist.name !== PLAYLIST_NAME) {
        // Playlist made before the bot had a name: rename it once (not critical if it fails).
        await sp(token, `/playlists/${playlist.id}`, { method: "PUT", body: JSON.stringify({ name: PLAYLIST_NAME }) })
          .then(() => env.DB.put("spotify", JSON.stringify({ ...s, playlist: { ...playlist, name: PLAYLIST_NAME } })))
          .catch((err) => console.error("playlist rename:", err.message));
      }
      // Same for /items (the older /tracks endpoint returns 403 for new apps).
      const fill = (id) => sp(token, `/playlists/${id}/items`, { method: "PUT", body: JSON.stringify({ uris: picks.map((p) => p.uri) }) });
      try {
        await fill(playlist.id);
      } catch (err) {
        if (!/not found/i.test(err.message)) throw err;
        // The playlist was deleted on Spotify: make a new one and use that from now on.
        const created = await sp(token, "/me/playlists", {
          method: "POST",
          body: JSON.stringify({ name: PLAYLIST_NAME, public: false, description: "New songs picked for you every Friday by Haneul." }),
        });
        playlist = { id: created.id, url: created.external_urls?.spotify, name: PLAYLIST_NAME };
        await env.DB.put("spotify", JSON.stringify({ ...s, playlist }));
        await fill(playlist.id);
      }
      playlistUrl = playlist.url;
    } catch (err) {
      console.error("playlist failed:", err.message);
      playlistError = err.message;
    }
  }

  // 5. Message + remember what was sent.
  const parts = [`🎧 Your weekly music · ${shortDate(todayISO())}`];
  if (releases.length) {
    parts.push(
      "🆕 New from artists you love\n" +
        releases.slice(0, 8).map((r) => `• ${r.artist}: ${r.name} (${r.type}, ${shortDate(r.date)})\n  ${r.url}`).join("\n")
    );
  }
  if (picks.length) {
    parts.push("✨ Picked for you\n" + picks.map((p, i) => `${i + 1}. ${p.name} · ${p.artist}\n   ${p.why}`).join("\n"));
  }
  if (playlistUrl) parts.push(`▶️ All picks in one playlist:\n${playlistUrl}`);
  else if (playlistError) parts.push(`⚠️ Couldn't update the playlist (${playlistError}).`);
  if (!releases.length && !picks.length) parts.push("Couldn't find anything new this week. Try /music again later.");
  await send(env, parts.join("\n\n"), { link_preview_options: { is_disabled: true } });

  history.albums = [...history.albums, ...releases.map((r) => r.id)].slice(-200);
  history.tracks = [...history.tracks, ...picks.map((p) => `${p.name} — ${p.artist}`)].slice(-200);
  await env.DB.put("music_history", JSON.stringify(history));
}
