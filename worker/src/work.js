import { todayISO } from "./dates.js";
import { rememberMany } from "./memory.js";

// ---------- Alex's work: articles he published and projects he's building ----------
// One list Haneul keeps up to date, so she (and the outreach emails) always know his latest real work.
// It grows three ways:
//  1. his feeds: every few hours she checks his Substack (and Medium etc. if he adds one) for new posts;
//  2. chat: when he tells her he published / built / finished something (TKS.life uploads, demos, milestones);
//  3. the Outreach tab → Settings → Your work (add or remove by hand).
// Stored in KV "work": [{ id, kind: "article" | "project", title, url, note, status, date, source }].

// His Substack lives in KV "substack_feed" (set with /substack <link> or Mentors → Settings); other places
// he publishes (Medium…) in KV "work_feeds". (The old example.substack.com address stopped existing.)
export const DEFAULT_FEEDS = [];
const FEED_BROKEN_MS = 24 * 3600000; // a feed failing this long → Haneul tells him once
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
  const substack = await env.DB.get("substack_feed");
  return [...new Set([...(substack ? [substack] : []), ...DEFAULT_FEEDS, ...((await env.DB.get("work_feeds", "json")) || [])])];
}

// Any way he gives his Substack ("name", name.substack.com, a post link, a custom domain) → its feed URL.
export function substackFeedUrl(s) {
  s = String(s || "").trim().replace(/^@/, "");
  if (!s) return "";
  if (/^[a-z0-9-]+$/i.test(s)) return `https://${s.toLowerCase()}.substack.com/feed`;
  let u;
  try { u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`); } catch { return ""; }
  if (/(^|\.)substack\.com$/i.test(u.hostname) && u.hostname.toLowerCase() !== "substack.com") return `https://${u.hostname.toLowerCase()}/feed`;
  if (u.hostname.toLowerCase() === "substack.com") return ""; // a profile page, not a publication
  return `${u.origin}/feed`; // custom domain
}

// A Medium username, "@name" or a feed/profile link → a feed URL.
export function toFeedUrl(s) {
  s = String(s || "").trim();
  if (!s) return "";
  const medium = s.match(/medium\.com\/(?:feed\/)?(@[\w.-]+)/i) || s.match(/^@?([\w.-]+)$/);
  if (medium) return `https://medium.com/feed/${medium[1].startsWith("@") ? medium[1] : "@" + medium[1]}`;
  const sub = s.match(/^https?:\/\/([\w-]+)\.substack\.com/i);
  if (sub) return `https://${sub[1]}.substack.com/feed`;
  if (!/^https?:\/\//.test(s)) return "";
  return /\/(feed|rss)(\.xml)?\/?$|\.xml$/i.test(s) ? s : s.replace(/\/(p\/.*)?$/, "").replace(/\/$/, "") + "/feed";
}

export async function onSubstackCommand(env, arg) {
  const { send } = await import("./telegram.js");
  const cur = await env.DB.get("substack_feed");
  if (!String(arg || "").trim()) return send(env, cur ? `📰 I watch your Substack at ${cur.replace(/\/feed$/, "")}. To change it: /substack <link>` : "📰 I don't know your Substack yet. Send /substack <your Substack link or name>.");
  const feed = substackFeedUrl(arg);
  if (!feed) return send(env, "That doesn't look like a Substack. Send the link to your publication (like https://name.substack.com) or one of your posts.");
  const res = await fetch(feed, { headers: { "User-Agent": "Mozilla/5.0 (Haneul)" }, signal: AbortSignal.timeout(15000) }).catch(() => null);
  const n = res?.ok ? feedItems(await res.text()).length : -1;
  if (n < 0) return send(env, `I couldn't open ${feed} (${res ? res.status : "no answer"}). Check the link and send it again.`);
  await env.DB.put("substack_feed", feed);
  const health = (await env.DB.get("work_feeds_health", "json")) || {};
  for (const k of Object.keys(health)) if (/substack/i.test(k)) delete health[k];
  await env.DB.put("work_feeds_health", JSON.stringify(health));
  await env.DB.delete("work_feed_slot"); // read it on the next run
  return send(env, `📰 Got it: I'm watching ${feed.replace(/\/feed$/, "")} (${n} post${n === 1 ? "" : "s"} there). New posts mark your newsletter issue as sent.`);
}

// Every few hours: new posts → his work list + memory, and Haneul says something about it.
// The first time a feed is read, its old posts are added quietly (no message).
export async function checkFeeds(env, haneulSays) {
  const seen = (await env.DB.get("work_feeds_seen", "json")) || {};
  const health = (await env.DB.get("work_feeds_health", "json")) || {};
  const fresh = [];
  for (const feed of await feedList(env)) {
    const res = await fetch(feed, { headers: { "User-Agent": "Mozilla/5.0 (Haneul)" }, signal: AbortSignal.timeout(15000) }).catch(() => null);
    if (!res?.ok) {
      const h = (health[feed] ||= { since: Date.now() });
      h.status = res ? res.status : "no answer";
      if (!h.told && Date.now() - h.since > FEED_BROKEN_MS) {
        h.told = true;
        const { send } = await import("./telegram.js");
        await send(env, `📰 I can't read ${feed.replace(/^https?:\/\//, "").replace(/\/feed$/, "")} (${h.status === 404 ? "it says Not Found" : `error ${h.status}`}) since yesterday, so I won't notice new posts there. Did it move? Send /substack <your Substack link> (or fix it in Mentors → Settings).`).catch(() => {});
      }
      continue;
    }
    delete health[feed];
    const items = feedItems(await res.text()).slice(0, 20);
    const first = !seen[feed];
    const added = await addWork(env, items.map((i) => ({ ...i, kind: "article" })), "feed");
    seen[feed] = Date.now();
    if (!first) fresh.push(...added);
  }
  await env.DB.put("work_feeds_seen", JSON.stringify(seen));
  await env.DB.put("work_feeds_health", JSON.stringify(health));
  await (await import("./progress.js")).checkGithub(env, haneulSays).catch((err) => console.error("github progress:", err.message));
  if (fresh.length) await (await import("./newsletter.js")).markSentFromPosts(env, fresh).catch((err) => console.error("newsletter sent:", err.message));
  if (fresh.length && haneulSays) {
    await haneulSays(env, `You just noticed Alex published something new: ${fresh.map((w) => `"${w.title}"`).join(", ")}.
React like a proud friend in 1-2 short texts (you saw it on his feed): congratulate him, maybe ask one question about it. Don't paste the link.`);
  }
  return { added: fresh.length };
}
