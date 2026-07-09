"""Tiny SQLite key/value state store.

Lives on the Railway volume (DATA_DIR env var, mount the volume at /data).
Holds three things: the Lightspeed tokens, the saleID cursor, and the last
run summary. If the volume is ever lost the only real casualty is the
rotating refresh token — reconnect via /auth and re-run; the spreadsheet
dedup check prevents duplicate rows.
"""

import json
import os
import sqlite3
import threading

DATA_DIR = os.environ.get("DATA_DIR", os.path.join(os.path.dirname(__file__), "data"))
DB_PATH  = os.path.join(DATA_DIR, "followup.db")

_lock = threading.Lock()


def _conn() -> sqlite3.Connection:
    os.makedirs(DATA_DIR, exist_ok=True)
    c = sqlite3.connect(DB_PATH, timeout=10)
    c.execute("PRAGMA journal_mode=WAL")
    return c


def init() -> None:
    with _lock, _conn() as c:
        c.execute("CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT)")


def get(key: str, default=None):
    with _lock, _conn() as c:
        row = c.execute("SELECT value FROM kv WHERE key = ?", (key,)).fetchone()
    if row is None:
        return default
    return row[0]


def set(key: str, value: str) -> None:
    with _lock, _conn() as c:
        c.execute(
            "INSERT INTO kv (key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, str(value)),
        )


def get_json(key: str, default=None):
    raw = get(key)
    if raw is None:
        return default
    try:
        return json.loads(raw)
    except (ValueError, TypeError):
        return default


def set_json(key: str, value) -> None:
    set(key, json.dumps(value))
