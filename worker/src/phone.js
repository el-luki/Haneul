import { addDaysISO, localHour, localMinute, todayISO } from "./dates.js";

// ---------- Phone focus: Haneul blocks distracting apps (with MacroDroid on his phone) ----------
// MacroDroid: when one of the chosen apps (social media, games) opens, it calls
//   GET /phone?key=WORKER_SECRET&app=<app name>
// and goes back to the home screen if the answer is "block". Haneul answers "ok" only while she has
// unlocked that app (he asks her in chat, with a reason, for a few minutes). Every try is counted,
// she teases him about it (at most every 20 min), and on Sundays she sends a weekly report.
// KV: phone_unlock {app, until, reason}, phone:<date> {app: tries}, phone_nudge (cool-down).

const MAX_UNLOCK_MIN = 30;
const lc = (s) => String(s || "").toLowerCase().trim();

export async function phoneCheck(env, app, { say } = {}) {
  app = String(app || "una app").replace(/[[\]]/g, "").trim().slice(0, 40) || "una app";
  const unlock = await env.DB.get("phone_unlock", "json");
  const open = unlock && unlock.until > Date.now() && (unlock.app === "all" || lc(app).includes(lc(unlock.app)) || lc(unlock.app).includes(lc(app)));
  // count it
  const key = `phone:${todayISO()}`;
  const day = (await env.DB.get(key, "json")) || {};
  const k = open ? `${app} (unlocked)` : app;
  day[k] = (day[k] || 0) + 1;
  await env.DB.put(key, JSON.stringify(day), { expirationTtl: 86400 * 15 });
  if (open) return "ok";
  if (say && !(await env.DB.get("phone_nudge"))) {
    await env.DB.put("phone_nudge", "1", { expirationTtl: 1200 });
    const tries = Object.entries(day).filter(([a]) => !a.endsWith("(unlocked)")).reduce((s, [, n]) => s + n, 0);
    await say(`Alex just tried to open ${app} on his phone, and you (Haneul) blocked it (phone focus: social media and games are blocked
unless you unlock them). That's ${tries} blocked tr${tries === 1 ? "y" : "ies"} today. Text him 1 short message like a friend who caught him:
playful, a little teasing, not mean or preachy. Remind him he can ask you to unlock it for a few minutes if he really needs it (with a reason).`);
  }
  return "block";
}

export async function phoneUnlock(env, { app, minutes, reason }) {
  const min = Math.max(1, Math.min(MAX_UNLOCK_MIN, Math.round(Number(minutes) || 10)));
  const u = { app: lc(app) || "all", until: Date.now() + min * 60000, reason: String(reason || "").slice(0, 200), min };
  await env.DB.put("phone_unlock", JSON.stringify(u), { expirationTtl: min * 60 + 60 });
  return u;
}

export async function phoneLock(env) {
  await env.DB.delete("phone_unlock");
}

async function triesOn(env, iso) {
  return (await env.DB.get(`phone:${iso}`, "json")) || {};
}

// For her prompt: today's tries, what's unlocked, and the rules for unlocking.
export async function phoneContext(env) {
  if (!(await env.DB.get("phone_setup"))) return "";
  const day = await triesOn(env, todayISO());
  const blocked = Object.entries(day).filter(([a]) => !a.endsWith("(unlocked)"));
  const u = await env.DB.get("phone_unlock", "json");
  const left = u && u.until > Date.now() ? Math.ceil((u.until - Date.now()) / 60000) : 0;
  const hm = localHour() * 60 + localMinute();
  const focusTime = (hm >= 7 * 60 + 15 && hm < 15 * 60) || (hm >= 16 * 60 + 15 && hm < 18 * 60) || hm >= 20 * 60 + 30;
  return `PHONE FOCUS: you block his social media and games (MacroDroid sends him to the home screen). ${blocked.length ? `Blocked tries today: ${blocked.map(([a, n]) => `${a} ×${n}`).join(", ")}.` : "No blocked tries today."}${left ? ` Right now ${u.app === "all" ? "everything is" : `${u.app} is`} unlocked for ${left} more min (${u.reason || "no reason given"}).` : ""}
Unlocking (the "phone_unlock" action): only when he asks AND gives a reason; at most ${MAX_UNLOCK_MIN} minutes (usually 10-15). Real reasons (school, TKS,
a message he must answer, family) → yes. "Bored" / "just a bit" → push back once, kindly${focusTime ? " (it's a focus time right now: school, homework or bedtime, so be firmer)" : ""}; if he insists, give 5-10 min.
He can't unlock without you. Never pretend you unlocked something unless you fill the action.`;
}

// Sunday 19:00: the week in numbers.
export async function phoneWeekly(env, haneulSays) {
  if (!(await env.DB.get("phone_setup"))) return;
  const today = todayISO();
  const totals = {};
  let blocked = 0, unlocked = 0;
  for (let i = 0; i < 7; i++) {
    for (const [a, n] of Object.entries(await triesOn(env, addDaysISO(today, -i)))) {
      if (a.endsWith("(unlocked)")) { unlocked += n; continue; }
      blocked += n;
      totals[a] = (totals[a] || 0) + n;
    }
  }
  const top = Object.entries(totals).sort((a, b) => b[1] - a[1]).slice(0, 3);
  await haneulSays(env, `Weekly phone-focus report for Alex (last 7 days): you blocked ${blocked} tries to open distracting apps${top.length ? ` (most: ${top.map(([a, n]) => `${a} ${n}×`).join(", ")})` : ""}; he opened apps ${unlocked} times while you had unlocked them.
Send it in 1-2 short texts like a friend: the number, the app he fights the most, and one encouraging or teasing line. ${blocked === 0 ? "Zero tries: celebrate it!" : ""}`);
}
