import { MODELS_SMART } from "./config.js";
import { addDaysISO, daysBetween, localWeekday, shortDateISO, todayISO, todayLong } from "./dates.js";
import { gemini, parseJson } from "./gemini.js";
import { notionDraft, notionReady } from "./notion.js";
import { send } from "./telegram.js";
import { workText } from "./work.js";

// ---------- Weekly newsletter ----------
// Alex's Substack goes out every Sunday (TKS personal brand: his lead archetype is The Thinker,
// "but why does it work?"). The calendar lives in KV "newsletter". Each week:
//   Thursday 16:30  Haneul writes a first draft of Sunday's issue (Notion → Newsletter Drafts,
//                   and the outline shows in the app under Mentors → Posts)
//   Saturday 10:00  edit nudge, if it isn't out yet
//   Sunday 17:00    send nudge, if it isn't out yet
//   Sunday 15:00    when fewer than 2 issues are planned, she suggests the next one
// An issue counts as sent when a new post shows up on his Substack feed (work.js), or with /newsletter sent.
// The big monthly TKS update (monthly.js) is separate: it's a recap of the month, built from these issues.

export const SEND_DAY = "Sun";
const DRAFT_AT = { weekday: "Thu", hour: 16, minute: 30 };
const EDIT_AT = { weekday: "Sat", hour: 10, minute: 0 };
const SEND_AT = { weekday: "Sun", hour: 17, minute: 0 };
const PLAN_AT = { weekday: "Sun", hour: 15, minute: 0 };
export const SCHEDULE = { DRAFT_AT, EDIT_AT, SEND_AT, PLAN_AT };

// The format every issue follows (from TKS Session 11 + his brand template).
export const FORMAT = `1. Hook: one surprising question or picture.
2. Why it works: the core explanation in plain words (he is a Thinker: explain why something works).
3. This week's progress: what he built or tried, including what broke.
4. The ask: ONE specific way a reader can help.`;

export const PRIVACY = "Never his address, school, schedule, phone number or live location. Never name, quote or show another person (write [ask first: name] instead). Family, health and personal life stay out.";

const SEED = [
  ["2026-11-29", "Build in public", "How do you land a rocket on its tail? (G-FOLD 3-DoF sim, progress so far)", "15 minutes with someone who has worked on GNC or landing guidance"],
  ["2026-12-06", "Learn in public", "I took apart our new vacuum (why Dyson cyclones work)", "What's something you've always wondered how it works?"],
  ["2026-12-13", "Collaborate in public", "What I learned from someone who works on landing algorithms and GNC", ""],
  ["2026-12-20", "Collaborate in public", "What I learned from someone who works on landing algorithms and GNC", ""],
  ["2026-12-27", "Build in public", "I built an AI assistant for $0 (Haneul)", "Share it with someone building on a $0 budget"],
  ["2027-01-03", "Learn in public", "The trick that makes an impossible problem easy (lossless convexification)", "Am I explaining this right? Corrections welcome"],
];
export function seedNewsletter() {
  return {
    name: "",
    issues: SEED.map(([date, stage, title, ask], i) => ({ n: i + 1, date, stage, title, ask, status: "planned" })),
  };
}

export async function getNewsletter(env) {
  return (await env.DB.get("newsletter", "json")) || seedNewsletter();
}
async function saveNewsletter(env, nl) {
  nl.issues.sort((a, b) => a.date.localeCompare(b.date));
  nl.issues = nl.issues.slice(-60);
  await env.DB.put("newsletter", JSON.stringify(nl));
}

const open = (i) => i.status !== "sent" && i.status !== "skipped";

