import { MODELS_LIGHT } from "./config.js";
import { addDaysISO, shortDateISO, todayISO } from "./dates.js";
import { gemini } from "./gemini.js";
import { send } from "./telegram.js";
import { nextId } from "./todos.js";
import { notionArchive, notionDiary, notionMemory, notionMemoryRows, notionReady, notionUpdateMemory, toNotion } from "./notion.js";

// ---------- Long-term memory ----------
// Facts about Alex: saved by hand ("remember that…", /remember, voice) or automatically
// by Haneul while chatting (source "chat"). Given to the assistant in chat, link summaries,
// TKS drafts and the monthly draft. Plus a nightly chat diary (one summary per day).

const MAX_FACTS = 1000;
const NEWEST_IN_PROMPT = 120; // the newest facts, always
const RELEVANT_IN_PROMPT = 60; // plus older facts that share words with what Alex just said
const DIARY_DAYS_IN_PROMPT = 30;

export async function getMemory(env) {
  return (await env.DB.get("memory", "json")) || [];
}

const norm = (s) => s.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").replace(/[^\p{L}\p{N} ]/gu, "").trim(); // \p{M} = accents

// The words that carry meaning: "Alex shared that Jensen Huang…" and "Alex told Haneul that
// Jensen Huang…" have the same ones, so they count as the same fact.
const FILLER = new Set(("alex haneul told tells shared shares said says mentioned mentions that the and his him he her she " +
  "with about has have had was were is are for from this these those really very also just into onto who what which " +
  "when where they them their there then than because been being will would could should can its it's alexs").split(" "));
export function keyWords(text) {
  return new Set(norm(text).split(/\s+/).filter((w) => w.length > 2 && !FILLER.has(w)));
}

// Same fact? Most of the meaningful words overlap (works across rewordings).
export function sameFact(a, b) {
  const A = keyWords(a);
  const B = keyWords(b);
  if (!A.size || !B.size) return norm(a) === norm(b);
  let both = 0;
  for (const w of A) if (B.has(w)) both++;
  const small = Math.min(A.size, B.size);
  return both / small >= 0.8 || both / (A.size + B.size - both) >= 0.6;
}

// Saves facts that aren't already known (including the same fact in other words).
export async function rememberMany(env, texts, source = "manual") {
  const memory = await getMemory(env);
  const saved = [];
  for (const raw of texts) {
    const text = String(raw || "").trim().slice(0, 500);
    if (norm(text).length < 6) continue;
    const twin = memory.find((f) => sameFact(f.text, text));
    if (twin) {
      // Already known. If the new wording has more detail, keep that one (and update Notion).
      if (keyWords(text).size > keyWords(twin.text).size) {
        twin.text = text;
        twin.updated = todayISO();
        twin.dirty = true;
      }
      continue;
    }
    const fact = { id: nextId(memory), text, date: todayISO(), source };
    memory.push(fact);
    saved.push(fact);
  }
  const dirty = memory.filter((f) => f.dirty);
  if (saved.length || dirty.length) {
    // Mirror new facts to the Notion "Memory" table and remember their row ids (for the two-way sync).
    for (const f of saved) f.np = await notionMemory(env, f).catch((err) => (console.error("notion memory:", err.message), null));
    for (const f of dirty) {
      delete f.dirty;
      if (f.np) await toNotion(env, notionUpdateMemory(env, f.np, f.text));
    }
    await env.DB.put("memory", JSON.stringify(memory.slice(-MAX_FACTS)));
  }
  return saved;
}

export async function remember(env, text) {
  const [fact] = await rememberMany(env, [text], "manual");
  return fact || (await getMemory(env)).find((f) => sameFact(f.text, text)) || { id: "?", text };
}

