# Phone focus: Haneul blocks distracting apps (MacroDroid)

Haneul can't touch other apps herself, so MacroDroid does the blocking and asks her every time.
When a blocked app opens, MacroDroid calls the worker. If Haneul answers `block`, it goes back
to the home screen. She answers `ok` only while she has unlocked that app for you (ask her in chat,
with a reason; max 30 minutes).

**Blocked:** social media and games.
**Not blocked:** AI apps, WhatsApp, Google apps (incl. YouTube), Slack and anything TKS, school apps,
Spotify, phone/camera/settings.

## The macro (1 macro; the free version allows 5)

1. MacroDroid → **Add Macro**. Name it `Haneul focus`.
2. **Trigger** → Applications → **Application Launched/Closed** → **Launched** → tick the apps to block:
   Instagram, TikTok, Facebook, X (Twitter), Snapchat, Threads, Reddit, Pinterest, BeReal, Discord (unless a
   class uses it), and **every game** on your phone.
3. **Action** → Web Interactions → **HTTP Request**
   - Method: `GET`
   - URL (use the same `key` as your WhatsApp macro):
     `https://haneul.YOUR-SUBDOMAIN.workers.dev/phone?key=YOUR_KEY&app=[app_name]`
     (insert `[app_name]` with the **…** magic-text button → "App name", so Haneul knows which app it was)
   - Turn on **Save HTTP response in variable** → new **local string variable** `answer`
   - Keep "Block next actions until complete" on
4. **Action** → Conditions/Loops → **If Clause** → condition: Variables → `answer` → **contains** → `block`
   - Inside the If: **Action** → Applications → **Launch Home Screen**
   - (optional) Inside the If: **Display Notification** → title `Haneul`, text `Blocked [app_name] · ask me to unlock it`
   - **End If**
5. Save. If MacroDroid asks for Accessibility or Usage Access permission, allow it (that's how it notices which
   app opened).

**No internet = no answer = the app opens.** That's on purpose, so a dead connection never locks you out.

## Using it

- Open a blocked app: you're back on the home screen, and Haneul texts you (at most every 20 minutes).
- "unlock instagram, I need to answer my TKS group": she unlocks it for 5–30 min if the reason is real.
  "I'm bored" gets a no first. She's firmer during school, homework (16:15–18:00) and after 20:30.
- "lock it again": she locks it right away.
- Sundays at 19:00: a weekly report (how many tries, which app you fight the most).

## Find my phone (ring it from the PC)

The PC sidebar → **Your phone** → **Ring my phone** sends a Telegram message starting with `📳 Find my phone`.
One macro makes it ring even on silent:

1. **Trigger** → Notification → **Notification Received** → app **Telegram**, text **contains** `Find my phone`.
2. **Actions**: Volume → **Volume Change** → Alarm (and Ring) 100% · Media → **Play/Stop Sound** (an alarm tone,
   stream Alarm) · Device Actions → **Vibrate** (long pattern) · optional **Flashlight** on for 10 s.
3. Save. Turn it off by opening the phone; it rings once per ping.

It only fires if the notification shows the text: Haneul's Telegram chat must not be muted, and Telegram →
Settings → Notifications → **Message preview** must be on. MacroDroid also needs Notification Access.

The same sheet sends a note, link or image to your phone (it arrives in Telegram), and sets the **put-it-down nudge**:
after that many minutes of screen time without a break (Off / 30 / 45 / 60 / 90, default 45), Haneul texts you once.
