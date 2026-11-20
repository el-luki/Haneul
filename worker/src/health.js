import { MODELS_LIGHT, MODELS_SMART } from "./config.js";
import { addDaysISO, localHour, localWeekday, todayISO } from "./dates.js";
import { send, tg } from "./telegram.js";

// ---------- Health: /status and automatic alerts ----------
// The bot records small "heartbeats" (last calendar sync, brief delivered, backup
// saved, Gemini usage today, GitHub token expiry) and checks them every 5 minutes.
// If something breaks, it tells you once a day instead of going silent.

const DAY = 86400000;

// GitHub jobs report back here when they finish (POST /heartbeat?job=brief).
export async function recordHeartbeat(env, job) {
  const beats = (await env.DB.get("heartbeats", "json")) || {};
  beats[job] = new Date().toISOString();
  await env.DB.put("heartbeats", JSON.stringify(beats));
}

// Called by gemini() after every attempt. Never throws: health tracking must not break answers.
export async function recordGemini(env, model, outcome) {
  try {
    const today = todayISO();
    let u = (await env.DB.get("gemini_usage", "json")) || {};
    if (u.date !== today) u = { date: today, models: {} };
    const m = (u.models[model] ||= { ok: 0, limited: false });
    if (outcome === "ok") m.ok++;
    if (outcome === "limited") m.limited = true;
    await env.DB.put("gemini_usage", JSON.stringify(u));
  } catch {}
}

// GitHub tells us when the token expires in a response header on every call.
export async function recordGithubToken(env, res) {
  try {
    const exp = res.headers.get("github-authentication-token-expiration");
    if (exp) await env.DB.put("github_token_expires", new Date(exp.replace(" UTC", "Z").replace(" ", "T")).toISOString());
  } catch {}
}

function ago(iso) {
  if (!iso) return "never";
  const min = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (min < 60) return `${min} min ago`;
  if (min < 48 * 60) return `${Math.round(min / 60)} h ago`;
  return `${Math.round(min / 1440)} days ago`;
}

function localDate(iso) {
  return iso ? new Intl.DateTimeFormat("en-CA", { timeZone: "America/Lima" }).format(new Date(iso)) : "";
}

