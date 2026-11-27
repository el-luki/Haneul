import { MODELS_LIGHT, MODELS_SMART } from "./config.js";
import { addDaysISO, localHour, localMinute, localWeekday, todayISO } from "./dates.js";
import { gemini, parseJson } from "./gemini.js";
import { memoryText } from "./memory.js";
import { send } from "./telegram.js";
import { newsSearch } from "./web.js";
import { getWork, workText } from "./work.js";
import { canUse, findEmail, hunterCredits, hunterReady, verifyEmail } from "./hunter.js";

// ---------- TKS mentor outreach ----------
// Contacts move through stages Research → Drafted → Sent → Replied → Call → Mentor → Closed.
// Haneul ranks the "next moves" (same logic as Alex's Mentor Radar prototype), drafts emails,
// and sends them through his own Gmail (gmail-script/Code.gs) ONLY after he approves each one
// in the app, at the time he picked. She also watches Gmail for replies, and every Sunday looks
// for company news and new (unverified) leads.
// Storage: D1 tables outreach (one JSON per contact), outreach_drafts, outreach_updates.

export const STAGES = ["research", "drafted", "sent", "replied", "call", "mentor", "closed"];
export const STAGE_NAME = { research: "Research", drafted: "Drafted", sent: "Sent", replied: "Replied", call: "Call", mentor: "Mentor", closed: "Closed" };
export const EMAIL_QUALITY = ["verified", "unverified", "generic", "wrong", "none"];
const DEFAULT_PROFILE = { cadence: 7, goal: 10, age: "", published: "", signature: "Alex Rivera\nTKS Innovator & Velocity Program member | Peru" };

// The cold-email template a TKS friend shared (it's getting him replies). Used for every FIRST email.
export function firstEmailRules(p, work = "") {
  return `Follow this proven cold-email template closely (fill every [ ] with REAL details; never invent):
Subject: Inquiry regarding <a specific technical subtopic of THEIR work> - Alex (TKS researcher)
Body:
Hello <"Dr. <Last name>" if the bio shows a PhD/MD, "Prof. <Last name>" if they're a professor, else their first name>,
I have been following your <research / work / company's work> at <their organization> on <their specific field, from the bio/news>.
I am Alex, a ${p.age ? `${p.age}-year-old` : "high-school"} TKS researcher from Peru. ${p.published
    ? `I recently published ${p.published}`
    : work ? "<ONE sentence about the piece of HIS WORK below that fits them best: \"I recently published <article> on <site>\" for an article, \"I have been building <project>\" for a project>"
    : "I have been building <ONE of his real projects from HIS WORK below that fits them>"} exploring <his specific focus that connects to them>.
As I was working on <a specific technical challenge in that project, related to their work>, I ran into a question: <ONE ultra-specific, high-friction technical micro-question tailored to THEIR research/work, answerable in a few lines>?
If you have 15 minutes in the coming weeks, I would be deeply grateful for your perspective on <brief closing focus>.
Best,
${p.signature}
Rules: plain text, under 150 words, no flattery beyond the template, no links, never invent publications, results, numbers or schools.${work ? `
HIS WORK (the only articles/projects you may mention; pick the one closest to THEIR field):
${work}` : ""}`;
}

const daysBetween = (fromIso, toIso) => Math.round((Date.parse(`${toIso}T12:00:00Z`) - Date.parse(`${fromIso}T12:00:00Z`)) / 86400000);

// ---------- ranking (ported from mentor-radar.html: nextMove / score) ----------
export function nextMove(c, cadence = 7, today = todayISO()) {
  const d = c.lastContact ? daysBetween(c.lastContact, today) : null;
  const fu = c.followUps || 0;
  if (c.nextFollowUp && c.stage !== "closed" && daysBetween(c.nextFollowUp, today) >= 0) return { due: true, t: "Planned check-in is due", w: 60, kind: "followup" };
  switch (c.stage) {
    case "research":
      if (c.emailQuality === "wrong" || c.emailQuality === "none") return { t: "Find the right person or address", w: 20 };
      if (c.emailQuality === "unverified") return { t: "Confirm the person and address, then draft", w: 30, kind: "first" };
      if (c.emailQuality === "generic") return { t: "Look for a named engineer before using the inbox", w: 22, kind: "first" };
      return { t: "Draft the first email", w: 35, kind: "first" };
    case "drafted":
      return { t: "Review the draft and send it", w: 45 };
    case "sent":
      if (d === null) return { t: "Log the date you sent it", w: 30 };
      if (d >= cadence * 3 && fu >= 2) return { due: true, t: "No reply after 2 follow-ups. Close or try another channel", w: 25 };
      if (d >= cadence) return { due: true, t: `Follow up (${fu ? `#${fu + 1}` : "first nudge"})`, w: 70, kind: "followup" };
      return { t: `Wait. Follow up in ${cadence - d}d`, w: 5, wait: true };
    case "replied":
      return { due: true, t: "Reply within a day and propose a call time", w: 90, kind: "reply" };
    case "call":
      if (d !== null && d >= 2 && !c.thanked) return { due: true, t: "Send a thank-you with one concrete takeaway", w: 80, kind: "thanks" };
      return { t: "Ask whether they'd be open to ongoing check-ins", w: 50, kind: "reply" };
    case "mentor":
      if (d === null || d >= 30) return { due: true, t: "Monthly update: share progress and one question", w: 65, kind: "monthly" };
      return { t: `Next update in ${30 - d}d`, w: 3, wait: true };
    default:
      return { t: "Closed", w: 0, wait: true };
  }
}
export const score = (c, cadence) => { const m = nextMove(c, cadence); return (c.fit || 3) * 12 + m.w + (m.due ? 20 : 0); };

// ---------- storage ----------
export const slug = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || `c-${Date.now()}`;

export async function listContacts(env) {
  if (!env.FEED) return [];
  const rows = (await env.FEED.prepare("SELECT id, data FROM outreach").all()).results || [];
  return rows.map((r) => ({ ...JSON.parse(r.data), id: r.id }));
}
export async function getContact(env, id) {
  const r = await env.FEED.prepare("SELECT id, data FROM outreach WHERE id = ?").bind(id).first();
  return r ? { ...JSON.parse(r.data), id: r.id } : null;
}
export async function saveContact(env, c) {
  const { id, ...data } = c;
  await env.FEED.prepare("INSERT OR REPLACE INTO outreach (id, data, updated) VALUES (?, ?, ?)").bind(id, JSON.stringify(data), Date.now()).run();
  return c;
}
export function addLog(c, text) {
  c.log = [...(c.log || []), { d: todayISO(), t: String(text).slice(0, 300) }].slice(-40);
  return c;
}
export async function profile(env) {
  return { ...DEFAULT_PROFILE, ...((await env.DB.get("outreach_profile", "json")) || {}) };
}

// Fields Alex can edit in the app.
const EDITABLE = ["name", "title", "org", "orgLine", "growth", "skills", "email", "emailQuality", "fit", "stage", "notes", "flag", "nextFollowUp", "lastContact", "followUps", "thanked", "linkedin", "meeting"];
export async function updateContact(env, id, fields) {
  let c = id ? await getContact(env, id) : null;
  const isNew = !c;
  if (isNew) c = { id: slug(`${fields.org || ""} ${fields.name || ""}`), stage: "research", fit: 3, emailQuality: "none", followUps: 0, lastContact: null, skills: [], log: [] };
  const changes = [];
  for (const k of EDITABLE) {
    if (!(k in fields)) continue;
    let v = fields[k];
    if (k === "fit") v = Math.max(1, Math.min(5, Number(v) || 3));
    if (k === "followUps") v = Math.max(0, Number(v) || 0);
    if (k === "stage" && !STAGES.includes(v)) continue;
    if (k === "emailQuality" && !EMAIL_QUALITY.includes(v)) continue;
    if (k === "skills" && !Array.isArray(v)) v = String(v || "").split(",").map((s) => s.trim()).filter(Boolean);
    if (k === "email") v = String(v || "").trim();
    if (JSON.stringify(c[k]) === JSON.stringify(v)) continue;
    if (k === "stage") changes.push(`Stage → ${STAGE_NAME[v]}`);
    else if (k === "email") changes.push(`Email → ${v || "(none)"}`);
    c[k] = v;
  }
  if (isNew) addLog(c, "Added");
  for (const ch of changes) addLog(c, ch);
  await saveContact(env, c);
  return c;
}

// ---------- Gmail (Apps Script in Alex's personal Google account) ----------
export function gmailReady(env) {
  return !!(env.GMAIL_SCRIPT_URL && env.GMAIL_SCRIPT_SECRET);
}
async function gmail(env, payload) {
  if (!gmailReady(env)) throw new Error("Gmail isn't connected yet (gmail-script)");
  // Google sometimes answers with a timeout (524, 5xx). Reading is retried; sending never is
  // (a send that timed out may still have gone out, and a retry would send it twice).
  const tries = payload.action === "send" ? 1 : 3;
  let last = "";
  for (let i = 0; i < tries; i++) {
    if (i) await new Promise((r) => setTimeout(r, 4000 * i));
    const res = await fetch(env.GMAIL_SCRIPT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload, secret: env.GMAIL_SCRIPT_SECRET }),
      redirect: "follow",
    }).catch((err) => ({ status: err.message, json: async () => ({}) }));
    const data = await res.json().catch(() => ({}));
    if (data.ok) return data;
    last = data.error || `the Gmail script answered ${res.status}`;
    if (data.error) break; // a real answer from the script (e.g. unauthorized): no point retrying
  }
  throw new Error(last);
}

