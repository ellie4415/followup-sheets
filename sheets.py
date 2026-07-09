"""Google Sheets writer — service-account auth, append-only.

The app ONLY ever appends new rows and writes headers/defaults to brand-new
tabs. It never edits or deletes existing rows, so staff columns ("Emailed?",
"Notes") can never be clobbered by the automation.
"""

import asyncio
import json
import logging

import httpx
from google.oauth2 import service_account
from google.auth.transport.requests import Request as GoogleAuthRequest

log = logging.getLogger("followup")

SCOPES = ["https://www.googleapis.com/auth/spreadsheets"]
BASE   = "https://sheets.googleapis.com/v4/spreadsheets"

HEADERS = ["Date", "Customer", "Phone", "Email", "Purchased", "Sale Total",
           "Salesperson", "Emailed?", "Notes", "Sale ID"]

STORE_TABS = ["Reno", "Rocklin"]

SETTINGS_TAB      = "Settings"
SETTINGS_DEFAULTS = [
    ["Dollar threshold — any sale at/over this total qualifies (blank or 0 = off)", "300"],
    ["Qualifying categories — Lightspeed category names, comma-separated (items anywhere under these count)", "Cameras, Lenses"],
    ["Skip shops — sales from these Lightspeed shops are ignored, comma-separated", "Action Camera Online"],
    ["", ""],
    ["The app re-reads this tab on every run. Edit values in column B only.", ""],
]


class SheetsError(Exception):
    pass


class Sheets:
    def __init__(self, sa_json: str, spreadsheet_id: str):
        try:
            info = json.loads(sa_json)
        except ValueError as exc:
            raise SheetsError(f"GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON: {exc}")
        self.creds = service_account.Credentials.from_service_account_info(info, scopes=SCOPES)
        self.sid   = spreadsheet_id

    async def _token(self) -> str:
        if not self.creds.valid:
            # google-auth's refresh is blocking — keep it off the event loop
            await asyncio.to_thread(self.creds.refresh, GoogleAuthRequest())
        return self.creds.token

    async def _request(self, method: str, url: str, **kwargs) -> dict:
        token = await self._token()
        headers = {"Authorization": f"Bearer {token}"}
        async with httpx.AsyncClient() as http:
            r = await http.request(method, url, headers=headers, timeout=30, **kwargs)
        if r.status_code == 403:
            raise SheetsError(
                "Google Sheets returned 403 — share the spreadsheet with the "
                f"service account email ({self.creds.service_account_email}) as Editor."
            )
        if r.status_code == 404:
            raise SheetsError("Spreadsheet not found — check the SHEET_ID env var.")
        r.raise_for_status()
        return r.json() if r.content else {}

    # ── Setup ─────────────────────────────────────────────────────────────────

    async def ensure_setup(self) -> None:
        """Create missing tabs and write headers/defaults on NEW tabs only."""
        meta = await self._request("GET", f"{BASE}/{self.sid}?fields=sheets.properties.title")
        existing = {s["properties"]["title"] for s in meta.get("sheets", [])}

        wanted  = STORE_TABS + [SETTINGS_TAB]
        missing = [t for t in wanted if t not in existing]
        if missing:
            body = {"requests": [{"addSheet": {"properties": {"title": t}}} for t in missing]}
            await self._request("POST", f"{BASE}/{self.sid}:batchUpdate", json=body)
            log.info(f"Created missing tabs: {missing}")

        for tab in STORE_TABS:
            if tab in missing:
                await self._write_range(f"{tab}!A1", [HEADERS])
        if SETTINGS_TAB in missing:
            await self._write_range(f"{SETTINGS_TAB}!A1", SETTINGS_DEFAULTS)

    async def _write_range(self, a1: str, values: list) -> None:
        await self._request(
            "PUT",
            f"{BASE}/{self.sid}/values/{a1}?valueInputOption=RAW",
            json={"values": values},
        )

    # ── Settings ──────────────────────────────────────────────────────────────

    async def read_settings(self) -> dict:
        data = await self._request("GET", f"{BASE}/{self.sid}/values/{SETTINGS_TAB}!B1:B3")
        rows = data.get("values", [])

        def cell(i: int) -> str:
            return rows[i][0].strip() if i < len(rows) and rows[i] else ""

        raw_threshold = cell(0).replace("$", "").replace(",", "")
        try:
            threshold = float(raw_threshold) if raw_threshold else 0.0
        except ValueError:
            log.warning(f"Unreadable threshold {cell(0)!r} in Settings — treating as off")
            threshold = 0.0

        categories = [c.strip() for c in cell(1).split(",") if c.strip()]
        skip_shops = {s.strip().lower() for s in cell(2).split(",") if s.strip()}
        return {"threshold": threshold, "categories": categories, "skip_shops": skip_shops}

    # ── Rows ──────────────────────────────────────────────────────────────────

    async def existing_sale_ids(self, tab: str) -> set:
        """Sale IDs already on the tab (column J) — dedup safety net so a lost
        cursor or re-run can never produce duplicate rows."""
        data = await self._request("GET", f"{BASE}/{self.sid}/values/{tab}!J2:J")
        return {row[0].strip() for row in data.get("values", []) if row and row[0].strip()}

    async def append_rows(self, tab: str, rows: list) -> None:
        if not rows:
            return
        await self._request(
            "POST",
            f"{BASE}/{self.sid}/values/{tab}!A1:append"
            "?valueInputOption=RAW&insertDataOption=INSERT_ROWS",
            json={"values": rows},
        )