// All checks in one place: used by /status (everything) and the alerts (problems only).
export async function healthChecks(env) {
  const now = Date.now();
  const hour = localHour();
  const today = todayISO();
  const beats = (await env.DB.get("heartbeats", "json")) || {};
  const schedule = await env.DB.get("schedule", "json");
  const classroom = await env.DB.get("classroom", "json");
  const tokenExp = await env.DB.get("github_token_expires");
  const usage = (await env.DB.get("gemini_usage", "json")) || {};
  const models = usage.date === today ? usage.models : {};
  // The day monitoring started: nothing is flagged before it had a chance to run once.
  let since = await env.DB.get("health_since");
  if (!since) {
    since = today;
    await env.DB.put("health_since", since);
  }
  const checks = [];
  const add = (id, ok, text, cooldownDays = 1) => checks.push({ id, ok, text, cooldownDays });

  // Morning brief: should have arrived by 7:00 (from the first full day of monitoring)
  const briefToday = localDate(beats.brief) === today;
  const weekend = ["Sat", "Sun"].includes(localWeekday());
  const briefDue = hour >= (weekend ? 9 : 7) && today > since;
  add("brief", briefToday || !briefDue, `☀️ Morning brief: ${briefToday ? `arrived ${ago(beats.brief)}` : !briefDue ? `comes at ${weekend ? "8:00" : "6:10"}` : "didn't arrive today. Check GitHub → Actions → Morning brief"}`);

  // Calendar sync: hourly from 5:00 to 22:00
  const syncAge = schedule ? now - Date.parse(schedule.synced_at) : Infinity;
  const syncHours = hour >= 7 && hour <= 22;
  add("sync", !syncHours || syncAge < 3 * 3600000, `🔄 Calendar sync: ${schedule ? ago(schedule.synced_at) : "never"}${syncHours && syncAge >= 3 * 3600000 ? " (should be hourly)" : ""}`);

  // Classroom: hourly from the school-account script
  if (classroom) {
    const old = now - Date.parse(classroom.synced_at) > 6 * 3600000;
    add("classroom", !old, `📚 Classroom: synced ${ago(classroom.synced_at)}${old ? " (should be hourly; check the school script's trigger)" : ""}`);
  }

  // Backups: weekly. Flag if the last one is old, or if one was started a day ago and never finished.
  const backupStarted = await env.DB.get("backup_started");
  const backupOld = beats.backup
    ? now - Date.parse(beats.backup) > 9 * DAY
    : Boolean(backupStarted) && today > addDaysISO(backupStarted, 1);
  add("backup", !backupOld, `💾 Backup: ${beats.backup ? `saved ${ago(beats.backup)}` : backupOld ? "started but never finished. Check GitHub → Actions → Weekly backup" : "none yet (runs Sundays 4:00, or /backup)"}`, 3);

  // GitHub token: warn 14 days before it expires
  if (tokenExp) {
    const days = Math.floor((Date.parse(tokenExp) - now) / DAY);
    add("token", days > 14, `🔑 GitHub token: ${days < 0 ? "EXPIRED. Make a new one" : `expires in ${days} days`}${days >= 0 && days <= 14 ? ". Make a new one soon" : ""}`, 3);
  }

  // Gemini quota today
  const used = (list) => list.reduce((s, m) => s + (models[m]?.ok || 0), 0);
  const allLimited = (list) => list.every((m) => models[m]?.limited);
  const smartModels = MODELS_SMART.filter((m) => !MODELS_LIGHT.includes(m));
  add("gemini", !allLimited(MODELS_LIGHT),
    `🤖 Gemini today: ${used(smartModels)} smart (${allLimited(smartModels) ? "quota used up, using Lite" : "OK"}) · ${used(MODELS_LIGHT)} lite${allLimited(MODELS_LIGHT) ? " · ALL models out of quota until tomorrow" : ""}`);

  // Spotify + last weekly jobs (info only)
  const spotify = await env.DB.get("spotify");
  add("spotify", true, `🎧 Spotify: ${spotify ? "connected" : "not connected (/spotify)"}`);
  add("review", true, `🗓️ Sunday review: ${ago(beats.review)} · 📰 monthly draft: ${ago(beats.monthly)}`);

  // Telegram webhook errors in the last hour
  try {
    const info = await tg(env, "getWebhookInfo", {});
    const recent = info.last_error_date && now / 1000 - info.last_error_date < 3600;
    add("telegram", !recent || info.pending_update_count < 5, `💬 Telegram: ${recent ? `error ${ago(new Date(info.last_error_date * 1000).toISOString())}: ${info.last_error_message}` : "OK"}${info.pending_update_count ? ` · ${info.pending_update_count} waiting` : ""}`);
  } catch {}

  return checks;
}

export async function showStatus(env) {
  const checks = await healthChecks(env);
  const problems = checks.filter((c) => !c.ok).length;
  return send(env, `${problems ? `⚠️ ${problems} thing${problems > 1 ? "s" : ""} need attention` : "✅ Everything is working"}\n\n${checks.map((c) => `${c.ok ? "" : "⚠️ "}${c.text}`).join("\n")}`);
}

// Every 5 minutes: alert about each problem at most once per cooldown period.
export async function runHealthAlerts(env) {
  const problems = (await healthChecks(env)).filter((c) => !c.ok);
  if (!problems.length) return;
  const alerted = (await env.DB.get("health_alerted", "json")) || {};
  const due = problems.filter((p) => !alerted[p.id] || Date.now() - Date.parse(alerted[p.id]) > p.cooldownDays * DAY);
  if (!due.length) return;
  for (const p of due) alerted[p.id] = new Date().toISOString();
  await env.DB.put("health_alerted", JSON.stringify(alerted));
  await send(env, `⚠️ Bot health check\n\n${due.map((p) => p.text).join("\n")}\n\n/status for the full picture`);
}
