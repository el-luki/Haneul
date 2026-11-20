import { todayISO } from "./dates.js";
import { rememberMany } from "./memory.js";

// ---------- Alex's work: articles he published and projects he's building ----------
// One list Haneul keeps up to date, so she (and the outreach emails) always know his latest real work.
// It grows three ways:
//  1. his feeds: every few hours she checks his Substack (and Medium etc. if he adds one) for new posts;
//  2. chat: when he tells her he published / built / finished something (TKS.life uploads, demos, milestones);
//  3. the Outreach tab → Settings → Your work (add or remove by hand).
// Stored in KV "work": [{ id, kind: "article" | "project", title, url, note, status, date, source }].

export const DEFAULT_FEEDS = []; // e.g. ["https://YOUR-NAME.substack.com/feed"]; more can be added in the app
const norm = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();

export async function getWork(env) {
  return (await env.DB.get("work", "json")) || [];
}

// Adds new items (the same title or link updates the old one). Returns the ones that are new.
export async function addWork(env, items, source = "chat") {
  const work = await getWork(env);
  const added = [];
  for (const raw of items || []) {
    const title = String(raw?.title || "").trim().slice(0, 160);
    if (norm(title).length < 3) continue;
    const kind = raw.kind === "article" ? "article" : "project";
    const url = /^https?:\/\//.test(raw.url || "") ? String(raw.url).slice(0, 400) : "";
    const twin = work.find((w) => (url && w.url === url) || norm(w.title) === norm(title));
    if (twin) {
      if (raw.note) twin.note = String(raw.note).slice(0, 300);
      if (raw.status) twin.status = String(raw.status).slice(0, 40);
      if (url && !twin.url) twin.url = url;
      twin.updated = todayISO();
      continue;
    }
    const item = { id: Math.max(0, ...work.map((w) => w.id || 0)) + 1, kind, title, url, note: String(raw.note || "").slice(0, 300),
      status: String(raw.status || (kind === "article" ? "published" : "in progress")).slice(0, 40), date: raw.date || todayISO(), source };
    work.push(item);
    added.push(item);
  }
  await env.DB.put("work", JSON.stringify(work.slice(-200)));
  // she also remembers it as a fact (shows up in her memory and the Notion Memory table)
  if (added.length && source !== "chat") { // from chat, her own "remember" already noted it
    await rememberMany(env, added.map((w) => w.kind === "article"
      ? `Alex published an article: "${w.title}" (${w.date})${w.url ? ` ${w.url}` : ""}`
      : `Alex's project: ${w.title}${w.note ? `: ${w.note}` : ""} (${w.status}, ${w.date})`), source).catch(() => {});
  }
  return added;
}

export async function removeWork(env, id) {
  const work = (await getWork(env)).filter((w) => w.id !== Number(id));
  await env.DB.put("work", JSON.stringify(work));
  return { ok: true };
}

// For prompts (chat, outreach): newest first.
export async function workText(env, n = 12) {
  const work = (await getWork(env)).slice().sort((a, b) => String(b.updated || b.date).localeCompare(String(a.updated || a.date))).slice(0, n);
  if (!work.length) return "";
  return work.map((w) => `- ${w.kind === "article" ? "Article" : "Project"} (${w.status}, ${w.date}): ${w.title}${w.note ? `: ${w.note}` : ""}${w.url ? ` [${w.url}]` : ""}`).join("\n");
}

// ---------- feeds (Substack, Medium…) ----------
export function feedItems(xml) {
  const tag = (s, t) => (s.match(new RegExp(`<${t}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${t}>`)) || [])[1]?.trim() || "";
  return String(xml).split(/<item[\s>]/).slice(1).map((it) => ({
    title: tag(it, "title").replace(/&amp;/g, "&").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"'),
    url: tag(it, "link"),
    date: (() => { const d = Date.parse(tag(it, "pubDate")); return isNaN(d) ? todayISO() : new Date(d - 5 * 3600000).toISOString().slice(0, 10); })(),
  })).filter((x) => x.title);
}

export async function feedList(env) {
  return [...DEFAULT_FEEDS, ...((await env.DB.get("work_feeds", "json")) || [])];
}

// A Medium username, "@name" or a feed/profile link → a feed URL.
export function toFeedUrl(s) {
  s = String(s || "").trim();
  if (!s) return "";
  const medium = s.match(/medium\.com\/(?:feed\/)?(@[\w.-]+)/i) || s.match(/^@?([\w.-]+)$/);
  if (medium) return `https://medium.com/feed/${medium[1].startsWith("@") ? medium[1] : "@" + medium[1]}`;
  const sub = s.match(/^https?:\/\/([\w-]+)\.substack\.com/i);
  if (sub) return `https://${sub[1]}.substack.com/feed`;
  return /^https?:\/\//.test(s) ? s : "";
}

// Every few hours: new posts → his work list + memory, and Haneul says something about it.
// The first time a feed is read, its old posts are added quietly (no message).
export async function checkFeeds(env, haneulSays) {
  const seen = (await env.DB.get("work_feeds_seen", "json")) || {};
  const fresh = [];
  for (const feed of await feedList(env)) {
    const res = await fetch(feed, { headers: { "User-Agent": "Mozilla/5.0 (Haneul)" }, signal: AbortSignal.timeout(15000) }).catch(() => null);
    if (!res?.ok) continue;
    const items = feedItems(await res.text()).slice(0, 20);
    const first = !seen[feed];
    const added = await addWork(env, items.map((i) => ({ ...i, kind: "article" })), "feed");
    seen[feed] = Date.now();
    if (!first) fresh.push(...added);
  }
  await env.DB.put("work_feeds_seen", JSON.stringify(seen));
  if (fresh.length && haneulSays) {
    await haneulSays(env, `You just noticed Alex published something new: ${fresh.map((w) => `"${w.title}"`).join(", ")}.
React like a proud friend in 1-2 short texts (you saw it on his feed): congratulate him, maybe ask one question about it. Don't paste the link.`);
  }
  return { added: fresh.length };
}
