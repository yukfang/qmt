#!/usr/bin/env python3
"""Poll Azure/local bridge debug logs every second and append to logs/qmt-debug.log"""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LOG_DIR = ROOT / "logs"
LOG_FILE = LOG_DIR / "qmt-debug.log"
STATE_FILE = LOG_DIR / "pull-state.json"

BASE_URL = os.environ.get("BRIDGE_URL", "https://ptrade.console.enrichlife.today").rstrip("/")
TOKEN = os.environ.get("BRIDGE_TOKEN", "")


def load_after() -> int:
    if not STATE_FILE.exists():
        return 0
    try:
        return int(json.loads(STATE_FILE.read_text()).get("after", 0))
    except Exception:
        return 0


def save_after(after: int) -> None:
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    STATE_FILE.write_text(json.dumps({"after": after}))


def fetch(after: int) -> dict:
    url = f"{BASE_URL}/api/debug?after={after}"
    req = urllib.request.Request(url)
    if TOKEN:
        req.add_header("X-Bridge-Token", TOKEN)
    with urllib.request.urlopen(req, timeout=8) as resp:
        return json.loads(resp.read().decode("utf-8"))


def main() -> int:
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    print(f"pulling {BASE_URL}/api/debug -> {LOG_FILE}", flush=True)
    after = load_after()
    while True:
        try:
            data = fetch(after)
            items = data.get("items") or []
            if items:
                with LOG_FILE.open("a", encoding="utf-8") as fh:
                    for item in items:
                        fh.write(
                            f"{item.get('id')} {item.get('ts')} {item.get('level')} {item.get('message')}\n"
                        )
                after = max(after, int(data.get("lastId") or items[-1]["id"]))
                save_after(after)
                print(f"wrote {len(items)} lines, after={after}", flush=True)
        except Exception as exc:
            print(f"pull error: {type(exc).__name__}: {exc}", flush=True)
        time.sleep(1)


if __name__ == "__main__":
    sys.exit(main())
