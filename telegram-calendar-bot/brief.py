"""Morning brief: today's calendar, open to-dos and a news summary, sent to Telegram.

Run locally:   py brief.py            (sends the brief)
               py brief.py --dry-run  (prints it instead of sending)
On GitHub Actions the same script runs on a schedule; secrets come from env vars.
"""

import json
import os
import re
import sys
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

HERE = Path(__file__).parent
CONFIG = json.loads((HERE / "config.json").read_text(encoding="utf-8"))
TZ = ZoneInfo(CONFIG["timezone"])


def load_env():
    """Read .env for local runs. Real environment variables (GitHub Secrets) win."""
    env_file = HERE / ".env"
    if env_file.exists():
        for line in env_file.read_text(encoding="utf-8").splitlines():
            if "=" in line and not line.strip().startswith("#"):
                key, value = line.split("=", 1)
                if value.strip() and not os.environ.get(key.strip()):
                    os.environ[key.strip()] = value.strip()


def http_get(url, timeout=20):
    req = urllib.request.Request(url, headers={"User-Agent": "morning-brief-bot/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def http_post_json(url, payload, timeout=60):
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read())


# ---------- Calendar ----------

def is_routine(title):
    """Whole-word match, so "Bus" doesn't also match words like "business"."""
    return any(
        re.search(rf"\b{re.escape(word)}\b", title, re.IGNORECASE)
        for word in CONFIG.get("routine_keywords", [])
    )


def collect_events(first_day, days=1):
    """Events from the Google Calendar secret iCal address(es) for `days` days
    starting at `first_day`. Several URLs are separated by spaces.
    Returns a sorted list of dicts, or None if no calendar is configured.
    tag: SCHOOL (classes), PERSONAL (important), ROUTINE (daily blocks)."""
    urls = os.environ.get("GOOGLE_CALENDAR_ICS_URL", "").split()
    if not urls:
        return None  # not configured yet

    import icalendar
    import recurring_ical_events

    events = []
    for url in urls:
        try:
            cal = icalendar.Calendar.from_ical(http_get(url))
        except Exception as exc:
            print(f"Calendar fetch failed: {exc}", file=sys.stderr)
            continue
        # A calendar named after a gmail.com address is the personal one;
        # anything else (the school domain) is the school calendar.
        cal_name = str(cal.get("X-WR-CALNAME", ""))
        source = "PERSONAL" if cal_name.lower().endswith("@gmail.com") else "SCHOOL"
        last_day = first_day + timedelta(days=days)
        for ev in recurring_ical_events.of(cal).between(first_day, last_day):
            start = ev.get("DTSTART").dt
            all_day = not isinstance(start, datetime)
            if not all_day:
                start = start.astimezone(TZ)
            end = ev.get("DTEND").dt if ev.get("DTEND") else None
            if isinstance(end, datetime):
                end = end.astimezone(TZ).isoformat()
            else:
                end = None  # all-day events or events without an end
            title = str(ev.get("SUMMARY", "(no title)"))
            tag = "ROUTINE" if source == "PERSONAL" and is_routine(title) else source
            events.append({
                "start": start.isoformat(),
                "end": end,
                "all_day": all_day,
                "title": title,
                "location": str(ev.get("LOCATION", "")).strip(),
                "tag": tag,
                "uid": str(ev.get("UID", "")),
            })
    events.sort(key=lambda e: ("0" if e["all_day"] else "1") + e["start"])
    return events


def todays_events():
    events = collect_events(datetime.now(TZ).date())
    if events is None:
        return None
    lines = []
    for e in events:
        when = "all day" if e["all_day"] else e["start"][11:16]
        loc = f" ({e['location']})" if e["location"] else ""
        lines.append(f"[{e['tag']}] {when} - {e['title']}{loc}")
    return lines


# ---------- To-dos ----------

def load_todos():
    """To-dos live in the Telegram bot (Cloudflare Worker). Falls back to todos.json
    if the bot isn't set up or can't be reached.
    Format: [{"task": "...", "due": "YYYY-MM-DD" or null, "done": false}]"""
    worker_url = os.environ.get("WORKER_URL", "").rstrip("/")
    secret = os.environ.get("WORKER_SECRET", "")
    if worker_url and secret:
        try:
            req = urllib.request.Request(
                f"{worker_url}/todos",
                headers={"Authorization": f"Bearer {secret}", "User-Agent": "morning-brief-bot/1.0"},
            )
            with urllib.request.urlopen(req, timeout=20) as resp:
                return json.loads(resp.read())
        except Exception as exc:
            print(f"Couldn't get to-dos from the bot, using todos.json: {exc}", file=sys.stderr)
    path = HERE / "todos.json"
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else []


def weather_summary():
    """Today's weather from Open-Meteo (free, no key), with rain chances at bus times."""
    w = CONFIG.get("weather")
    if not w:
        return ""
    params = urllib.parse.urlencode({
        "latitude": w["lat"], "longitude": w["lon"], "timezone": CONFIG["timezone"], "forecast_days": 1,
        "hourly": "precipitation_probability",
        "daily": "temperature_2m_max,temperature_2m_min,precipitation_probability_max",
    })
    try:
        f = json.loads(http_get(f"https://api.open-meteo.com/v1/forecast?{params}"))
    except Exception as exc:
        print(f"Weather failed: {exc}", file=sys.stderr)
        return ""
    rain = dict(zip(f["hourly"]["time"], f["hourly"]["precipitation_probability"]))
    day = f["daily"]["time"][0]
    bus = ", ".join(f"{h}:00 {rain.get(f'{day}T{h:02d}:00', 0)}%" for h in w.get("bus_hours", []))
    return (
        f"{w['city']}: {round(f['daily']['temperature_2m_min'][0])}-{round(f['daily']['temperature_2m_max'][0])}°C, "
        f"rain chance up to {f['daily']['precipitation_probability_max'][0]}%. "
        f"Rain chance at bus times: {bus}."
    )


def outreach_summary():
    """TKS mentor outreach: what's due + new replies from Gmail ("" if nothing or unreachable)."""
    worker_url = os.environ.get("WORKER_URL", "").rstrip("/")
    secret = os.environ.get("WORKER_SECRET", "")
    if not worker_url or not secret:
        return ""
    try:
        req = urllib.request.Request(
            f"{worker_url}/outreach-brief",
            headers={"Authorization": f"Bearer {secret}", "User-Agent": "morning-brief-bot/1.0"},
        )
        with urllib.request.urlopen(req, timeout=20) as resp:
            return resp.read().decode("utf-8").strip()
    except Exception as exc:
        print(f"Couldn't get outreach status: {exc}", file=sys.stderr)
        return ""


def ap_summary():
    """AP Physics status from the bot ("" if not started or unreachable)."""
    worker_url = os.environ.get("WORKER_URL", "").rstrip("/")
    secret = os.environ.get("WORKER_SECRET", "")
    if not worker_url or not secret:
        return ""
    try:
        req = urllib.request.Request(
            f"{worker_url}/ap",
            headers={"Authorization": f"Bearer {secret}", "User-Agent": "morning-brief-bot/1.0"},
        )
        with urllib.request.urlopen(req, timeout=20) as resp:
            return json.loads(resp.read()).get("summary", "")
    except Exception as exc:
        print(f"Couldn't get AP status: {exc}", file=sys.stderr)
        return ""


def open_todos():
    items = [t for t in load_todos() if not t.get("done")]
    items.sort(key=lambda t: t.get("due") or "9999-12-31")
    today = datetime.now(TZ).date()
    lines = []
    for t in items:
        due = t.get("due")
        tag = ""
        if due:
            d = date.fromisoformat(due)
            if d < today:
                tag = " (OVERDUE)"
            elif d == today:
                tag = " (due TODAY)"
            elif d == today + timedelta(days=1):
                tag = " (due tomorrow)"
            else:
                tag = f" (due {d.strftime('%a %d %b')})"
        lines.append(f"{t['task']}{tag}")
    return lines


# ---------- News ----------

def headlines():
    items = []
    for url in CONFIG["news_feeds"]:
        try:
            root = ET.fromstring(http_get(url))
        except Exception as exc:
            print(f"Feed failed ({url}): {exc}", file=sys.stderr)
            continue
        count = 0
        for item in root.iter("item"):
            title = (item.findtext("title") or "").strip()
            desc = (item.findtext("description") or "").strip()
            if title:
                items.append(f"{title}: {desc}")
                count += 1
            if count >= CONFIG["news_items_per_feed"]:
                break
    return items


# ---------- Gemini ----------

def ask_gemini(prompt):
    """Try the configured model, then backups. Free-tier models are sometimes busy
    (HTTP 503) or rate-limited (429), so retry a couple of times before moving on."""
    import time
    import urllib.error

    key = os.environ["GEMINI_API_KEY"]
    models = [CONFIG["gemini_model"]] + CONFIG.get("gemini_backup_models", [])
    last_error = None
    for model in models:
        url = (
            "https://generativelanguage.googleapis.com/v1beta/models/"
            f"{model}:generateContent?key={urllib.parse.quote(key)}"
        )
        for attempt in range(3):
            try:
                data = http_post_json(url, {"contents": [{"parts": [{"text": prompt}]}]})
                return data["candidates"][0]["content"]["parts"][0]["text"].strip()
            except urllib.error.HTTPError as exc:
                last_error = f"{model}: HTTP {exc.code}"
                if exc.code not in (500, 503):
                    break  # 429 = quota used up, or another error: try the next model
                time.sleep(5 * (attempt + 1))
            except Exception as exc:
                last_error = f"{model}: {exc}"
                break
        print(f"Gemini model failed: {last_error}", file=sys.stderr)
    raise RuntimeError(last_error)


def build_brief():
    now = datetime.now(TZ)
    events = todays_events()
    todos = open_todos()
    news = headlines()

    if events is None:
        cal_text = "(calendar not connected yet)"
    else:
        cal_text = "\n".join(events) or "(nothing scheduled)"
    todo_text = "\n".join(todos) or "(no open to-dos)"
    news_text = "\n".join(news) or "(news unavailable)"

    prompt = f"""You are Haneul, Alex's personal assistant and close friend: warm, upbeat and genuinely excited for Alex's day (like a friend texting, never formal), but still brief and useful. Write Alex's morning brief for {now.strftime('%A %d %B %Y')}.
Write in {CONFIG['language']}. It will be read on a phone in Telegram, so:
- plain text only, NO markdown symbols like ** or #
- one emoji at the start of each section heading only; NO emojis anywhere else (not in sentences)
- keep it under 320 words

Sections, in this order (never invent events; use only what is listed):
0. Weather: ONE line from WEATHER below (temperature range + rain). If the rain chance at any
   bus time (6-7am or 3-4pm) is 40% or more, add "☂️ bring an umbrella". Skip if WEATHER is empty.
1. Important today: the [PERSONAL] events (meetings, deadlines, TKS, church...), with times.
   If there are none, say "Nothing special today".
2. Classes: the [SCHOOL] events as a compact list, "time - class (room)".
   Shorten long class names (e.g. "British and World Literature: 11" -> "British Lit").
   If there are no classes (weekend or holiday), say so in one line.
3. Routine: summarize the [ROUTINE] blocks in ONE short line (e.g. "Homework 4:15, CS 7pm, music 8pm").
4. To-dos: list them, overdue and due-today first. If none, say so in one line.
4b. AP Physics: if AP PHYSICS STATUS below is not empty, one or two lines: today's focus unit,
    streak, and pace. If it says Alex is behind or skipped yesterday, call it out honestly but kindly.
    If it's empty, skip this section.
4c. Mentor outreach: if MENTOR OUTREACH below is not empty, 1-3 lines: replies to answer first,
    then follow-ups due. Never invent names. If it's empty or says nothing is due, skip this section.
5. News: the 4-5 most important stories, one short line each, neutral tone.
6. One short motivating line to start the day.

CALENDAR:
{cal_text}

TO-DOS:
{todo_text}

AP PHYSICS STATUS:
{ap_summary()}

MENTOR OUTREACH:
{outreach_summary()}

WEATHER:
{weather_summary()}

NEWS HEADLINES:
{news_text}
"""
    try:
        return ask_gemini(prompt)
    except Exception as exc:
        print(f"Gemini failed, sending plain brief: {exc}", file=sys.stderr)
        return (
            f"Good morning! {now.strftime('%A %d %B')}\n\n"
            f"📅 Schedule\n{cal_text}\n\n✅ To-dos\n{todo_text}\n\n"
            f"📰 News\n" + "\n".join(n.split(':')[0] for n in news[:5])
        )


def heartbeat(job):
    """Tell the bot this job finished, so /status and the health alerts know."""
    worker_url = os.environ.get("WORKER_URL", "").rstrip("/")
    secret = os.environ.get("WORKER_SECRET", "")
    if not worker_url or not secret:
        return
    try:
        req = urllib.request.Request(
            f"{worker_url}/heartbeat?job={job}", data=b"", method="POST",
            headers={"Authorization": f"Bearer {secret}", "User-Agent": "morning-brief-bot/1.0"},
        )
        urllib.request.urlopen(req, timeout=15).read()
    except Exception as exc:
        print(f"Heartbeat failed (not important): {exc}", file=sys.stderr)


def relay(payload):
    """Send a message through the bot (Cloudflare Worker), so it also reaches the Haneul app
    and follows the app-only setting. Returns False if the worker can't be reached."""
    worker_url = os.environ.get("WORKER_URL", "").rstrip("/")
    secret = os.environ.get("WORKER_SECRET", "")
    if not worker_url or not secret:
        return False
    req = urllib.request.Request(
        f"{worker_url}/relay",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {secret}", "User-Agent": "morning-brief-bot/1.0"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return resp.status == 200
    except Exception as exc:
        print(f"Relay failed, sending to Telegram directly: {exc}", file=sys.stderr)
        return False


def send_telegram(text):
    if relay({"text": text}):
        return
    token = os.environ["TELEGRAM_BOT_TOKEN"]
    chat_id = os.environ["TELEGRAM_CHAT_ID"]
    url = f"https://api.telegram.org/bot{token}/sendMessage"
    for i in range(0, len(text), 4000):  # Telegram limit is 4096 chars per message
        http_post_json(url, {"chat_id": chat_id, "text": text[i:i + 4000]})


if __name__ == "__main__":
    load_env()
    brief = build_brief()
    if "--dry-run" in sys.argv:
        print(brief)
    else:
        send_telegram(brief)
        heartbeat("brief")
        print("Brief sent.")
