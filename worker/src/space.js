import { gemini, parseJson } from "./gemini.js";
import { send, typing } from "./telegram.js";

// ---------- Space-tech article of the day ----------
// Sent ~10 minutes before your "Read a relevant Article on Space Tech" calendar block
// (so only on the days you have that block), or any time with /space.

export const SPACE_FEEDS = [
  "https://spacenews.com/feed/",
  "https://www.nasaspaceflight.com/feed/",
  "https://spaceflightnow.com/feed/",
  "https://www.space.com/feeds/all",
];
export const SPACE_BLOCK = /space\s*tech/i; // matches the calendar block's title

export function rssItems(xml) {
  const items = [];
  for (const m of xml.slice(0, 200000).matchAll(/<item[\s>][\s\S]*?<\/item>/g)) {
    const get = (tag) => {
      const t = m[0].match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`));
      return t ? t[1].replace(/<!\[CDATA\[|\]\]>/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() : "";
    };
    const link = get("link");
    if (link) items.push({ title: get("title"), link, text: get("description").slice(0, 300), date: get("pubDate") });
  }
  return items;
}

export async function runSpaceArticle(env) {
  await typing(env);
  const history = (await env.DB.get("space_history", "json")) || [];
  const lists = await Promise.all(
    SPACE_FEEDS.map((u) => fetch(u, { headers: { "User-Agent": "HaneulBot/1.0" } }).then((r) => (r.ok ? r.text() : "")).then(rssItems).catch(() => []))
  );
  const fresh = lists.flatMap((l) => l.slice(0, 8)).filter((it) => !history.includes(it.link));
  if (!fresh.length) return send(env, "🚀 Couldn't reach the space news sites right now. Try /space later.");

  const list = fresh.map((it, i) => `[${i}] ${it.title}: ${it.text}`).join("\n");
  const prompt = `Pick the ONE article that Alex (11th grade, TKS student, builds rocket/landing/guidance projects,
interested in propulsion, reusable rockets, spacecraft engineering, space startups) would learn the most from.
Prefer engineering depth over politics or business-only news.

Articles:
${list}

Return JSON: {"i": number, "summary": ["3 short points about what it says"], "why": "one line on why it's worth reading for Alex", "think": "one question to think about while reading"}`;
  const r = parseJson((await gemini(env, [{ role: "user", parts: [{ text: prompt }] }], { json: true })));
  const pick = fresh[r.i] || fresh[0];
  await env.DB.put("space_history", JSON.stringify([...history, pick.link].slice(-150)));
  return send(
    env,
    `🚀 Space-tech read of the day\n${pick.title}\n${pick.link}\n\n${(r.summary || []).map((s) => `• ${s}`).join("\n")}\n\n` +
      `🎯 Why: ${r.why || ""}\n🤔 Think about: ${r.think || ""}`
  );
}