// The hourly check runs in the background: a one-off Google hiccup at 1 am isn't worth a message.
// Alex only hears about it if it fails 3 checks in a row.
export async function syncGmailQuietly(env) {
  try {
    const r = await syncGmail(env);
    await env.DB.delete("gmail_fails");
    return r;
  } catch (err) {
    const n = (Number(await env.DB.get("gmail_fails")) || 0) + 1;
    await env.DB.put("gmail_fails", String(n), { expirationTtl: 86400 * 3 });
    console.error("gmail sync:", n, err.message);
    if (n === 3) await send(env, `⚠️ I couldn't check your Gmail for outreach replies 3 times in a row (${err.message}). I'll keep trying; if it lasts, the Gmail script may need a new deployment.`);
    return { error: err.message };
  }
}

// ---------- drafts ----------
const KIND_TASK = {
  first: "a FIRST cold email asking for mentorship/advice",
  followup: "a short, polite FOLLOW-UP to an email they haven't answered yet (2-4 sentences, same thread)",
  reply: "a REPLY to their answer: thank them and propose 2-3 concrete times for a 15-20 minute call (his timezone is Lima, UTC-5)",
  thanks: "a THANK-YOU after the call, with one concrete takeaway he's applying",
  monthly: "a short MONTHLY UPDATE for a mentor: what he did since last time and ONE focused question",
};

export async function draftEmail(env, id, kind) {
  const c = await getContact(env, id);
  if (!c) throw new Error("no such contact");
  kind = KIND_TASK[kind] ? kind : nextMove(c).kind || "first";
  const p = await profile(env);
  const first = c.name && !/team|leadership|operations|recruiting|hiring/i.test(c.name) ? c.name.replace(/^(dr|mr|ms|mrs).?s+/i, "").split(" ")[0] : `${c.org} team`;
  const alex = await memoryText(env, `${c.org} ${(c.skills || []).join(" ")} GNC rocket TKS project`).catch(() => "");
  const prompt = `Write ${KIND_TASK[kind]} from Alex to ${c.name || "the team"}${c.title ? ` (${c.title})` : ""} at ${c.org}.

About them: ${c.orgLine || ""} ${c.growth ? `(${c.growth})` : ""}
Their relevant work/skills: ${(c.skills || []).join("; ") || "unknown"}
Notes: ${c.notes || "-"} ${c.flag ? `Warning: ${c.flag}` : ""}
Previous contact: ${(c.log || []).slice(-6).map((l) => `${l.d} ${l.t}`).join(" | ")}

About Alex (facts you may use; never invent achievements, schools, numbers or projects that aren't here):
He's an 11th-grade student in Lima in TKS (The Knowledge Society), interested in guidance, navigation & control (GNC) for rockets and landers.
${alex.slice(0, 2500)}

${kind === "first" ? firstEmailRules(p, await workText(env).catch(() => "")) + "\n" : ""}Rules: ${kind === "first" ? "use the template above." : `start with "Hi ${first}," on its own line.`} Plain text email, under 150 words (follow-ups under 70). Specific to THEIR work (mention one real detail from above), one clear,
easy-to-answer question, a small ask (15-minute call or a short written answer), no flattery, no "I hope this email finds you well",
no attachments or links. End with exactly this signature:
${p.signature}

Return JSON: {"subject": "...", "body": "..."}`;
  const r = parseJson(await gemini(env, [{ role: "user", parts: [{ text: prompt }] }], { json: true, models: MODELS_LIGHT }));
  if (!r.subject || !r.body) throw new Error("the draft came back empty, try again");
  const subject = kind === "followup" && c.lastSubject ? `Re: ${c.lastSubject.replace(/^re:\s*/i, "")}` : String(r.subject).slice(0, 200);
  const ins = await env.FEED.prepare("INSERT INTO outreach_drafts (contact_id, kind, to_addr, subject, body, status, created) VALUES (?, ?, ?, ?, ?, 'draft', ?)")
    .bind(c.id, kind, c.email || "", subject, String(r.body).slice(0, 6000), Date.now()).run();
  if (c.stage === "research") {
    c.stage = "drafted";
    addLog(c, "Drafted the first email");
    await saveContact(env, c);
  }
  return { id: ins.meta?.last_row_id, contact_id: c.id, kind, to_addr: c.email || "", subject, body: r.body, status: "draft" };
}

export async function listDrafts(env) {
  if (!env.FEED) return [];
  return (await env.FEED.prepare("SELECT * FROM outreach_drafts WHERE status IN ('draft','approved','failed') OR sent_at > ? ORDER BY id DESC LIMIT 60").bind(Date.now() - 14 * 86400000).all()).results || [];
}

const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[a-z]{2,}$/i;

// Alex approved a draft in the app: it's sent by the cron at sendAt (ms). The ONLY way an email goes out.
export async function approveDraft(env, draftId, { to, subject, body, sendAt }) {
  const d = await env.FEED.prepare("SELECT * FROM outreach_drafts WHERE id = ?").bind(draftId).first();
  if (!d) return { error: "no such draft" };
  if (!["draft", "failed", "approved"].includes(d.status)) return { error: `this email is already ${d.status}` };
  if (d.kind === "meeting" || d.kind === "linkedin") return { error: "this one isn't an email: send it yourself, then tap \"I sent it\"" };
  to = String(to || "").trim();
  if (!EMAIL_RE.test(to)) return { error: "that email address doesn't look right" };
  if (!String(subject || "").trim() || !String(body || "").trim()) return { error: "subject and text can't be empty" };
  const when = Math.max(Date.now(), Number(sendAt) || Date.now());
  await env.FEED.prepare("UPDATE outreach_drafts SET to_addr = ?, subject = ?, body = ?, status = 'approved', send_at = ?, error = NULL WHERE id = ?")
    .bind(to, String(subject).slice(0, 200), String(body).slice(0, 6000), when, draftId).run();
  const c = await getContact(env, d.contact_id);
  if (c) {
    addLog(c, `Approved "${String(subject).slice(0, 60)}" for ${new Date(when - 5 * 3600000).toISOString().slice(0, 16).replace("T", " ")}`);
    await saveContact(env, c);
  }
  return { ok: true, sendAt: when };
}

export async function cancelDraft(env, draftId, { discard = false } = {}) {
  await env.FEED.prepare(`UPDATE outreach_drafts SET status = ? WHERE id = ? AND status IN ('draft','approved','failed')`).bind(discard ? "cancelled" : "draft", draftId).run();
  return { ok: true };
}

export async function saveDraftText(env, draftId, { to, subject, body }) {
  await env.FEED.prepare("UPDATE outreach_drafts SET to_addr = ?, subject = ?, body = ? WHERE id = ? AND status IN ('draft','failed')").bind(String(to || ""), String(subject || ""), String(body || ""), draftId).run();
  return { ok: true };
}

