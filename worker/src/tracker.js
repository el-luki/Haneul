import { addDaysISO, todayISO } from "./dates.js";
import { findChildPage, notion, notionReady, pageIdFrom, pageText } from "./notion.js";
import { STAGE_NAME, addLog, listContacts, profile, saveContact, slug } from "./outreach.js";

// ---------- Networking Tracker (Notion) ----------
// A Velocity goal: one tracker of every mentor / person Alex is reaching out to. He added a Notion
// template ("Networking Tracker": Contact Name, Relationship, Last Interaction Date, Follow-up Date,
// Last Topic Discussed, Notes) inside Haneul's page. Every hour it's synced both ways with her outreach list:
// - everyone past "Research" (drafted, sent, replied, call, mentor, closed) gets a row, kept up to date;
// - what he edits in Notion (follow-up date, last interaction, notes, relationship) flows back into Haneul;
// - a person he adds himself in Notion becomes an outreach contact; a row he deletes stays deleted.
// KV "tracker": { db, columns, cleaned, rows: { contactId: { np, sent } }, hidden: [contactId], last }

const COLS = { name: "Contact Name", rel: "Relationship", last: "Last Interaction Date", follow: "Follow-up Date", topic: "Last Topic Discussed", notes: "Notes" };
// Columns Haneul adds to the template (once).
const EXTRA = {
  Organization: { rich_text: {} },
  Stage: { select: { options: Object.values(STAGE_NAME).map((name) => ({ name })) } },
  Email: { email: {} },
  "Haneul ID": { rich_text: {} }, // links the row to her contact; don't edit
};
const SAMPLES = ["John Doe", "Mark Johnson", "Jane Smith"]; // the template's example rows
const MAX_WRITES = 30; // the free plan allows 50 outside requests per run

const rt = (s) => (s ? [{ type: "text", text: { content: String(s).slice(0, 1900) } }] : []);
const plain = (p) => (p?.[p.type] && Array.isArray(p[p.type]) ? p[p.type].map((r) => r.plain_text).join("") : "");
const clean = (id) => String(id || "").replace(/-/g, "");

async function getState(env) {
  return (await env.DB.get("tracker", "json")) || { rows: {}, hidden: [] };
}

// The tracker table: any table titled "…tracker…"/"…network…" in Haneul's page or one level below.
async function findTracker(env, st) {
  if (st.db) return st.db;
  const home = pageIdFrom(env.NOTION_PAGE);
  const kids = async (id) => (await notion(env, "GET", `/blocks/${id}/children?page_size=100`)).results || [];
  const isIt = (b) => b.type === "child_database" && /track|network/i.test(b.child_database.title);
  const top = await kids(home);
  let hit = top.find(isIt);
  for (const p of top.filter((b) => b.type === "child_page" && /network|connect|outreach|mentor/i.test(b.child_page.title))) {
    if (hit) break;
    hit = (await kids(p.id)).find(isIt);
  }
  if (hit) st.db = hit.id;
  return st.db || null;
}

// A Notion row → the fields Haneul cares about.
export function readRow(page) {
  const P = page.properties || {};
  const titleProp = Object.values(P).find((p) => p.type === "title");
  return {
    np: page.id,
    name: plain(titleProp).trim(),
    rel: P[COLS.rel]?.select?.name || "",
    last: P[COLS.last]?.date?.start || "",
    follow: P[COLS.follow]?.date?.start || "",
    topic: plain(P[COLS.topic]).trim(),
    notes: plain(P[COLS.notes]).trim(),
    org: plain(P.Organization).trim(),
    stage: P.Stage?.select?.name || "",
    email: P.Email?.email || "",
    hid: plain(P["Haneul ID"]).trim(),
  };
}

