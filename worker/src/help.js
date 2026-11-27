import { AP_CHECKIN_HOUR, AP_CHECKIN_MINUTE, DUE_ALERT_HOUR, HABIT_HOUR, HABIT_MINUTE, JOURNAL_HOUR, JOURNAL_MINUTE, MONTHLY_HOUR, MUSIC_HOUR, REMIND_MINUTES, REVIEW_HOUR, WEATHER } from "./config.js";

// ---------- Help library ----------
// /help shows the overview; /help <topic> shows the details of one topic.
// The chat assistant also reads this, so "how do I...?" questions get real answers.

export const HELP_TOPICS = {
  todos: {
    title: "📋 To-dos",
    body: `/todos: see your list, with ✅ buttons to tick items off
done 3: tick off to-do #3 (several: done 3 5 7)
add Physics lab report friday: add a to-do (dates like "friday" or "tomorrow" are understood)
📸 A photo of your agenda: tap "📒 Agenda" and the tasks are added for you

Due-today and overdue to-dos show up in the morning brief, and at ${DUE_ALERT_HOUR}:00 you get a heads-up for tomorrow.`,
  },
  photos: {
    title: "📸 Photos (agenda + TKS)",
    body: `Send a photo and pick what it is:
📒 Agenda → to-dos with due dates
🧠 TKS notes → Mindset of the Week draft for TKS.life
🧑‍🏫 Homework problem → step-by-step hints (/help tutor)
✖ Cancel

Several pages? Send them together (as one album), then pick once.
/tks <typed notes>: same TKS draft, from typed notes instead of photos

Tip: shoot from straight above, page filling the screen, good light.`,
  },
  calendar: {
    title: "📅 Calendar + reminders",
    body: `/today: today's schedule (important, classes, routine)
/tomorrow: tomorrow's schedule

⏰ ~${REMIND_MINUTES} min before important events (your personal calendar, not classes or routine) you get a reminder.
Calendars sync every hour from 5:00 to 22:00, so changes show up within an hour.
To make a block count as routine (no reminders), add a word from its title to routine_keywords in config.json.`,
  },
  ap: {
    title: "📘 AP Physics 1",
    body: `/ap: status (days left, focus unit, streak, on track or behind)
/ap plan: the full plan, unit by unit
/ap 45 projectile motion: log 45 minutes (the topic is optional)
/ap rest: rest day (keeps your streak)
/ap done 3: mark Unit 3 finished · /ap undo 3: unmark it
/ap exam 2027-05-04: change the exam date

📘 Every day at ${AP_CHECKIN_HOUR}:${String(AP_CHECKIN_MINUTE).padStart(2, "0")} I ask if you studied (buttons: 30 min / 1 h / 2 h / rest / didn't study).
Your AP status is also in the morning brief.`,
  },
  music: {
    title: "🎧 Music",
    body: `/music: get this week's picks right now
/outreach: TKS mentor outreach, what's due (draft, approve and send in the app's Outreach tab)
/callme: I call you now · /callme 19:30 quiz me (or just ask me to call you)
/wrapped: your week in music (also every Sunday at 18:00, with a playlist of your top songs)
/np: what you're listening to right now + today's top artists (I always know it when we chat)
/spotify: connect (or reconnect) your Spotify account

🎧 Every Friday at ${MUSIC_HOUR}:00: new releases from artists you listen to + ~12 picks for you,
also saved in your playlist "Weekly Picks · Haneul".`,
  },
  whatsapp: {
    title: "💬 WhatsApp alerts",
    body: `I forward WhatsApp messages that are important by what they SAY.
/wa: see your settings · /wa off: pause alerts · /wa on: resume
/words: see keywords · /words add física · /words remove test
   (keyword matches are always forwarded, even if the AI is down)
/smart off: keywords only (nothing sent to Google) · /smart on: AI judges every message
/vip add Mamá: always forward everything from someone · /vip remove Mamá

Alerts can take up to 30 seconds (messages are judged in batches).`,
  },
  ideas: {
    title: "💡 Ideas inbox",
    body: `/note <idea>: save an idea (add #tags like #tks or #project)
idea: <text> works too
/notes: your latest ideas · /notes tks: search them (accents don't matter)
/note show 3: read idea #3 in full · /note delete 3: remove it
🎤 A voice note with an idea is saved here too.

Ideas from the past week show up in your Sunday review.`,
  },
  voice: {
    title: "🎤 Voice notes",
    body: `Send a voice message (Spanish or English) and I'll figure out what to do:
➕ "Tengo que entregar el informe de física el viernes" → to-do
📅 "Reunión con Jordan el viernes a las 5" → calendar event (I ask before adding)
💡 "Idea for TKS: ..." → saved in your ideas inbox
📘 "Estudié 45 minutos de cinemática" → AP Physics time
▶️ "¿Va a llover hoy?" / "ya terminé la tarea 3" / "pausa WhatsApp" → runs the command
🤖 Anything else → I answer it like a chat message

Works for almost everything except things that need a photo, video or link.
I always show you what I heard first. Max 5 minutes per voice note.`,
  },
  status: {
    title: "🩺 Status + backups",
    body: `/status: is everything working? Brief, calendar + Classroom sync, backups, Gemini quota today,
GitHub token expiry, Spotify, Telegram.
If something breaks I tell you by myself (each problem at most once a day).
💾 Every Sunday at 4:00 your data (to-dos, journal, habits, memory, ideas, AP + Korean progress)
is backed up to the "backups" branch of your private GitHub repo. /backup: back up now.`,
  },
  journal: {
    title: "📓 Nightly journal",
    body: `Every night at ${JOURNAL_HOUR}:${JOURNAL_MINUTE} I ask one question (on TKS days, about your session).
Reply to that message, by text or voice, and it's saved.
/journal: your last 7 entries · /journal <text>: write an entry now · /journal skip: skip tonight
Entries feed your Sunday review and your monthly newsletter draft.`,
  },
  habits: {
    title: "🔁 Habits",
    body: `At ${HABIT_HOUR}:${HABIT_MINUTE} I send today's habits as buttons: tap to tick ✅ (tap again to untick).
/habits: all habits with 🔥 streaks and this week's score
/habit 2: tick habit #2 for today
/habit add Gym mon wed fri · /habit add Read 20 min (no days = every day)
/habit days 2 tue thu · /habit remove 2
Streaks only count the days a habit is scheduled. Habits show up in your Sunday review.`,
  },
  memory: {
    title: "🧠 Memory",
    body: `I remember your life, not just today's chat:
💬 While we chat, I save anything worth keeping (news, wins, plans, people, worries…) automatically.
📌 You can also tell me directly: "remember that …" (or "recuerda que …", /remember …, a voice note).
📔 Every night at 23:30 I write a short diary of what we talked about, and I read the last 2 weeks in every chat.
🗨️ The last 10 back-and-forths I remember word for word (cleared after a week without chatting, or /forget).
/memory: what I remember · /memory tks: search · /memory all · /memory delete 3: forget one
Everything is saved in your weekly backup.`,
  },

  korean: {
    title: "🇰🇷 Korean",
    body: `I teach you Korean while we chat: about every 3rd message I slip in one word that fits
what we're talking about (Hangul + romanization + meaning), and I remember what you've learned.
/korean words: everything you've learned · /korean: a full lesson + quiz + audio right now
/korean say 안녕하세요: hear anything in Korean · /korean audio: replay the last lesson
/korean daily on: daily lessons again (weekdays 6:30, weekends 9:00) · /korean daily off`,
  },
  velocity: {
    title: "🚀 Velocity challenges",
    body: `TKS sends the weekly challenge as a Notion page. On it: ⋯ → Duplicate, then move the copy into
Haneul → TKS → Velocity. Every hour I check there for a new challenge, pull out every task + deadline, and ask:
➕ Add as to-dos · 📅 To-dos + calendar · ✖ Skip
Tasks show up as "Velocity: …" to-dos (brief, 19:00 heads-up, Sunday review), and I check in on Wednesday
at 17:30 if some are still open. With 📅, each task goes into a free spot in your calendar on its due day
(or the day before if that day is full), never over classes, the bus or homework blocks.
/velocity: read the newest challenge right now
/velocity calendar: re-place the open Velocity to-dos in free spots (removes all-day ones I made)`,
  },
  slack: {
    title: "💼 TKS Slack catch-up",
    body: `I quietly collect your Slack notifications all day (forwarded by MacroDroid), then catch you up
on the bus: weekdays 15:05, weekends 12:00. Or any time: /slack
⭐ Priority: Jordan, #cohort-general, #announcements, #i-jordan-velocity and every DM
   (if someone asks about your availability, I draft a reply using your calendar)
🔭 Builders: people in #builders-feedback and #i-ml-life doing stuff close to your interests
🧵 Important thread replies · then everything else, one line per channel
I only see what Slack notifies you about, so set Slack to notify you for all messages in channels you care about.`,
  },
  notion: {
    title: "📝 Notion",
    body: `I work inside your "Haneul" page in Notion (only that page, nothing else):
🧠 TKS page: your session notes (Cohort meeting, Velocity, 1-1 with Jordan…). /tks drafts your Mindset of the Week
   from the note you edited most recently there (if it's almost empty, I tell you instead of making stuff up)
💡 Ideas table: everything from /note, voice ideas and link summaries
📖 Reading table: a row each time you /read; write your own notes on a chapter there and I react to them
📓 Journal table: your nightly answers
📰 Newsletter Drafts table: the weekly issue drafts and the monthly TKS update, ready to edit
🧠 Memory table: everything I remember about you. Edit or delete a row and I update within an hour;
   add your own row and I learn it
📔 Chat Diary table: my nightly summary of what we talked about
/notion: check the connection`,
  },

  workout: {
    title: "🏃 Workout",
    body: `Mon-Thu + weekends (Friday is a rest day), about 30 min, fitted into your calendar every morning:
🌅 weekend with a free morning → a run (endurance)
💪 free 30+ min in the afternoon → full session (strength and runs alternate)
⚡ only 15-29 min free → quick routine · less than that → 10-min mini (still counts)
5 min before, I send the routine with ✅ Done · ⏰ In 1 h · ⏭️ Skip. It gets harder as you go.
/workout: today's plan + routine now · /workout done · /workout skip · /workout status
/workout off · /workout on`,
  },
  reading: {
    title: "📖 Reading buddy",
    body: `Every evening at 19:30 I check in about your book. Tell me your chapter and I react like
I'm reading it with you: my favorite part of THAT chapter (no spoilers ahead) + a question to think about.
📖 I read today → tell me the chapter · or /read 5 (add what you thought: /read 5 loved the golden circle)
/reading: progress + streak · /book Title by Author: start a new book · /reading off · /reading on`,
  },

  tutor: {
    title: "🧑‍🏫 Homework tutor",
    body: `Send a photo of a problem, then tap 🧑‍🏫 Homework problem → hints.
Or type it: /hint A ball is thrown at 20 m/s at 30°. How far does it go?
💡 Next hint: 4 hints, each a bit more specific (never the answer)
✍️ Check my answer: reply with your answer, and I tell you if it's right (and what kind of mistake if not)
🔓 Full solution: only after the last hint
/hint alone: next hint for the current problem`,
  },
  classroom: {
    title: "📚 Google Classroom",
    body: `A script in your school account sends me your Classroom assignments every hour.
📚 New assignment posted → I ping you with the due date and link
➕ Pending assignments become to-dos automatically (brief, 19:00 heads-up, Sunday review)
✅ Turned in on Classroom → the to-do disappears by itself
done 5 on a Classroom to-do → it won't come back, even if not turned in
/classroom: everything pending, with links`,
  },
  links: {
    title: "🔗 Links + videos",
    body: `Send me a link and I'll summarize it, suggest project ideas, and save it to your ideas:
✅ articles and websites · ✅ YouTube (also Shorts) · ✅ TikTok (from its caption)
❌ Instagram blocks bots, so save the reel (or screen-record it) and send the VIDEO instead.
🎬 Any video you send (up to 20 MB) gets watched and summarized the same way.
Add a comment next to the link, e.g. "for my rocket project https://...", and I'll take it into account.
/notes link: all your saved links`,
  },
  events: {
    title: "📅 Add calendar events",
    body: `/event Meeting with Jordan friday 5pm
(also: "event: ...", "evento: ...", "add event ...", or a voice note)
I show you the event first, with ✅ Add it / ✖ Cancel buttons.
No time → all-day event. No end time → 1 hour.
It goes into your personal Google Calendar, and reminders pick it up within a minute.`,
  },
  space: {
    title: "🚀 Space-tech article",
    body: `Every morning (6:10 on school days, on the bus; 9:30 on weekends),
I send one article picked for you (SpaceNews, NASASpaceflight, Spaceflight Now, Space.com),
with a 3-point summary, why it's worth it, and a question to think about.
/space: get one right now (never repeats an article).`,
  },
  focus: {
    title: "🎯 Focus sessions",
    body: `/focus 45 AP physics: a 45-minute focus session (any length 5-180; the words say what it's for)
While it runs: your focus playlist plays on Spotify (if it's open), I hold my random texts,
and distracting apps are blocked on your phone.
At the end the minutes are logged (AP Physics minutes also go to your AP log) and I check in.
/focus: how long is left · /focus stop: end early · /focus playlist <Spotify link>: pick the music
In the app: the Focus card in Today (desktop) or my menu → Focus (phone).`,
  },
  phonefocus: {
    title: "📵 Phone focus",
    body: `MacroDroid asks me before opening social media or games. I block them ONLY while something important is on:
an important event on your calendar right now (classes, homework/study blocks, TKS sessions, 1:1s and braindates,
meetings, events, newsletter time) or a focus session. Lunch, the bus, routines and small Velocity to-dos don't count.
Need an app during those times? Ask me in chat with a reason and I'll unlock it for a few minutes.
Screen time: two more MacroDroid macros (Screen On → the same link + &screen=on, Screen Off → &screen=off) let me
count your phone time, unlocks and longest session. It shows in Today, the week review and the Sunday report.`,
  },
  progress: {
    title: "🛠️ Build in public (GitHub)",
    body: `Every few hours I read the public activity of your whole GitHub account, so new projects are picked up on their own.
Pushes become progress notes (commit messages + the files that changed), and new repos go to your work list.
The notes fill "this week's progress" in your Thursday newsletter draft and show up in your week review.`,
  },
  debrief: {
    title: "🤝 After a mentor chat",
    body: `15 minutes after a 1:1 on your calendar ends ("Name and Alex Rivera"), I ask 3 things:
what you learned, what surprised you, what you'll try. Reply to that message (text or voice).
I save it for your "Collaborate in public" newsletter issues and draft a thank-you note for you to send yourself.`,
  },
  newsletter: {
    title: "📰 Weekly newsletter",
    body: `Your Substack goes out every Sunday. Each issue: a hook, why it works, this week's progress, one ask.
Thursday 16:30: I write a first draft of Sunday's issue (Notion → Newsletter Drafts, and Mentors → Posts in the app)
Saturday 10:00: a nudge to edit it · Sunday 17:00: a nudge to send it (only if it isn't out yet)
When you publish, I notice it on your Substack feed and mark the issue sent (/substack <link> tells me where your Substack is).
When fewer than 2 issues are planned, I suggest the next one on Sunday at 15:00.
/newsletter: the calendar · /newsletter draft · plan · sent · skip · name <name>
The big monthly TKS update (/monthly) is separate: a recap of the month, built from these issues.`,
  },
  monthly: {
    title: "📰 Monthly TKS update",
    body: `On the last day of each month at ${MONTHLY_HOUR}:00 I write a FIRST DRAFT of your Substack newsletter,
in the style of your last issue (TKS Updates, Highlights, Projects, last month's goals, Next Month's Goals).
It uses: TKS sessions from your calendar, Mindset drafts, ideas and links, finished to-dos and AP hours.
Anything I'm not sure about is marked [check].
/monthly: get this month's draft right now`,
  },
  weather: {
    title: "🌦️ Weather",
    body: `/weather (or /clima): ${WEATHER.name} now, today and tomorrow, with rain chances at bus times (6–7am, 3–4pm)
☂️ I tell you to bring an umbrella when rain at bus time is 40% or more.
The weather is also the first line of your morning brief.`,
  },
  review: {
    title: "🗓️ Sunday review",
    body: `Every Sunday at ${REVIEW_HOUR}:00 you get a look at the coming week:
📅 important events per day (and days without classes)
⚠️ overdue and upcoming deadlines
📘 AP Physics: hours, streak, on track or behind
💡 the ideas you saved this week
🎯 3 suggestions for what to focus on
/review: get it right now`,
  },
  chat: {
    title: "🤖 Chat",
    body: `Write anything that isn't a command and I'll answer like an assistant.
I know your schedule for today and tomorrow, and your to-dos.
Examples: "when am I free tomorrow?", "help me plan my homework tonight", "explain torque simply"
/forget: clear my chat memory (it also resets by itself after a day)`,
  },
  auto: {
    title: "⏱️ Automatic messages",
    body: `☀️ 6:10 weekdays / 8:00 weekends: morning brief (events, classes, to-dos, AP status, news)
⏰ ~${REMIND_MINUTES} min before important events: reminder
🌙 ${DUE_ALERT_HOUR}:00: to-dos due tomorrow
📘 ${AP_CHECKIN_HOUR}:${String(AP_CHECKIN_MINUTE).padStart(2, "0")}: AP Physics check-in
🔁 ${HABIT_HOUR}:${HABIT_MINUTE}: habit check-in
📓 ${JOURNAL_HOUR}:${JOURNAL_MINUTE}: journal question
🏃 workout: 5 min before the slot I find in your calendar (not Fridays)
📖 19:30: reading check-in
💼 Slack catch-up: weekdays 15:05, weekends 12:00
💬 1-2 random texts from me a day (never during school, events or bedtime)
🎧 Fridays ${MUSIC_HOUR}:00: weekly music
🗓️ Sundays ${REVIEW_HOUR}:00: weekly review
🚀 Before your Space Tech reading block: article of the day
📰 Thursdays 16:30: newsletter draft · Sat 10:00 edit nudge · Sun 17:00 send nudge
📰 Last day of the month ${MONTHLY_HOUR}:00: monthly TKS update draft
💬 Any time: important WhatsApp messages
💾 Sundays 4:00: backup (silent) · 🩺 health alerts only if something breaks`,
  },
};