// Cron: send approved emails whose time has come.
async function sendDue(env) {
  const due = (await env.FEED.prepare("SELECT * FROM outreach_drafts WHERE status = 'approved' AND send_at <= ? ORDER BY send_at LIMIT 3").bind(Date.now()).all()).results || [];
  for (const d of due) {
    // claim it first, so two cron runs can't both send it
    const claim = await env.FEED.prepare("UPDATE outreach_drafts SET status = 'sending' WHERE id = ? AND status = 'approved'").bind(d.id).run();
    if (!claim.meta?.changes) continue;
    const c = await getContact(env, d.contact_id);
    try {
      const r = await gmail(env, { action: "send", to: d.to_addr, subject: d.subject, body: d.body, threadId: d.kind === "first" ? "" : c?.threadId || "" });
      await env.FEED.prepare("UPDATE outreach_drafts SET status = 'sent', sent_at = ?, thread_id = ? WHERE id = ?").bind(Date.now(), r.threadId || "", d.id).run();
      if (c) {
        c.lastContact = todayISO();
        c.lastSubject = d.subject;
        if (r.threadId) c.threadId = r.threadId;
        if (["research", "drafted"].includes(c.stage)) c.stage = "sent";
        if (d.kind === "followup") c.followUps = (c.followUps || 0) + 1;
        if (d.kind === "thanks") c.thanked = true;
        if (c.nextFollowUp && c.nextFollowUp <= todayISO()) c.nextFollowUp = null;
        addLog(c, `Sent: "${d.subject.slice(0, 80)}"`);
        await saveContact(env, c);
      }
      await send(env, `📨 Sent to ${c?.name || d.to_addr}${c?.org ? ` (${c.org})` : ""}: "${d.subject}"`);
    } catch (err) {
      await env.FEED.prepare("UPDATE outreach_drafts SET status = 'failed', error = ? WHERE id = ?").bind(String(err.message).slice(0, 300), d.id).run();
      await send(env, `⚠️ Couldn't send the email to ${c?.name || d.to_addr} (${err.message}). It's back in Outreach → Drafts.`);
    }
  }
}

// ---------- Hunter.io on a contact ----------
export async function hunterFind(env, id) {
  const c = await getContact(env, id);
  if (!c) return { error: "no such contact" };
  if (c.hunterClaimed) return { error: "this person asked Hunter not to process their data" };
  if (!(await canUse(env, "searches"))) return { error: "no Hunter credits left this month" };
  const r = await findEmail(env, { name: c.name, org: c.org, domain: c.domain, linkedin: c.linkedin });
  c.hunterTried = todayISO();
  if (r?.claimed) {
    // they asked (directly or not) to stop the processing of their data: never store or use it
    c.hunterClaimed = true;
    addLog(c, "Hunter: this person opted out of data processing (no email stored)");
    await saveContact(env, c);
    return { found: false, claimed: true };
  }
  if (!r) { addLog(c, "Hunter: no email found (no credit used)"); await saveContact(env, c); return { found: false }; }
  c.email = r.email;
  c.emailQuality = r.status === "valid" ? "verified" : "unverified";
  c.hunterChecked = todayISO(); // the finder already verified it
  addLog(c, `Hunter found ${r.email} (confidence ${r.score}%${r.status ? `, ${r.status}` : ""}${r.provenance ? `, ${r.provenance === "found" ? "seen on the web" : "guessed from the company pattern"}` : ""})`);
  await saveContact(env, c);
  return { found: true, email: r.email, score: r.score, quality: c.emailQuality };
}
export async function hunterVerify(env, id) {
  const c = await getContact(env, id);
  if (!c?.email) return { error: "no email to check" };
  if (!(await canUse(env, "verifications"))) return { error: "no Hunter credits left this month" };
  const r = await verifyEmail(env, c.email);
  if (r.pending) return { status: "Hunter is still checking; try again in a minute (no extra cost)" };
  if (r.skipped) { c.hunterChecked = todayISO(); await saveContact(env, c); return { status: "personal address (Gmail etc.): Hunter can't check those, so no credit used" }; }
  if (r.quality) c.emailQuality = r.quality;
  c.hunterChecked = todayISO();
  if (r.claimed) { c.hunterClaimed = true; c.email = ""; c.emailQuality = "none"; }
  addLog(c, `Hunter checked the email: ${r.status}`);
  await saveContact(env, c);
  return r;
}

