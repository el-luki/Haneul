import { MODELS_SMART } from "./config.js";
import { localHour, localMinute, localWeekday, todayISO } from "./dates.js";
import { send } from "./telegram.js";

// ---------- TKS Slack catch-up ----------
// MacroDroid forwards every Slack notification to POST /slack. They're collected all day
// (silently), and Haneul sends a fun catch-up on the bus (weekdays 15:05, weekends 12:00)
// or on /slack: priority first (VIPs, DMs, availability questions with a reply draft),
// builders with similar interests, important thread replies, then the rest by channel.

export const VIP_CHANNELS = ["cohort-general", "announcements", "director-velocity"];
export const VIP_PEOPLE = [/jordan/i];
export const BUILDER_CHANNELS = ["builders-feedback", "i-ml-life"];
export const DIGEST_TIMES = { weekday: { hour: 15, minute: 5 }, weekend: { hour: 12, minute: 0 } };
const KEEP = 500; // notifications kept (about 2 days)

// Slack's own summary notifications ("3 new messages", "Slack") carry no content.
export function isSlackNoise({ title, text }) {
  const t = String(text || "").trim();
  if (!t && !String(title || "").trim()) return true;
  if (/^slack$/i.test(String(title).trim()) && !t) return true;
  if (/^\d+ (new )?(messages?|mensajes?)( in| en| from| de)?/i.test(t)) return true;
  if (/^(checking for new messages|syncing|sincronizando)/i.test(t)) return true;
  return false;
}

// Where did it come from? Slack shows "#channel" in the title for channels, and just a
// person's name for DMs (sometimes "Name in #channel" or a "Thread"/"Hilo" hint).
export function classify({ title = "", text = "" }) {
  const all = `${title} ${text}`;
  const channel = (all.match(/#([a-z0-9][a-z0-9_-]+)/i) || [])[1]?.toLowerCase() || "";
  const thread = /\b(thread|hilo|replied|respondi[oó])\b/i.test(all);
  const dm = !channel && !/^slack$/i.test(title.trim());
  const vip =
    dm ||
    VIP_CHANNELS.includes(channel) ||
    VIP_PEOPLE.some((re) => re.test(title) || re.test(String(text).split(":")[0]));
  return { channel, dm, thread, vip, builders: BUILDER_CHANNELS.includes(channel) };
}

// Queue consumer: one database write per batch.
export async function onSlackBatch(items, env) {
  const log = (await env.DB.get("slack_log", "json")) || [];
  const seen = new Set(log.slice(-150).map((m) => `${m.title}|${m.text}`));
  const now = new Date().toISOString();
  for (const n of items) {
    if (isSlackNoise(n)) continue;
    const key = `${n.title}|${n.text}`;
    if (seen.has(key)) continue; // Android often re-posts the same notification
    seen.add(key);
    log.push({ at: n.at || now, title: String(n.title).slice(0, 200), text: String(n.text).slice(0, 1500), ...classify(n) });
  }
  await env.DB.put("slack_log", JSON.stringify(log.slice(-KEEP)));
}

function timeOf(iso) {
  return new Intl.DateTimeFormat("en-GB", { timeZone: "America/Lima", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
}

export function digestTask(items, sinceLabel) {
  const line = (m) =>
    `${timeOf(m.at)} | ${m.vip ? "[VIP] " : ""}${m.dm ? "[DM] " : ""}${m.builders ? "[BUILDERS] " : ""}${m.thread ? "[THREAD] " : ""}` +
    `${m.channel ? `#${m.channel}` : "direct"} | ${m.title} | ${m.text}`;
  return `Alex just got on the bus and his TKS Slack exploded. Catch him up on everything since ${sinceLabel}.
Below are ALL his Slack notifications (time | tags | where | title | message). [VIP] = Jordan, #cohort-general,
#announcements, #director-velocity, or a DM. [BUILDERS] = #builders-feedback (people share what they built) and
#i-ml-life (braindate reports, life updates). [THREAD] = probably a reply in a thread.

Write the catch-up as Haneul. It must be FUN: react like a friend (gasp, tease him, joke about the chaos,
hype people's wins), at least one tease or joke per text, but every fact exact. Never invent messages.
Send 3-6 texts, in this order (skip a part if there's nothing for it):
1) PRIORITY: EVERY single [VIP] message, even small ones: who, what they said or want.
   If someone asks about availability, a time, a meeting, or expects an answer: first look at EVERY event in his
   calendar for that day inside the asked time range (meetings like a Jordan 1-1, classes, TKS sessions; routine
   blocks like homework can move). Pick a slot that doesn't overlap any meeting, mention any clash (or a smart
   combo, e.g. "you already have a 1-1 with him at 17:20"), and give a short reply draft in quotes he can copy.
2) BUILDERS: people in #builders-feedback / #i-ml-life doing something close to Alex's interests and projects
   (rockets, landing/guidance, optimization, space tech, engineering, AI/ML). If it's VERY close to his own work,
   get excited, tell him to reach out, and give a one-line opener he could send them.
3) THREADS: important replies in threads (decisions, answers, things that involve Alex). Don't repeat part 2.
4) EVERYTHING ELSE: one short line per channel with what happened, and how many unimportant messages you skipped.
This message is the exception to "keep texts short": clear and complete beats short here. No emojis at all.
Plain text, no markdown.

NOTIFICATIONS (${items.length}):
${items.map(line).join("\n")}`;
}

// Sends the catch-up. manual = /slack (answers even when there's nothing new).
export async function slackDigest(env, haneulSays, { manual = false } = {}) {
  const log = (await env.DB.get("slack_log", "json")) || [];
  const last = (await env.DB.get("slack_last_digest")) || "";
  const items = log.filter((m) => m.at > last);
  if (!items.length) {
    if (manual) return send(env, "nothing new on slack since my last catch-up. suspiciously quiet");
    return;
  }
  const since = last ? `${timeOf(last)}${last.slice(0, 10) === new Date().toISOString().slice(0, 10) ? "" : " yesterday"}` : "this morning";
  // Very busy days: keep every VIP message and the most recent of the rest.
  const vip = items.filter((m) => m.vip);
  const rest = items.filter((m) => !m.vip).slice(-(250 - Math.min(vip.length, 150)));
  const chosen = [...vip, ...rest].sort((a, b) => a.at.localeCompare(b.at));
  // Once a day, so it can use the smart models (better at checking the calendar for reply drafts).
  await haneulSays(env, digestTask(chosen, since), { maxTexts: 6, models: MODELS_SMART, maxEmojis: 0 });
  await env.DB.put("slack_last_digest", new Date().toISOString());
}

// Called every 5 minutes: the bus catch-up (weekdays 15:05, weekends 12:00), once a day.
export async function runSlack(env) {
  const weekend = ["Sat", "Sun"].includes(localWeekday());
  const t = weekend ? DIGEST_TIMES.weekend : DIGEST_TIMES.weekday;
  const now = localHour() * 60 + localMinute();
  const at = t.hour * 60 + t.minute;
  if (now < at || now >= at + 30) return;
  if ((await env.DB.get("slack_digest_date")) === todayISO()) return;
  await env.DB.put("slack_digest_date", todayISO());
  await env.BG_JOBS.send({ kind: "slack" }); // Gemini runs in the background queue
}