// What a contact's row should say.
export function rowFor(c, { cadence = 7, topic = "", rel = "", today = todayISO() } = {}) {
  let follow = c.nextFollowUp || "";
  if (!follow && c.lastContact) {
    if (c.stage === "sent") follow = addDaysISO(c.lastContact, cadence);
    else if (c.stage === "mentor") follow = addDaysISO(c.lastContact, 30);
    else if (c.stage === "call") follow = addDaysISO(c.lastContact, 2);
  }
  if (!follow && c.stage === "replied") follow = today;
  return {
    name: String(c.name || c.org || "").slice(0, 120),
    org: c.name ? String(c.org || "") : "",
    rel: rel || (c.stage === "mentor" ? "Mentor" : "Industry Acquaintance"),
    stage: STAGE_NAME[c.stage] || "",
    email: c.email || "",
    last: c.lastContact || "",
    follow: c.stage === "closed" ? "" : follow,
    topic: String(topic || "").slice(0, 300),
    notes: String(c.notes || "").slice(0, 1500),
  };
}

function props(r, id) {
  const d = (x) => ({ date: x ? { start: x } : null });
  return {
    [COLS.name]: { title: rt(r.name || "Unnamed") },
    [COLS.rel]: { select: r.rel ? { name: r.rel } : null },
    [COLS.last]: d(r.last),
    [COLS.follow]: d(r.follow),
    [COLS.topic]: { rich_text: rt(r.topic) },
    [COLS.notes]: { rich_text: rt(r.notes) },
    Organization: { rich_text: rt(r.org) },
    Stage: { select: r.stage ? { name: r.stage } : null },
    Email: { email: r.email || null },
    ...(id ? { "Haneul ID": { rich_text: rt(id) } } : {}),
  };
}

const FIELDS = ["name", "rel", "last", "follow", "topic", "notes", "org", "stage", "email"];
export const differs = (a, b) => FIELDS.some((k) => String(a?.[k] || "") !== String(b?.[k] || ""));

// Alex's edits in Notion (vs what Haneul last wrote there) → the contact. Returns true if it changed.
export function pullEdits(c, row, sent) {
  if (!sent) return false;
  let changed = false;
  const take = (k, field, label) => {
    if (row[k] === (sent[k] || "") || row[k] === (c[field] || "")) return;
    c[field] = row[k] || (field === "notes" ? "" : null);
    addLog(c, `${label} → ${row[k] || "(cleared)"} (edited in Notion)`);
    changed = true;
  };
  take("follow", "nextFollowUp", "Next follow-up");
  take("last", "lastContact", "Last contact");
  take("notes", "notes", "Notes");
  if (row.rel && row.rel !== sent.rel) { c.relationship = row.rel; changed = true; }
  return changed;
}