// ---------- daily outreach: Haneul researches + drafts, Alex sends (goal: 10 a day) ----------
// Channel per contact: email (sent from his Gmail after he approves) > booking link (he books a slot and
// pastes her note) > LinkedIn (he sends her message himself). Only emails are ever sent by Haneul.
export function channelOf(c) {
  if (c.email && EMAIL_RE.test(c.email) && c.emailQuality !== "wrong") return "email";
  if (c.meeting && /^https?:\/\//.test(c.meeting)) return "meeting";
  if (c.linkedin && /linkedin\.com/.test(c.linkedin)) return "linkedin";
  return "none";
}
const KIND_OF_CHANNEL = { email: "first", meeting: "meeting", linkedin: "linkedin" };
export const dayStart = (iso = todayISO()) => Date.parse(`${iso}T00:00:00-05:00`); // Lima midnight

// How many reach-outs Alex did today (emails sent + booking notes / LinkedIn messages he marked as sent)
// and how many drafts are waiting for him.
export async function dailyProgress(env) {
  if (!env.FEED) return { done: 0, ready: 0, goal: 10 };
  const p = await profile(env);
  const done = (await env.FEED.prepare("SELECT COUNT(*) AS n FROM outreach_drafts WHERE status = 'sent' AND sent_at >= ? AND kind IN ('first','meeting','linkedin')").bind(dayStart()).first())?.n || 0;
  const ready = (await env.FEED.prepare("SELECT COUNT(*) AS n FROM outreach_drafts WHERE status IN ('draft','failed') AND kind IN ('first','meeting','linkedin')").bind().first())?.n || 0;
  const madeToday = (await env.FEED.prepare("SELECT COUNT(*) AS n FROM outreach_drafts WHERE created >= ? AND kind IN ('first','meeting','linkedin') AND status != 'cancelled'").bind(dayStart()).first())?.n || 0;
  return { done, ready, madeToday, goal: p.goal || 10 };
}

// Pick the next mentors to reach (best fit first), research them (bio + recent news) and draft a
// first message for each, so Alex has `goal` ready. Runs weekdays at 16:00 (and from the tab).
export async function prepOutreach(env, opts = {}) {
  // one prep at a time (the 4pm job and a tap on "Prepare more" could overlap and draft the same person twice)
  if (await env.DB.get("outreach_prep_lock")) return { busy: true };
  await env.DB.put("outreach_prep_lock", "1", { expirationTtl: 300 });
  try { return await prepRun(env, opts); } finally { await env.DB.delete("outreach_prep_lock"); }
}
async function prepRun(env, { max } = {}) {
  const p = await profile(env);
  const { done, ready, madeToday } = await dailyProgress(env);
  const goal = p.goal || 10;
  if (ready >= goal * 2 && !max) return { prepared: 0, ready, done, backlog: true }; // he has plenty waiting: don't pile up more
  const need = Math.min(max || 99, Math.max(0, goal - done - madeToday), goal * 2 - ready);
  if (need <= 0) return { prepared: 0, ready, done };
  const busy = new Set(((await env.FEED.prepare("SELECT contact_id FROM outreach_drafts WHERE status IN ('draft','approved','sending','failed')").all()).results || []).map((r) => r.contact_id));
  const today = todayISO();
  const picks = (await listContacts(env))
    .filter((c) => c.stage === "research" && (c.fit || 3) >= 3 && !busy.has(c.id) && channelOf(c) !== "none" && !(c.snooze && c.snooze > today)) // only real fits for his focus
    .sort((a, b) => (b.fit || 3) - (a.fit || 3) || (a.order ?? 999) - (b.order ?? 999))
    .slice(0, need);
  if (!picks.length) return { prepared: 0, ready, done, empty: true };
  // Hunter (small free allowance): find emails for up to 3 picks that only have a booking link / LinkedIn
  // (best fit first), and check up to 3 emails that were never checked. Never blocks the drafts.
  if (hunterReady(env)) {
    let finds = 0, checks = 0;
    for (const c of picks) {
      try {
        if (channelOf(c) !== "email" && !c.hunterTried && !c.hunterClaimed && finds < 2 && (await canUse(env, "searches"))) {
          finds++;
          const r = await hunterFind(env, c.id);
          if (r.found) Object.assign(c, await getContact(env, c.id));
        } else if (channelOf(c) === "email" && !c.hunterChecked && checks < 3 && (await canUse(env, "verifications"))) {
          checks++;
          await hunterVerify(env, c.id);
          Object.assign(c, await getContact(env, c.id));
        }
      } catch (err) { console.error("hunter:", err.message); }
    }
  }
  // Hunter may have marked an email invalid: whoever has no way left to reach them waits (no draft)
  for (let i = picks.length - 1; i >= 0; i--) if (channelOf(picks[i]) === "none") picks.splice(i, 1);
  if (!picks.length) return { prepared: 0, ready, done };
  // research: Gemini + Google Search checks each person is real and at that org, and finds facts about THEIR work.
  // Someone it can't confirm gets no draft (and waits 30 days); if grounding is unavailable, news headlines as before.
  const log = [];
  let refused = "";
  for (const c of picks.slice(0, 6)) {
    const reuse = webFresh(c) && !c.web.error;
    const g = reuse ? c.web : refused ? { error: refused } : await groundedResearch(env, c).catch((err) => ({ error: err.message }));
    if (g.error && /HTTP 4\d\d/.test(g.error)) refused = g.error; // quota or not allowed: don't spend the run retrying
    if (!reuse && !g.error) await saveWeb(env, c.id, g);
    if (g.error) {
      await new Promise((r) => setTimeout(r, 1200)); // pace the searches (bursts get refused)
      const news = await newsSearch(`"${c.name}" ${c.org}`).catch(() => []);
      c.news = news.slice(0, 3).map((n) => `${n.title} (${n.source}, ${n.date})`);
      log.push({ name: c.name, grounded: false, error: g.error.slice(0, 120) });
      continue;
    }
    c.grounded = g;
    log.push({ name: c.name, grounded: true, reused: reuse, verified: g.verified, facts: g.facts.length, sources: g.sources });
  }
  await env.DB.put("outreach_research_last", JSON.stringify({ at: Date.now(), log }), { expirationTtl: 86400 * 14 });
  for (let i = picks.length - 1; i >= 0; i--) if (picks[i].grounded?.verified === false) picks.splice(i, 1);
  if (!picks.length) return { prepared: 0, ready, done };
  const alex = await memoryText(env, "TKS rocket GNC propulsion landing convex project mentor").catch(() => "");
  const prompt = `Alex wants to reach out to these mentors from TKS's (The Knowledge Society) mentor network. For EACH, write his FIRST message.

About Alex (facts you may use; never invent achievements, schools, numbers or projects that aren't here):
He's an 11th-grade student in Lima, Peru, in TKS. His focus is SPACE TECH: guidance, navigation & control (GNC) and propulsion.
His Learn article (Medium): "Why Landing a Rocket Is a Math Problem".
His Build: LanderSim, a 3-DoF fuel-optimal rocket-landing simulator in Python (CVXPY). Other projects are NOT his focus: don't mention them to aerospace people. Learning AP Physics and CS50P.
${alex.slice(0, 2000)}

Channel rules:
- "email": ${firstEmailRules(p, await workText(env).catch(() => ""))}
- "meeting": they have a TKS booking link. Write the short note he pastes in the booking form ("what would you like to discuss"):
  2-4 sentences, under 70 words, no greeting/signature. Subject = "Booking note".
- "linkedin": a LinkedIn connection note, UNDER 280 characters, starts with "Hi <first name>,". Subject = "LinkedIn note".
Facts about THEM: use ONLY "verified research" (from Google Search) and the bio. Never attribute Alex's numbers (5x/s, 7-12 ms, 0.6%) or methods
to them, never claim they use a method unless the research says so (ask instead), never invent a role, project or field for them.
A team contact (no person's name) is greeted "Hello <org> team,". Only say he's "working on" something listed above (LanderSim, his article).
His article's exact title is "Why Landing a Rocket Is a Math Problem"; never invent other titles. Don't mention Haneul.
For booking and LinkedIn notes: he found them through TKS's mentor network, ONE real detail of THEIR work (from the research/bio), the same
kind of ultra-specific technical micro-question tied to his GNC / propulsion work, a small ask (15 minutes). No flattery, no links.

Return JSON: [{"id": "...", "subject": "...", "body": "..."}]

${picks.map((c) => `--- id: ${c.id} | channel: ${channelOf(c)} | ${c.name}, ${c.title || ""} at ${c.org}
bio: ${String(c.bio || c.orgLine || "").slice(0, 700)}
why he picked them: ${(!OFF_FOCUS.test(c.notes || "") && c.notes) || "-"}
question idea: ${c.ask || "-"}
${c.grounded ? `verified research: role: ${c.grounded.role || "-"}; ${c.grounded.facts.join(" | ") || "no specific facts"}; GNC link: ${c.grounded.gnc || "-"}` : `recent news: ${(c.news || []).join(" | ") || "none found"}`}`).join("\n")}`;
  const r = parseJson(await gemini(env, [{ role: "user", parts: [{ text: prompt }] }], { json: true, models: MODELS_SMART }));
  const list = Array.isArray(r) ? r : r.drafts || r.messages || [];
  let prepared = 0;
  for (const c of picks) {
    const m = list.find((x) => x?.id === c.id);
    if (!m?.body) continue;
    m.body = cleanDraft(m.subject, m.body);
    if (!m.body) { // pitched an off-focus project anyway: park them a month instead of researching them again every run
      const fresh = await getContact(env, c.id);
      fresh.snooze = addDaysISO(todayISO(), 30);
      fresh.flag = "Haneul could only find a BCI/neuro angle for them, not rockets/GNC: check the fit.";
      await saveContact(env, fresh);
      continue;
    }
    const ch = channelOf(c);
    const kind = KIND_OF_CHANNEL[ch];
    if (!kind) continue;
    const to = ch === "email" ? c.email : ch === "meeting" ? c.meeting : c.linkedin;
    const body = ch === "linkedin" ? String(m.body).slice(0, 300) : String(m.body).slice(0, 6000);
    await env.FEED.prepare("INSERT INTO outreach_drafts (contact_id, kind, to_addr, subject, body, status, created) VALUES (?, ?, ?, ?, ?, 'draft', ?)")
      .bind(c.id, kind, to, String(m.subject || "").slice(0, 200), body, Date.now()).run();
    const fresh = await getContact(env, c.id);
    fresh.stage = "drafted";
    if (c.grounded) fresh.research = c.grounded.facts;
    else if (c.news?.length) fresh.research = c.news;
    addLog(fresh, `Haneul researched them and drafted ${ch === "email" ? "an email" : ch === "meeting" ? "a booking note" : "a LinkedIn note"}`);
    await saveContact(env, fresh);
    prepared++;
  }
  return { prepared, ready: ready + prepared, done };
}

// His BCI/EEG and app projects aren't his pitch to aerospace mentors (the prompt says so; this catches slips).
const OFF_FOCUS = /\b(EEG|BCI|brain[- ]computer|neuro\w*|Haneul)\b/i;
// null = drop the draft; otherwise the body with his article's real title
export function cleanDraft(subject, body) {
  if (OFF_FOCUS.test(`${subject} ${body}`)) return null;
  return String(body).replace(/["“][^"”]*Convex Math[^"”]*["”]/g, '"Why Landing a Rocket Is a Math Problem"');
}

// Web search for the research: Tavily (secret TAVILY_API_KEY, free 1,000 searches/month; ~6 a day here).
// Without the key, Gemini's own Google Search tool, which the free tier refuses on Gemini 3 (one 429, then news).
async function tavily(env, query, max = 6) {
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.TAVILY_API_KEY}` },
    body: JSON.stringify({ query, search_depth: "basic", max_results: max }),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`Tavily HTTP ${res.status}`); // 4xx (bad key, credits used up) stops the run's searches
  return ((await res.json()).results || []).map((r) => ({ url: String(r.url || ""), title: String(r.title || ""), text: String(r.content || "").slice(0, 700) }));
}

// One person (or a team: then their org's GNC work): is it real, and what do they actually work on?
async function groundedResearch(env, c, models = MODELS_SMART) {
  const team = !/\s/.test(String(c.name).trim()) || /\b(team|operations|engineering|recruiting)\b/i.test(c.name);
  const ask = `A high-school student (rocket guidance, navigation & control) wants to write to ${team ? `the team at ${c.org}` : `${c.name}, ${c.title || "?"} at ${c.org}`}.
What we have: ${String(c.bio || c.orgLine || "").slice(0, 400)}
Return ONLY JSON:
{"verified": true/false (${team ? "true if the company exists and is active" : "true only if the results show this person really exists AND works or worked at this org in a role like this"}),
 "why": "if not verified: one short reason",
 "role": "${team ? "what the company does" : "their current role, per the results"}",
 "facts": ["2-3 specific, checkable things about ${team ? "the company's" : "THEIR own"} work (projects, papers, talks, launches, missions), with month/year"],
 "gnc": "one line: how this touches guidance/navigation/control or propulsion, or \"\" if it doesn't"}
Only what the results support; never guess.`;
  let r, sources;
  if (env.TAVILY_API_KEY) {
    const web = await tavily(env, team ? `${c.org} guidance navigation control` : `"${c.name}" ${c.org}`);
    if (!web.length) return { error: "no web results" };
    r = parseJson(await gemini(env, [{ role: "user", parts: [{ text: `${ask}
Each fact ends with the [number] of the result it comes from.

Web results:
${web.map((w, i) => `[${i + 1}] ${w.title} (${w.url})\n${w.text}`).join("\n\n")}` }] }], { json: true, models }));
    r.facts = (Array.isArray(r.facts) ? r.facts : []).filter((f) => /\[\d+\]/.test(String(f))).map((f) => String(f).replace(/\s*\[\d+\]/g, "")); // a fact without its source is dropped
    sources = web.length;
  } else {
    const found = [];
    const text = await gemini(env, [{ role: "user", parts: [{ text: `Use Google Search. ${ask}` }] }], { models: ["gemini-flash-latest"], tools: [{ google_search: {} }], sources: found });
    if (!found.length) return { error: "answered without searching" }; // no sources = not verified, use the news instead
    r = parseJson(text);
    sources = found.length;
  }
  return {
    verified: r.verified !== false, why: String(r.why || "").slice(0, 160), role: String(r.role || "").slice(0, 160),
    facts: (Array.isArray(r.facts) ? r.facts : []).slice(0, 3).map((f) => String(f).slice(0, 240)), gnc: String(r.gnc || "").slice(0, 200), sources,
  };
}

// ---------- Tavily: every contact researched (kept 30 days), and new people found on the web ----------
const webFresh = (c) => !!c.web?.at && c.web.at > addDaysISO(todayISO(), -30);

// Stores what the research found. Someone it can't confirm is flagged (and, if not contacted yet, parked 30 days).
async function saveWeb(env, id, g) {
  const c = await getContact(env, id);
  if (!c) return;
  c.web = { at: todayISO(), verified: g.verified, why: g.why || "", role: g.role || "", facts: g.facts || [], gnc: g.gnc || "", sources: g.sources || 0 };
  if (g.facts?.length) c.research = g.facts;
  if (g.verified === false) {
    c.flag = `Haneul couldn't confirm this person on the web (${g.why || "no match"}). Check them before writing.`.slice(0, 300);
    if (c.stage === "research") c.snooze = addDaysISO(todayISO(), 30);
    addLog(c, "Haneul's web search couldn't confirm them");
  } else addLog(c, `Haneul checked them on the web (${(g.facts || []).length} facts)`);
  await saveContact(env, c);
}