// For prompts: the newest facts + older ones related to `query` (what Alex just said).
export async function memoryText(env, query = "") {
  const memory = await getMemory(env);
  const newest = memory.slice(-NEWEST_IN_PROMPT);
  const older = memory.slice(0, -NEWEST_IN_PROMPT);
  let relevant = [];
  const q = keyWords(query);
  if (q.size && older.length) {
    relevant = older
      .map((f) => ({ f, score: [...keyWords(f.text)].filter((w) => q.has(w)).length }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, RELEVANT_IN_PROMPT)
      .map((x) => x.f);
  }
  const facts = [...relevant, ...newest];
  return facts.map((f) => `- (${shortDateISO(f.date)}) ${f.text}`).join("\n") || "(nothing saved yet)";
}

// One-time cleanup: merge facts that are the same thing in different words (keeps the more
// detailed wording, removes the extra row in Notion too). Returns how many were removed.
export async function dedupeMemory(env) {
  const memory = await getMemory(env);
  const kept = [];
  let removed = 0;
  for (const f of memory) {
    const twin = kept.find((k) => sameFact(k.text, f.text));
    if (!twin) {
      kept.push(f);
      continue;
    }
    removed++;
    const keepNew = keyWords(f.text).size > keyWords(twin.text).size;
    const drop = keepNew ? twin : f;
    if (keepNew) Object.assign(twin, { text: f.text, np: twin.np || f.np });
    if (drop.np && drop.np !== twin.np) await toNotion(env, notionArchive(env, drop.np));
    if (keepNew && twin.np) await toNotion(env, notionUpdateMemory(env, twin.np, twin.text));
  }
  if (removed) await env.DB.put("memory", JSON.stringify(kept));
  return removed;
}

// "remember that ...", "recuerda que ...", "acuérdate de ..." → returns the fact, or null
export function rememberPhrase(text) {
  const m = text.match(/^(please\s+)?(remember( that)?|recuerda( que)?|acu[eé]rdate( de| que)?)[\s:,]+(.+)$/is);
  return m ? m[6].trim() : null;
}

export async function onMemoryCommand(env, cmd, arg) {
  const memory = await getMemory(env);
  if (cmd === "/remember") {
    if (!arg) return send(env, "Tell me what to remember, e.g.: /remember my rocket landing sim is written in Python");
    const f = await remember(env, arg);
    return send(env, `🧠 Got it, I'll remember that (#${f.id}).`);
  }
  // /memory [all | delete N | <search words>]
  const [act, n] = arg.split(/\s+/);
  const a = (act || "").toLowerCase();
  if (a === "delete" && Number(n)) {
    if (!memory.some((f) => f.id === Number(n))) return send(env, `I couldn't find memory #${n}.`);
    const gone = memory.find((f) => f.id === Number(n));
    await env.DB.put("memory", JSON.stringify(memory.filter((f) => f.id !== Number(n))));
    await toNotion(env, notionArchive(env, gone?.np)); // also remove it from Notion
    return send(env, `🗑️ Forgot #${n}.`);
  }
  if (!memory.length) return send(env, "🧠 I don't remember anything about you yet. Just chat with me, or: remember that …");
  const line = (f) => `#${f.id} ${f.source === "chat" ? "💬" : "📌"} ${shortDateISO(f.date)}: ${f.text}`;
  let shown = memory;
  let title = `🧠 What I remember about you (${memory.length})`;
  if (arg && a !== "all") {
    const words = norm(arg).split(" ").filter(Boolean);
    shown = memory.filter((f) => words.every((w) => norm(f.text).includes(w)));
    title = `🧠 ${shown.length} memories about "${arg}"`;
  } else if (a !== "all" && memory.length > 40) {
    shown = memory.slice(-40);
    title += `, newest 40 (/memory all for everything)`;
  }
  return send(env, `${title}\n💬 = I picked it up while chatting · 📌 = you asked me to remember\n\n${[...shown].reverse().map(line).join("\n")}\n\n/memory delete 3 · /memory <search>`);
}

// ---------- Chat diary ----------
// Every chat message is logged for the day; at night Haneul writes a short summary,
// so she remembers what you talked about long after the chat history is gone.

export async function logChatDay(env, entries) {
  const key = `chat_day:${todayISO()}`;
  const log = (await env.DB.get(key, "json")) || [];
  for (const { who, text } of entries) log.push({ who, text: String(text).slice(0, 800) });
  await env.DB.put(key, JSON.stringify(log.slice(-200)), { expirationTtl: 60 * 60 * 24 * 3 });
}

export async function writeChatDiary(env, day = todayISO()) {
  const log = (await env.DB.get(`chat_day:${day}`, "json")) || [];
  if (!log.length) return;
  const diary = (await env.DB.get("chat_diary", "json")) || [];
  if (diary.some((d) => d.date === day)) return;
  const transcript = log.map((m) => `${m.who}: ${m.text}`).join("\n").slice(-12000);
  const summary = await gemini(
    env,
    [{ role: "user", parts: [{ text: `Summarize today's chat between Alex and Haneul (Alex's assistant bot) in 2-4 short sentences,
in English, third person (Alex is a boy: he/him). Keep what matters for remembering later: news, feelings, plans, decisions,
open questions, jokes worth remembering. Skip greetings and small talk.\n\n${transcript}` }] }],
    { models: MODELS_LIGHT }
  );
  diary.push({ date: day, summary: summary.trim().slice(0, 1200) });
  await toNotion(env, notionDiary(env, { date: day, summary: summary.trim() }));
  await env.DB.put("chat_diary", JSON.stringify(diary.slice(-120)));
}

export async function diaryText(env) {
  const diary = ((await env.DB.get("chat_diary", "json")) || []).filter((d) => d.date >= addDaysISO(todayISO(), -DIARY_DAYS_IN_PROMPT));
  return diary.map((d) => `- ${shortDateISO(d.date)}: ${d.summary}`).join("\n") || "(no earlier chats yet)";
}

// ---------- Two-way sync with Notion (hourly) ----------
// Notion is where Alex can read and edit Haneul's memory comfortably; the bot keeps a fast
// copy. Every hour: a row deleted in Notion is forgotten, an edited row updates the fact,
// a row Alex added himself is learned, and any fact not in Notion yet is copied there.

export async function syncMemoryWithNotion(env) {
  if (!notionReady(env)) return null;
  const rows = await notionMemoryRows(env);
  if (!rows) return null;
  const memory = await getMemory(env);
  const clean = (id) => (id || "").replace(/-/g, "");
  const byNp = new Map(rows.map((r) => [clean(r.np), r]));
  const result = { removed: 0, edited: 0, added: 0, uploaded: 0, duplicates: 0 };
  const kept = [];
  const used = new Set(); // Notion rows already matched to a fact

  for (const f of memory) {
    if (!f.np) {
      // Not linked yet. If Notion already has this fact (e.g. a row created by a request that
      // timed out), reuse that row instead of making a second one.
      const twin = rows.find((r) => !used.has(clean(r.np)) && r.text && sameFact(r.text, f.text));
      f.np = twin ? twin.np : await notionMemory(env, f).catch(() => null);
      if (f.np && !twin) result.uploaded++;
      if (f.np) used.add(clean(f.np));
      kept.push(f);
      continue;
    }
    const row = byNp.get(clean(f.np));
    if (!row) { result.removed++; continue; } // deleted in Notion → forget it
    if (used.has(clean(f.np))) { result.duplicates++; continue; } // two facts on one row: keep one
    used.add(clean(f.np));
    if (row.text && row.text !== f.text) { f.text = row.text.slice(0, 500); result.edited++; }
    kept.push(f);
  }
  for (const r of rows) {
    if (used.has(clean(r.np)) || !r.text) continue;
    if (kept.some((f) => sameFact(f.text, r.text))) {
      // An extra copy of a fact she already has: delete the extra row instead of importing it.
      await toNotion(env, notionArchive(env, r.np));
      result.duplicates++;
      continue;
    }
    kept.push({ id: nextId(kept), text: r.text.slice(0, 500), date: r.date, source: "notion", np: r.np }); // added by Alex
    used.add(clean(r.np));
    result.added++;
  }
  await env.DB.put("memory", JSON.stringify(kept.slice(-MAX_FACTS)));
  return result;
}

// One-time copy of what Haneul already had before Notion (diary, ideas, journal) into Notion.
// Memory facts are copied by syncMemoryWithNotion itself.
export async function backfillNotion(env) {
  if (!notionReady(env) || (await env.DB.get("notion_backfill_done"))) return null;
  const { notionIdea, notionJournal } = await import("./notion.js");
  const counts = { diary: 0, ideas: 0, journal: 0 };
  for (const d of (await env.DB.get("chat_diary", "json")) || []) {
    await notionDiary(env, d);
    counts.diary++;
  }
  for (const n of (await env.DB.get("notes", "json")) || []) {
    await notionIdea(env, n);
    counts.ideas++;
  }
  for (const j of (await env.DB.get("journal", "json")) || []) {
    await notionJournal(env, j);
    counts.journal++;
  }
  await env.DB.put("notion_backfill_done", new Date().toISOString());
  return counts;
}

// The hourly job: copy old stuff once, then the two-way memory sync.
export async function runNotionSync(env) {
  // One-time cleanup of facts saved twice in different words (before the smarter check existed).
  let deduped = 0;
  if (!(await env.DB.get("memory_deduped_v2"))) {
    deduped = await dedupeMemory(env);
    await env.DB.put("memory_deduped_v2", new Date().toISOString());
  }
  const backfill = await backfillNotion(env);
  const memory = await syncMemoryWithNotion(env);
  console.log("notion sync:", JSON.stringify({ deduped, backfill, memory }));
  await env.DB.put("notion_sync_last", JSON.stringify({ at: new Date().toISOString(), deduped, memory }));
  return { deduped, backfill, memory };
}
