# Haneul (하늘)

**An AI best friend and personal assistant for a busy high-school student, built with a $0 budget.**

Haneul ("sky" in Korean) lives in Telegram and in her own installable web app. She texts like a real
friend (short messages, reactions, voice notes, even phone calls), and she also runs the boring parts
of a student's life: calendar, to-dos, homework plans, mentor outreach, habits and focus.

Everything runs on free tiers: a **Cloudflare Worker** (+ KV, D1 and Queues), **Gemini** (free API),
**GitHub Actions** and a few **Google Apps Scripts**.

> This is a public copy of a real, daily-used project. The sample user is a fictional student,
> "Alex Rivera" in Lima. All personal data, accounts, IDs and secrets have been removed.

## What she does

| Area | Features |
|---|---|
| 💬 Chat | Short, natural texts in English or Spanish; emoji reactions; voice notes (Gemini TTS); long-term memory synced two-way with Notion; nightly chat diary |
| 📞 Voice | Real-time voice calls in the app (Gemini Live), "Hey Haneul" hands-free wake word, she can call you at a set time |
| 📅 Schedule | Calendar sync, reminders before events, morning brief, "what's coming up this week" answers, tasks placed into free calendar slots |
| ✅ To-dos | From chat, from a photo of the school agenda, from Google Classroom, from TKS Velocity challenges in Notion |
| 📚 Study | A semester plan for an online course (tasks spread over the days left, check-ins, behind-pace warnings), a daily SAT practice question, a question of the day, Korean words in chat |
| 🤝 Outreach | Mentor CRM: ranks contacts, researches them (news + Hunter.io email finder), drafts cold emails / booking notes / LinkedIn notes, sends approved emails from your Gmail, watches for replies, finds new mentors in the news |
| 🌐 Networking | Daily LinkedIn + X post drafts from your real work, weekly article outline, posting streak |
| 🎧 Music | Spotify: knows what you're playing, builds focus playlists, sings along (no lyrics reproduced), weekly "wrapped" |
| 📵 Focus | Blocks social media and games through MacroDroid; Haneul unlocks apps for a reason and sends a weekly report |
| 🏃 Habits | Workouts fitted into the calendar, reading buddy, journal, habit check-ins, reading log |

## How it fits together

```
Telegram ─┐                         ┌─ Gemini (chat, vision, TTS, Live)
App (PWA) ┼─► Cloudflare Worker ────┼─ Notion (notes, memory, challenges)
MacroDroid┘   (KV · D1 · Queues ·   ├─ Spotify · Hunter.io · Google News
              5-min cron)           └─ Apps Scripts (Calendar, Gmail, Classroom)
                     ▲
GitHub Actions ──────┘ (morning brief, calendar sync, weekly review, backups)
```

- `worker/src/`: the Worker, one file per feature (`chat.js` is the personality and actions,
  `outreach.js` the mentor CRM, `course.js` the study planner, `social.js` the post drafts…)
- `worker/app/index.html`: the whole web app (one file: chat, calls, panels, service worker)
- `worker/test/run.js`: ~290 checks, run with `cd worker && npm test`
- `telegram-calendar-bot/`: Python jobs for GitHub Actions (brief, calendar sync, reviews)
- `calendar-script/`, `gmail-script/`, `classroom-script/`: Google Apps Scripts
- `docs/`: setup notes (e.g. the MacroDroid focus macro)

## Design notes

- **Rules in code, not just prompts.** Emoji limits, "no markdown", language detection, "music only
  when asked", and action notes that the model writes as text (and that get turned into real actions)
  are all enforced in code, after the prompt alone proved unreliable.
- **Actions are real.** When Haneul says she added a to-do or put on music, the app did it and
  writes a receipt into her history, so she never claims something that didn't happen.
- **Nothing is sent without approval.** Outreach emails go out only after the user approves each
  one; LinkedIn/X posts open the sites' own share pages; the user presses "Post".
- **Free-tier limits shape the code.** 50 outside requests per Worker run (budgeted Notion reads),
  KV write limits (D1 for the message feed), Gemini free quotas (model fallbacks), Hunter.io's small
  monthly credit pool (spent carefully, opted-out people never stored).

## Setup (short)

1. Create a Telegram bot, a Cloudflare account, a Gemini API key.
2. In `worker/wrangler.toml` put your own KV namespace and D1 database ids, then
   `npx wrangler secret put TELEGRAM_BOT_TOKEN` (and `TELEGRAM_CHAT_ID`, `GEMINI_API_KEY`,
   `WORKER_SECRET`; optional: `NOTION_TOKEN`, `NOTION_PAGE`, `HUNTER_API_KEY`, Spotify, Gmail script).
3. `cd worker && npm test && npx wrangler deploy`
4. Set the GitHub secrets listed in `.github/workflows/` for the brief and calendar jobs.
5. Personalize `worker/src/config.js` (timezone, city, times) and the persona in `worker/src/chat.js`.

Never commit `.env` files or keys (`.gitignore` already excludes them).