// 8 contacts per run (best fit first), then it queues itself until everyone has research from the last 30 days.
// Stops on a Tavily refusal (credits) or a Gemini quota error, and picks up where it left off next time.
export async function researchAll(env) {
  if (!env.TAVILY_API_KEY) return { error: "no TAVILY_API_KEY" };
  const left = (await listContacts(env)).filter((c) => c.stage !== "closed" && !webFresh(c)).sort((a, b) => (b.fit || 3) - (a.fit || 3));
  let done = 0, stop = "";
  for (const c of left.slice(0, 8)) {
    const g = await groundedResearch(env, c, MODELS_LIGHT).catch((err) => ({ error: err.message }));
    if (g.error && /HTTP \d{3}|overloaded/.test(g.error)) { stop = g.error.slice(0, 160); break; }
    await saveWeb(env, c.id, g.error ? { verified: undefined, why: g.error } : g); // no results / unreadable: marked, not retried for 30 days
    done++;
    await new Promise((r) => setTimeout(r, 4000)); // the free Gemini tier allows ~15 calls a minute
  }
  const more = left.length - done;
  await env.DB.put("outreach_research_all", JSON.stringify({ at: Date.now(), done, more, stop }), { expirationTtl: 86400 * 30 });
  if (more > 0 && done && !stop) await env.BG_JOBS.send({ kind: "outreach_research_all" });
  return { done, more, stop };
}

