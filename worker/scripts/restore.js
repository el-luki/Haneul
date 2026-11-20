// Put a backup back into the bot's storage (Cloudflare KV).
//
// 1. Get a backup file: on github.com, switch the branch to "backups" and download
//    backups/latest.json (or a dated one).
// 2. From the worker folder:   node scripts/restore.js path/to/latest.json
//    Add --only journal,habits to restore just some parts.
//
// It overwrites those keys with the backup's contents, so it asks before writing.
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { execSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const file = process.argv[2];
if (!file) {
  console.log("Usage: node scripts/restore.js <backup.json> [--only key1,key2]");
  process.exit(1);
}
const onlyArg = process.argv.indexOf("--only");
const only = onlyArg > 0 ? process.argv[onlyArg + 1].split(",") : null;

const backup = JSON.parse(readFileSync(file, "utf8"));
const entries = Object.entries(backup.data).filter(([key]) => !only || only.includes(key));
const tables = Object.keys(backup.db || {}).filter((t) => !only || only.includes(`db:${t}`));
console.log(`Backup from ${backup.exported_at}. Will restore: ${entries.map(([k]) => k).join(", ") || "(no KV keys)"}${tables.length ? ` + app database: ${tables.map((t) => `${t} (${backup.db[t].rows.length} rows)`).join(", ")}` : ""}`);

const rl = createInterface({ input: process.stdin, output: process.stdout });
const answer = await rl.question("This overwrites the bot's current data for those keys. Type 'yes' to continue: ");
rl.close();
if (answer.trim().toLowerCase() !== "yes") {
  console.log("Cancelled, nothing changed.");
  process.exit(0);
}

if (entries.length) {
const bulk = join(tmpdir(), "kv-restore.json");
const raw = new Set(backup.raw || []); // plain-text keys go back without JSON quotes
writeFileSync(bulk, JSON.stringify(entries.map(([key, value]) => ({ key, value: raw.has(key) ? String(value) : JSON.stringify(value) }))));
try {
  execSync(`npx wrangler kv bulk put "${bulk}" --binding DB --remote`, { stdio: "inherit", shell: true });
  console.log("Restored the KV data.");
} finally {
  unlinkSync(bulk);
}
}

// The app database (D1 "haneul": messages, reactions, songs). Rows with the same id are
// replaced; newer rows that aren't in the backup stay. Restore just one with --only db:feed
const sqlValue = (v) => (v === null || v === undefined ? "NULL" : typeof v === "number" ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
for (const [table, { columns, rows }] of Object.entries(backup.db || {})) {
  if (only && !only.includes(`db:${table}`)) continue;
  if (!rows?.length) continue;
  const sqlFile = join(tmpdir(), `d1-restore-${table}.sql`);
  const lines = rows.map((r) => `INSERT OR REPLACE INTO ${table} (${columns.join(", ")}) VALUES (${columns.map((c) => sqlValue(r[c])).join(", ")});`);
  writeFileSync(sqlFile, lines.join("\n"));
  try {
    execSync(`npx wrangler d1 execute haneul --remote --file "${sqlFile}" -y`, { stdio: "inherit", shell: true });
    console.log(`Restored ${rows.length} rows into ${table}.`);
  } finally {
    unlinkSync(sqlFile);
  }
}