// Words people might type after /help, mapped to a topic.
export const HELP_ALIASES = {
  todo: "todos", tasks: "todos", tareas: "todos", add: "todos", done: "todos",
  photo: "photos", foto: "photos", fotos: "photos", agenda: "photos", tks: "photos", mindset: "photos",
  today: "calendar", tomorrow: "calendar", reminders: "calendar", recordatorios: "calendar", calendario: "calendar",
  physics: "ap", fisica: "ap", física: "ap", study: "ap",
  spotify: "music", musica: "music", música: "music",
  wa: "whatsapp", vip: "whatsapp", words: "whatsapp", smart: "whatsapp",
  assistant: "chat", forget: "chat",
  note: "ideas", notes: "ideas", idea: "ideas", ideas: "ideas", notas: "ideas",
  audio: "voice", voz: "voice", "voice-notes": "voice", nota_de_voz: "voice",
  clima: "weather", tiempo: "weather", rain: "weather", lluvia: "weather",
  sunday: "review", domingo: "review", week: "review", semana: "review",
  link: "links", url: "links", youtube: "links", instagram: "links", reels: "links", reel: "links", video: "links", tiktok: "links",
  event: "events", evento: "events", eventos: "events",
  school: "classroom", colegio: "classroom", assignments: "classroom", homework: "classroom",
  diario: "journal", diary: "journal", reflection: "journal",
  backup: "status", backups: "status", health: "status", estado: "status",
  habit: "habits", habitos: "habits", "hábitos": "habits", streak: "habits",
  remember: "memory", recuerda: "memory", memoria: "memory",
  coreano: "korean", hangul: "korean", language: "korean", idioma: "korean", pronunciation: "korean", pronunciacion: "korean",
  tks_slack: "slack", channels: "slack", canales: "slack",
  gym: "workout", ejercicio: "workout", run: "workout", correr: "workout", exercise: "workout",
  book: "reading", libro: "reading", read: "reading", leer: "reading", lectura: "reading",
  challenge: "velocity", reto: "velocity", retos: "velocity",
  hint: "tutor", hints: "tutor", problem: "tutor", problema: "tutor", math: "tutor", matematicas: "tutor",
  rocket: "space", articulo: "space", article: "space",
focus: "focus", enfoque: "focus", pomodoro: "focus", phone: "phonefocus", macrodroid: "phonefocus", block: "phonefocus", apps: "phonefocus",
  github: "progress", commits: "progress", progress: "progress", mentor: "debrief", braindate: "debrief", thanks: "debrief",
  newsletter: "newsletter", substack: "newsletter", weekly: "newsletter", boletin: "newsletter", "boletín": "newsletter", month: "monthly", mes: "monthly",
  automatic: "auto", schedule: "auto", horario: "auto",
};

