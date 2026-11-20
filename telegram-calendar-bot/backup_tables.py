"""Adds the app database (messages, reactions, songs) to the weekly backup file.

The bot hands out each table in small pages (/backup-table), so no single request goes over
Cloudflare's free CPU limit. Used by .github/workflows/backup.yml:

    python telegram-calendar-bot/backup_tables.py /tmp/latest.json
"""

import json
import os
import sys
import urllib.request


def fetch(url, secret):
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {secret}", "User-Agent": "morning-brief-bot/1.0"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read())


def main():
    path = sys.argv[1]
    worker_url = os.environ["WORKER_URL"].rstrip("/")
    secret = os.environ["WORKER_SECRET"]
    backup = json.load(open(path, encoding="utf-8"))
    backup["db"] = {}
    for table in backup.get("tables", []):
        rows, columns, after = [], [], 0
        for _ in range(500):  # 500 pages x 400 rows is far more than the feed keeps
            page = fetch(f"{worker_url}/backup-table?table={table}&after={after}", secret)
            columns = page.get("columns", columns)
            rows += page.get("rows", [])
            if not page.get("next"):
                break
            after = page["next"]
        backup["db"][table] = {"columns": columns, "rows": rows}
        print(f"{table}: {len(rows)} rows")
    json.dump(backup, open(path, "w", encoding="utf-8"), ensure_ascii=False)


if __name__ == "__main__":
    main()