export async function syncTracker(env) {
  if (!notionReady(env) || !env.FEED) return { skipped: true };
  const st = await getState(env);
  const db = await findTracker(env, st);
  if (!db) return { error: "no Networking Tracker table found in Haneul's Notion page" };
  const res = { created: 0, updated: 0, pulled: 0, imported: 0, removed: 0, samples: 0 };
  let writes = 0;

  if (!st.columns) {
    await notion(env, "PATCH", `/databases/${db}`, { properties: EXTRA });
    st.columns = true;
    writes++;
  }

  // all rows
  const rows = [];
  let cursor;
  for (let i = 0; i < 5; i++) {
    const data = await notion(env, "POST", `/databases/${db}/query`, { page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) });
    rows.push(...(data.results || []).map(readRow));
    writes++;
    if (!data.has_more) break;
    cursor = data.next_cursor;
  }

  // the template's three examples go to Notion's trash (once)
  if (!st.cleaned) {
    for (const r of rows.filter((r) => !r.hid && SAMPLES.includes(r.name) && r.last < "2026")) {
      await notion(env, "PATCH", `/pages/${r.np}`, { archived: true });
      r.gone = true;
      res.samples++;
      writes++;
    }
    st.cleaned = true;
  }

  const contacts = await listContacts(env);
  const byId = new Map(contacts.map((c) => [c.id, c]));
  const p = await profile(env);
  const hidden = new Set(st.hidden || []);
  const byNp = new Map(rows.filter((r) => !r.gone).map((r) => [clean(r.np), r]));

  // subject of the newest email to each person = "Last Topic Discussed"
  const subj = new Map();
  for (const d of (await env.FEED.prepare("SELECT contact_id, subject FROM outreach_drafts WHERE status IN ('sent','approved') ORDER BY id ASC").all()).results || []) subj.set(d.contact_id, d.subject);

  // 1. rows Alex added himself → new contacts
  for (const r of rows) {
    if (r.gone || r.hid || !r.name || writes >= MAX_WRITES) continue;
    const linked = Object.entries(st.rows).find(([, v]) => clean(v.np) === clean(r.np));
    if (linked) { r.hid = linked[0]; continue; }
    const id = slug(`${r.org} ${r.name}`);
    let c = byId.get(id) || contacts.find((x) => x.name && x.name.toLowerCase() === r.name.toLowerCase() && (!r.org || x.org?.toLowerCase() === r.org.toLowerCase()));
    if (c) { r.hid = c.id; st.rows[c.id] = { np: r.np, sent: {} }; await notion(env, "PATCH", `/pages/${r.np}`, { properties: { "Haneul ID": { rich_text: rt(c.id) } } }); writes++; continue; } // someone she already knows
    if (!c) {
      c = addLog({
        id, name: r.name.slice(0, 80), title: "", org: r.org.slice(0, 80), orgLine: "", growth: "", skills: [],
        email: r.email, emailQuality: r.email ? "unverified" : "none", fit: 3,
        stage: r.last ? "sent" : "research", followUps: 0, lastContact: r.last || null, nextFollowUp: r.follow || null,
        notes: r.notes.slice(0, 1500), relationship: r.rel, source: "notion", log: [],
      }, "Added from the Networking Tracker in Notion");
      await saveContact(env, c);
      byId.set(id, c);
      res.imported++;
    }
    r.hid = id;
    st.rows[id] = { np: r.np, sent: { ...r } };
    await notion(env, "PATCH", `/pages/${r.np}`, { properties: { "Haneul ID": { rich_text: rt(id) } } });
    writes++;
  }

  // 2. every contact past Research: pull his edits, then push hers
  const wanted = contacts.filter((c) => c.stage !== "research" || c.lastContact || st.rows[c.id]);
  wanted.sort((a, b) => String(st.rows[a.id] ? 1 : 0).localeCompare(String(st.rows[b.id] ? 1 : 0))); // new rows first
  for (const c0 of wanted) {
    const c = byId.get(c0.id) || c0;
    if (hidden.has(c.id)) continue;
    const link = st.rows[c.id];
    let row = link ? byNp.get(clean(link.np)) : rows.find((r) => r.hid === c.id && !r.gone);
    if (link && !row) { // deleted in Notion: keep it out
      hidden.add(c.id);
      delete st.rows[c.id];
      res.removed++;
      continue;
    }
    if (row && pullEdits(c, row, link?.sent)) { await saveContact(env, c); res.pulled++; }
    const want = rowFor(c, { cadence: p.cadence, topic: subj.get(c.id) || row?.topic || "", rel: c.relationship || row?.rel || "" });
    if (row && !differs(want, row)) { st.rows[c.id] = { np: row.np, sent: want }; continue; }
    if (writes >= MAX_WRITES) break;
    if (row) {
      await notion(env, "PATCH", `/pages/${row.np}`, { properties: props(want, c.id) });
      res.updated++;
    } else {
      const page = await notion(env, "POST", "/pages", { parent: { database_id: db }, properties: props(want, c.id) });
      row = { np: page.id };
      res.created++;
    }
    st.rows[c.id] = { np: row.np, sent: want };
    writes++;
  }

  st.hidden = [...hidden].slice(-300);
  st.last = { at: new Date().toISOString(), ...res };
  await env.DB.put("tracker", JSON.stringify(st));
  return { ...res, url: `https://www.notion.so/${clean(db)}` };
}

// For the app's Settings tab.
export async function trackerStatus(env) {
  const st = await getState(env);
  return { ready: notionReady(env), found: !!st.db, url: st.db ? `https://www.notion.so/${clean(st.db)}` : "", rows: Object.keys(st.rows || {}).length, last: st.last || null };
}

// ---------- Braindates (TKS peers) ----------
// Alex keeps one Notion page per person he met at a TKS Braindate (TKS → Braindates → "Name"), with the
// date on the first line ("8/11/2026", day/month) and notes like "Focus: …". They get their OWN tracker
// on a separate page ("TKS Connections" → "Braindate Tracker"), not the mentor one. Hourly, one way for the
// facts (new pages → rows, edited pages → refreshed), while Relationship / Follow-up Date stay his to fill.
// KV "braindates": { page, db, rows: { personPageId: { np, edited } } }

