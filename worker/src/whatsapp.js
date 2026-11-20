import { parseJsonList } from "./agenda.js";
import { MODELS_LIGHT } from "./config.js";
import { todayISO, todayLong } from "./dates.js";
import { gemini } from "./gemini.js";
import { eventsForDay, formatEvent } from "./schedule.js";
import { send } from "./telegram.js";
import { getTodos } from "./todos.js";

// ---------- WhatsApp alerts ----------
//
// Every WhatsApp notification arrives here, in batches of up to 30 seconds.
// The bot looks at WHAT the message says, not who sent it:
//   1. obvious noise (jaja, stickers, emojis, reactions...) is skipped without AI
//   2. keyword matches are always forwarded (and work even if Gemini is down)
//   3. Gemini reads the rest and forwards what's important (smart mode, ON by default)
//   4. optional VIPs: everything from them is forwarded
// /smart off switches to keywords-only, so no messages are sent to Google.

export const DEFAULT_WORDS = [
  "urgent", "urgente", "emergency", "emergencia", "exam", "examen", "quiz", "test",
  "deadline", "entrega", "call me", "llámame", "llamame", "cancelled", "cancelado", "reunión", "meeting",
];

export async function readNotification(request, url) {
  let title = url.searchParams.get("title") || "";
  let text = url.searchParams.get("text") || "";
  if (!title && !text) {
    const raw = await request.text();
    try {
      const json = JSON.parse(raw);
      title = json.title || "";
      text = json.text || "";
    } catch {
      const form = new URLSearchParams(raw);
      title = form.get("title") || "";
      text = form.get("text") || "";
    }
  }
  return { title: String(title).slice(0, 200), text: String(text).slice(0, 2000) };
}

export async function getWaSettings(env) {
  const s = (await env.DB.get("wa_settings", "json")) || {};
  // v2: smart (content-based) filtering became the default. Older saved settings had it off.
  const smart = s.v === 2 ? s.smart ?? true : true;
  return { v: 2, on: s.on ?? true, smart, vips: s.vips ?? [], words: s.words ?? DEFAULT_WORDS };
}

// Messages that can't be important, skipped before asking Gemini (saves free quota).
export function isNoise({ title, text }) {
  const t = text.trim();
  if (/^whatsapp$/i.test(title.trim()) && !t) return true;
  if (/^(WhatsApp Web|Backup)/i.test(title)) return true;
  if (/^(\d+ (new )?messages?( from \d+ chats?)?|\d+ mensajes? nuevos?|checking for new messages|backup in progress)/i.test(t)) return true;
  if (t.length < 2) return true;
  if (/^[\p{Extended_Pictographic}\p{Emoji_Modifier}‍️\s]+$/u.test(t)) return true; // only emojis
  if (/^((ja|je|ha|he|jsj|xd|lol|lmao)+|ok(ay|ey|i)?|va|dale|sí|si|no|gracias|thanks|thx|ty|bueno|listo|jajaja\S*)[\s!.?]*$/i.test(t)) return true;
  if (/^(📷|🎥|🎤|🎵|👾)?\s*(photo|foto|video|vídeo|gif|sticker|audio|voice message|mensaje de voz)$/i.test(t)) return true;
  if (/^(reacted|reaccionó|reaccion[oó]) /i.test(t)) return true;
  if (/^(this message was deleted|se eliminó este mensaje|eliminaste este mensaje)$/i.test(t)) return true;
  return false;
}

export async function saveWaSettings(env, s) {
  await env.DB.put("wa_settings", JSON.stringify(s));
}

export async function handleWhatsAppBatch(items, env) {
  const s = await getWaSettings(env);
  if (!s.on) return;

  // Drop noise and duplicates. Android often re-posts the same notification,
  // so remember recent messages and never judge or forward one twice.
  const recent = (await env.DB.get("wa_recent", "json")) || [];
  const seen = new Set(recent);
  const fresh = [];
  for (const n of items) {
    const key = `${n.title}|${n.text}`;
    if (seen.has(key) || isNoise(n)) continue;
    seen.add(key);
    fresh.push({ ...n, key });
  }
  if (!fresh.length) return;
  await env.DB.put("wa_recent", JSON.stringify([...recent, ...fresh.map((m) => m.key)].slice(-60)), {
    expirationTtl: 60 * 60 * 6,
  });

  const forward = []; // { title, text, reason }
  const toJudge = [];
  for (const m of fresh) {
    const lowerTitle = m.title.toLowerCase();
    const lowerText = m.text.toLowerCase();
    const word = s.words.find((w) =>
      new RegExp(`(^|[^\\p{L}])${escapeRegex(w.toLowerCase())}($|[^\\p{L}])`, "u").test(lowerText)
    );
    const vip = s.vips.find((v) => lowerTitle.includes(v.toLowerCase()));
    if (word) forward.push({ ...m, reason: `🔑 "${word}"` });
    else if (vip) forward.push({ ...m, reason: `⭐ ${vip}` });
    else toJudge.push(m);
  }

  if (s.smart && toJudge.length) {
    const verdicts = await judgeBatch(env, toJudge);
    toJudge.forEach((m, i) => {
      if (verdicts[i]) forward.push({ ...m, reason: `🤖 ${verdicts[i]}` });
    });
  }
  console.log(`whatsapp batch: ${items.length} in, ${fresh.length} judged, ${forward.length} forwarded`,
    forward.map((f) => f.reason));
  if (!forward.length) return;

  if (forward.length === 1) {
    const f = forward[0];
    return send(env, `💬 WhatsApp · ${f.title || "(unknown)"}\n${f.text}\n\n${f.reason}`);
  }
  const lines = forward.map((f) => `▪️ ${f.title || "(unknown)"}\n${f.text}\n${f.reason}`);
  return send(env, `💬 ${forward.length} important WhatsApp messages:\n\n${lines.join("\n\n")}`);
}

