import { AP_UNITS, apSummary, getAp } from "./ap.js";
import { getHabits, habitStreak } from "./habits.js";
import { getMemory } from "./memory.js";
import { getNotes } from "./notes.js";

// ---------- Monthly TKS update: data for the GitHub job ----------

export async function monthData(env, month) {
  const inMonth = (d) => (d || "").startsWith(month);
  const ap = await getAp(env);
  const apMinutes = Object.entries(ap.logs).filter(([d]) => inMonth(d)).reduce((s, [, l]) => s + (l.minutes || 0), 0);
  const h = await getHabits(env);
  const habitDays = (habit) => Object.entries(h.log).filter(([d, ids]) => inMonth(d) && ids.includes(habit.id)).length;
  return {
    journal: ((await env.DB.get("journal", "json")) || []).filter((j) => inMonth(j.date)),
    habits: h.list.map((x) => ({ name: x.name, days_done: habitDays(x), streak: habitStreak(x, h.log) })),
    memory: (await getMemory(env)).map((f) => f.text),
    korean_lessons: ((await env.DB.get("korean", "json")) || {}).lesson || 0,
    notes: (await getNotes(env)).filter((n) => inMonth(n.date)),
    newsletter_issues: ((await env.DB.get("newsletter", "json"))?.issues || []).filter((i) => inMonth(i.date)).map((i) => ({ n: i.n, date: i.date, title: i.title, status: i.status, url: i.sentUrl || "" })),
    tks_drafts: ((await env.DB.get("tks_drafts", "json")) || []).filter((d) => inMonth(d.date)),
    done: ((await env.DB.get("done_log", "json")) || []).filter((d) => inMonth(d.date)),
    ap: (await env.DB.get("ap"))
      ? { minutes: apMinutes, units_done: ap.done.map((n) => AP_UNITS.find((u) => u.n === n)?.name), summary: apSummary(ap) }
      : null,
  };
}
