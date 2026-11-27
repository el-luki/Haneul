import { todayISO } from "./dates.js";
import { HiccupError } from "./telegram.js";

// ---------- Notion ----------
// Haneul works inside ONE Notion page ("Haneul") that Alex connected to her integration.
// On first use she creates five tables there: TKS Notes, Ideas, Reading, Journal and
// Newsletter Drafts. Secrets: NOTION_TOKEN (ntn_…) and NOTION_PAGE (the page's link).
// Notion is optional: every function quietly does nothing if it isn't set up.

const API = "https://api.notion.com/v1";
const VERSION = "2022-06-28";

export function notionReady(env) {
  return Boolean(env.NOTION_TOKEN && env.NOTION_PAGE);
}

// "https://www.notion.so/Haneul-2a1b…32 hex" or a bare id → "2a1b…" (dashed form)
export function pageIdFrom(link) {
  const hex = (String(link).replace(/-/g, "").match(/[0-9a-f]{32}(?![0-9a-f])/i) || [])[0];
  if (!hex) return null;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`.toLowerCase();
}

export async function notion(env, method, path, body) {
  let last = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 1500 * attempt));
    let res;
    try {
      res = await fetch(`${API}${path}`, {
        method,
        headers: { Authorization: `Bearer ${env.NOTION_TOKEN}`, "Notion-Version": VERSION, "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(30000),
      });
    } catch (err) {
      last = `couldn't reach Notion (${err.message})`;
      continue;
    }
    const raw = await res.text();
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      last = `Notion had a hiccup (${res.status})`;
      continue;
    }
    if (res.ok) return data;
    if (res.status === 429 || res.status >= 500) {
      last = `Notion is busy (${res.status})`;
      continue;
    }
    throw new Error(`Notion: ${data.message || res.status}`);
  }
  throw new HiccupError(last);
}

// ---------- the five tables ----------

const title = { title: {} };
const date = { date: {} };
const text = { rich_text: {} };
const TABLES = {
  ideas: { name: "Ideas", icon: "💡", props: { Name: title, Date: date, Tags: { multi_select: {} }, Source: { select: {} }, Link: { url: {} } } },
  reading: { name: "Reading", icon: "📖", props: { Name: title, Book: { select: {} }, Chapter: { number: {} }, Date: date } },
  journal: { name: "Journal", icon: "📓", props: { Name: title, Date: date, Answer: text } },
  drafts: { name: "Newsletter Drafts", icon: "📰", props: { Name: title, Month: date } },
  memory: { name: "Memory", icon: "🧠", props: { Name: title, Date: date, Source: { select: {} } } },
  diary: { name: "Chat Diary", icon: "📔", props: { Name: title, Date: date } },
};

// Creates any missing tables once; their ids are remembered in KV.
export async function ensureNotion(env) {
  if (!notionReady(env)) return null;
  const saved = (await env.DB.get("notion", "json")) || {};
  const parent = pageIdFrom(env.NOTION_PAGE);
  if (!parent) throw new Error("NOTION_PAGE isn't a valid Notion page link");
  if (saved.parent !== parent) for (const k of Object.keys(TABLES)) delete saved[k]; // page changed: start over
  let changed = false;
  for (const [key, t] of Object.entries(TABLES)) {
    if (saved[key]) continue;
    const db = await notion(env, "POST", "/databases", {
      parent: { type: "page_id", page_id: parent },
      icon: { type: "emoji", emoji: t.icon },
      title: [{ type: "text", text: { content: t.name } }],
      properties: t.props,
    });
    saved[key] = db.id;
    changed = true;
  }
  // Alex's own notes live in a "TKS" page inside Haneul (made once if missing).
  if (!saved.tks) {
    const kids = (await notion(env, "GET", `/blocks/${parent}/children?page_size=100`)).results || [];
    const found = kids.find((b) => b.type === "child_page" && b.child_page.title.trim().toLowerCase() === "tks");
    saved.tks = found
      ? found.id
      : (await notion(env, "POST", "/pages", {
          parent: { page_id: parent },
          icon: { type: "emoji", emoji: "🧠" },
          properties: { title: { title: [{ type: "text", text: { content: "TKS" } }] } },
        })).id;
    changed = true;
  }
  saved.parent = parent;
  if (changed) await env.DB.put("notion", JSON.stringify(saved));
  return saved;
}

// Long text → paragraph blocks (Notion allows 2000 characters per text piece).
export function paragraphs(content) {
  const blocks = [];
  for (const para of String(content || "").split(/\n{2,}|\n/)) {
    const p = para.trim();
    if (!p) continue;
    for (let i = 0; i < p.length; i += 1900) {
      blocks.push({ object: "block", type: "paragraph", paragraph: { rich_text: [{ type: "text", text: { content: p.slice(i, i + 1900) } }] } });
    }
  }
  return blocks.slice(0, 100);
}

