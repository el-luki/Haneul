// ---------- Web search (free, no key) ----------
// Google Search grounding isn't included in Alex's free Gemini tier, so Haneul searches
// Google News (public RSS) for anything recent and Wikipedia for background, and answers
// from those results.

const UA = { "User-Agent": "HaneulBot/1.0 (personal assistant)" };

const strip = (s) =>
  String(s || "")
    .replace(/<!\[CDATA\[|\]\]>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();

// Google News first; it sometimes refuses bursts of requests from Cloudflare, so: one retry,
// then Bing News (also a free public RSS feed).
async function rss(url) {
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(15000) }).catch(() => null);
  if (!res?.ok) return "";
  const xml = (await res.text()).slice(0, 150000);
  return xml.includes("<item>") ? xml : "";
}
export async function newsSearch(query, lang = "en") {
  const loc = lang === "es" ? "hl=es-419&gl=PE&ceid=PE:es-419" : "hl=en-US&gl=US&ceid=US:en";
  const google = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&${loc}`;
  let xml = await rss(google);
  if (!xml) { await new Promise((r) => setTimeout(r, 1500)); xml = await rss(google); }
  if (!xml) xml = await rss(`https://www.bing.com/news/search?format=rss&q=${encodeURIComponent(query)}&setlang=${lang === "es" ? "es" : "en"}`);
  if (!xml) return [];
  const items = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const get = (tag) => strip((m[1].match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`)) || [])[1]);
    items.push({ title: get("title"), date: get("pubDate").slice(0, 16), source: get("source"), link: get("link") });
    if (items.length >= 8) break;
  }
  return items;
}

export async function wikiSearch(query, lang = "en") {
  const host = lang === "es" ? "es.wikipedia.org" : "en.wikipedia.org";
  const res = await fetch(`https://${host}/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&srlimit=3`, {
    headers: UA,
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) return [];
  const data = await res.json().catch(() => ({}));
  return (data.query?.search || []).map((r) => ({ title: r.title, text: strip(r.snippet) }));
}

// Search results as text for Haneul's prompt.
export async function searchWeb(query, lang = "en") {
  const [news, wiki] = await Promise.all([newsSearch(query, lang).catch(() => []), wikiSearch(query, lang).catch(() => [])]);
  const lines = [];
  if (news.length) lines.push("NEWS (Google News, newest results):", ...news.map((n) => `- ${n.title} (${n.source || "news"}, ${n.date})`));
  if (wiki.length) lines.push("WIKIPEDIA:", ...wiki.map((w) => `- ${w.title}: ${w.text}`));
  return lines.join("\n");
}
