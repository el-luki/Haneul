// ---------- Backups ----------
// GET /backup returns everything worth keeping from KV; GET /backup-table returns the app
// database (D1) page by page. The weekly GitHub job (backup.yml) saves both to the "backups"
// branch of the private repo. Restore with `node scripts/restore.js <backup file>` (see README).
//
// Never included: login tokens and passwords (Spotify), push-notification subscriptions,
// the audio of voice notes (too big for weekly copies; their text is kept), and short-lived
// state (waiting photos, quiz answers, "already sent today" markers…).

export const BACKUP_KEYS = [
  "todos", "done_log", "notes", "journal", "habits", "memory", "ap", "korean",
  "tks_drafts", "wa_settings", "classroom_seen", "classroom_dismissed",
  "music_history", "space_history", "reminded", "chat_diary",
  // added with the app (2026-11-10)
  "chat", "chat_lang", "workout", "reading", "velocity_info", "velocity_seen",
  "app_voice", "app_mode", "app_calls", "notion", "listens_after", "calls_scheduled",
  "work", "work_feeds", "bible", "outreach_profile", "course", "sat", "qotd", "social",
];

// D1 tables and the columns that are backed up (no audio blobs).
export const BACKUP_TABLES = {
  feed: ["id", "at", "who", "text", "buttons", "mid", "src", "reply_mid", "image", "audio_mime", "react_me", "react_her", "updated"],
  listens: ["id", "at", "track", "artist", "album", "track_id", "ms"],
  outreach: ["id", "data", "updated"],
  outreach_drafts: ["id", "contact_id", "kind", "to_addr", "subject", "body", "status", "send_at", "sent_at", "thread_id", "error", "created"],
  outreach_updates: ["id", "at", "kind", "org", "title", "url", "source", "seen"],
};
export const TABLE_PAGE = 400; // small pages keep each request under the free 10 ms CPU limit

export async function exportData(env) {
  const data = {};
  const raw = []; // keys stored as plain text (e.g. chat_lang = "es"), restored without JSON quotes
  for (const key of BACKUP_KEYS) {
    const value = await env.DB.get(key);
    if (value === null) continue;
    try {
      data[key] = JSON.parse(value);
    } catch {
      data[key] = value;
      raw.push(key);
    }
  }
  return { exported_at: new Date().toISOString(), keys: Object.keys(data).length, data, raw, tables: Object.keys(BACKUP_TABLES) };
}

// One page of a D1 table: rows with id > after, oldest first. next = the id to continue from (or null).
export async function exportTable(env, table, after = 0) {
  const cols = BACKUP_TABLES[table];
  if (!cols) return { error: "unknown table" };
  if (!env.FEED) return { rows: [], next: null };
  // paged by SQLite's rowid (works for number and text ids alike)
  const found = (await env.FEED.prepare(`SELECT rowid AS _r, ${cols.join(", ")} FROM ${table} WHERE rowid > ? ORDER BY rowid ASC LIMIT ?`).bind(after, TABLE_PAGE).all()).results || [];
  const last = found[found.length - 1];
  const rows = found.map(({ _r, ...r }) => r);
  return { table, columns: cols, rows, next: found.length === TABLE_PAGE ? last._r ?? last.id : null };
}