// The issue he's working on now: the first one not out yet, from 3 days ago on (a late send still counts).
export function currentIssue(nl, today = todayISO()) {
  return nl.issues.find((i) => open(i) && daysBetween(today, i.date) >= -3) || null;
}
// Issues still to come (not sent, from today on).
export function upcomingIssues(nl, today = todayISO()) {
  return nl.issues.filter((i) => open(i) && i.date >= today);
}
// A post published on `postDate` is the issue due within 3 days of it.
export function issueForPost(nl, postDate) {
  return nl.issues.filter((i) => open(i) && Math.abs(daysBetween(postDate, i.date)) <= 3)
    .sort((a, b) => Math.abs(daysBetween(postDate, a.date)) - Math.abs(daysBetween(postDate, b.date)))[0] || null;
}
// The Sunday after the last planned issue (or the next Sunday).
export function nextSendDate(nl, today = todayISO()) {
  const last = nl.issues.map((i) => i.date).sort().pop();
  let d = last && last >= today ? addDaysISO(last, 1) : today;
  while (new Date(`${d}T12:00:00Z`).getUTCDay() !== 0) d = addDaysISO(d, 1);
  return d;
}

const statusWord = { planned: "planned", drafted: "draft ready", sent: "sent ✓", skipped: "skipped" };
export function formatCalendar(nl, today = todayISO()) {
  const cur = currentIssue(nl, today);
  const rows = nl.issues.filter((i) => i.date >= addDaysISO(today, -14)).slice(0, 8)
    .map((i) => `${i === cur ? "▶" : "·"} #${i.n} ${shortDateISO(i.date)} · ${i.title} (${statusWord[i.status] || i.status})`);
  return `📰 ${nl.name || "Your weekly newsletter"} · every Sunday\n${rows.join("\n") || "Nothing planned yet: /newsletter plan"}`;
}

// For her chat prompt.
export async function newsletterContext(env) {
  const nl = await getNewsletter(env);
  const cur = currentIssue(nl);
  if (!cur) return `NEWSLETTER: weekly on Sundays (Substack), but nothing is planned right now.`;
  return `NEWSLETTER (his weekly Substack, every Sunday${nl.name ? `, called "${nl.name}"` : ", name not picked yet"}): next is #${cur.n} on ${shortDateISO(cur.date)}, "${cur.title}" (${statusWord[cur.status]}${cur.draftUrl ? ", draft in Notion" : ""}).
He drafts Thursdays, edits Saturdays, sends Sundays. Privacy lines for anything you suggest for it: ${PRIVACY}`;
}

export function draftPrompt(issue, work, name, material = {}) {
  return `Today is ${todayLong()}. Alex (11th grader in TKS, into space tech, GNC, landing algorithms) writes a weekly
Substack newsletter${name ? ` called "${name}"` : ""}. Write a FIRST DRAFT of issue #${issue.n} (goes out ${issue.date}).
Title: ${issue.title}
Stage: ${issue.stage}
${issue.ask ? `The ask at the end: ${issue.ask}` : ""}

Format (400-600 words, his own voice: curious, clear, careful, a 16-year-old, not corporate):
${FORMAT}

Use only things from his real work below. Where you need a fact, number or result you don't have, write [check: what to add].
Privacy: ${PRIVACY}

His work and learning:
${work || "(nothing logged)"}
${material.progress ? `\nWhat he actually built recently (from his GitHub commits; use this for "this week's progress", in plain words, no commit jargon):\n${material.progress}\n` : ""}${material.debriefs ? `\nHis notes from recent chats with people in the field (use these for Collaborate issues; keep the [ask first: name] placeholders):\n${material.debriefs}\n` : ""}
Return JSON: {"hook": "first line", "sections": [{"heading": "...", "text": "..."}], "ask": "the closing ask"}`;
}

