import { apCheckin } from "./ap.js";
import { runOutreach } from "./outreach.js";
import { runCalls } from "./realism.js";
import { logListens } from "./listening.js";
import { AP_CHECKIN_HOUR, AP_CHECKIN_MINUTE, DUE_ALERT_HOUR, HABIT_HOUR, HABIT_MINUTE, JOURNAL_HOUR, JOURNAL_MINUTE, KOREAN_WEEKDAY, KOREAN_WEEKEND, MONTHLY_HOUR, MUSIC_HOUR, REMIND_MINUTES, REVIEW_HOUR } from "./config.js";
import { addDaysISO, localHour, localMinute, localWeekday, todayISO } from "./dates.js";
import { habitCheckin } from "./habits.js";
import { recordGithubToken, runHealthAlerts } from "./health.js";
import { sendJournalQuestion } from "./journal.js";
import { writeChatDiary } from "./memory.js";
import { runCheckins } from "./checkins.js";
import { runSlack } from "./slack.js";
import { runVelocity } from "./velocity.js";
import { READING_HOUR, READING_MINUTE } from "./reading.js";
import { runWorkout } from "./workout.js";
import { SPACE_BLOCK } from "./space.js";
import { send } from "./telegram.js";
import { formatTodos, getTodos } from "./todos.js";

// ---------- Reminders ----------

// GitHub's own schedule can run hours late, so Cloudflare's (reliable) timer
// starts the GitHub jobs instead. "workflow_dispatch" starts them within ~a minute.
// The GitHub job takes ~2 minutes, so it's started a little early.
export function briefTime(weekday) {
  return ["Sat", "Sun"].includes(weekday) ? { hour: 7, minute: 55 } : { hour: 6, minute: 5 };
}
export const SYNC_FIRST_HOUR = 5;
export const SYNC_LAST_HOUR = 22;
export const BACKUP_HOUR = 4; // weekly backup: Sundays 4:00

