"""Monthly TKS update: a first draft of your Substack newsletter, written in the
style of your previous issue, from this month's data:
  - TKS sessions and important events (calendar)
  - Mindset of the Week drafts, ideas and saved links (bot)
  - finished to-dos and AP Physics time (bot)
  - last issue's "Next Month's Goals", so you can say how they went

Started by the bot on the last day of each month at 17:00 (or with /monthly).
Run locally:  py monthly_update.py            (sends it)
              py monthly_update.py --dry-run  (prints it)
"""

import html
import json
import os
import re
import sys
import urllib.request
import xml.etree.ElementTree as ET
from datetime import date, datetime, timedelta

import brief


def month_data(month):
    worker_url = os.environ.get("WORKER_URL", "").rstrip("/")
    secret = os.environ.get("WORKER_SECRET", "")
    empty = {"notes": [], "tks_drafts": [], "done": [], "ap": None}
    if not worker_url or not secret:
        return empty
    req = urllib.request.Request(
        f"{worker_url}/month-data?month={month}",
        headers={"Authorization": f"Bearer {secret}", "User-Agent": "morning-brief-bot/1.0"},
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            return json.loads(resp.read())
    except Exception as exc:
        print(f"Couldn't get month data from the bot: {exc}", file=sys.stderr)
        return empty


def html_to_text(raw):
    raw = re.sub(r"(?i)<br\s*/?>|</p>|</li>|</h\d>", "\n", raw)
    raw = re.sub(r"(?i)<li[^>]*>", "- ", raw)
    raw = re.sub(r"(?i)<h(\d)[^>]*>", lambda m: "\n" + "#" * int(m.group(1)) + " ", raw)
    text = html.unescape(re.sub(r"<[^>]+>", "", raw))
    return re.sub(r"\n{3,}", "\n\n", text).strip()


def last_newsletter():
    """Latest post from the Substack RSS feed: (title, plain text)."""
    feed = brief.CONFIG.get("newsletter_feed")
    if not feed:
        return "", ""
    try:
        root = ET.fromstring(brief.http_get(feed))
        item = root.find("./channel/item")
        ns = {"content": "http://purl.org/rss/1.0/modules/content/"}
        body = item.findtext("content:encoded", default="", namespaces=ns) or item.findtext("description", "")
        return item.findtext("title", ""), html_to_text(body)
    except Exception as exc:
        print(f"Couldn't read the newsletter feed: {exc}", file=sys.stderr)
        return "", ""


def notion_draft(draft):
    """Save the draft as a page in the Notion "Newsletter Drafts" table (via the bot). Returns its link or ""."""
    worker_url = os.environ.get("WORKER_URL", "").rstrip("/")
    secret = os.environ.get("WORKER_SECRET", "")
    if not worker_url or not secret:
        return ""
    month = datetime.now(brief.TZ).strftime("%B %Y")
    req = urllib.request.Request(
        f"{worker_url}/notion-draft",
        data=json.dumps({"title": f"{month} newsletter draft", "content": draft}).encode("utf-8"),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {secret}", "User-Agent": "morning-brief-bot/1.0"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.loads(resp.read()).get("url", "")
    except Exception as exc:
        print(f"Couldn't save the draft to Notion: {exc}", file=sys.stderr)
        return ""


def build_update():
    today = datetime.now(brief.TZ).date()
    first = today.replace(day=1)
    next_first = (first + timedelta(days=32)).replace(day=1)
    month_name = first.strftime("%B")
    next_month = next_first.strftime("%B")

    data = month_data(first.strftime("%Y-%m"))
    events = brief.collect_events(first, days=(next_first - first).days) or []
    important = [f"{e['start'][:10]} {e['title']}" for e in events if e["tag"] == "PERSONAL"]
    prev_title, prev_text = last_newsletter()

    ap = data.get("ap") or {}
    ap_text = (
        f"{round(ap.get('minutes', 0) / 60, 1)} hours studied this month; units finished so far: "
        f"{', '.join(u for u in ap.get('units_done', []) if u) or 'none yet'}\n{ap.get('summary', '')}"
        if ap else "(not tracked)"
    )
    join = lambda items, key: "\n".join(f"- {i[key][:400]}" for i in items) or "(none)"

    prompt = f"""Write a FIRST DRAFT of Alex Rivera's "{month_name} Newsletter!" for Substack.
Alex is an 11th-grade student in TKS (The Knowledge Society) who builds engineering projects.
This is a draft for Alex to edit, so mark anything you're unsure about with [check] and never invent
achievements, numbers, links or events that aren't in the data below.

COPY THE STYLE AND STRUCTURE OF ALEX'S PREVIOUS ISSUE (below):
- title line "{month_name} Newsletter!" and a one-line subtitle
- opens with "Hey everyone!" and a short intro paragraph
- sections, in this order: TKS Updates · Month's Highlights · Personal & Engineering Projects ·
  How last month's goals went · Next Month's Goals ({next_month})
  (drop "About Me"; it was only for the first issue)
- warm, earnest, first person ("I"), polished but conversational; NO emojis
- bullets for highlights/projects/goals; project bullets start with the project name and a colon
- ends with "Thanks for reading!", an invitation to reply with feedback, then "Best," and "Alex"
- plain text for Telegram: put each section heading on its own line in CAPITALS, no markdown symbols
- 350-550 words

For "How last month's goals went": go through the goals listed in the previous issue one by one and say
what the data shows (done / progress / no info → [check]).
For "Next Month's Goals": suggest 5-7 goals that build on this month (Alex will edit them).

PREVIOUS ISSUE ({prev_title or "not found"}):
{prev_text[:6000] or "(couldn't load it)"}

THIS MONTH'S DATA ({month_name} {first.year}):

Important calendar events (TKS sessions, meetings, deadlines):
{chr(10).join(important) or "(none)"}

Mindset of the Week drafts:
{join(data.get("tks_drafts", []), "text")}

Ideas and saved links:
{join(data.get("notes", []), "text")}

Finished to-dos:
{join(data.get("done", []), "task")}

AP Physics 1 self-study:
{ap_text}

Habits (days done this month, current streak):
{chr(10).join(f"- {h['name']}: {h['days_done']} days, streak {h['streak']}" for h in data.get("habits", [])) or "(none)"}

Korean lessons completed so far: {data.get("korean_lessons", 0)}

Nightly journal entries (use them for reflections and lessons learned, in Alex's own words where it fits):
{chr(10).join(f"- {j['date']} {j['q']} -> {j['a'][:300]}" for j in data.get("journal", [])) or "(none)"}

Long-term facts about Alex and the projects (context, don't list them):
{chr(10).join(f"- {m}" for m in data.get("memory", [])) or "(none)"}
"""
    try:
        return brief.ask_gemini(prompt)
    except Exception as exc:
        print(f"Gemini failed: {exc}", file=sys.stderr)
        return f"📰 Couldn't write the {month_name} draft right now (Gemini unavailable). Try /monthly again later."


if __name__ == "__main__":
    brief.load_env()
    draft = build_update()
    if "--dry-run" in sys.argv:
        print(draft)
    else:
        link = notion_draft(draft)
        if link:
            preview = draft[:1500] + ("…" if len(draft) > 1500 else "")
            brief.send_telegram(f"📰 Your monthly TKS update draft is in Notion, ready to edit:\n{link}\n\nPreview:\n\n{preview}")
        else:
            brief.send_telegram("📰 Your monthly TKS update draft. Edit it, then paste it into Substack:\n\n" + draft)
        brief.heartbeat("monthly")
        print("Draft sent.")
