"""Sunday review: next week's events and deadlines, AP Physics progress, the ideas
you saved this week, and a suggested focus. Sent to Telegram.

Started by the bot every Sunday at 16:00 (or with /review).
Run locally:  py weekly_review.py            (sends it)
              py weekly_review.py --dry-run  (prints it)
"""

import json
import os
import sys
import urllib.request
from collections import defaultdict
from datetime import date, datetime, timedelta

import brief


def review_data():
    worker_url = os.environ.get("WORKER_URL", "").rstrip("/")
    secret = os.environ.get("WORKER_SECRET", "")
    if not worker_url or not secret:
        return {"todos": [], "ap": "", "notes": []}
    req = urllib.request.Request(
        f"{worker_url}/review-data",
        headers={"Authorization": f"Bearer {secret}", "User-Agent": "morning-brief-bot/1.0"},
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            return json.loads(resp.read())
    except Exception as exc:
        print(f"Couldn't get review data from the bot: {exc}", file=sys.stderr)
        return {"todos": [], "ap": "", "notes": []}


def next_week():
    """Monday-Sunday of the coming week, grouped by day."""
    today = datetime.now(brief.TZ).date()
    monday = today + timedelta(days=(7 - today.weekday()) % 7 or 7)
    events = brief.collect_events(monday, days=7) or []
    days = defaultdict(lambda: {"important": [], "classes": 0})
    for e in events:
        d = e["start"][:10]
        if e["tag"] == "PERSONAL":
            when = "all day" if e["all_day"] else e["start"][11:16]
            days[d]["important"].append(f"{when} {e['title']}")
        elif e["tag"] == "SCHOOL":
            days[d]["classes"] += 1
    lines = []
    for i in range(7):
        d = monday + timedelta(days=i)
        info = days[d.isoformat()]
        school = f"{info['classes']} classes" if info["classes"] else "no classes"
        important = "; ".join(info["important"]) or "nothing special"
        lines.append(f"{d.strftime('%a %d %b')} ({school}): {important}")
    return monday, lines


def build_review():
    data = review_data()
    monday, week_lines = next_week()
    sunday = monday + timedelta(days=6)

    todos = [t for t in data.get("todos", []) if not t.get("done")]
    overdue = [t for t in todos if t.get("due") and date.fromisoformat(t["due"]) < monday]
    this_week = [t for t in todos if t.get("due") and monday <= date.fromisoformat(t["due"]) <= sunday]
    no_date = [t for t in todos if not t.get("due")]
    fmt = lambda ts: "\n".join(f"#{t.get('id', '?')} {t['task']} (due {t.get('due') or 'no date'})" for t in ts) or "(none)"
    notes = "\n".join(f"#{n['id']} {n['text'][:200]}" for n in data.get("notes", [])) or "(none)"

    prompt = f"""You are Haneul, Alex's personal assistant and close friend: warm, enthusiastic about Alex's wins, kind but honest about what slipped (like a friend texting, never formal). Write the Sunday review for the week of
{monday.strftime('%A %d %B')} to {sunday.strftime('%A %d %B %Y')}. Alex is an 11th-grade student in TKS.
Write in {brief.CONFIG['language']}. It's read on a phone in Telegram, so plain text only, NO markdown
symbols like ** or #, one emoji only at the start of each section heading (none in the sentences), under 350 words. Use only the facts below.

Sections, in this order:
1. 📅 Next week: one line per day that has something important (skip quiet days, but mention days
   with no classes, e.g. holidays). Never invent events.
2. ⚠️ Deadlines: overdue first (call them out clearly), then what's due this week. Skip if none.
3. 📘 AP Physics: from the status below: hours this week, streak, on track or behind, and the
   focus for next week. Honest but encouraging. Skip if the status is empty.
4. 🔁 Habits: one line per habit (done/due this week, streak). Praise streaks, flag the weakest habit. Skip if none.
5. 💡 Ideas you saved this week: a short list. Skip if none.
6. 📓 From your journal: 1-2 sentences reflecting a pattern or highlight from this week's entries. Skip if none.
7. 🎯 Focus for the week: 3 concrete suggestions based on everything above
   (e.g. which evening to tackle a deadline, when to fit AP study around busy days).

NEXT WEEK'S CALENDAR:
{chr(10).join(week_lines)}

OVERDUE TO-DOS:
{fmt(overdue)}

DUE NEXT WEEK:
{fmt(this_week)}

TO-DOS WITHOUT A DATE:
{fmt(no_date)}

AP PHYSICS STATUS:
{data.get('ap') or ''}

IDEAS SAVED THIS WEEK:
{notes}

HABITS THIS WEEK:
{chr(10).join(f"{h['name']}: {h['done']}/{h['due']} done, streak {h['streak']}" for h in data.get("habits", [])) or "(none)"}

JOURNAL ENTRIES THIS WEEK:
{chr(10).join(f"{j['date']} {j['q']} -> {j['a'][:300]}" for j in data.get("journal", [])) or "(none)"}

KOREAN LESSONS COMPLETED SO FAR: {data.get("korean_lessons", 0)}
"""
    try:
        return brief.ask_gemini(prompt)
    except Exception as exc:
        print(f"Gemini failed, sending plain review: {exc}", file=sys.stderr)
        return (
            f"🗓️ Week of {monday.strftime('%d %b')}\n\n📅 Next week\n" + "\n".join(week_lines) +
            f"\n\n⚠️ Overdue\n{fmt(overdue)}\n\n📌 Due this week\n{fmt(this_week)}" +
            (f"\n\n📘 AP Physics\n{data['ap']}" if data.get("ap") else "")
        )


if __name__ == "__main__":
    brief.load_env()
    review = build_review()
    if "--dry-run" in sys.argv:
        print(review)
    else:
        brief.send_telegram(review)
        brief.heartbeat("review")
        print("Review sent.")