// One Gemini call for the whole batch. Returns, per message, a short reason if
// it's important, or "" if not. If Gemini is down, returns all "" (keywords
// still work, so the most obvious important messages are never lost).
export async function judgeBatch(env, messages) {
  const todos = await getTodos(env);
  const events = (await eventsForDay(env, todayISO())) || [];
  const important = events.filter((e) => e.tag === "PERSONAL").map(formatEvent);
  const list = messages.map((m, i) => `[${i}] chat/sender: ${m.title}\n    message: ${m.text}`).join("\n");

  const prompt = `You filter WhatsApp notifications for Alex, an 11th-grade student who reads WhatsApp anyway
but doesn't want to MISS anything important. Judge each message by WHAT IT SAYS, not who sent it.

IMPORTANT (forward it):
- something Alex must do, answer or decide soon; a direct question that needs a reply today
- changes to plans, times or places (cancelled, moved, "where are you?", "we're leaving at...")
- school: exams, homework, deadlines, grades, teacher announcements, group-project work
- TKS, meetings, calls, opportunities with a deadline
- family needs, health, safety, money, transport/pickup
- anything urgent, even if casual in tone
NOT IMPORTANT: chit-chat, jokes, memes, greetings, opinions, reactions, forwarded chains, group banter,
news links without a request, "good night", plans far in the future with nothing to do now.
When genuinely unsure and it involves school, family, plans or a direct request, lean important.

Context. Today is ${todayLong()}.
Alex's important events today: ${important.join("; ") || "none"}
Alex's to-dos: ${todos.map((t) => t.task).join("; ") || "none"}

Messages:
${list}

Return a JSON array with one object per message, in order:
[{"i": 0, "important": true or false, "why": "max 8 words, in the message's language"}]`;

  try {
    const raw = await gemini(env, [{ role: "user", parts: [{ text: prompt }] }], {
      json: true,
      models: MODELS_LIGHT, // runs many times a day: never touch the small smart-model quota
    });
    const verdicts = parseJsonList(raw);
    return messages.map((_, i) => {
      const v = verdicts.find((x) => x && x.i === i) || verdicts[i];
      return v && v.important ? v.why || "looks important" : "";
    });
  } catch (err) {
    console.error("judgeBatch failed:", err.message);
    return messages.map(() => "");
  }
}

export function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function onWaCommand(env, cmd, arg) {
  const s = await getWaSettings(env);
  const [action, ...restWords] = arg.split(/\s+/);
  const value = restWords.join(" ").trim();
  const act = (action || "").toLowerCase();

  if (cmd === "/vip" || cmd === "/words") {
    const listName = cmd === "/vip" ? "vips" : "words";
    const label = cmd === "/vip" ? "VIP contacts" : "Keywords";
    if (act === "add" && value) {
      if (!s[listName].some((x) => x.toLowerCase() === value.toLowerCase())) s[listName].push(value);
      await saveWaSettings(env, s);
    } else if ((act === "remove" || act === "delete") && value) {
      s[listName] = s[listName].filter((x) => x.toLowerCase() !== value.toLowerCase());
      await saveWaSettings(env, s);
    } else if (act) {
      return send(env, `Use: ${cmd} add <name>, ${cmd} remove <name>, or just ${cmd} to see the list.`);
    }
    const list = s[listName].length ? s[listName].map((x) => `• ${x}`).join("\n") : "(none yet)";
    return send(env, `${label}:\n${list}`);
  }

  if (cmd === "/smart") {
    if (act === "on" || act === "off") {
      s.smart = act === "on";
      await saveWaSettings(env, s);
    }
    return send(
      env,
      `🤖 Smart WhatsApp filter is ${s.smart ? "ON" : "OFF"}.\n` +
        (s.smart
          ? "Gemini reads each message and forwards the important ones. (Those messages are sent to Google.) /smart off for keywords only."
          : "Only keyword matches (and VIPs) are forwarded; nothing is sent to Google. /smart on to let Gemini judge every message.")
    );
  }

  // /wa on | off | (status)
  if (act === "on" || act === "off") {
    s.on = act === "on";
    await saveWaSettings(env, s);
  }
  return send(
    env,
    `💬 WhatsApp alerts: ${s.on ? "ON" : "PAUSED"}\n` +
      `🤖 Smart filter (Gemini judges each message): ${s.smart ? "ON" : "OFF"}\n` +
      `🔑 Keywords (always forwarded): ${s.words.join(", ")}\n` +
      `⭐ VIPs (optional, everything from them): ${s.vips.join(", ") || "(none)"}\n\n` +
      `/wa off to pause · /words add física · /smart off · /vip add Mamá`
  );
}
