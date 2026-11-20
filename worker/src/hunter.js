// ---------- Hunter.io: find and verify mentors' email addresses ----------
// Free plan: a small monthly pool (one shared credit pool: a search costs 1 credit, a verification 0.5),
// so every call checks what's left first, and the cost Hunter reports (X-Credits-Used) is subtracted.
// Secret: HUNTER_API_KEY (npx.cmd wrangler secret put HUNTER_API_KEY). Docs: hunter.io/api-documentation/v2

const API = "https://api.hunter.io/v2";
const WEBMAIL = /@(gmail|googlemail|hotmail|outlook|live|yahoo|icloud|me|aol|proton(mail)?)\./i;

export const hunterReady = (env) => !!env.HUNTER_API_KEY;

export class HunterError extends Error {
  constructor(message, { status, code } = {}) { super(message); this.status = status; this.code = code; }
}

async function hunter(env, path, params = {}) {
  if (!hunterReady(env)) throw new HunterError("Hunter isn't connected (HUNTER_API_KEY)");
  const q = new URLSearchParams({ ...params, api_key: env.HUNTER_API_KEY });
  const res = await fetch(`${API}/${path}?${q}`, { signal: AbortSignal.timeout(30000) });
  const body = await res.json().catch(() => ({}));
  const used = Number(res.headers.get("X-Credits-Used"));
  if (used > 0) await spend(env, used, res.headers.get("X-Credits-Unit") || "credit");
  if (!res.ok && res.status !== 202) {
    const e = (Array.isArray(body.errors) ? body.errors[0] : body.errors) || {};
    throw new HunterError(e.details || `Hunter answered ${res.status}`, { status: res.status, code: e.id || e.code });
  }
  return { data: body.data || {}, status: res.status };
}

// What's left this period: { credits (shared pool) | searches + verifications, reset }. The account call
// is free; cached 10 minutes and lowered by each request's reported cost in between.
export async function hunterCredits(env, { fresh = false } = {}) {
  if (!hunterReady(env)) return null;
  const cached = await env.DB.get("hunter_credits", "json");
  if (!fresh && cached && Date.now() - cached.at < 600000) return cached;
  const r = await hunter(env, "account").catch(() => null);
  if (!r) return cached || null;
  const q = r.data.requests || {};
  const left = (x) => (!x ? null : typeof x.remaining === "number" ? x.remaining : typeof x.available === "number" ? Math.max(0, x.available - (x.used || 0)) : null);
  const out = { pool: !!q.credits, credits: left(q.credits), searches: left(q.searches), verifications: left(q.verifications), reset: r.data.reset_date || "", at: Date.now() };
  await env.DB.put("hunter_credits", JSON.stringify(out), { expirationTtl: 3600 });
  return out;
}
async function spend(env, amount, unit) {
  const c = await env.DB.get("hunter_credits", "json");
  if (!c) return;
  if (c.pool || unit === "credit") {
    if (typeof c.credits === "number") c.credits = Math.max(0, c.credits - amount);
    c.searches = typeof c.credits === "number" ? Math.floor(c.credits) : c.searches;
    c.verifications = typeof c.credits === "number" ? Math.floor(c.credits * 2) : c.verifications;
  } else if (typeof c[unit === "search" ? "searches" : "verifications"] === "number") {
    c[unit === "search" ? "searches" : "verifications"] = Math.max(0, c[unit === "search" ? "searches" : "verifications"] - amount);
  }
  await env.DB.put("hunter_credits", JSON.stringify(c), { expirationTtl: 3600 });
}
// Enough left for one search (1 credit) / one verification (0.5)?
export async function canUse(env, kind) {
  const c = await hunterCredits(env);
  if (!c) return hunterReady(env); // unknown: try anyway (Hunter refuses when it's empty)
  if (c.pool && typeof c.credits === "number") return c.credits >= (kind === "searches" ? 1 : 0.5);
  const n = c[kind];
  return n === null || n === undefined || n > 0;
}

const handleOf = (url) => (String(url || "").match(/linkedin\.com\/in\/([^/?#\s]+)/i) || [])[1] || "";

// The person's work email: { email, score, status, provenance } | null (not found: costs nothing)
// | { claimed: true } (they asked Hunter to stop processing their data: never store or use it).
export async function findEmail(env, { name, org, domain, linkedin }) {
  const clean = String(name || "").replace(/^(dr|prof|mr|ms|mrs)\.?\s+/i, "").replace(/\s+(md|phd)\.?$/i, "").trim();
  const parts = clean.split(/\s+/).filter(Boolean);
  const handle = handleOf(linkedin);
  if (!(org || domain || handle) || (!parts.length && !handle)) return null;
  const params = { max_duration: "15" };
  if (domain) params.domain = domain; else if (org) params.company = org;
  if (handle) params.linkedin_handle = handle;
  if (parts.length >= 2) { params.first_name = parts[0]; params.last_name = parts[parts.length - 1]; } else if (parts.length) params.full_name = clean;
  try {
    const { data } = await hunter(env, "email-finder", params);
    if (!data.email) return null;
    return { email: data.email, score: data.score || 0, status: data.verification?.status || "", provenance: data.provenance || "" };
  } catch (err) {
    if (err.status === 451 || err.code === "claimed_email") return { claimed: true };
    throw err;
  }
}

// Is this address real? → { quality: "verified" | "unverified" | "wrong" | null (keep as is), status, pending }.
export async function verifyEmail(env, email) {
  if (WEBMAIL.test(email)) return { quality: null, status: "webmail", skipped: true }; // Gmail etc.: Hunter can't check it; don't spend credits
  try {
    const { data, status } = await hunter(env, "email-verifier", { email });
    if (status === 202) return { quality: null, status: "pending", pending: true }; // still checking: asking again later is free
    const s = data.status || "unknown";
    const quality = s === "valid" ? "verified" : s === "invalid" || s === "disposable" ? "wrong" : s === "webmail" ? null : "unverified";
    return { quality, status: s, score: data.score ?? null };
  } catch (err) {
    if (err.status === 451 || err.code === "claimed_email") return { quality: "wrong", status: "claimed", claimed: true };
    throw err;
  }
}
