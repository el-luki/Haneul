"""Send today's and tomorrow's calendar events to the Telegram bot.

The bot (Cloudflare Worker) can't read the calendars itself cheaply, so GitHub
Actions runs this every hour. The bot then uses the list to send reminders
before important events and to answer /today.

Run locally:  py sync_schedule.py
"""

import json
import os
import sys
import urllib.request
from datetime import datetime, timedelta

import brief

SYNC_DAYS = 8


def main():
    brief.load_env()
    worker_url = os.environ.get("WORKER_URL", "").rstrip("/")
    secret = os.environ.get("WORKER_SECRET", "")
    if not worker_url or not secret:
        sys.exit("WORKER_URL / WORKER_SECRET are not set.")

    # 8 days, so Haneul can find free spots for tasks later in the week (Velocity challenges)
    first = datetime.now(brief.TZ).date()
    events = brief.collect_events(first, days=SYNC_DAYS)
    if events is None:
        sys.exit("GOOGLE_CALENDAR_ICS_URL is not set.")

    payload = {
        "synced_at": datetime.now(brief.TZ).isoformat(),
        "until": (first + timedelta(days=SYNC_DAYS - 1)).isoformat(),
        "events": events,
    }
    req = urllib.request.Request(
        f"{worker_url}/schedule",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {secret}",
            "User-Agent": "morning-brief-bot/1.0",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        print(f"Synced {len(events)} events: {resp.read().decode()}")


if __name__ == "__main__":
    main()
