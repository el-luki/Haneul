import { todayISO, addDaysISO } from "./dates.js";

// ---------- Build in public: his GitHub account → progress notes ----------
// Every few hours (with the Substack feed check) Haneul reads the PUBLIC activity of his whole GitHub
// account, so a new project is picked up without changing anything here:
//   pushes  → the commit messages and the files that changed (one note per push)
//   new repo → "started a new project" (also added to his work list, and she congratulates him)
//   made public / releases → a note each
// The notes feed the Thursday newsletter draft ("this week's progress"), her chat, and the week review.
// KV "github_progress": { seen: [event ids], notes: [{ id, date, repo, kind, text, url }], started }
// Account: GITHUB_USER, or the owner of GITHUB_REPO.

const MAX_COMPARES = 6; // each push needs one extra request for its commits (subrequest budget)

export function ghOwner(env) {
  return String(env.GITHUB_USER || String(env.GITHUB_REPO || "").split("/")[0] || "").trim();
}

async function gh(path) {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: { "User-Agent": "haneul-bot", Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`GitHub ${res.status} on ${path.split("?")[0]}`);
  return res.json();
}

const shortRepo = (full) => String(full || "").split("/").pop().replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
const firstLine = (m) => String(m || "").split("\n")[0].trim();
// "Merge branch …", "wip", "." say nothing about the work
export const noisy = (m) => /^(merge (branch|pull request)|wip\b|update readme\.md$|initial commit$|\.+$|fix$|update$)/i.test(firstLine(m)) || firstLine(m).length < 3;

// One push (with its compare result) → a readable note.
export function pushNote(repo, compare) {
  const msgs = (compare?.commits || []).map((c) => firstLine(c.commit?.message)).filter((m) => !noisy(m));
  const files = (compare?.files || []).slice().sort((a, b) => (b.additions || 0) - (a.additions || 0)).slice(0, 4).map((f) => f.filename);
  if (!msgs.length && !files.length) return "";
  const n = compare?.total_commits || msgs.length;
  return `${shortRepo(repo)}: ${n} commit${n === 1 ? "" : "s"}${msgs.length ? ` (${msgs.slice(0, 5).join("; ")})` : ""}${files.length ? `. Files: ${files.join(", ")}` : ""}`.slice(0, 600);
}

export async function getProgress(env) {
  return (await env.DB.get("github_progress", "json")) || { seen: [], notes: [], started: false };
}

export async function checkGithub(env, haneulSays) {
  const owner = ghOwner(env);
  if (!owner) return { skipped: "no account" };
  const st = await getProgress(env);
  const first = !st.started;
  const events = await gh(`/users/${owner}/events/public?per_page=40`);
  const fresh = [];
  let compares = 0;
  const { addWork } = await import("./work.js");
  for (const e of events.slice().reverse()) {
    if (st.seen.includes(e.id)) continue;
    const date = new Date(Date.parse(e.created_at) - 5 * 3600000).toISOString().slice(0, 10); // Lima date
    if (first && date < addDaysISO(todayISO(), -21)) { st.seen.push(e.id); continue; } // first run: last 3 weeks
    const repo = e.repo?.name || "";
    const url = `https://github.com/${repo}`;
    let note = null;
    if (e.type === "PushEvent") {
      if (compares >= MAX_COMPARES) break; // the rest next time (not marked seen)
      compares++;
      const c = e.payload?.before && e.payload?.head ? await gh(`/repos/${repo}/compare/${e.payload.before}...${e.payload.head}`).catch(() => null) : null;
      const text = pushNote(repo, c);
      if (text) note = { kind: "push", text, url: c?.html_url || url };
    } else if (e.type === "CreateEvent" && e.payload?.ref_type === "repository") {
      note = { kind: "new", text: `Started a new project: ${shortRepo(repo)}${e.payload.description ? ` (${String(e.payload.description).slice(0, 160)})` : ""}`, url };
      if (!first) await addWork(env, [{ title: shortRepo(repo), url, note: e.payload.description || "", kind: "project", status: "started" }], "github").catch(() => {});
    } else if (e.type === "PublicEvent") {
      note = { kind: "public", text: `Made ${shortRepo(repo)} public`, url };
    } else if (e.type === "ReleaseEvent" && e.payload?.action === "published") {
      note = { kind: "release", text: `Released ${shortRepo(repo)} ${e.payload.release?.tag_name || ""}`.trim(), url: e.payload.release?.html_url || url };
    }
    st.seen.push(e.id);
    if (note) {
      const n = { id: e.id, date, repo, ...note };
      st.notes.push(n);
      if (!first) fresh.push(n);
    }
  }
  st.seen = st.seen.slice(-300);
  st.notes = st.notes.slice(-150);
  st.started = true;
  st.last = new Date().toISOString();
  await env.DB.put("github_progress", JSON.stringify(st));
  const started = fresh.filter((n) => n.kind === "new" || n.kind === "release" || n.kind === "public");
  if (started.length && haneulSays) {
    await haneulSays(env, `You noticed on Alex's GitHub: ${started.map((n) => n.text).join("; ")}.
React like a proud friend in 1-2 short texts (ask one question about it). Don't paste links.`).catch(() => {});
  }
  return { added: fresh.length, compares };
}

// The last `days` of progress, for prompts (newsletter draft, chat).
export async function progressText(env, days = 10) {
  const st = await getProgress(env);
  const from = addDaysISO(todayISO(), -days);
  const notes = st.notes.filter((n) => n.date >= from);
  return notes.length ? notes.map((n) => `- ${n.date} ${n.text}`).join("\n") : "";
}

export async function progressContext(env) {
  const t = await progressText(env, 7);
  return t ? `GITHUB (his build-in-public progress this week, from his commits):\n${t.split("\n").slice(-6).join("\n")}` : "";
}