// Thursday (or /newsletter draft): a first draft of the current issue, saved to Notion.
export async function draftIssue(env, haneulSays, { manual = false } = {}) {
  const nl = await getNewsletter(env);
  const issue = currentIssue(nl);
  if (!issue) return manual ? send(env, "📰 Nothing planned to draft. Try /newsletter plan.") : null;
  if (issue.status === "drafted" && !manual) return null;
  const work = await workText(env).catch(() => "");
  const material = {
    progress: await (await import("./progress.js")).progressText(env, 10).catch(() => ""),
    debriefs: await (await import("./debrief.js")).debriefText(env, 21).catch(() => ""),
  };
  const r = parseJson(await gemini(env, [{ role: "user", parts: [{ text: draftPrompt(issue, work, nl.name, material) }] }], { json: true, models: MODELS_SMART }));
  if (!r?.sections?.length) return manual ? send(env, "📰 I couldn't write the draft just now. Try /newsletter draft again in a bit.") : null;
  const sections = r.sections.slice(0, 6).map((s) => ({ heading: String(s.heading || "").slice(0, 120), text: String(s.text || "").slice(0, 2500) }));
  const body = [r.hook, ...sections.flatMap((s) => [s.heading, s.text]), r.ask ? `Ask: ${r.ask}` : ""].filter(Boolean).join("\n\n");
  const url = notionReady(env) ? await notionDraft(env, `Newsletter #${issue.n}: ${issue.title}`, body).catch(() => "") : "";
  issue.status = "drafted";
  issue.draftUrl = url || issue.draftUrl || "";
  issue.hook = String(r.hook || "").slice(0, 300);
  issue.outline = sections.map((s) => s.heading).filter(Boolean);
  await saveNewsletter(env, nl);
  // the app's Mentors → Posts tab shows it as this week's article
  const { setWeeklyFromNewsletter } = await import("./social.js");
  await setWeeklyFromNewsletter(env, issue).catch(() => {});
  await haneulSays(env, `You just wrote the first draft of Alex's newsletter issue #${issue.n}, "${issue.title}", which goes out Sunday.
Tell him in 1-2 short texts that it's ready to edit (it's a starting point in his voice; spots marked [check] need his real results).`);
  if (url) await send(env, `📝 Draft #${issue.n}: ${url}`);
  else await send(env, `📝 Draft #${issue.n}\n\n${body.slice(0, 3500)}`);
}

// Sunday 15:00 when the calendar runs low (or /newsletter plan): suggest the next issue and add it.
export async function planNext(env, haneulSays, { manual = false } = {}) {
  const nl = await getNewsletter(env);
  if (!manual && upcomingIssues(nl).length >= 2) return null;
  const work = await workText(env).catch(() => "");
  const past = nl.issues.map((i) => i.title).join(" | ");
  const r = parseJson(await gemini(env, [{ role: "user", parts: [{ text: `Alex (11th grader, TKS, space tech, GNC, landing algorithms) writes a weekly Substack newsletter.
He's a Thinker: each issue explains why something works, from his own build or learning. Suggest the NEXT issue.
Stages to rotate: Build in public, Learn in public, Collaborate in public.
Past and planned issues (don't repeat): ${past || "(none)"}
His work and learning:
${work || "(nothing logged)"}
Return JSON: {"title": "...", "stage": "...", "ask": "one specific ask for readers"}` }] }], { json: true, models: MODELS_SMART }));
  if (!r?.title) return manual ? send(env, "📰 No idea came out just now. Try /newsletter plan again later.") : null;
  const issue = { n: nl.issues.reduce((m, i) => Math.max(m, i.n), 0) + 1, date: nextSendDate(nl), stage: String(r.stage || "Learn in public").slice(0, 40), title: String(r.title).slice(0, 160), ask: String(r.ask || "").slice(0, 200), status: "planned" };
  nl.issues.push(issue);
  await saveNewsletter(env, nl);
  await haneulSays(env, `You added the next issue to Alex's newsletter calendar: #${issue.n} on ${shortDateISO(issue.date)}, "${issue.title}" (${issue.stage}).
Suggest it in 1-2 short texts and say he can change it (send "/newsletter" to see the calendar).`);
}

