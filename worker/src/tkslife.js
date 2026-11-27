import { MODELS_SMART } from "./config.js";
import { addDaysISO, todayISO } from "./dates.js";
import { gemini, parseJson } from "./gemini.js";
import { notion, notionReady, pageText } from "./notion.js";
import { send } from "./telegram.js";

// ---------- TKS.life ----------
// Every 30 minutes Haneul checks Alex's TKS.life (the site's own backend, signed in as him):
// - braindates he logged → his Braindate Tracker in Notion, and a high-five draft for each person he
//   hasn't high-fived yet;
// - braindates he wrote notes about in Notion (TKS → Braindates) but didn't log yet → a log draft;
// - high fives he received, and open braindates that match his interests → a text.
// NOTHING is posted until he taps "Post on TKS.life" in the app's TKS.life panel.
// Sign-in: he types his email + password ONCE in the app; the worker trades them for TKS.life's session
// tokens and keeps only the tokens (never the password). The site renews them on every request, like his
// browser does. If TKS.life ever signs him out, she asks him to connect again.
// KV "tks_auth": { access, refresh, userId, since, expired? } · KV "tks": state below · KV "tks_people": cohort names

const API = "https://backend-v2.tks.life";
export const INTERESTS = /\b(space|space ?tech|aerospace|aeronautic\w*|rockets?|gnc|guidance|propulsion|robotics?|drones?|optimi[sz]ation|satellites?|orbit\w*|astro\w*|nasa|spacex)\b/i;

export class TksSignedOut extends Error {}
// TKS.life is down or acting up (maintenance, 5xx, timeouts, a brief 401 during an update): skip quietly.
export class TksDown extends Error {}

// Announced maintenance windows (UTC), plus a buffer after each one. No syncs and no sign-out alerts inside.
// Nov 22 2026, 2-4 p.m. PST = 22:00-00:00 UTC = 17:00-19:00 in Lima.
export const MAINTENANCE = [["2026-11-22T22:00:00Z", "2026-11-23T00:00:00Z"]];
const AFTER_BUFFER_MS = 30 * 60000;
// A 401 has to keep happening this long (several syncs) before it counts as a real sign-out.
export const SIGNOUT_CONFIRM_MS = 90 * 60000;

export function inMaintenance(now = Date.now(), windows = MAINTENANCE) {
  const w = windows.find(([a, b]) => now >= Date.parse(a) && now < Date.parse(b) + AFTER_BUFFER_MS);
  return w ? { until: Date.parse(w[1]) + AFTER_BUFFER_MS } : null;
}
// Is this 401 a confirmed sign-out? Only if the first one in a row was long enough ago.
export function signoutConfirmed(suspectSince, now = Date.now()) {
  return !!suspectSince && now - Date.parse(suspectSince) >= SIGNOUT_CONFIRM_MS;
}

// Same as the TKS.life site: send both tokens, keep the "accesstoken" it hands back, and retry once before
// treating a 401 (or 403 "Unauthorized") as a sign-out. Their backend keeps accepting the token past its
// 1-hour expiry as long as the refresh token goes along, which is why his browser never asks him to sign in.
// Outages never sign him out: 5xx / timeouts / maintenance → TksDown (skip this sync), and a 401 only becomes
// "signed out" (plus the text asking him to reconnect) after it keeps happening for 90 minutes.
async function tks(env, method, path, body, retried = false) {
  const auth = await env.DB.get("tks_auth", "json");
  if (!auth?.access || auth.expired) throw new TksSignedOut("TKS.life isn't connected");
  if (inMaintenance()) throw new TksDown("TKS.life is down for scheduled maintenance");
  let res;
  try {
    res = await fetch(`${API}${path}`, {
      method,
      headers: { Authorization: `Bearer ${auth.access}`, "access-token": auth.access, "refresh-token": auth.refresh, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20000),
    });
  } catch (err) {
    throw new TksDown(`TKS.life didn't answer (${err.message})`);
  }
  const fresh = res.headers.get("accesstoken");
  if (fresh && fresh !== auth.access) await env.DB.put("tks_auth", JSON.stringify({ ...auth, access: fresh, refresh: res.headers.get("refreshtoken") || auth.refresh, renewed: new Date().toISOString() }));
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 || (res.status === 403 && data.error === "Unauthorized")) {
    if (!retried) return tks(env, method, path, body, true);
    const now = await env.DB.get("tks_auth", "json") || auth;
    if (!signoutConfirmed(now.suspect)) {
      if (!now.suspect) await env.DB.put("tks_auth", JSON.stringify({ ...now, suspect: new Date().toISOString() }));
      throw new TksDown("TKS.life said 'unauthorized'; checking again on the next syncs before calling it a sign-out");
    }
    await env.DB.put("tks_auth", JSON.stringify({ ...now, expired: new Date().toISOString() }));
    await send(env, "🔐 TKS.life signed me out. Connect it again in the app (the TKS.life panel) so I can keep logging your braindates.").catch(() => {});
    throw new TksSignedOut("TKS.life signed out");
  }
  if (res.status >= 500 || res.status === 429) throw new TksDown(`TKS.life is having trouble (${res.status})`);
  if (!res.ok) throw new Error(`TKS.life: ${data.message || data.error || res.status}`);
  // it works: a 401 streak (if any) is over
  if (auth.suspect) {
    const cur = (await env.DB.get("tks_auth", "json")) || auth;
    delete cur.suspect;
    await env.DB.put("tks_auth", JSON.stringify(cur));
  }
  return data;
}

