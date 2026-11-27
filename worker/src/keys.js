// ---------- Keys: who may call which routes ----------
// Each caller has its own key, so the one typed into the phone can't open backups or start jobs:
//   phone (MacroDroid: /phone, /slack, /whatsapp) → KV "phone_key"
//   Telegram webhook (/telegram)                  → KV "tg_secret" (Haneul registers it with Telegram herself)
//   GitHub jobs (everything else)                 → the WORKER_SECRET secret
//   desk face module (/device/*)                  → KV "device_key" (device.js)
// While moving over, the old WORKER_SECRET still works for the phone and Telegram routes, until
// KV "legacy_keys" is set to "off".

async function legacyOk(env) {
  return (await env.DB.get("legacy_keys")) !== "off";
}

export async function phoneKeyOk(env, given) {
  if (!given) return false;
  const k = await env.DB.get("phone_key");
  if (k && given === k) return true;
  return (await legacyOk(env)) && !!env.WORKER_SECRET && given === env.WORKER_SECRET;
}

export async function telegramSecretOk(env, given) {
  if (!given) return false;
  const k = await env.DB.get("tg_secret");
  if (k && given === k) return true;
  return (await legacyOk(env)) && !!env.WORKER_SECRET && given === env.WORKER_SECRET;
}

// Telegram must send the new secret with every update: when KV "tg_secret" changes, re-register the
// webhook (same address, same settings) with it. Runs from the 5-minute timer; a no-op once done.
export async function ensureTelegramWebhook(env) {
  const secret = await env.DB.get("tg_secret");
  if (!secret || !env.TELEGRAM_BOT_TOKEN) return "no secret";
  const mark = secret.slice(0, 6) + secret.length;
  if ((await env.DB.get("tg_secret_registered")) === mark) return "already";
  const api = (m, body) => fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${m}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}),
  }).then((r) => r.json());
  const info = (await api("getWebhookInfo"))?.result || {};
  const url = info.url || `${env.PUBLIC_URL}/telegram`;
  const r = await api("setWebhook", { url, secret_token: secret, ...(info.allowed_updates ? { allowed_updates: info.allowed_updates } : {}), ...(info.max_connections ? { max_connections: info.max_connections } : {}) });
  if (!r?.ok) throw new Error(`setWebhook: ${r?.description || "failed"}`);
  await env.DB.put("tg_secret_registered", mark);
  return "registered";
}
