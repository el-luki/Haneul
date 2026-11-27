// ---------- X (Twitter): post a draft Alex approved ----------
// Only ever called from the app's "Approve & post" button: Haneul never posts on her own.
// Keys (developer.x.com → your app → Keys and tokens; app permissions: Read and write), added with
//   npx.cmd wrangler secret put X_API_KEY / X_API_SECRET / X_ACCESS_TOKEN / X_ACCESS_SECRET
// Requests are signed with OAuth 1.0a (HMAC-SHA1). For the JSON body of POST /2/tweets, only the
// oauth_* values (and any query parameters) are signed.

export const xReady = (env) => !!(env.X_API_KEY && env.X_API_SECRET && env.X_ACCESS_TOKEN && env.X_ACCESS_SECRET);

// RFC 3986 percent-encoding (what OAuth requires; encodeURIComponent leaves !'()* alone)
export const pct = (s) => encodeURIComponent(String(s)).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());

async function hmacSha1Base64(key, text) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(text)));
  let bin = "";
  for (const b of sig) bin += String.fromCharCode(b);
  return btoa(bin);
}

// The Authorization header for one request. `params` = query + form parameters (not a JSON body).
export async function oauthHeader({ method, url, params = {}, consumerKey, consumerSecret, token, tokenSecret, nonce, timestamp }) {
  const oauth = {
    oauth_consumer_key: consumerKey,
    oauth_nonce: nonce || crypto.randomUUID().replace(/-/g, ""),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(timestamp || Math.floor(Date.now() / 1000)),
    oauth_token: token,
    oauth_version: "1.0",
  };
  const all = { ...params, ...oauth };
  const paramString = Object.keys(all).map((k) => [pct(k), pct(all[k])]).sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join("&");
  const base = `${method.toUpperCase()}&${pct(url)}&${pct(paramString)}`;
  const signature = await hmacSha1Base64(`${pct(consumerSecret)}&${pct(tokenSecret)}`, base);
  const header = { ...oauth, oauth_signature: signature };
  return "OAuth " + Object.keys(header).sort().map((k) => `${pct(k)}="${pct(header[k])}"`).join(", ");
}

// Posts one tweet: { id, url } — or throws with a message Alex can act on.
export async function postTweet(env, text) {
  if (!xReady(env)) throw new Error("X isn't connected yet (add the 4 X keys)");
  text = String(text || "").trim();
  if (!text) throw new Error("the post is empty");
  if ([...text].length > 280) throw new Error(`the post is ${[...text].length} characters; X allows 280`);
  const url = "https://api.x.com/2/tweets";
  const auth = await oauthHeader({ method: "POST", url, consumerKey: env.X_API_KEY, consumerSecret: env.X_API_SECRET, token: env.X_ACCESS_TOKEN, tokenSecret: env.X_ACCESS_SECRET });
  const res = await fetch(url, { method: "POST", headers: { Authorization: auth, "Content-Type": "application/json" }, body: JSON.stringify({ text }), signal: AbortSignal.timeout(20000) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = body.detail || body.title || body.errors?.[0]?.message || `X answered ${res.status}`;
    if (res.status === 402 || /credit/i.test(JSON.stringify(body))) {
      const e = new Error("X has no API credits on your account (X now charges for posting through its API), so this post goes through X's share page instead.");
      e.noCredits = true;
      throw e;
    }
    if (res.status === 401) throw new Error(`X refused the keys (${detail}). Check the 4 keys, and regenerate the access token after changing permissions.`);
    if (res.status === 403) throw new Error(`X said no (${detail}). The app needs "Read and write" permission, then a NEW access token; X also refuses exact duplicate posts.`);
    if (res.status === 429) throw new Error("X's limit for now is reached (free plans allow few posts). Try again later.");
    throw new Error(detail);
  }
  const id = body.data?.id;
  if (!id) throw new Error("X didn't return the post id");
  return { id, url: `https://x.com/i/web/status/${id}` };
}

// Read-only check that the keys work (no post): { username } or { error }.
export async function xWhoAmI(env) {
  if (!xReady(env)) return { error: "X isn't connected yet (add the 4 X keys)" };
  const url = "https://api.x.com/2/users/me";
  const auth = await oauthHeader({ method: "GET", url, consumerKey: env.X_API_KEY, consumerSecret: env.X_API_SECRET, token: env.X_ACCESS_TOKEN, tokenSecret: env.X_ACCESS_SECRET });
  const res = await fetch(url, { headers: { Authorization: auth }, signal: AbortSignal.timeout(15000) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) return { error: body.detail || body.title || `X answered ${res.status}`, status: res.status };
  return { username: body.data?.username, name: body.data?.name };
}