export function helpOverview() {
  return `👋 I'm Haneul, your personal assistant. Here's everything I can do:

📋 To-dos: /todos · done 3 · add <task>
📚 Classroom: /classroom (assignments become to-dos automatically)
📸 Photos: agenda → to-dos · TKS notes → Mindset draft · /tks <notes>
📅 Calendar: /today · /tomorrow · /weather · /event <event>
💡 Ideas: /note <idea> · /notes · /notes <search>
🔗 Links + videos: send one → summary + project ideas, saved
🎤 Voice notes: send one → to-do, event, idea, AP log, any command
🚀 Space-tech read: /space
🔁 Habits: /habits · /habit 2 · /habit add <name>
📓 Journal: reply to the ${JOURNAL_HOUR}:${JOURNAL_MINUTE} question · /journal
🧠 Memory: "remember that …" · /memory
🇰🇷 Korean: I teach you words while we chat · /korean words · /korean say <word>
🏃 Workout: /workout · /workout done
📖 Reading: /reading · /read 5 · /book <title>
🧑‍🏫 Homework tutor: photo → 🧑‍🏫, or /hint <problem>
🗓️ Sunday review: /review · 📰 Newsletter: /newsletter · Monthly TKS draft: /monthly
🎯 Focus: /focus 45 AP physics · /focus stop
📘 AP Physics: /ap · /ap plan · /ap 45 · /ap done 1
🎧 Music: /music · /np · /spotify
💬 WhatsApp: /wa · /words · /smart
💼 Slack catch-up: /slack (and on the bus, 15:05)
📝 Notion: /notion · /tks reads your newest TKS note
🚀 Velocity: /velocity (challenge → to-dos + calendar)
📱 App (chat + voice calls): open https://haneul.YOUR-SUBDOMAIN.workers.dev/app
🤖 Chat: just write to me · /forget
🩺 Status: /status · 💾 /backup

More detail on any topic:
/help todos · /help photos · /help calendar · /help weather
/help velocity · /help notion · /help slack · /help workout · /help reading · /help tutor · /help habits · /help journal · /help memory · /help korean · /help status
/help classroom · /help ideas · /help voice · /help links · /help events
/help space · /help review · /help newsletter · /help monthly · /help ap
/help focus · /help phone · /help github · /help mentor
/help music · /help whatsapp · /help chat · /help auto

Or just ask me, e.g. "how do I log AP study time?"
Tip: type / to see the command menu.`;
}