// Find `want` new mentors named in web results (space GNC / propulsion), add them, then research them.
export async function discoverWeb(env, want = 10) {
  if (!env.TAVILY_API_KEY) return { error: "no TAVILY_API_KEY" };
  const known = new Set((await listContacts(env)).map((c) => String(c.name).toLowerCase()));
  const people = [], queries = [];
  for (const q of DISCOVER_TOPICS.flat().slice(0, 8)) { // 8 searches at most per run
    if (people.length >= want) break;
    const web = await tavily(env, q, 8).catch((err) => ({ error: err.message }));
    if (web.error) { queries.push(`${q} (${web.error})`); break; }
    queries.push(`${q} (${web.length})`);
    if (!web.length) continue;
    let list;
    try {
      const r = parseJson(await gemini(env, [{ role: "user", parts: [{ text: `Alex (11th grader in TKS; his focus is space tech: rocket guidance, navigation & control and propulsion; he built a fuel-optimal rocket-landing simulator) is looking for AEROSPACE mentors.
From ONLY these web results, pick REAL PEOPLE who are NAMED in a result and would be a great mentor for him: engineers, researchers, professors,
early-stage founders in GNC / propulsion / space who might answer a student. SKIP household names, billionaires and CEOs of big companies,
politicians, celebrities, TKS staff, and anyone not named in the text. Never invent a name, role or company.
Already tracked (skip): ${[...known].slice(0, 120).join(", ")}.
Return JSON: [{"name": "Full Name", "org": "their company/lab", "title": "their role if stated", "why": "one line: why they fit Alex",
"ask": "one specific question he could ask them", "skills": ["2-3 tags"], "fit": 1-5, "source": <number of the result>}]  ([] if none)

${web.map((w, i) => `[${i + 1}] ${w.title} (${w.url})\n${w.text}`).join("\n\n")}` }] }], { json: true, models: MODELS_SMART }));
      list = Array.isArray(r) ? r : r.people || [];
    } catch (err) { queries.push(`gemini: ${err.message.slice(0, 80)}`); break; }
    for (const x of list) {
      const w = web[(Number(x?.source) || 0) - 1];
      if (!w || !x.name || !x.org || String(x.name).trim().split(/\s+/).length < 2 || known.has(String(x.name).toLowerCase()) || (Number(x.fit) || 3) < 3) continue;
      known.add(String(x.name).toLowerCase());
      people.push({ ...x, url: w.url, snippet: w.text });
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  let added = 0;
  for (const x of people.slice(0, want)) {
    const id = slug(`${x.org} ${x.name}`);
    if (await getContact(env, id)) continue;
    await saveContact(env, addLog({
      id, name: String(x.name).slice(0, 80), title: String(x.title || "").slice(0, 80), org: String(x.org).slice(0, 80), orgLine: "", growth: "",
      skills: (x.skills || []).slice(0, 4).map((s) => String(s).slice(0, 40)), email: "", emailQuality: "none",
      fit: Math.max(1, Math.min(5, Number(x.fit) || 3)), stage: "research", followUps: 0, lastContact: null,
      notes: String(x.why || "").slice(0, 300), ask: String(x.ask || "").slice(0, 300), bio: `On the web: ${String(x.snippet || "").slice(0, 400)} (${x.url})`,
      flag: "Found by Haneul on the web: check it's the right person before writing.", source: "web",
      linkedin: /linkedin\.com\/in\//.test(x.url) ? x.url : "", meeting: "", log: [],
    }, "Found by Haneul on the web"));
    await env.FEED.prepare("INSERT OR IGNORE INTO outreach_updates (at, kind, org, title, url, source) VALUES (?, 'lead', ?, ?, ?, 'Haneul')")
      .bind(Date.now(), String(x.org).slice(0, 80), `New mentor: ${x.name} (${x.org}): ${String(x.why || "").slice(0, 160)}`, `lead:${id}`).run();
    added++;
    if (hunterReady(env)) await hunterFind(env, id).catch((err) => console.error("hunter discover:", err.message));
  }
  await env.DB.put("outreach_discover_last", JSON.stringify({ at: Date.now(), queries, added, names: people.slice(0, want).map((p) => p.name) }), { expirationTtl: 86400 * 14 });
  if (added) await env.BG_JOBS.send({ kind: "outreach_research_all" }); // verify the new people
  return { added, names: people.slice(0, want).map((p) => p.name) };
}

// Alex sent a booking note / LinkedIn message himself: counts toward today's goal.
export async function markSent(env, draftId, { body } = {}) {
  const d = await env.FEED.prepare("SELECT * FROM outreach_drafts WHERE id = ?").bind(draftId).first();
  if (!d) return { error: "no such draft" };
  if (d.kind === "first" || !["draft", "failed"].includes(d.status)) return { error: "emails are sent from the app after you approve them" };
  await env.FEED.prepare("UPDATE outreach_drafts SET status = 'sent', sent_at = ?, body = ? WHERE id = ?").bind(Date.now(), String(body ?? d.body).slice(0, 6000), draftId).run();
  const c = await getContact(env, d.contact_id);
  if (c) {
    c.lastContact = todayISO();
    if (["research", "drafted"].includes(c.stage)) c.stage = "sent";
    addLog(c, d.kind === "meeting" ? "Booked a call and sent the note" : "Sent the LinkedIn note");
    await saveContact(env, c);
  }
  return { ok: true };
}

// "Not now": drop today's draft and don't suggest them again for a month.
export async function skipContact(env, draftId) {
  const d = await env.FEED.prepare("SELECT * FROM outreach_drafts WHERE id = ?").bind(draftId).first();
  if (!d) return { error: "no such draft" };
  await env.FEED.prepare("UPDATE outreach_drafts SET status = 'cancelled' WHERE id = ? AND status IN ('draft','failed')").bind(draftId).run();
  const c = await getContact(env, d.contact_id);
  if (c) {
    c.stage = "research";
    c.snooze = addDaysISO(todayISO(), 30);
    addLog(c, "Skipped for now (back in a month)");
    await saveContact(env, c);
  }
  return { ok: true };
}

// One-time import (TKS mentor list, ranked by Haneul): new contacts only, existing ones are left alone.
export async function importContacts(env, list) {
  const have = new Set((await listContacts(env)).map((c) => c.id));
  let added = 0;
  for (const [i, m] of (list || []).entries()) {
    if (!m?.name || !m?.org) continue;
    const id = slug(`${m.org} ${m.name}`);
    if (have.has(id)) continue;
    const email = EMAIL_RE.test(String(m.email || "")) ? String(m.email).trim() : "";
    await saveContact(env, addLog({
      id, name: String(m.name).slice(0, 80), title: String(m.title || "").slice(0, 80), org: String(m.org).slice(0, 80),
      orgLine: "", growth: "", skills: (m.skills || []).slice(0, 4).map((s) => String(s).slice(0, 40)),
      email, emailQuality: email ? "verified" : "none", fit: Math.max(1, Math.min(5, Number(m.fit) || 3)), stage: "research",
      followUps: 0, lastContact: null, notes: String(m.why || "").slice(0, 300), ask: String(m.ask || "").slice(0, 300),
      bio: String(m.bio || "").slice(0, 900), linkedin: String(m.linkedin || ""), meeting: String(m.meeting || ""),
      source: "tks", order: i, log: [],
    }, `Added from TKS's mentor list${email ? " (email from the list)" : ""}`));
    added++;
  }
  return { added };
}

// ---------- replies + mail overview from Gmail ----------
const emailOf = (from) => (String(from).match(/<([^>]+)>/)?.[1] || String(from)).trim().toLowerCase();

export async function syncGmail(env) {
  if (!gmailReady(env) || !env.FEED) return { skipped: true };
  const contacts = await listContacts(env);
  const tracked = contacts.filter((c) => EMAIL_RE.test(c.email || ""));
  if (!tracked.length) return { tracked: 0 };
  const byEmail = new Map(tracked.map((c) => [c.email.toLowerCase(), c]));
  const r = await gmail(env, { action: "overview", addresses: [...byEmail.keys()], days: 30 });
  const seen = new Set((await env.DB.get("outreach_seen_msgs", "json")) || []);
  const fresh = [];
  for (const m of r.messages || []) {
    const fromAddr = emailOf(m.from);
    const c = byEmail.get(fromAddr);
    if (!c || seen.has(m.id)) continue; // only replies FROM a tracked contact
    if (String(m.to || "").toLowerCase().includes(fromAddr)) { seen.add(m.id); continue; } // mail to yourself (a test) isn't a reply
    seen.add(m.id);
    fresh.push({ c, m });
  }
  for (const { c, m } of fresh) {
    const fresh2 = await getContact(env, c.id);
    if (["sent", "drafted", "research"].includes(fresh2.stage)) fresh2.stage = "replied";
    fresh2.lastReply = todayISO();
    fresh2.lastContact = todayISO();
    if (m.threadId) fresh2.threadId = m.threadId;
    addLog(fresh2, `Reply: "${String(m.subject || "").slice(0, 80)}"`);
    await saveContact(env, fresh2);
    await send(env, `📬 ${fresh2.name || fresh2.org} replied!\n"${String(m.snippet || "").slice(0, 220)}"\n\nOpen Outreach in the app and I'll help you answer.`);
  }
  await env.DB.put("outreach_seen_msgs", JSON.stringify([...seen].slice(-500)));
  const items = (r.messages || []).slice(0, 25).map((m) => {
    const c = byEmail.get(emailOf(m.from)) || [...byEmail.entries()].find(([e]) => String(m.to || "").toLowerCase().includes(e))?.[1];
    return { from: m.from, to: m.to, subject: m.subject, snippet: String(m.snippet || "").slice(0, 160), date: m.date, contact: c?.id || null, incoming: byEmail.has(emailOf(m.from)) };
  });
  await env.DB.put("outreach_mail", JSON.stringify({ at: Date.now(), items }));
  return { tracked: tracked.length, messages: (r.messages || []).length, newReplies: fresh.length };
}

// ---------- weekly: company news + new (unverified) leads ----------
export async function weeklySearch(env) {
  const contacts = await listContacts(env);
  const orgs = [...new Set(contacts.filter((c) => c.stage !== "closed").map((c) => c.org).filter(Boolean))].slice(0, 12);
  let added = 0;
  for (const org of orgs) {
    await new Promise((r) => setTimeout(r, 1200)); // pace the searches (bursts get refused)
    const news = await newsSearch(`"${org}"`).catch(() => []);
    for (const n of news.slice(0, 2)) {
      if (!n.link) continue;
      // same headline from two outlets = one update
      const r = await env.FEED.prepare("INSERT OR IGNORE INTO outreach_updates (at, kind, org, title, url, source) SELECT ?, 'news', ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM outreach_updates WHERE org = ? AND title = ?)")
        .bind(Date.now(), org, n.title.slice(0, 300), n.link, n.source || "news", org, n.title.slice(0, 300)).run();
      added += r.meta?.changes || 0;
    }
  }
  // new leads: companies doing GNC / landing guidance work that aren't tracked yet
  const queries = ["lunar lander guidance navigation control startup", "rocket landing guidance engineer startup", "spacecraft autonomy GNC company funding"];
  // only recent news (Wikipedia brought up companies that closed years ago, and missions)
  const results = [];
  for (const q of queries) {
    await new Promise((r) => setTimeout(r, 1200));
    const news = await newsSearch(q).catch(() => []);
    results.push(...news.slice(0, 8).map((n) => `NEWS: ${n.title} (${n.source}, ${n.date})`));
  }
  let leads = [];
  if (results.length < 4) return { orgs: orgs.length, added, leads: 0, note: "not enough news for leads this week" };
  try {
    const r = parseJson(await gemini(env, [{ role: "user", parts: [{ text: `Alex (11th grader in TKS, into rocket/lander guidance, navigation & control and convex trajectory optimization)
is looking for mentors at space companies. From ONLY these recent news headlines, pick up to 3 COMPANIES he doesn't track yet whose work fits GNC.
Only companies that are active right now (they appear in recent news as operating). Not space agencies, government programs,
missions or spacecraft names (e.g. not "Chandrayaan-3" or "NASA"), not defunct companies. If none fit, return [].
Already tracked: ${orgs.join(", ")}.
Never invent people, emails or facts not in the results. Return JSON:
[{"org": "...", "orgLine": "what they do, from the results", "why": "one line: why it fits his GNC interest", "skills": ["2-3 relevant skills"], "fit": 1-5}]

${results.join("\n").slice(0, 8000)}` }] }], { json: true, models: MODELS_SMART }));
    leads = (Array.isArray(r) ? r : r.leads || []).filter((l) => l?.org && !orgs.some((o) => o.toLowerCase() === String(l.org).toLowerCase())).slice(0, 3);
  } catch (err) {
    console.error("outreach leads:", err.message);
  }
  for (const l of leads) {
    const id = slug(`${l.org} gnc team`);
    if (await getContact(env, id)) continue;
    const c = addLog({
      id, name: "GNC team (find a named engineer)", title: "", org: String(l.org).slice(0, 80), orgLine: String(l.orgLine || "").slice(0, 300), growth: "",
      skills: (l.skills || []).slice(0, 4), email: "", emailQuality: "none", fit: Math.max(1, Math.min(5, Number(l.fit) || 3)), stage: "research",
      followUps: 0, lastContact: null, notes: "", flag: `Found by Haneul from news, unverified. ${String(l.why || "").slice(0, 200)} Check the company and find a named GNC engineer on LinkedIn.`,
      source: "haneul", log: [],
    }, "Found by Haneul's weekly search (unverified)");
    await saveContact(env, c);
    await env.FEED.prepare("INSERT OR IGNORE INTO outreach_updates (at, kind, org, title, url, source) VALUES (?, 'lead', ?, ?, ?, 'Haneul')").bind(Date.now(), c.org, `New lead: ${c.org}: ${String(l.why || c.orgLine).slice(0, 200)}`, `lead:${id}`).run();
    added++;
  }
  return { orgs: orgs.length, added, leads: leads.length };
}

export async function listUpdates(env, limit = 40) {
  if (!env.FEED) return [];
  return (await env.FEED.prepare("SELECT * FROM outreach_updates ORDER BY id DESC LIMIT ?").bind(limit).all()).results || [];
}

// ---------- the whole tab, for the app ----------
export async function outreachState(env) {
  const p = await profile(env);
  const contacts = (await listContacts(env)).map((c) => ({ ...c, move: nextMove(c, p.cadence), score: score(c, p.cadence) }));
  contacts.sort((a, b) => b.score - a.score);
  return {
    contacts,
    drafts: await listDrafts(env),
    updates: await listUpdates(env),
    mail: (await env.DB.get("outreach_mail", "json")) || null,
    profile: p,
    today: await dailyProgress(env),
    discovered: (await env.DB.get("outreach_discover_last", "json")) || null,
    hunter: hunterReady(env) ? (await hunterCredits(env).catch(() => null)) || { unknown: true } : null,
    work: await getWork(env),
    feeds: ((await env.DB.get("work_feeds", "json")) || []),
    substack: ((await env.DB.get("substack_feed")) || "").replace(/\/feed$/, ""),
    gmail: gmailReady(env),
    overview: overviewText(contacts),
  };
}

// "2 due · 1 reply waiting · 3 waiting on them": one line for the tab, chat and the brief.
export function overviewText(contacts) {
  const open = contacts.filter((c) => c.stage !== "closed");
  const due = open.filter((c) => c.move?.due);
  const replied = open.filter((c) => c.stage === "replied");
  const waiting = open.filter((c) => c.stage === "sent" && c.move && !c.move.due);
  const mentors = open.filter((c) => c.stage === "mentor");
  const research = open.filter((c) => c.stage === "research" || c.stage === "drafted");
  return [
    due.length ? `${due.length} due` : "nothing due",
    research.length ? `${research.length} to research` : "",
    replied.length ? `${replied.length} repl${replied.length === 1 ? "y" : "ies"} to answer` : "",
    waiting.length ? `${waiting.length} waiting on them` : "",
    mentors.length ? `${mentors.length} mentor${mentors.length === 1 ? "" : "s"}` : "",
  ].filter(Boolean).join(" · ");
}

// For Haneul's prompt (chat, check-ins): only what's due, short.
export async function outreachContext(env) {
  if (!env.FEED) return "";
  const p = await profile(env);
  const list = (await listContacts(env)).filter((c) => c.stage !== "closed").map((c) => ({ c, m: nextMove(c, p.cadence), s: score(c, p.cadence) }));
  if (!list.length) return "";
  const due = list.filter((x) => x.m.due).sort((a, b) => b.s - a.s).slice(0, 3);
  const replies = list.filter((x) => x.c.stage === "replied");
  const t = await dailyProgress(env);
  const lines = [`TKS mentor outreach (Outreach tab in the app): ${overviewText(list.map((x) => ({ ...x.c, move: x.m })))}.`,
    `Today's outreach goal: ${t.done}/${t.goal} sent so far, ${t.ready} drafted messages waiting for him (you researched them and wrote the drafts).`];
  if (due.length) lines.push(`Due: ${due.map((x) => `${x.c.name || x.c.org} at ${x.c.org}: ${x.m.t}`).join("; ")}.`);
  lines.push("Everyone past Research is also mirrored every hour to his Networking Tracker table in Notion (a Velocity goal); what he edits there (follow-up dates, notes) comes back to you.");
  if (replies.length) lines.push(`Waiting for Alex's answer: ${replies.map((x) => `${x.c.name || x.c.org} (${x.c.org})`).join(", ")}. Mention it if it fits; emails are only sent after he approves them in the app.`);
  return lines.join("\n");
}

// For the morning brief (GitHub job → /outreach-brief).
export async function outreachBrief(env) {
  if (!env.FEED) return "";
  const p = await profile(env);
  const list = (await listContacts(env)).filter((c) => c.stage !== "closed").map((c) => ({ c, m: nextMove(c, p.cadence), s: score(c, p.cadence) }));
  if (!list.length) return "";
  const due = list.filter((x) => x.m.due).sort((a, b) => b.s - a.s).slice(0, 4);
  const mail = (await env.DB.get("outreach_mail", "json")) || {};
  const recentIn = (mail.items || []).filter((i) => i.incoming && Date.now() - Date.parse(i.date || 0) < 2 * 86400000);
  const lines = [`🤝 Mentor outreach: ${overviewText(list.map((x) => ({ ...x.c, move: x.m })))}`];
  for (const x of due) lines.push(`• ${x.c.name || x.c.org} (${x.c.org}): ${x.m.t}`);
  for (const i of recentIn.slice(0, 3)) lines.push(`📬 ${String(i.from).replace(/<.*>/, "").trim()}: "${String(i.subject).slice(0, 60)}"`);
  return lines.join("\n");
}

// ---------- cron (every 5 minutes) ----------
export async function runOutreach(env) {
  if (!env.FEED) return;
  await sendDue(env).catch((err) => console.error("outreach send:", err.message));
  // Gmail: replies + overview once an hour (minute ≥ 20 window)
  const slot = `${todayISO()}T${localHour()}`;
  if (gmailReady(env) && localMinute() >= 20 && (await env.DB.get("outreach_sync_slot")) !== slot) {
    await env.DB.put("outreach_sync_slot", slot);
    await env.BG_JOBS.send({ kind: "outreach_sync" });
  }
  // Weekdays: 16:00 Haneul researches + drafts today's messages, 17:00 she reminds him (goal: 10 a day)
  const weekday = !["Sat", "Sun"].includes(localWeekday());
  if (weekday && localHour() === 15 && localMinute() >= 30 && (await env.DB.get("outreach_discover_day")) !== todayISO()) {
    await env.DB.put("outreach_discover_day", todayISO(), { expirationTtl: 86400 * 3 });
    await env.BG_JOBS.send({ kind: "outreach_discover" });
  }
  if (weekday && localHour() === 16 && (await env.DB.get("outreach_prep_day")) !== todayISO()) {
    await env.DB.put("outreach_prep_day", todayISO(), { expirationTtl: 86400 * 3 });
    await env.BG_JOBS.send({ kind: "outreach_prep" });
  }
  if (weekday && localHour() === 17 && (await env.DB.get("outreach_nudge_day")) !== todayISO()) {
    await env.DB.put("outreach_nudge_day", todayISO(), { expirationTtl: 86400 * 3 });
    await env.BG_JOBS.send({ kind: "outreach_nudge" });
  }
  // Sunday 10:00-11:00: news + new leads
  const week = addDaysISO(todayISO(), 0).slice(0, 10);
  if (localWeekday() === "Sun" && localHour() === 10 && (await env.DB.get("outreach_week")) !== week) {
    await env.DB.put("outreach_week", week);
    await env.BG_JOBS.send({ kind: "outreach_weekly" });
  }
}

// 17:00 on weekdays: the reminder (in her voice, short). If nothing's drafted yet, she preps first.
export async function outreachNudge(env, haneulSays) {
  let t = await dailyProgress(env);
  if (t.done + t.madeToday < t.goal) await prepOutreach(env).catch((err) => console.error("outreach prep:", err.message));
  t = await dailyProgress(env);
  if (t.done >= t.goal) return;
  const left = t.goal - t.done;
  await haneulSays(env, `It's 5pm: time for Alex's daily mentor outreach (his goal: ${t.goal} a day). Today: ${t.done} sent, ${t.ready} drafts ready
that YOU researched and wrote for him (emails he approves in the app, booking notes and LinkedIn notes he sends himself). ${left} to go.
Remind him in 1-2 short texts, like a friend hyping him up: say how many are ready and that they're in the Mentors tab. No lists.`);
}

// ---------- every day: new mentors from the news ----------
// Rotating topics close to his work; Gemini keeps only people NAMED in the headlines (never invented),
// and Hunter looks up their work email. They land in Research with a "found in the news" note.
const DISCOVER_TOPICS = [ // his focus: space tech, GNC + propulsion
  ["rocket landing guidance navigation control engineer", "lunar lander company engineer"],
  ["rocket engine startup propulsion engineer", "methane rocket engine test startup"],
  ["spacecraft guidance navigation control startup", "space startup founder raises"],
  ["hypersonic vehicle startup engineer", "reentry vehicle capsule startup"],
  ["Latin America space startup founder", "Peru aerospace engineer"],
  ["trajectory optimization aerospace professor", "aerospace engineering lab autonomy professor"],
  ["in-space propulsion startup thruster", "satellite propulsion company CTO"],
];
export async function discoverMentors(env) {
  const contacts = await listContacts(env);
  const known = new Set(contacts.map((c) => `${c.name}`.toLowerCase()));
  const day = Math.floor(Date.parse(`${todayISO()}T12:00:00Z`) / 86400000);
  // today's topic first; if it gives nobody (headlines often name no one, or Google refuses Cloudflare),
  // the next topics, up to 3 per day, until there are 2 good people
  const queries = [];
  let people = [];
  for (let k = 0; k < 3 && people.length < 2; k++) {
    const results = [];
    for (const q of DISCOVER_TOPICS[(day + k) % DISCOVER_TOPICS.length]) {
      await new Promise((r) => setTimeout(r, 1500));
      const news = await newsSearch(q).catch(() => []);
      const recent = news.filter((n) => { const t = Date.parse(n.date || ""); return isNaN(t) || Date.now() - t < 365 * 86400000; }); // last 12 months
      queries.push(`${q} (${recent.length})`);
      results.push(...recent.slice(0, 10).map((n) => `${n.title} (${n.source}, ${n.date})`));
    }
    if (results.length < 3) continue;
    try {
      const r = parseJson(await gemini(env, [{ role: "user", parts: [{ text: `Alex (11th grader in TKS; his focus is space tech: rocket guidance, navigation & control and propulsion; he built a fuel-optimal rocket-landing simulator) is looking for AEROSPACE mentors.
From ONLY these news headlines, pick up to 3 REAL PEOPLE who are NAMED in a headline and would be a great mentor for him (founders,
engineers, researchers in GNC / propulsion / space) who might actually answer a student: engineers, researchers, professors, early-stage founders.
SKIP household names, billionaires and CEOs of big/famous companies (e.g. Sam Altman, Elon Musk, Jeff Bezos): they won't reply.
Never invent a name or a company; skip politicians and celebrities; skip people not named in the text.
Not TKS staff or founders (he already knows them). Already tracked (skip): ${[...known].slice(0, 80).join(", ")}.
Return JSON: [{"name": "Full Name", "org": "their company/lab", "title": "their role if stated", "why": "one line: why they fit Alex",
"ask": "one specific question he could ask them", "skills": ["2-3 tags"], "fit": 1-5, "headline": "the headline you used"}]  ([] if none)

${results.join("\n").slice(0, 9000)}` }] }], { json: true, models: MODELS_SMART }));
      const found = (Array.isArray(r) ? r : r.people || []).filter((x) => x?.name && x?.org && x.name.split(/\s+/).length >= 2 && !known.has(x.name.toLowerCase())
        && !people.some((p) => p.name.toLowerCase() === x.name.toLowerCase()) && (Number(x.fit) || 3) >= 3);
      people.push(...found);
    } catch (err) {
      console.error("discover:", err.message);
    }
  }
  people = people.slice(0, 3);
  let added = 0;
  for (const x of people) {
    const id = slug(`${x.org} ${x.name}`);
    if (await getContact(env, id)) continue;
    await saveContact(env, addLog({
      id, name: String(x.name).slice(0, 80), title: String(x.title || "").slice(0, 80), org: String(x.org).slice(0, 80), orgLine: "", growth: "",
      skills: (x.skills || []).slice(0, 4).map((s) => String(s).slice(0, 40)), email: "", emailQuality: "none",
      fit: Math.max(1, Math.min(5, Number(x.fit) || 3)), stage: "research", followUps: 0, lastContact: null,
      notes: String(x.why || "").slice(0, 300), ask: String(x.ask || "").slice(0, 300), bio: `In the news: ${String(x.headline || "").slice(0, 300)}`,
      flag: "Found by Haneul in today's news (unverified): check it's the right person before writing.", source: "news", linkedin: "", meeting: "", log: [],
    }, "Found by Haneul in the news"));
    await env.FEED.prepare("INSERT OR IGNORE INTO outreach_updates (at, kind, org, title, url, source) VALUES (?, 'lead', ?, ?, ?, 'Haneul')")
      .bind(Date.now(), String(x.org).slice(0, 80), `New mentor: ${x.name} (${x.org}): ${String(x.why || "").slice(0, 160)}`, `lead:${id}`).run();
    added++;
    if (hunterReady(env)) await hunterFind(env, id).catch((err) => console.error("hunter discover:", err.message));
  }
  await env.DB.put("outreach_discover_last", JSON.stringify({ at: Date.now(), queries, added, names: people.map((p) => p.name) }), { expirationTtl: 86400 * 14 });
  return { added, names: people.map((p) => p.name) };
}