const BD_PROPS = {
  "Contact Name": { title: {} },
  Relationship: { select: { options: ["TKS Peer", "TKS Alum", "Mentor", "Friend"].map((name) => ({ name })) } },
  "Met On": { date: {} },
  "Follow-up Date": { date: {} },
  Focus: { rich_text: {} },
  Notes: { rich_text: {} },
  "Notes Page": { url: {} },
};

// "8/11/2026\nFocus: cancer…" → { date: "2026-11-08", focus: "cancer…", notes }
export function parseBraindate(text) {
  const lines = String(text || "").split("\n").map((l) => l.trim()).filter(Boolean);
  let date = "";
  const m = lines[0]?.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  if (m) { date = `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`; lines.shift(); }
  const fl = lines.find((l) => /^(focus|foco)\s*:/i.test(l));
  const focus = fl ? fl.replace(/^[^:]+:\s*/, "") : lines[0] || "";
  return { date, focus: focus.slice(0, 300), notes: lines.filter((l) => l !== fl).join(" · ").slice(0, 1800) };
}

export async function syncBraindates(env) {
  if (!notionReady(env)) return { skipped: true };
  const st = (await env.DB.get("braindates", "json")) || { rows: {} };
  const tks = (await env.DB.get("notion", "json"))?.tks;
  const src = st.src || (await findChildPage(env, tks, /braindate/i));
  if (!src) return { error: "no Braindates page inside TKS" };
  st.src = src;
  const home = pageIdFrom(env.NOTION_PAGE);
  if (!st.page) {
    st.page = (await notion(env, "POST", "/pages", { parent: { page_id: home }, icon: { type: "emoji", emoji: "🤝" }, properties: { title: { title: rt("TKS Connections") } },
      children: [{ object: "block", type: "paragraph", paragraph: { rich_text: rt("People you met at TKS Braindates. Haneul adds a row for every page in TKS → Braindates and refreshes it when you edit your notes; Relationship and Follow-up Date are yours to fill.") } }] })).id;
    await env.DB.put("braindates", JSON.stringify(st));
  }
  if (!st.db) {
    st.db = (await notion(env, "POST", "/databases", { parent: { type: "page_id", page_id: st.page }, icon: { type: "emoji", emoji: "🧠" }, title: rt("Braindate Tracker"), properties: BD_PROPS })).id;
    await env.DB.put("braindates", JSON.stringify(st));
  }
  const res = { created: 0, updated: 0, removed: 0 };
  const kids = ((await notion(env, "GET", `/blocks/${src}/children?page_size=100`)).results || []).filter((b) => b.type === "child_page");
  const budget = { left: 30 };
  for (const k of kids) {
    const have = st.rows[k.id];
    if (have && (have.gone || have.edited === k.last_edited_time)) continue; // a row he deleted stays deleted
    if (budget.left < 4) break;
    const info = parseBraindate(await pageText(env, k.id, budget).catch(() => ""));
    const props = {
      "Contact Name": { title: rt(k.child_page.title || "Unnamed") },
      "Met On": { date: info.date || k.created_time ? { start: info.date || k.created_time.slice(0, 10) } : null },
      Focus: { rich_text: rt(info.focus) },
      Notes: { rich_text: rt(info.notes) },
      "Notes Page": { url: `https://www.notion.so/${clean(k.id)}` },
    };
    budget.left--;
    if (have) {
      await notion(env, "PATCH", `/pages/${have.np}`, { properties: props }).catch(async (err) => { if (/archived|Could not find/i.test(err.message)) { have.gone = true; res.removed++; } else throw err; });
      if (!have.gone) res.updated++;
      have.edited = k.last_edited_time;
    } else {
      const page = await notion(env, "POST", "/pages", { parent: { database_id: st.db }, properties: { ...props, Relationship: { select: { name: "TKS Peer" } } } });
      st.rows[k.id] = { np: page.id, edited: k.last_edited_time };
      res.created++;
    }
  }
  st.last = { at: new Date().toISOString(), ...res };
  await env.DB.put("braindates", JSON.stringify(st));
  return { ...res, url: `https://www.notion.so/${clean(st.db)}` };
}
