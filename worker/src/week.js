import { addDaysISO, todayISO } from "./dates.js";

// ---------- Week in review (the app's "This week" sheet) ----------
// The last 7 days, day by day: mentor reach-outs sent, LinkedIn posts, focus + AP minutes, habits done,
// to-dos finished and GitHub progress notes; plus the newsletter issue and a few plain highlights.
// Everything is read from what Haneul already stores, so there's no AI call and it loads fast.

export function weekDays(today = todayISO()) {
  return Array.from({ length: 7 }, (_, i) => addDaysISO(today, i - 6));
}

// A couple of plain sentences from the numbers (no AI): the best day and what's going well.
export function highlights(days, totals) {
  const out = [];
  const mins = days.map((d) => d.focus + d.ap);
  const best = mins.indexOf(Math.max(...mins));
  if (mins[best] > 0) out.push(`Best focus day: ${new Date(days[best].d + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" })} (${mins[best]} min).`);
  if (totals.linkedin >= 5) out.push(`LinkedIn ${totals.linkedin}/7 days. That's the habit Jordan asked for.`);
  else if (totals.linkedin) out.push(`LinkedIn ${totals.linkedin}/7 days. Aim for 5+ next week.`);
  if (totals.outreach) out.push(`${totals.outreach} mentor reach-out${totals.outreach === 1 ? "" : "s"} sent.`);
  if (totals.commits) out.push(`${totals.commits} GitHub update${totals.commits === 1 ? "" : "s"}: material for the newsletter.`);
  if (totals.screen) out.push(`Phone: about ${Math.round(totals.screen / 7)} min a day.`);
  if (!out.length) out.push("A quiet week in the numbers. Pick one thing to show up for next week.");
  return out.slice(0, 3);
}

export async function weekStats(env) {
  const days = weekDays();
  const from = days[0];
  const row = Object.fromEntries(days.map((d) => [d, { d, outreach: 0, linkedin: 0, focus: 0, ap: 0, habits: 0, done: 0, commits: 0, screen: 0 }]));
  const safe = (p) => p.catch(() => null);
  const [social, ap, habits, doneLog, focusLog, progress] = await Promise.all([
    safe(env.DB.get("social", "json")), safe(env.DB.get("ap", "json")), safe(env.DB.get("habits", "json")),
    safe(env.DB.get("done_log", "json")), safe(env.DB.get("focus_log", "json")), safe(env.DB.get("github_progress", "json")),
  ]);
  for (const d of days) {
    if (social?.days?.[d]?.posted?.linkedin) row[d].linkedin = 1;
    row[d].ap = ap?.logs?.[d]?.minutes || 0;
    row[d].habits = (habits?.log?.[d] || []).length;
  }
  for (const x of doneLog || []) if (row[x.date]) row[x.date].done++;
  for (const x of focusLog || []) if (row[x.date] && !/\b(ap|physics|f[ií]sica)\b/i.test(x.label || "")) row[x.date].focus += x.min || 0; // AP focus is already in the AP minutes
  for (const n of progress?.notes || []) if (row[n.date]) row[n.date].commits++;
  const screenOn = !!(await env.DB.get("screen_setup").catch(() => null));
  if (screenOn) for (const s of await (await import("./screen.js")).screenWeek(env).catch(() => [])) if (row[s.date]) row[s.date].screen = s.minutes;
  if (env.FEED) {
    const start = Date.parse(`${from}T00:00:00-05:00`);
    const sent = await env.FEED.prepare("SELECT sent_at FROM outreach_drafts WHERE status = 'sent' AND sent_at >= ? AND kind IN ('first','meeting','linkedin')").bind(start).all().catch(() => null);
    for (const r of sent?.results || []) {
      const d = new Date(r.sent_at - 5 * 3600000).toISOString().slice(0, 10);
      if (row[d]) row[d].outreach++;
    }
  }
  const list = days.map((d) => row[d]);
  const sum = (k) => list.reduce((s, x) => s + x[k], 0);
  const totals = { outreach: sum("outreach"), linkedin: sum("linkedin"), focus: sum("focus"), ap: sum("ap"), habits: sum("habits"), done: sum("done"), commits: sum("commits"), screen: sum("screen") };
  let newsletter = null;
  try {
    const nm = await import("./newsletter.js");
    const nl = await nm.getNewsletter(env);
    const cur = nm.currentIssue(nl);
    const sentThisWeek = nl.issues.filter((i) => i.status === "sent" && i.date >= from);
    newsletter = { current: cur ? { n: cur.n, date: cur.date, title: cur.title, status: cur.status } : null, sent: sentThisWeek.length };
  } catch {}
  return { from, to: days[6], days: list, totals, newsletter, screenOn, highlights: highlights(list, totals) };
}