export async function startGithubJob(env, workflow, inputs) {
  if (!env.GITHUB_TOKEN) throw new Error("GITHUB_TOKEN is not set on the bot");
  const res = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/${workflow}/dispatches`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "haneul",
    },
    body: JSON.stringify(inputs ? { ref: "main", inputs } : { ref: "main" }),
  });
  await recordGithubToken(env, res); // remembers when the token expires, for /status
  if (res.status !== 204) throw new Error(`GitHub said ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

export async function runGithubJobs(env) {
  const today = todayISO();
  const hour = localHour();
  const minute = localMinute();

  // Morning brief, once a day: 6:10 on weekdays (bus), 8:00 on weekends.
  const brief = briefTime(localWeekday());
  // A window instead of an exact minute: the timer runs every 5 minutes, so "7:58" alone never matched (no Sunday brief).
  const nowMin = hour * 60 + minute;
  const briefMin = brief.hour * 60 + brief.minute;
  if (nowMin >= briefMin && nowMin < briefMin + 60 && (await env.DB.get("brief_started")) !== today) {
    await env.DB.put("brief_started", today);
    try {
      await startGithubJob(env, "morning-brief.yml");
    } catch (err) {
      await send(env, `⚠️ Couldn't start your morning brief: ${err.message}\nIf the GitHub token expired, make a new one.`);
    }
  }

  // Sunday review, once a week.
  if (localWeekday() === "Sun" && hour === REVIEW_HOUR && (await env.DB.get("review_started")) !== today) {
    await env.DB.put("review_started", today);
    await startGithubJob(env, "weekly-review.yml").catch((err) =>
      send(env, `⚠️ Couldn't start your Sunday review: ${err.message}`)
    );
  }

  // Weekly backup to the repo's "backups" branch, Sundays at BACKUP_HOUR.
  if (localWeekday() === "Sun" && hour === BACKUP_HOUR && (await env.DB.get("backup_started")) !== today) {
    await env.DB.put("backup_started", today);
    await startGithubJob(env, "backup.yml").catch((err) => send(env, `⚠️ Couldn't start the weekly backup: ${err.message}`));
  }

  // Monthly TKS update draft: last day of the month at MONTHLY_HOUR.
  const lastDayOfMonth = addDaysISO(today, 1).slice(8, 10) === "01";
  if (lastDayOfMonth && hour === MONTHLY_HOUR && (await env.DB.get("monthly_started")) !== today) {
    await env.DB.put("monthly_started", today);
    await startGithubJob(env, "monthly-update.yml").catch((err) =>
      send(env, `⚠️ Couldn't start your monthly update draft: ${err.message}`)
    );
  }

  // Calendar sync, once an hour (first run of each hour), 5:00-22:59.
  if (hour >= SYNC_FIRST_HOUR && hour <= SYNC_LAST_HOUR) {
    const slot = `${today}T${hour}`;
    if ((await env.DB.get("sync_started")) !== slot) {
      await env.DB.put("sync_started", slot);
      await startGithubJob(env, "sync-schedule.yml").catch((err) => console.error("sync start failed:", err.message));
    }
  }
}

export async function runReminders(env) {
  const now = Date.now();
  await runGithubJobs(env).catch((err) => console.error("github jobs:", err.message));
  await runHealthAlerts(env).catch((err) => console.error("health check:", err.message));

  // 1. Event reminders: important (PERSONAL) events starting in the next REMIND_MINUTES.
  const schedule = await env.DB.get("schedule", "json");
  if (schedule) {
    const reminded = (await env.DB.get("reminded", "json")) || {};
    const soon = schedule.events.filter((e) => {
      if (e.all_day || e.tag !== "PERSONAL") return false;
      const minutes = (Date.parse(e.start) - now) / 60000;
      return minutes > 0 && minutes <= REMIND_MINUTES && !reminded[`${e.uid}|${e.start}`];
    });
    for (const e of soon) {
      const minutes = Math.max(1, Math.round((Date.parse(e.start) - now) / 60000));
      const where = e.location ? `\n📍 ${e.location}` : "";
      await send(env, `⏰ In ${minutes} min (${e.start.slice(11, 16)}): ${e.title}${where}`);
      reminded[`${e.uid}|${e.start}`] = now;
    }
    if (soon.length) {
      // forget reminders older than 2 days so this list stays small
      for (const [key, at] of Object.entries(reminded)) if (now - at > 2 * 86400000) delete reminded[key];
      await env.DB.put("reminded", JSON.stringify(reminded));
    }
  }

  // 1b. Space-tech article in the MORNING (he has no time to read in the afternoon): on the bus on school
  // days (6:10, before the 6:30 question of the day), 9:30 on weekends (between the question and the SAT).
  if ((await env.DB.get("space_date")) !== todayISO()) {
    const nowMin = localHour() * 60 + localMinute();
    const weekend = ["Sat", "Sun"].includes(localWeekday());
    const at = weekend ? 9 * 60 + 30 : 6 * 60 + 10;
    const due = nowMin >= at && nowMin < at + 60;
    if (due) {
      await env.DB.put("space_date", todayISO());
      await env.BG_JOBS.send({ kind: "space" });
    }
  }

  // 2. AP Physics check-in at AP_CHECKIN_HOUR:AP_CHECKIN_MINUTE, once a day (only once the plan has been started with /ap).
  if (localHour() === AP_CHECKIN_HOUR && localMinute() >= AP_CHECKIN_MINUTE) {
    const today = todayISO();
    if ((await env.DB.get("ap_checkin_date")) !== today && (await env.DB.get("ap")) && !(await env.DB.get("course"))) {
      await env.DB.put("ap_checkin_date", today);
      await apCheckin(env);
    }
  }

  // 2b. Habit check-in, journal question and Korean lesson, once a day each.
  const today = todayISO();
  const hm = localHour() * 60 + localMinute();
  const once = async (key, fn) => {
    if ((await env.DB.get(key)) === today) return;
    await env.DB.put(key, today);
    await fn();
  };
  if (hm >= HABIT_HOUR * 60 + HABIT_MINUTE && hm < HABIT_HOUR * 60 + HABIT_MINUTE + 30) {
    await once("habit_checkin_date", () => habitCheckin(env));
  }
  if (hm >= JOURNAL_HOUR * 60 + JOURNAL_MINUTE && hm < JOURNAL_HOUR * 60 + JOURNAL_MINUTE + 30) {
    await once("journal_date", () => sendJournalQuestion(env));
  }
  const weekend = ["Sat", "Sun"].includes(localWeekday());
  const kt = weekend ? KOREAN_WEEKEND : KOREAN_WEEKDAY;
  if (hm >= kt.hour * 60 + kt.minute && hm < kt.hour * 60 + kt.minute + 30) {
    const k = await env.DB.get("korean", "json");
    // Daily lessons are opt-in now (Korean happens inside the chat); /korean daily on turns them back on.
    if (k?.daily === true) await once("korean_date", () => env.BG_JOBS.send({ kind: "korean" })); // slow: background queue
  }

  // Workout (plan at 6:00, reminder 5 min before), random check-ins, reading nudge at 19:30.
  await runWorkout(env).catch((err) => console.error("workout:", err.message));
  await runCheckins(env).catch((err) => console.error("checkins:", err.message));
  await runSlack(env).catch((err) => console.error("slack:", err.message));
  await runVelocity(env).catch((err) => console.error("velocity:", err.message));
  await logListens(env).catch((err) => console.error("listens:", err.message));
  await runCalls(env).catch((err) => console.error("calls:", err.message));
  // Sundays at 18:00: the weekly music recap
  if (localWeekday() === "Sun" && localHour() === 18 && (await env.DB.get("wrapped_date")) !== todayISO()) {
    await env.DB.put("wrapped_date", todayISO());
    await env.BG_JOBS.send({ kind: "wrapped" });
  }
  await runOutreach(env).catch((err) => console.error("outreach:", err.message));
  // Question of the day (6:30 on the bus; weekends 9:00) and the daily SAT question (15:15 bus home; weekends 10:00)
  {
    const wkend = ["Sat", "Sun"].includes(localWeekday());
    const qAt = wkend ? 9 * 60 : 6 * 60 + 30, sAt = wkend ? 10 * 60 : 15 * 60 + 15;
    if (hm >= qAt && hm < qAt + 30) await once("qotd_date", () => env.BG_JOBS.send({ kind: "qotd" }));
    if (hm >= sAt && hm < sAt + 30) await once("sat_date", () => env.BG_JOBS.send({ kind: "sat" }));
  }
  // LinkedIn + X drafts (school days 15:45, weekends 12:00) and the weekly article idea (Sundays 15:00)
  {
    const sAt = ["Sat", "Sun"].includes(localWeekday()) ? 12 * 60 : 15 * 60 + 45;
    if (hm >= sAt && hm < sAt + 30) await once("social_date", () => env.BG_JOBS.send({ kind: "social" }));
    if (localWeekday() === "Sun" && hm >= 15 * 60 && hm < 15 * 60 + 30) await once("weekly_article_date", () => env.BG_JOBS.send({ kind: "weekly_article" }));
  }
  // AP Physics course (Semester A plan): today's work at the start of homework time, a check-in later
  {
    const wkend = ["Sat", "Sun"].includes(localWeekday());
    const startAt = wkend ? 11 * 60 : 16 * 60 + 15, checkAt = wkend ? 17 * 60 : 19 * 60;
    if (hm >= startAt && hm < startAt + 30) await once("course_start_date", () => env.BG_JOBS.send({ kind: "course", step: "start" }));
    if (hm >= checkAt && hm < checkAt + 30) await once("course_check_date", () => env.BG_JOBS.send({ kind: "course", step: "check" }));
  }
  // 20:00 every day: Bible reading (his church's sheet)
  if (hm >= 20 * 60 && hm < 20 * 60 + 30) await once("bible_date", () => env.BG_JOBS.send({ kind: "bible" }));
  // Sundays 19:00: phone-focus weekly report
  if (localWeekday() === "Sun" && hm >= 19 * 60 && hm < 19 * 60 + 30) await once("phone_week_date", () => env.BG_JOBS.send({ kind: "phone_weekly" }));
  // his Substack / Medium: new posts go to his work list (and Haneul congratulates him), every 3 hours
  const feedSlot = `${todayISO()}-${Math.floor(localHour() / 3)}`;
  if ((await env.DB.get("work_feed_slot")) !== feedSlot) {
    await env.DB.put("work_feed_slot", feedSlot, { expirationTtl: 86400 });
    await env.BG_JOBS.send({ kind: "work_feeds" });
  }
  if (hm >= READING_HOUR * 60 + READING_MINUTE && hm < READING_HOUR * 60 + READING_MINUTE + 30) {
    await once("reading_date", () => env.BG_JOBS.send({ kind: "reading" }));
  }

  // Notion: hourly two-way memory sync (+ a one-time copy of older data), in the background queue.
  if (localMinute() >= 20) {
    const slot = `${todayISO()}T${localHour()}`;
    if ((await env.DB.get("notion_sync_slot")) !== slot) {
      await env.DB.put("notion_sync_slot", slot);
      await env.BG_JOBS.send({ kind: "notion_sync" });
    }
  }

  // Chat diary: at 23:30, Haneul summarizes today's chats so she remembers them later.
  if (hm >= 23 * 60 + 30) await once("diary_date", () => writeChatDiary(env).catch((err) => console.error("diary:", err.message)));

  // 3. Weekly music on Friday at MUSIC_HOUR (only if Spotify is connected).
  if (localWeekday() === "Fri" && localHour() === MUSIC_HOUR) {
    const today = todayISO();
    if ((await env.DB.get("music_date")) !== today && (await env.DB.get("spotify"))) {
      await env.DB.put("music_date", today);
      await env.BG_JOBS.send({ kind: "music" }); // slow job: run it in the background queue
    }
  }

  // 4. Evening heads-up: to-dos due tomorrow (and anything overdue), once a day.
  if (localHour() === DUE_ALERT_HOUR) {
    const today = todayISO();
    if ((await env.DB.get("due_alert_date")) !== today) {
      await env.DB.put("due_alert_date", today);
      const tomorrow = addDaysISO(today, 1);
      const due = (await getTodos(env)).filter((t) => t.due && t.due <= tomorrow);
      if (due.length) {
        await send(env, `🌙 Heads-up for tomorrow:\n\n${formatTodos(due)}\n\nSend "done <number>" for anything already finished.`);
      }
    }
  }
}