const rt = (s) => [{ type: "text", text: { content: String(s || "").slice(0, 1900) } }];

async function addRow(env, table, properties, body) {
  const ids = await ensureNotion(env);
  if (!ids) return null;
  return notion(env, "POST", "/pages", {
    parent: { database_id: ids[table] },
    properties,
    ...(body ? { children: paragraphs(body) } : {}),
  });
}

// Fire-and-forget helper: Notion must never break the main feature.
export function toNotion(env, promise) {
  return promise.catch((err) => console.error("notion:", err.message));
}

// ---------- writes ----------

export async function notionIdea(env, note) {
  const firstLine = note.text.split("\n")[0].replace(/^🔗\s*/, "").slice(0, 120);
  const link = (note.text.match(/https?:\/\/\S+/) || [])[0];
  return addRow(env, "ideas", {
    Name: { title: rt(firstLine) },
    Date: { date: { start: note.date || todayISO() } },
    Tags: { multi_select: (note.tags || []).map((t) => ({ name: t.replace(/^#/, "").slice(0, 50) })) },
    Source: { select: { name: note.source || "text" } },
    ...(link ? { Link: { url: link } } : {}),
  }, note.text);
}

export async function notionJournal(env, entry) {
  return addRow(env, "journal", {
    Name: { title: rt(entry.q) },
    Date: { date: { start: entry.date || todayISO() } },
    Answer: { rich_text: rt(entry.a) },
  }, entry.a);
}

export async function notionReading(env, book, chapter, note) {
  return addRow(env, "reading", {
    Name: { title: rt(note ? note.slice(0, 120) : `Chapter ${chapter}`) },
    Book: { select: { name: book.slice(0, 90) } },
    Chapter: { number: chapter },
    Date: { date: { start: todayISO() } },
  }, note || "");
}

// One memory fact → a row in "Memory". Returns the Notion page id (kept with the fact).
export async function notionMemory(env, fact) {
  const page = await addRow(env, "memory", {
    Name: { title: rt(fact.text) },
    Date: { date: { start: fact.date || todayISO() } },
    Source: { select: { name: fact.source === "chat" ? "picked up in chat" : fact.source === "notion" ? "added in Notion" : "you told me" } },
  });
  return page?.id || null;
}

export async function notionUpdateMemory(env, pageId, text) {
  if (!notionReady(env) || !pageId) return;
  await notion(env, "PATCH", `/pages/${pageId}`, { properties: { Name: { title: rt(text) } } });
}

export async function notionArchive(env, pageId) {
  if (!notionReady(env) || !pageId) return;
  await notion(env, "PATCH", `/pages/${pageId}`, { archived: true });
}

// All rows of the Memory table: [{ np, text, date }] (for the hourly two-way sync).
export async function notionMemoryRows(env) {
  const ids = await ensureNotion(env);
  if (!ids) return null;
  const rows = [];
  let cursor;
  for (let i = 0; i < 10; i++) {
    const data = await notion(env, "POST", `/databases/${ids.memory}/query`, { page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) });
    for (const p of data.results || []) {
      rows.push({ np: p.id, text: titleOf(p).trim(), date: p.properties.Date?.date?.start || todayISO() });
    }
    if (!data.has_more) break;
    cursor = data.next_cursor;
  }
  return rows;
}

export async function notionDiary(env, entry) {
  return addRow(env, "diary", {
    Name: { title: rt(`${entry.date}: ${entry.summary.slice(0, 80)}`) },
    Date: { date: { start: entry.date } },
  }, entry.summary);
}

// The monthly newsletter draft as a page Alex can edit. Returns its link.
export async function notionDraft(env, name, content) {
  const page = await addRow(env, "drafts", {
    Name: { title: rt(name) },
    Month: { date: { start: todayISO().slice(0, 8) + "01" } },
  }, content);
  return page?.url || "";
}

// ---------- reads ----------

const BLOCK_TEXT = ["paragraph", "heading_1", "heading_2", "heading_3", "bulleted_list_item", "numbered_list_item", "to_do", "quote", "callout", "toggle"];

// All the text of a page, including what's inside toggles, callouts, columns, lists and tables
// (TKS challenge pages keep everything inside toggles). Sub-pages and tables of Haneul's are skipped.
export async function pageText(env, pageId, budget = { left: 20 }) {
  const lines = [];
  async function walk(id, depth) {
    let cursor;
    do {
      if (budget.left-- <= 0) return;
      const data = await notion(env, "GET", `/blocks/${id}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ""}`);
      for (const b of data.results || []) {
        if (BLOCK_TEXT.includes(b.type)) {
          const t = (b[b.type].rich_text || []).map((r) => r.plain_text).join("");
          if (t.trim()) lines.push(`${"  ".repeat(depth)}${b.type.startsWith("bulleted") || b.type.startsWith("numbered") ? "• " : b.type === "to_do" ? (b.to_do.checked ? "[x] " : "[ ] ") : ""}${t}`);
        } else if (b.type === "table_row") {
          const cells = (b.table_row.cells || []).map((c) => c.map((r) => r.plain_text).join("")).filter(Boolean);
          if (cells.length) lines.push(`${"  ".repeat(depth)}${cells.join(" | ")}`);
        }
        if (b.has_children && b.type !== "child_page" && b.type !== "child_database" && depth < 4) await walk(b.id, depth + 1);
      }
      cursor = data.has_more ? data.next_cursor : null;
    } while (cursor);
  }
  await walk(pageId, 0);
  return lines.join("\n");
}

async function query(env, table, body) {
  const ids = await ensureNotion(env);
  if (!ids) return [];
  return (await notion(env, "POST", `/databases/${ids[table]}/query`, body)).results || [];
}

const titleOf = (page) => (Object.values(page.properties).find((p) => p.type === "title")?.title || []).map((r) => r.plain_text).join("");

// Alex's own TKS notes live as subpages of the connected page (Cohort meeting, Velocity,
// 1-1 with Jordan…). /tks reads the one he edited most recently, skipping Haneul's own table
// rows and empty pages: { title, text, url } or null.
// A session note needs real words: lists of dates, headings or a template don't count (avoids made-up drafts).
export const MIN_TKS_WORDS = 40;
export function realWords(text) {
  return (String(text).match(/\p{L}{2,}/gu) || []).filter((w) => !/^(january|february|march|april|may|june|july|august|september|october|november|december|enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)$/i.test(w)).length;
}

export async function latestTksNote(env, { budget = 36 } = {}) {
  const ids = (await ensureNotion(env)) || {};
  const velocity = (await env.DB.get("notion", "json"))?.velocity;
  return latestUnder(env, ids.tks, { budget, skip: [velocity] });
}

// The most recently edited page somewhere inside `ancestorId` (any depth) with at least
// MIN_TKS_WORDS real words: { id, title, text, url, edited } — or { tooShort } / null.
// includeSelf = the ancestor page itself also counts (e.g. a challenge pasted into "Velocity").
// It walks the page's own sub-pages (not a workspace search: Haneul's own table rows — memory, diary,
// journal — are edited all the time and pushed his pages out of the search's newest 30).
export async function latestUnder(env, ancestorId, { includeSelf = false, budget = 36, skip = [] } = {}) {
  const skipIds = new Set(skip.filter(Boolean).map((x) => String(x).replace(/-/g, "")));
  const root = (ancestorId || "").replace(/-/g, "");
  if (!root) return null;
  const b = { left: budget };
  const pages = []; // { id, title, edited, depth }
  if (includeSelf) {
    b.left--;
    const self = await notion(env, "GET", `/pages/${root}`).catch(() => null);
    if (self) pages.push({ id: self.id, title: titleOf(self), edited: self.last_edited_time, url: self.url, self: true });
  }
  // open the most recently edited pages first: a new note is usually in the newest branch
  const open = [{ id: root, edited: "9", depth: 0 }];
  const listBudget = Math.floor(budget / 2);
  let listed = 0;
  while (open.length && listed < listBudget) {
    open.sort((x, y) => String(y.edited).localeCompare(String(x.edited)));
    const { id, depth } = open.shift();
    listed++; b.left--;
    const data = await notion(env, "GET", `/blocks/${id}/children?page_size=100`).catch(() => ({}));
    for (const k of data.results || []) {
      if (k.type !== "child_page") continue; // tables (child_database) are Haneul's, not his notes
      if (skipIds.has(k.id.replace(/-/g, ""))) continue; // e.g. Velocity challenges aren't session notes
      const p = { id: k.id, title: k.child_page.title, edited: k.last_edited_time, depth: depth + 1 };
      pages.push(p);
      if (depth < 4) open.push(p);
    }
  }
  pages.sort((x, y) => String(y.edited).localeCompare(String(x.edited)));
  let shortOne = null;
  for (const p of pages) {
    if (b.left <= 1) break;
    const text = await pageText(env, p.id, b).catch(() => "");
    if (realWords(text) < MIN_TKS_WORDS) { if (!pages.some((q) => q !== p && q.depth > p.depth)) shortOne ||= p.title || "Untitled"; continue; }
    return { id: p.id, title: p.title, text, url: p.url || `https://www.notion.so/${p.id.replace(/-/g, "")}`, edited: p.edited };
  }
  return shortOne ? { title: shortOne, text: "", tooShort: true } : null;
}

// A child page by title (e.g. "Velocity" inside TKS), or null.
export async function findChildPage(env, parentId, titleRe) {
  if (!parentId) return null;
  const kids = (await notion(env, "GET", `/blocks/${parentId}/children?page_size=100`)).results || [];
  const hit = kids.find((b) => b.type === "child_page" && titleRe.test(b.child_page.title));
  return hit ? hit.id : null;
}

// Alex's own notes on a chapter (from the Reading table), as text.
export async function chapterNotes(env, book, chapter) {
  const pages = await query(env, "reading", {
    filter: { and: [{ property: "Chapter", number: { equals: chapter } }, { property: "Book", select: { equals: book.slice(0, 90) } }] },
    page_size: 5,
  });
  const texts = [];
  for (const p of pages) {
    const t = `${titleOf(p)}\n${await pageText(env, p.id)}`.trim();
    if (t && !/^chapter \d+$/i.test(t)) texts.push(t);
  }
  return texts.join("\n---\n").slice(0, 4000);
}

export async function notionStatus(env) {
  if (!notionReady(env)) return "📝 Notion isn't connected yet (NOTION_TOKEN / NOTION_PAGE missing).";
  const ids = await ensureNotion(env);
  return `📝 Notion connected. Your tables are inside the Haneul page:\n${Object.values(TABLES).map((t) => `${t.icon} ${t.name}`).join("\n")}\n${env.NOTION_PAGE}`;
}

// ---------- For the Haneul app's Notion panel ----------
const plainProp = (p) => {
  if (!p) return "";
  if (p.type === "rich_text") return p.rich_text.map((r) => r.plain_text).join("");
  if (p.type === "select") return p.select?.name || "";
  if (p.type === "multi_select") return p.multi_select.map((x) => x.name).join(", ");
  if (p.type === "number") return p.number ?? "";
  if (p.type === "date") return p.date?.start || "";
  if (p.type === "url") return p.url || "";
  return "";
};
const pageUrl = (id) => `https://www.notion.so/${String(id).replace(/-/g, "")}`;
const DB_ORDER = ["ideas", "journal", "reading", "drafts", "memory", "diary"];

// Your TKS pages + the newest rows of every table (titles only; tap one to read it).
export async function notionOverview(env) {
  if (!notionReady(env)) return { ready: false };
  const ids = await ensureNotion(env);
  const tksKids = ids.tks ? (await notion(env, "GET", `/blocks/${ids.tks}/children?page_size=100`)).results || [] : [];
  const tks = tksKids.filter((b) => b.type === "child_page").map((b) => ({ id: b.id, title: b.child_page.title || "Untitled", url: pageUrl(b.id), date: b.last_edited_time }));
  const tables = await Promise.all(
    DB_ORDER.map(async (key) => {
      const rows = await notion(env, "POST", `/databases/${ids[key]}/query`, { page_size: 8, sorts: [{ timestamp: "created_time", direction: "descending" }] })
        .then((r) => r.results || [])
        .catch(() => []);
      return {
        key,
        name: TABLES[key].name,
        icon: TABLES[key].icon,
        url: pageUrl(ids[key]),
        items: rows.map((p) => ({ id: p.id, title: titleOf(p) || "Untitled", url: p.url, date: plainProp(p.properties.Date) || p.created_time.slice(0, 10) })),
      };
    })
  );
  return { ready: true, home: env.NOTION_PAGE, tks: { url: pageUrl(ids.tks), pages: tks }, tables };
}

// One page: its title, its fields (Book, Chapter, Answer…) and its text.
export async function notionPage(env, id) {
  if (!notionReady(env) || !/^[0-9a-f-]{32,36}$/i.test(id)) return { error: "bad page" };
  const page = await notion(env, "GET", `/pages/${id}`);
  const fields = Object.entries(page.properties || {})
    .filter(([, p]) => p.type !== "title")
    .map(([k, p]) => [k, String(plainProp(p))])
    .filter(([, v]) => v);
  const title = titleOf(page) || "Untitled";
  // sub-pages and tables inside it (pageText skips them), so a page holding only a table isn't "empty"
  const kids = ((await notion(env, "GET", `/blocks/${id}/children?page_size=100`).catch(() => ({}))).results || [])
    .filter((b) => b.type === "child_page" || b.type === "child_database")
    .map((b) => ({ id: b.id, kind: b.type === "child_page" ? "page" : "table", title: b[b.type].title || "Untitled", url: pageUrl(b.id) }));
  return { title, url: page.url, fields, text: (await pageText(env, id)).slice(0, 20000), children: kids };
}