// The password goes straight to TKS.life and is never stored.
export async function tksConnect(env, { email, password }) {
  if (!email || !password) return { error: "email and password, please" };
  const res = await fetch(`${API}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: String(email).toLowerCase().trim(), password: String(password) }), signal: AbortSignal.timeout(20000) });
  const data = await res.json().catch(() => ({}));
  const access = res.headers.get("accesstoken");
  if (!res.ok || !access) return { error: res.status === 401 || res.status === 400 ? "TKS.life said the email or password is wrong" : `TKS.life: ${data.message || res.status}` };
  const userId = res.headers.get("userid") || data.userId || data.uuid || "";
  await env.DB.put("tks_auth", JSON.stringify({ access, refresh: res.headers.get("refreshtoken") || access, userId, since: new Date().toISOString() }));
  return { ok: true };
}

export async function tksDisconnect(env) {
  await env.DB.delete("tks_auth");
  return { ok: true };
}

async function getState(env) {
  return (await env.DB.get("tks", "json")) || { seenLogs: [], seenRecv: [], seenOpen: [], drafted: [], drafts: [] };
}
async function saveState(env, st) {
  st.seenLogs = st.seenLogs.slice(-300); st.seenRecv = st.seenRecv.slice(-300); st.seenOpen = st.seenOpen.slice(-300); st.drafted = st.drafted.slice(-300);
  st.drafts = st.drafts.filter((d) => d.status === "draft" || Date.now() - d.created < 14 * 86400000).slice(-60);
  await env.DB.put("tks", JSON.stringify(st));
}

export async function tksStatus(env) {
  const auth = await env.DB.get("tks_auth", "json");
  const st = await getState(env);
  const m = inMaintenance();
  return { connected: !!auth?.access && !auth.expired, expired: !!auth?.expired, since: auth?.since || null, last: st.last || null,
    paused: m ? new Date(m.until).toISOString() : st.down && Date.now() - Date.parse(st.down.at) < 3600000 ? st.down.why : null, drafts: st.drafts.filter((d) => d.status === "draft"), recent: st.recent || null };
}

// Cohort names → TKS.life ids (only id, name, username are kept). Refreshed weekly.
async function people(env) {
  const cached = await env.DB.get("tks_people", "json");
  if (cached && Date.now() - cached.at < 7 * 86400000) return cached.list;
  const data = await tks(env, "GET", "/students/community");
  const list = (data.cohorts || []).flatMap((c) => c.students || []).map((s) => ({ id: s.id, name: s.name, username: s.username }));
  await env.DB.put("tks_people", JSON.stringify({ at: Date.now(), list }));
  return list;
}
const norm = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z ]/g, "").trim();
export function matchPerson(list, name) {
  const n = norm(name);
  if (!n) return null;
  return list.find((p) => norm(p.name) === n) || list.find((p) => norm(p.name).startsWith(n + " ") || n.startsWith(norm(p.name) + " ")) || list.find((p) => norm(p.name).split(" ")[0] === n.split(" ")[0] && n.split(" ").length === 1) || null;
}

// His own past writing, so drafts sound like him.
const styleOf = (examples) => examples.filter(Boolean).slice(0, 3).map((t) => `- "${String(t).slice(0, 400)}"`).join("\n");

async function draftHighFive(env, { name, log, examples }) {
  const r = parseJson(await gemini(env, [{ role: "user", parts: [{ text: `Write a TKS.life "high five" from Alex (11th grader, TKS, space tech) to ${name}, after their braindate.
His log of the braindate: "${log}"
High fives he wrote before (match this voice: warm, simple, enthusiastic, specific; 2-3 sentences):
${styleOf(examples) || '- "Priya is really cool! We can talk about anything and enjoy it!"'}
Mention one real thing from the log. No hashtags, no emojis overload (0-1). Return JSON: {"message": "..."}` }] }], { json: true, models: MODELS_SMART }));
  return String(r?.message || "").trim().slice(0, 600);
}

async function draftLog(env, { name, notes, examples }) {
  const r = parseJson(await gemini(env, [{ role: "user", parts: [{ text: `Write Alex's TKS.life braindate log for his braindate with ${name}, from his own notes:
"${notes}"
His past logs (match this voice exactly: first person, friendly, 2-4 sentences, ends warmly):
${styleOf(examples)}
Use only facts from the notes. Return JSON: {"title": "3-6 word title like 'Space, SAT, and more!'", "note": "..."}` }] }], { json: true, models: MODELS_SMART }));
  return { title: String(r?.title || `Braindate with ${name}`).slice(0, 80), note: String(r?.note || "").trim().slice(0, 1500) };
}

// One line per braindate in a person's "TKS.life Log", newest first.
export const logLine = (b) => `${String(b.happenedAt).slice(0, 10)} · ${b.title}: ${b.note || ""}`.replace(/\s+/g, " ").trim();
export function mergeLog(old, lines) {
  const have = String(old || "").split("\n").filter((l) => /^\d{4}-\d\d-\d\d · /.test(l)); // older one-line logs get rewritten
  const all = [...lines, ...have].filter((l, i, a) => a.findIndex((x) => x.slice(0, 40) === l.slice(0, 40)) === i);
  return all.sort().reverse().join("\n").slice(0, 1900);
}
// Every braindate → one entry per person: earliest date met, all their braindates.
export function groupBraindates(logs) {
  const by = new Map();
  for (const b of logs) for (const p of b.people || []) {
    const g = by.get(p.id) || { person: p, met: b.happenedAt, lines: [] };
    if (b.happenedAt < g.met) g.met = b.happenedAt;
    g.lines.push(logLine(b));
    by.set(p.id, g);
  }
  return [...by.values()].sort((a, b) => String(a.met).localeCompare(String(b.met)));
}

async function trackerCol(env, db, st) {
  if (st.trackerCol) return;
  await notion(env, "PATCH", `/databases/${db}`, { properties: { "TKS.life Log": { rich_text: {} } } });
  st.trackerCol = true;
}

// A person from TKS.life → their row in the Braindate Tracker (created, or the log added to it).
async function upsertPerson(env, db, { person: p, met, lines }) {
  const rt = (s) => (s ? [{ type: "text", text: { content: String(s).slice(0, 1900) } }] : []);
  const found = (await notion(env, "POST", `/databases/${db}/query`, { filter: { property: "Contact Name", title: { equals: p.name } }, page_size: 1 })).results?.[0];
  if (found) {
    const old = (found.properties?.["TKS.life Log"]?.rich_text || []).map((t) => t.plain_text).join("");
    const props = { "TKS.life Log": { rich_text: rt(mergeLog(old, lines)) } };
    if (!found.properties?.["Met On"]?.date?.start) props["Met On"] = { date: { start: String(met).slice(0, 10) } };
    await notion(env, "PATCH", `/pages/${found.id}`, { properties: props });
    return "updated";
  }
  await notion(env, "POST", "/pages", { parent: { database_id: db }, properties: {
    "Contact Name": { title: rt(p.name) },
    Relationship: { select: { name: "TKS Peer" } },
    "Met On": { date: { start: String(met).slice(0, 10) } },
    Focus: { rich_text: rt(p.currentFocus) },
    "TKS.life Log": { rich_text: rt(mergeLog("", lines)) },
    ...(p.username ? { "Notes Page": { url: `https://tks.life/profile/${p.username}` } } : {}),
  } });
  return "created";
}