export function helpText(arg) {
  const key = (arg || "").toLowerCase().trim().replace(/^\//, "");
  if (!key) return helpOverview();
  const topic = HELP_TOPICS[key] || HELP_TOPICS[HELP_ALIASES[key]];
  if (!topic) return `I don't have a help page for "${arg}".\n\n${helpOverview()}`;
  return `${topic.title}\n\n${topic.body}\n\n/help for all topics`;
}

// Full reference for the chat assistant.
export function helpReference() {
  return Object.values(HELP_TOPICS)
    .map((t) => `${t.title}\n${t.body}`)
    .join("\n\n");
}

// Commands shown in Telegram's "/" menu (set with setMyCommands).
export const MENU_COMMANDS = [
  { command: "help", description: "All commands and how to use them" },
  { command: "status", description: "Is everything working?" },
  { command: "today", description: "Today's schedule" },
  { command: "tomorrow", description: "Tomorrow's schedule" },
  { command: "todos", description: "Your to-do list" },
  { command: "classroom", description: "Pending Classroom assignments" },
  { command: "habits", description: "Habits and streaks" },
  { command: "korean", description: "Korean lesson now" },
  { command: "hint", description: "Homework tutor: hints for a problem" },
  { command: "slack", description: "TKS Slack catch-up" },
  { command: "velocity", description: "Read this week's Velocity challenge" },
  { command: "notion", description: "Notion connection" },
  { command: "workout", description: "Today's workout" },
  { command: "reading", description: "Reading progress" },
  { command: "journal", description: "Journal entries" },
  { command: "memory", description: "What the bot remembers about you" },
  { command: "weather", description: "Weather + rain at bus times" },
  { command: "note", description: "Save an idea" },
  { command: "notes", description: "Your ideas (add words to search)" },
  { command: "review", description: "Weekly review now" },
  { command: "event", description: "Add an event to your calendar" },
  { command: "space", description: "Space-tech article now" },
  { command: "newsletter", description: "Weekly newsletter: calendar and drafts" },
  { command: "focus", description: "Start a focus session (e.g. /focus 45 AP physics)" },
  { command: "monthly", description: "Monthly TKS update draft" },
  { command: "ap", description: "AP Physics status" },
  { command: "music", description: "This week's music picks" },
  { command: "wa", description: "WhatsApp alert settings" },
  { command: "tks", description: "Mindset draft from typed notes" },
  { command: "forget", description: "Clear chat memory" },
];
