// ---------- LinkedIn: post a draft Alex approved ----------
// Only the app's "Approve & post on LinkedIn" button calls postLinkedIn: Haneul never posts on her own.
// Setup: a LinkedIn developer app (linkedin.com/developers) with the products "Share on LinkedIn" and
// "Sign In with LinkedIn using OpenID Connect", redirect URL <PUBLIC_URL>/linkedin/callback, and
//   npx.cmd wrangler secret put LINKEDIN_CLIENT_ID / LINKEDIN_CLIENT_SECRET
// Then "Connect LinkedIn" in the app (he signs in on LinkedIn). The access lasts ~60 days; she warns
// before it runs out. KV "linkedin_auth": { token, expires_at, sub, name }.

import { htmlPage } from "./music.js";
import { send } from "./telegram.js";

const SCOPES = "openid profile w_member_social";

// Option B (no LinkedIn developer app needed): an automation service that already has an approved LinkedIn
// app (e.g. Make.com: "Custom webhook" → LinkedIn "Create a User Text Post"). Haneul sends the approved
// text to that private webhook URL:  npx.cmd wrangler secret put LINKEDIN_WEBHOOK_URL
export const liWebhookReady = (env) => /^https:\/\//.test(env.LINKEDIN_WEBHOOK_URL || "");
export async function postViaWebhook(env, text) {
  const res = await fetch(env.LINKEDIN_WEBHOOK_URL, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, source: "haneul", at: new Date().toISOString() }), signal: AbortSignal.timeout(25000),
  });
  const reply = (await res.text().catch(() => "")).slice(0, 300);
  if (!res.ok) throw new Error(res.status === 410 || res.status === 404 ? "the Make webhook link doesn't exist anymore (check the scenario)" : `the automation answered ${res.status}${reply ? `: ${reply}` : ""}`);
  const url = (reply.match(/https:\/\/www\.linkedin\.com\/[^\s"']+/) || [])[0];
  return { id: "", url: url || "https://www.linkedin.com/in/me/recent-activity/all/" };
}
export const liConfigured = (env) => !!(env.LINKEDIN_CLIENT_ID && env.LINKEDIN_CLIENT_SECRET);

export async function liAuth(env) {
  const a = await env.DB.get("linkedin_auth", "json");
  return a && a.token && a.expires_at > Date.now() ? a : null;
}
export async function liStatus(env) {
  if (liWebhookReady(env)) return { configured: true, connected: true, via: "make", daysLeft: 9999 };
  const a = await env.DB.get("linkedin_auth", "json");
  if (!liConfigured(env)) return { configured: false };
  if (!a?.token) return { configured: true, connected: false };
  const days = Math.floor((a.expires_at - Date.now()) / 86400000);
  return { configured: true, connected: days >= 0, expired: days < 0, daysLeft: Math.max(0, days), name: a.name || "" };
}

// Step 1 (from the app, logged in): a one-time sign-in link.
export async function liStart(env) {
  if (!liConfigured(env)) return { error: "LinkedIn isn't set up yet (add LINKEDIN_CLIENT_ID and LINKEDIN_CLIENT_SECRET)" };
  const state = crypto.randomUUID().replace(/-/g, "");
  await env.DB.put("linkedin_state", state, { expirationTtl: 900 });
  const u = new URL("https://www.linkedin.com/oauth/v2/authorization");
  u.search = new URLSearchParams({ response_type: "code", client_id: env.LINKEDIN_CLIENT_ID, redirect_uri: `${env.PUBLIC_URL}/linkedin/callback`, scope: SCOPES, state }).toString();
  return { url: u.toString() };
}

// Step 2: LinkedIn sends him back here with a code.
export async function liCallback(url, env) {
  const state = await env.DB.get("linkedin_state");
  if (!state || url.searchParams.get("state") !== state) return htmlPage("This link expired. Tap “Connect LinkedIn” in the app again.");
  if (url.searchParams.get("error")) return htmlPage(`LinkedIn said: ${url.searchParams.get("error_description") || url.searchParams.get("error")}. Try “Connect LinkedIn” again.`);
  const res = await fetch("https://www.linkedin.com/oauth/v2/accessToken", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code: url.searchParams.get("code") || "", redirect_uri: `${env.PUBLIC_URL}/linkedin/callback`, client_id: env.LINKEDIN_CLIENT_ID, client_secret: env.LINKEDIN_CLIENT_SECRET }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) return htmlPage(`Couldn't connect LinkedIn (${data.error_description || data.error || res.status}).`);
  const me = await fetch("https://api.linkedin.com/v2/userinfo", { headers: { Authorization: `Bearer ${data.access_token}` } }).then((r) => r.json()).catch(() => ({}));
  if (!me.sub) return htmlPage("Connected, but LinkedIn didn't say who you are. Check that the app has “Sign In with LinkedIn using OpenID Connect”.");
  await env.DB.put("linkedin_auth", JSON.stringify({ token: data.access_token, expires_at: Date.now() + (Number(data.expires_in) || 5184000) * 1000, sub: me.sub, name: me.name || "", connected_at: Date.now() }));
  await env.DB.delete("linkedin_state");
  await send(env, `🔗 LinkedIn connected${me.name ? ` (${me.name})` : ""}. Your daily LinkedIn draft now has an “Approve & post” button in Mentors → Posts.`).catch(() => {});
  return htmlPage("✅ LinkedIn connected. You can close this tab and go back to Haneul.");
}

// LinkedIn's "little text" format: these characters must be escaped, or the post gets cut off.
// Hashtags become LinkedIn hashtags.
export function liText(text) {
  const esc = (s) => s.replace(/[\\|{}@\[\]()<>#*_~]/g, (c) => "\\" + c);
  return String(text).split(/(#[\p{L}\p{N}_]+)/u).map((part) => (/^#[\p{L}\p{N}_]+$/u.test(part) ? `{hashtag|\\#|${part.slice(1)}}` : esc(part))).join("");
}

// API versions are monthly (YYYYMM) and expire after about a year: try a recent one, then older ones.
export function liVersions(now = new Date()) {
  const out = [];
  for (const back of [1, 3, 6, 9]) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1));
    out.push(`${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  return out;
}

// Posts on his profile: { id, url } or throws with a message he can act on.
export async function postLinkedIn(env, text) {
  if (liWebhookReady(env)) {
    text = String(text || "").trim();
    if (!text) throw new Error("the post is empty");
    if (text.length > 3000) throw new Error("LinkedIn posts can be 3,000 characters at most");
    return postViaWebhook(env, text); // plain text: the automation's LinkedIn module handles formatting
  }
  const a = await liAuth(env);
  if (!a) throw new Error((await env.DB.get("linkedin_auth")) ? "LinkedIn sign-in expired: tap “Connect LinkedIn” again" : "LinkedIn isn't connected yet");
  text = String(text || "").trim();
  if (!text) throw new Error("the post is empty");
  if (text.length > 3000) throw new Error("LinkedIn posts can be 3,000 characters at most");
  const body = JSON.stringify({
    author: `urn:li:person:${a.sub}`, commentary: liText(text), visibility: "PUBLIC",
    distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
    lifecycleState: "PUBLISHED", isReshareDisabledByAuthor: false,
  });
  let last = "";
  for (const version of liVersions()) {
    const res = await fetch("https://api.linkedin.com/rest/posts", {
      method: "POST",
      headers: { Authorization: `Bearer ${a.token}`, "Content-Type": "application/json", "LinkedIn-Version": version, "X-Restli-Protocol-Version": "2.0.0" },
      body, signal: AbortSignal.timeout(20000),
    });
    if (res.status === 201) {
      const id = res.headers.get("x-restli-id") || res.headers.get("x-linkedin-id") || "";
      return { id, url: id ? `https://www.linkedin.com/feed/update/${id}/` : "https://www.linkedin.com/in/me/recent-activity/all/" };
    }
    const err = await res.json().catch(() => ({}));
    last = err.message || `LinkedIn answered ${res.status}`;
    if (/version/i.test(last) && (res.status === 426 || res.status === 400)) continue; // that API version is gone: try an older one
    if (res.status === 401) throw new Error("LinkedIn sign-in isn't valid anymore: tap “Connect LinkedIn” again");
    if (res.status === 403) throw new Error(`LinkedIn said no (${last}). The app needs the “Share on LinkedIn” product.`);
    if (res.status === 422 && /duplicate/i.test(last)) throw new Error("LinkedIn refuses an exact duplicate of a recent post");
    throw new Error(last);
  }
  throw new Error(`LinkedIn didn't accept any API version (${last})`);
}

// Cron (daily): a heads-up a week before the sign-in runs out, and on the day.
export async function liExpiryNudge(env) {
  const s = await liStatus(env);
  if (!s.connected || s.via === "make") return; // the automation keeps its own LinkedIn connection
  if (s.daysLeft === 7 || s.daysLeft === 1) {
    const key = `linkedin_nudge_${s.daysLeft}`;
    if (await env.DB.get(key)) return;
    await env.DB.put(key, "1", { expirationTtl: 86400 * 3 });
    await send(env, `🔗 Your LinkedIn connection runs out in ${s.daysLeft} day${s.daysLeft === 1 ? "" : "s"} (LinkedIn's rule). Tap “Connect LinkedIn” in Mentors → Posts to renew it.`);
  }
}
