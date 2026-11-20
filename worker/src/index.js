// Claude Administrator - Telegram bot running on a free Cloudflare Worker.
//
// Telegram sends every message to POST /telegram (a "webhook"), so the bot
// answers within seconds. To-dos live in Cloudflare KV (a small free database)
// and the morning brief reads them from GET /todos.
//
// Features:
//   photo of the agenda     -> to-dos with due dates
//   photo(s) of TKS notes   -> Mindset of the Week draft for TKS.life
//   /todos, done 3, add ... -> manage to-dos
//   any other text          -> chat with the assistant (Gemini)

import { apSummary, getAp } from "./ap.js";
import { sendWrapped } from "./listening.js";
import { outreachBrief, outreachNudge, prepOutreach, syncGmailQuietly, weeklySearch } from "./outreach.js";
import { haneulSays } from "./chat.js";
import { notionDraft, notionReady } from "./notion.js";
import { runNotionSync } from "./memory.js";
import { onSlackBatch, slackDigest } from "./slack.js";
import { checkVelocity } from "./velocity.js";
import { readingReminder } from "./reading.js";
import { sendWorkout } from "./workout.js";
import { exportData, exportTable } from "./backup.js";
import { recordHeartbeat } from "./health.js";
import { onClassroomSync } from "./classroom.js";
import { addDaysISO, todayISO } from "./dates.js";
import { getHabits, habitStreak, habitWeek } from "./habits.js";
import { runKoreanLesson } from "./korean.js";
import { monthData } from "./monthly.js";
import { runMusic, spotifyRoutes } from "./music.js";
import { getNotes } from "./notes.js";
import { runReminders } from "./reminders.js";
import { handleUpdate } from "./router.js";
import { runSpaceArticle } from "./space.js";
import { appRoutes, relayVoice } from "./app.js";
import { onVideo } from "./links.js";
import { HiccupError, send } from "./telegram.js";
import { getTodos } from "./todos.js";
import { handleWhatsAppBatch, readNotification } from "./whatsapp.js";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // The GitHub jobs (brief, weekly review, Korean audio…) send their messages through here,
    // so they reach the app's feed and follow the app-only setting like everything else.
    if (url.pathname === "/relay" && request.method === "POST") {
      if (request.headers.get("Authorization") !== `Bearer ${env.WORKER_SECRET}`) return new Response("unauthorized", { status: 401 });
      const body = await request.json().catch(() => ({}));
      if (body.voice) await relayVoice(env, body.voice, body.caption || "");
      else await send(env, String(body.text || "").slice(0, 20000));
      return new Response("ok");
    }

    // The Haneul app (chat + voice calls), see app.js.
    if (url.pathname === "/app" || url.pathname.startsWith("/app/")) return appRoutes(request, env, url);

    // The morning brief (GitHub Actions) reads the to-do list from here.
    if (url.pathname === "/todos" && request.method === "GET") {
      if (request.headers.get("Authorization") !== `Bearer ${env.WORKER_SECRET}`) {
        return new Response("unauthorized", { status: 401 });
      }
      return Response.json(await getTodos(env));
    }

    // MacroDroid on the phone sends every WhatsApp notification here.
    // Accepts query parameters (?title=..&text=..), a form body or a JSON body.
    if (url.pathname === "/whatsapp" && request.method === "POST") {
      const auth = request.headers.get("Authorization") || `Bearer ${url.searchParams.get("key") || ""}`;
      if (auth !== `Bearer ${env.WORKER_SECRET}`) return new Response("unauthorized", { status: 401 });
      const n = await readNotification(request, url);
      if (n.title || n.text) await env.WA_JOBS.send(n);
      return new Response("ok");
    }

    // MacroDroid: a blocked app (social media, games) just opened. "block" = back to the home screen.
    if (url.pathname === "/phone" && (request.method === "GET" || request.method === "POST")) {
      if (url.searchParams.get("key") !== env.WORKER_SECRET) return new Response("unauthorized", { status: 401 });
      const { phoneCheck } = await import("./phone.js");
      if (!(await env.DB.get("phone_setup"))) await env.DB.put("phone_setup", new Date().toISOString());
      const answer = await phoneCheck(env, url.searchParams.get("app"), { say: (task) => env.BG_JOBS.send({ kind: "say", task }) });
      return new Response(answer, { headers: { "Content-Type": "text/plain" } });
    }

    // Weekly backup (GitHub Actions) downloads everything worth keeping from here.
    if (url.pathname === "/backup" && request.method === "GET") {
      if (request.headers.get("Authorization") !== `Bearer ${env.WORKER_SECRET}`) {
        return new Response("unauthorized", { status: 401 });
      }
      return Response.json(await exportData(env));
    }
    // The morning brief (GitHub job) adds the mentor-outreach section from here.
    if (url.pathname === "/outreach-brief" && request.method === "GET") {
      if (request.headers.get("Authorization") !== `Bearer ${env.WORKER_SECRET}`) return new Response("unauthorized", { status: 401 });
      return new Response(await outreachBrief(env).catch(() => ""), { headers: { "Content-Type": "text/plain; charset=utf-8" } });
    }
    // …and the app database (messages, reactions, songs), one page at a time.
    if (url.pathname === "/backup-table" && request.method === "GET") {
      if (request.headers.get("Authorization") !== `Bearer ${env.WORKER_SECRET}`) {
        return new Response("unauthorized", { status: 401 });
      }
      const res = await exportTable(env, url.searchParams.get("table"), Number(url.searchParams.get("after")) || 0);
      return Response.json(res, { status: res.error ? 400 : 200 });
    }

    // GitHub jobs report "done" here, so /status and the health alerts know they ran.
    if (url.pathname === "/heartbeat" && request.method === "POST") {
      if (request.headers.get("Authorization") !== `Bearer ${env.WORKER_SECRET}`) {
        return new Response("unauthorized", { status: 401 });
      }
      const job = url.searchParams.get("job") || "";
      if (!/^[a-z]{2,20}$/.test(job)) return new Response("bad job", { status: 400 });
      await recordHeartbeat(env, job);
      return new Response("ok");
    }

    // MacroDroid forwards every Slack notification here (same password as /whatsapp).
    if (url.pathname === "/slack" && request.method === "POST") {
      const auth = request.headers.get("Authorization") || `Bearer ${url.searchParams.get("key") || ""}`;
      if (auth !== `Bearer ${env.WORKER_SECRET}`) return new Response("unauthorized", { status: 401 });
      const n = await readNotification(request, url);
      if (n.title || n.text) await env.SLACK_JOBS.send({ ...n, at: new Date().toISOString() });
      return new Response("ok");
    }

    // Start a Notion sync right away (used after setup; normally it runs every hour).
    if (url.pathname === "/notion-sync" && request.method === "POST") {
      if (request.headers.get("Authorization") !== `Bearer ${env.WORKER_SECRET}`) {
        return new Response("unauthorized", { status: 401 });
      }
      await env.BG_JOBS.send({ kind: "notion_sync" });
      return new Response("queued");
    }

    // The monthly newsletter draft (GitHub job) is saved as a Notion page; returns its link.
    if (url.pathname === "/notion-draft" && request.method === "POST") {
      if (request.headers.get("Authorization") !== `Bearer ${env.WORKER_SECRET}`) {
        return new Response("unauthorized", { status: 401 });
      }
      const { title, content } = await request.json();
      if (!notionReady(env)) return Response.json({ url: "" });
      return Response.json({ url: await notionDraft(env, String(title || "Newsletter draft"), String(content || "")) });
    }

    // Spotify connection (one-time login in the browser).
    if (url.pathname === "/spotify/login" || url.pathname === "/spotify/callback") return spotifyRoutes(url, env);

    // The Sunday review (GitHub Actions) reads to-dos, AP status and this week's ideas from here.
    if (url.pathname === "/review-data" && request.method === "GET") {
      if (request.headers.get("Authorization") !== `Bearer ${env.WORKER_SECRET}`) {
        return new Response("unauthorized", { status: 401 });
      }
      const weekAgo = addDaysISO(todayISO(), -7);
      const started = await env.DB.get("ap");
      const h = await getHabits(env);
      return Response.json({
        todos: await getTodos(env),
        ap: started ? apSummary(await getAp(env)) : "",
        notes: (await getNotes(env)).filter((n) => n.date > weekAgo),
        journal: ((await env.DB.get("journal", "json")) || []).filter((j) => j.date > weekAgo),
        habits: h.list.map((x) => ({ name: x.name, ...habitWeek(x, h.log), streak: habitStreak(x, h.log) })),
        korean_lessons: ((await env.DB.get("korean", "json")) || {}).lesson || 0,
      });
    }

    // Google Classroom sync from the school-account script. Uses its OWN password
    // (CLASSROOM_SECRET), which can only send assignments, nothing else.
    if (url.pathname === "/classroom" && request.method === "POST") {
      if (!env.CLASSROOM_SECRET || request.headers.get("Authorization") !== `Bearer ${env.CLASSROOM_SECRET}`) {
        return new Response("unauthorized", { status: 401 });
      }
      const body = await request.json();
      if (!Array.isArray(body.assignments)) return new Response("assignments missing", { status: 400 });
      return Response.json(await onClassroomSync(env, body.assignments));
    }

    // The monthly TKS update (GitHub Actions) reads the month's ideas, drafts, finished tasks and AP time.
    if (url.pathname === "/month-data" && request.method === "GET") {
      if (request.headers.get("Authorization") !== `Bearer ${env.WORKER_SECRET}`) {
        return new Response("unauthorized", { status: 401 });
      }
      const month = url.searchParams.get("month") || todayISO().slice(0, 7);
      return Response.json(await monthData(env, month));
    }

    // The morning brief reads the AP Physics status from here.
    if (url.pathname === "/ap" && request.method === "GET") {
      if (request.headers.get("Authorization") !== `Bearer ${env.WORKER_SECRET}`) {
        return new Response("unauthorized", { status: 401 });
      }
      const started = await env.DB.get("ap");
      return Response.json({ summary: started ? apSummary(await getAp(env)) : "" });
    }

    // GitHub Actions sends today's + tomorrow's calendar events here every hour.
    if (url.pathname === "/schedule" && request.method === "POST") {
      if (request.headers.get("Authorization") !== `Bearer ${env.WORKER_SECRET}`) {
        return new Response("unauthorized", { status: 401 });
      }
      const body = await request.json();
      if (!Array.isArray(body.events)) return new Response("events missing", { status: 400 });
      await env.DB.put("schedule", JSON.stringify({ synced_at: body.synced_at, until: body.until || null, events: body.events }));
      return new Response(`stored ${body.events.length} events`);
    }

    // Telegram webhook. The secret header proves the request really comes from Telegram.
    if (url.pathname === "/telegram" && request.method === "POST") {
      if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.WORKER_SECRET) {
        return new Response("unauthorized", { status: 401 });
      }
      // Hand the message to the background queue and answer Telegram immediately.
      // (If we made Telegram wait for Gemini, it would hang up and the work would be lost.)
      await env.JOBS.send(await request.json());
      return new Response("ok");
    }

    return new Response("Haneul (Claude Administrator bot) is running.");
  },

  // Background worker: handles one Telegram update at a time, with no time pressure.
  async queue(batch, env) {
    if (batch.queue === "admin-bot-slack") {
      try {
        await onSlackBatch(batch.messages.map((m) => m.body), env);
      } catch (err) {
        console.error(err);
      }
      batch.ackAll();
      return;
    }
    if (batch.queue === "admin-bot-whatsapp") {
      try {
        await handleWhatsAppBatch(batch.messages.map((m) => m.body), env);
      } catch (err) {
        console.error(err);
      }
      batch.ackAll();
      return;
    }
    for (const message of batch.messages) {
      try {
        if (message.body.kind === "music") await runMusic(env);
        else if (message.body.kind === "space") await runSpaceArticle(env);
        else if (message.body.kind === "korean") await runKoreanLesson(env);
        else if (message.body.kind === "say") await haneulSays(env, message.body.task);
        else if (message.body.kind === "slack") await slackDigest(env, haneulSays);
        else if (message.body.kind === "velocity") await checkVelocity(env);
        else if (message.body.kind === "outreach_sync") await syncGmailQuietly(env);
        else if (message.body.kind === "wrapped") await sendWrapped(env, haneulSays);
        else if (message.body.kind === "outreach_weekly") await weeklySearch(env);
        else if (message.body.kind === "outreach_prep") await prepOutreach(env);
        else if (message.body.kind === "outreach_discover") await (await import("./outreach.js")).discoverMentors(env);
        else if (message.body.kind === "social") await (await import("./social.js")).socialDaily(env, haneulSays);
        else if (message.body.kind === "social_new") await (await import("./social.js")).draftSocial(env, { again: true });
        else if (message.body.kind === "weekly_article") await (await import("./social.js")).weeklyArticle(env, haneulSays);
        else if (message.body.kind === "qotd") await (await import("./daily.js")).sendQotd(env, haneulSays);
        else if (message.body.kind === "sat") await (await import("./daily.js")).sendSat(env);
        else if (message.body.kind === "course") await (await import("./course.js")).courseNudge(env, haneulSays, message.body.step);
        else if (message.body.kind === "bible") await (await import("./bible.js")).bibleReminder(env, haneulSays);
        else if (message.body.kind === "phone_weekly") await (await import("./phone.js")).phoneWeekly(env, haneulSays);
        else if (message.body.kind === "work_feeds") await (await import("./work.js")).checkFeeds(env, haneulSays);
        else if (message.body.kind === "outreach_nudge") await outreachNudge(env, haneulSays);
        else if (message.body.kind === "app_video") await onVideo({ app_file: message.body.file, caption: message.body.caption || "" }, env);
        else if (message.body.kind === "notion_sync") {
          await env.DB.put("notion_sync_started", new Date().toISOString());
          const r = await runNotionSync(env);
          if (message.body.report) await send(env, `📝 Notion sync done: ${JSON.stringify(r)}`);
        }
        else if (message.body.kind === "workout") await sendWorkout(env, haneulSays);
        else if (message.body.kind === "reading") await readingReminder(env, haneulSays);
        else await handleUpdate(message.body, env);
      } catch (err) {
        console.error(err);
        const msg = err instanceof HiccupError
          ? "ugh, Google or Telegram had a hiccup just now (not you). try that again in a minute?"
          : `⚠️ Something went wrong: ${err.message}`;
        await send(env, msg).catch(() => {});
      }
      message.ack(); // never retry automatically, so you don't get duplicate replies
    }
  },

  // Runs every 5 minutes (see [triggers] in wrangler.toml).
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runReminders(env));
  },
};