// Saturday / Sunday nudges, only if the current issue isn't out yet.
export async function nudge(env, haneulSays, step) {
  const nl = await getNewsletter(env);
  const issue = currentIssue(nl);
  if (!issue || daysBetween(todayISO(), issue.date) > 1) return null;
  const task = step === "edit"
    ? `It's Saturday: remind Alex to edit his newsletter issue #${issue.n}, "${issue.title}", so it's ready for tomorrow${issue.draftUrl ? " (the draft is in Notion)" : " (there's no draft yet: he can send /newsletter draft)"}. 1-2 short texts, encouraging.`
    : `It's Sunday evening and Alex's newsletter issue #${issue.n}, "${issue.title}", isn't out yet. A light nudge in 1-2 short texts: hit publish on Substack, or send "/newsletter skip" if this week can't happen (no guilt).`;
  await haneulSays(env, task);
}

// From the feed checker: new Substack posts mark the matching issue as sent.
export async function markSentFromPosts(env, posts) {
  const nl = await getNewsletter(env);
  let changed = 0;
  for (const p of posts) {
    if (/medium\.com/i.test(p.url || "")) continue; // his newsletter is the Substack; Medium posts are separate pieces
    const issue = issueForPost(nl, String(p.date || todayISO()).slice(0, 10));
    if (!issue) continue;
    issue.status = "sent";
    issue.sentUrl = p.url;
    changed++;
  }
  if (changed) await saveNewsletter(env, nl);
  return changed;
}

// Runs every tick: queues the week's steps once each.
export async function runNewsletter(env, hm) {
  const day = localWeekday();
  for (const [step, at] of [["draft", DRAFT_AT], ["edit", EDIT_AT], ["send", SEND_AT], ["plan", PLAN_AT]]) {
    const t = at.hour * 60 + at.minute;
    if (day !== at.weekday || hm < t || hm >= t + 30) continue;
    const key = `newsletter_${step}_date`;
    if ((await env.DB.get(key)) === todayISO()) continue;
    await env.DB.put(key, todayISO());
    await env.BG_JOBS.send({ kind: "newsletter", step });
  }
}

export async function newsletterJob(env, haneulSays, step) {
  if (step === "draft") return draftIssue(env, haneulSays);
  if (step === "draft_now") return draftIssue(env, haneulSays, { manual: true });
  if (step === "plan") return planNext(env, haneulSays);
  if (step === "plan_now") return planNext(env, haneulSays, { manual: true });
  if (step === "edit" || step === "send") return nudge(env, haneulSays, step);
}

// /newsletter · /newsletter draft · plan · sent · skip · name <name>
export async function onNewsletterCommand(env, arg) {
  const [sub, ...rest] = String(arg || "").trim().split(/\s+/);
  const word = (sub || "").toLowerCase();
  const nl = await getNewsletter(env);
  if (!word) {
    const cur = currentIssue(nl);
    return send(env, `${formatCalendar(nl)}${cur?.draftUrl ? `\n\n📝 Draft #${cur.n}: ${cur.draftUrl}` : ""}\n\n/newsletter draft · plan · sent · skip · name <name>`);
  }
  if (word === "draft") {
    await send(env, "📝 Writing the draft, one sec…");
    return env.BG_JOBS.send({ kind: "newsletter", step: "draft_now" });
  }
  if (word === "plan") {
    await send(env, "💡 Thinking of the next issue…");
    return env.BG_JOBS.send({ kind: "newsletter", step: "plan_now" });
  }
  if (word === "name") {
    const name = rest.join(" ").replace(/^["“]|["”]$/g, "").trim().slice(0, 80);
    if (!name) return send(env, `The name is ${nl.name ? `"${nl.name}"` : "not picked yet"}. Send /newsletter name Why It Lands (for example).`);
    nl.name = name;
    await saveNewsletter(env, nl);
    return send(env, `📰 Your newsletter is now "${name}". Remember to update the invite message too.`);
  }
  if (word === "sent" || word === "skip") {
    const cur = currentIssue(nl);
    if (!cur) return send(env, "There's no open issue right now.");
    cur.status = word === "sent" ? "sent" : "skipped";
    await saveNewsletter(env, nl);
    return send(env, word === "sent" ? `🎉 #${cur.n} is out. Nice.` : `OK, #${cur.n} is skipped. Next week counts.`);
  }
  return send(env, "/newsletter: the calendar · draft · plan · sent · skip · name <name>");
}