async function toTracker(env, b, st) {
  if (!notionReady(env)) return;
  const bd = await env.DB.get("braindates", "json");
  if (!bd?.db) return;
  await trackerCol(env, bd.db, st);
  for (const g of groupBraindates([b])) await upsertPerson(env, bd.db, g);
}

// Every braindate he ever logged → the tracker. Runs as a chain of background jobs, BACKFILL_BATCH
// people per job (2 Notion calls each), so each run stays under Cloudflare's 50 outside requests.
const BACKFILL_BATCH = 15;
export async function tksBackfill(env, { offset = 0 } = {}) {
  const bd = await env.DB.get("braindates", "json");
  if (!bd?.db || !notionReady(env)) return { error: "Braindate Tracker not set up" };
  const st = await getState(env);
  let job = offset ? await env.DB.get("tks_backfill", "json") : null;
  if (!job) {
    const logs = [];
    for (let page = 1; page <= 10; page++) {
      const got = (await tks(env, "GET", `/completed-brain-dates/me?page=${page}&limit=50`)).brainDates || [];
      logs.push(...got.filter((b) => !logs.some((x) => x.id === b.id)));
      if (got.length < 50) break;
    }
    job = { braindates: logs.length, groups: groupBraindates(logs), created: 0, updated: 0, started: new Date().toISOString() };
    st.seenLogs = [...new Set([...st.seenLogs, ...logs.map((b) => b.id)])];
    await trackerCol(env, bd.db, st);
    await saveState(env, st);
  }
  for (const g of job.groups.slice(offset, offset + BACKFILL_BATCH)) job[await upsertPerson(env, bd.db, g)]++;
  const next = offset + BACKFILL_BATCH;
  job.done = next >= job.groups.length;
  job.at = Math.min(next, job.groups.length);
  await env.DB.put("tks_backfill", JSON.stringify(job), { expirationTtl: 7 * 86400 });
  if (!job.done) await env.BG_JOBS.send({ kind: "tks_backfill", offset: next }, { delaySeconds: 5 });
  return { braindates: job.braindates, people: job.groups.length, at: job.at, created: job.created, updated: job.updated, done: job.done };
}

// Every 30 min. While TKS.life is down (maintenance, errors, a short 401 streak) the sync is skipped quietly.
export async function tksSync(env, haneulSays) {
  if (inMaintenance()) return { skipped: "maintenance" };
  try {
    return await syncOnce(env, haneulSays);
  } catch (err) {
    if (err instanceof TksDown) {
      const st = await getState(env);
      st.down = { at: new Date().toISOString(), why: err.message };
      await saveState(env, st);
      return { skipped: err.message };
    }
    throw err;
  }
}

async function syncOnce(env, haneulSays) {
  const auth = await env.DB.get("tks_auth", "json");
  if (!auth?.access || auth.expired) return { skipped: true };
  const st = await getState(env);
  const first = !st.started;
  const res = { logs: 0, highFives: 0, logDrafts: 0, received: 0, open: 0 };
  const news = [];

  const logs = (await tks(env, "GET", "/completed-brain-dates/me?page=1&limit=10")).brainDates || [];
  const given = (await tks(env, "GET", "/high-fives/given?page=1&limit=50")).highFives || [];
  const gaveTo = new Set(given.map((h) => h.recipient?.id));
  const hfExamples = given.map((h) => h.message);
  const logExamples = logs.map((l) => l.note);

  // 1. braindates he logged
  for (const b of logs.slice().reverse()) {
    if (st.seenLogs.includes(b.id)) continue;
    st.seenLogs.push(b.id);
    if (first && b.happenedAt < addDaysISO(todayISO(), -3)) continue; // first run: only the last few days
    await toTracker(env, b, st).catch((err) => console.error("tks tracker:", err.message));
    res.logs++;
    for (const p of b.people || []) {
      const key = `hf:${p.id}`;
      if (gaveTo.has(p.id) || st.drafted.includes(key) || res.highFives >= 3) continue;
      const message = await draftHighFive(env, { name: p.name, log: b.note, examples: hfExamples }).catch(() => "");
      if (!message) continue;
      st.drafted.push(key);
      st.drafts.push({ id: crypto.randomUUID(), kind: "highfive", recipientId: p.id, name: p.name, text: message, status: "draft", created: Date.now() });
      res.highFives++;
    }
  }

  // 2. Notion braindate notes he hasn't logged on TKS.life yet → a log draft
  const bd = await env.DB.get("braindates", "json");
  const loggedNames = new Set(logs.flatMap((b) => (b.people || []).map((p) => norm(p.name))));
  if (bd?.src && notionReady(env)) {
    const kids = ((await notion(env, "GET", `/blocks/${bd.src}/children?page_size=100`)).results || []).filter((k) => k.type === "child_page" && Date.now() - Date.parse(k.created_time) < 7 * 86400000);
    let list = null;
    for (const k of kids) {
      const name = k.child_page.title;
      const key = `log:${k.id}`;
      if (st.drafted.includes(key) || res.logDrafts >= 2) continue;
      if (loggedNames.has(norm(name)) || [...loggedNames].some((n) => n.split(" ")[0] === norm(name).split(" ")[0] && norm(name).split(" ").length === 1)) { st.drafted.push(key); continue; }
      const notes = await pageText(env, k.id, { left: 4 }).catch(() => "");
      if (notes.trim().length < 40) continue; // wait until he wrote something
      list ||= await people(env).catch(() => []);
      const who = matchPerson(list, name);
      const d = await draftLog(env, { name, notes, examples: logExamples }).catch(() => null);
      if (!d?.note) continue;
      const date = (notes.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/) || []);
      st.drafted.push(key);
      st.drafts.push({ id: crypto.randomUUID(), kind: "log", name, peopleIds: who ? [who.id] : [], matched: !!who, happenedAt: date[0] ? `${date[3]}-${date[2].padStart(2, "0")}-${date[1].padStart(2, "0")}` : k.created_time.slice(0, 10), title: d.title, text: d.note, status: "draft", created: Date.now() });
      res.logDrafts++;
    }
  }

  // 3. high fives he got
  const recv = (await tks(env, "GET", "/high-fives/received?page=1&limit=10")).highFives || [];
  for (const h of recv) {
    if (st.seenRecv.includes(h.id)) continue;
    st.seenRecv.push(h.id);
    if (first) continue;
    news.push(`${h.sender?.name || "Someone"} gave him a high five on TKS.life: "${String(h.message || "").slice(0, 200)}"`);
    res.received++;
  }

  // 4. open braindates that fit his interests
  const open = (await tks(env, "GET", "/braindates?page=1&limit=10&isClosed=false&program=innovate")).braindates || [];
  for (const o of open) {
    if (st.seenOpen.includes(o.id)) continue;
    st.seenOpen.push(o.id);
    if (first || !INTERESTS.test(`${o.title} ${o.description}`)) continue;
    news.push(`New open braindate on TKS.life that fits his interests: "${o.title}": ${String(o.description || "").slice(0, 200)}`);
    res.open++;
  }

  // what the panel shows (names, dates, titles only)
  st.recent = {
    logs: logs.slice(0, 6).map((b) => ({ with: (b.people || []).map((p) => p.name).join(", "), date: String(b.happenedAt).slice(0, 10), title: b.title })),
    received: recv.slice(0, 5).map((h) => ({ from: h.sender?.name || "", text: String(h.message || "").slice(0, 220), at: h.createdAt })),
    open: open.filter((o) => INTERESTS.test(`${o.title} ${o.description}`)).slice(0, 5).map((o) => ({ title: o.title, text: String(o.description || "").slice(0, 220), at: o.createdAt })),
  };
  st.started = true;
  st.last = { at: new Date().toISOString(), ...res };
  delete st.down;
  await saveState(env, st);

  const drafts = res.highFives + res.logDrafts;
  if (haneulSays && (drafts || news.length)) {
    await haneulSays(env, `TKS.life update for Alex, in 1-2 short texts:
${drafts ? `- you drafted ${res.highFives ? `${res.highFives} high five(s)` : ""}${res.highFives && res.logDrafts ? " and " : ""}${res.logDrafts ? `${res.logDrafts} braindate log(s)` : ""}; they're waiting in the TKS.life panel of the app (nothing is posted until he taps Post).` : ""}
${news.map((n) => `- ${n}`).join("\n")}`, { maxTexts: 2 }).catch((err) => console.error("tks ping:", err.message));
  }
  return res;
}

// He tapped "Post on TKS.life".
export async function tksPost(env, { id, text, title }) {
  const st = await getState(env);
  const d = st.drafts.find((x) => x.id === id);
  if (!d || d.status !== "draft") return { error: "that draft is gone" };
  const body = String(text ?? d.text).trim();
  if (!body) return { error: "it's empty" };
  if (d.kind === "highfive") {
    await tks(env, "POST", `/high-fives/${d.recipientId}`, { message: body });
  } else {
    if (!d.peopleIds?.length) return { error: `I couldn't find ${d.name} on TKS.life; log it there yourself` };
    await tks(env, "POST", "/completed-brain-dates", { peopleIds: d.peopleIds, happenedAt: d.happenedAt, title: String(title ?? d.title).slice(0, 120), note: body, requestId: crypto.randomUUID() });
  }
  d.text = body;
  if (title) d.title = title;
  d.status = "posted";
  d.posted = Date.now();
  await saveState(env, st);
  return { ok: true };
}

export async function tksSkip(env, { id }) {
  const st = await getState(env);
  const d = st.drafts.find((x) => x.id === id);
  if (d) d.status = "skipped";
  await saveState(env, st);
  return { ok: true };
}
