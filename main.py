"""Follow-Up Sheets — Lightspeed → Google Sheets customer follow-up lists.

Standalone app, deliberately isolated from lab-sync: its own Lightspeed OAuth
client (own rate-limit bucket, own refresh-token chain), its own repo, its own
Railway service. A failure here can never touch lab order syncing.

What it does, once a day (and on demand): pulls new completed sales from
Lightspeed, keeps the ones worth a follow-up email — customer has an email on
file AND (the sale includes a camera/lens item OR the total is over the
configurable threshold) — and appends one row per sale to a Reno or Rocklin
tab of a Google Sheet. Append-only: staff notes columns are never touched.
"""

import asyncio
import logging
import os
import secrets
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import httpx
from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from fastapi.templating import Jinja2Templates

import lightspeed as ls
import sheets as sh
import store

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("followup")

# ── Config ────────────────────────────────────────────────────────────────────

APP_URL       = os.environ.get("APP_URL", "http://localhost:8000").rstrip("/")
CLIENT_ID     = os.environ.get("LIGHTSPEED_CLIENT_ID", "")
CLIENT_SECRET = os.environ.get("LIGHTSPEED_CLIENT_SECRET", "")
SA_JSON       = os.environ.get("GOOGLE_SERVICE_ACCOUNT_JSON", "")
SHEET_ID      = os.environ.get("SHEET_ID", "")
RUN_HOUR      = int(os.environ.get("RUN_HOUR", "6"))          # daily run, Pacific
LOOKBACK_DAYS = int(os.environ.get("LOOKBACK_DAYS", "7"))     # first run only
PACIFIC       = ZoneInfo("America/Los_Angeles")

REDIRECT_URI = f"{APP_URL}/auth/callback"

app       = FastAPI()
templates = Jinja2Templates(directory="templates")

_pkce_states: dict = {}          # state -> verifier (in-flight OAuth attempts)
_refresh_lock = asyncio.Lock()   # refreshes must NEVER run concurrently
_job_lock     = asyncio.Lock()   # one run at a time
_job_running  = False


# ── Lightspeed auth ───────────────────────────────────────────────────────────

async def get_client() -> ls.LightspeedClient:
    """Refresh the token (serialized) and return a ready client.

    The rotated refresh token is persisted BEFORE the function returns —
    losing a rotated token kills the whole grant (lab-sync, July 2 2026)."""
    tokens = store.get_json("tokens")
    if not tokens or not tokens.get("refresh_token"):
        raise ls.AuthExpired("Not connected to Lightspeed — visit /auth")

    async with _refresh_lock:
        tokens = store.get_json("tokens")  # re-read: another coroutine may have rotated it
        try:
            fresh = await ls.do_refresh(CLIENT_ID, CLIENT_SECRET, tokens["refresh_token"])
        except httpx.HTTPStatusError as exc:
            if exc.response.status_code in (400, 401):
                raise ls.AuthExpired(
                    "Lightspeed rejected the refresh token — reconnect via /auth"
                ) from exc
            raise
        tokens["access_token"]  = fresh["access_token"]
        tokens["refresh_token"] = fresh["refresh_token"]
        store.set_json("tokens", tokens)

    return ls.LightspeedClient(tokens["access_token"], tokens["account_id"])


# ── Sale fetching (sort=-saleID pagination; this account rejects timestamp filters) ──

async def fetch_new_sales(client: ls.LightspeedClient, cursor: int) -> list:
    """All sales with saleID > cursor, oldest first. When there is no cursor
    yet (first run), falls back to a LOOKBACK_DAYS timestamp window."""
    since_str = ""
    if cursor <= 0:
        since = datetime.now(tz=PACIFIC) - timedelta(days=LOOKBACK_DAYS)
        since_str = since.astimezone(ZoneInfo("UTC")).strftime("%Y-%m-%dT%H:%M:%S+00:00")

    collected: list = []
    url = None
    for page in range(1, 61):
        try:
            if url:
                data = await client.get_url(url)
            else:
                data = await client.get("Sale.json", params={"limit": 100, "sort": "-saleID"})
        except httpx.HTTPStatusError as exc:
            if exc.response.status_code == 401:
                raise ls.AuthExpired("Lightspeed authorization expired mid-run — visit /auth")
            raise
        batch = ls.as_list(data.get("Sale"))
        if not batch:
            break

        past_window = False
        for sale in batch:
            sale_id = int(sale.get("saleID") or 0)
            if cursor > 0:
                if sale_id <= cursor:
                    past_window = True
                    continue
            elif (sale.get("timeStamp") or "") < since_str:
                past_window = True
                continue
            collected.append(sale)

        if past_window:
            break
        url = (data.get("@attributes") or {}).get("next") or data.get("next")
        if not url or len(batch) < 100:
            break

    collected.sort(key=lambda s: int(s.get("saleID") or 0))
    log.info(f"Fetched {len(collected)} new sales (cursor={cursor})")
    return collected


# ── Qualification + row building ──────────────────────────────────────────────

def _store_tab(shop_name: str) -> str:
    n = (shop_name or "").lower()
    if "reno" in n:
        return "Reno"
    if "rocklin" in n:
        return "Rocklin"
    return ""


def _line_items(lines: list) -> list:
    """[(name, qty, category_id), ...] for every real line on the sale."""
    out = []
    for sl in lines:
        item = sl.get("Item") if isinstance(sl.get("Item"), dict) else {}
        name = (sl.get("itemDescription") or "").strip() \
            or (item.get("description") or item.get("customSku") or "").strip() \
            or (sl.get("note") or "").strip()
        if not name:
            continue
        try:
            qty = int(float(sl.get("unitQuantity") or 1))
        except (ValueError, TypeError):
            qty = 1
        cat_id = str(item.get("categoryID") or sl.get("categoryID") or "")
        out.append((name, qty, cat_id))
    return out


def _purchased_text(items: list) -> str:
    parts = []
    for name, qty, _ in items:
        parts.append(f"{name} ×{qty}" if qty > 1 else name)
    return ", ".join(parts)


async def run_job(trigger: str) -> dict:
    """One full pull → filter → append cycle. Returns the run summary."""
    summary = {
        "started":  datetime.now(tz=PACIFIC).strftime("%-m/%-d/%Y %-I:%M %p"),
        "trigger":  trigger,
        "ok":       False,
        "added":    {t: 0 for t in sh.STORE_TABS},
        "skipped":  {},
        "error":    "",
    }
    skipped = summary["skipped"]

    def skip(reason: str):
        skipped[reason] = skipped.get(reason, 0) + 1

    try:
        if not (CLIENT_ID and SA_JSON and SHEET_ID):
            raise RuntimeError("Missing configuration — check the checklist on the home page")

        client = await get_client()
        sheet  = sh.Sheets(SA_JSON, SHEET_ID)
        await sheet.ensure_setup()
        settings = await sheet.read_settings()
        threshold = settings["threshold"]

        categories = await client.get_categories()
        qual_ids   = ls.qualifying_category_ids(categories, settings["categories"])
        if settings["categories"] and not qual_ids:
            log.warning(f"No Lightspeed categories matched {settings['categories']} — "
                        "only the dollar threshold will qualify sales this run")
        shops     = await client.get_shops()
        employees = await client.get_employees()

        cursor = int(store.get("cursor") or 0)
        sales  = await fetch_new_sales(client, cursor)

        existing = {}
        for tab in sh.STORE_TABS:
            existing[tab] = await sheet.existing_sale_ids(tab)

        rows_by_tab: dict = {t: [] for t in sh.STORE_TABS}
        customer_cache: dict = {}
        max_id = cursor

        for sale in sales:
            sale_id = int(sale.get("saleID") or 0)
            max_id  = max(max_id, sale_id)

            if str(sale.get("completed")) != "true":
                skip("not completed (open register cart)")
                continue
            if str(sale.get("voided")) == "true":
                skip("voided")
                continue

            shop_name = shops.get(str(sale.get("shopID", "")), "")
            if shop_name.strip().lower() in settings["skip_shops"]:
                skip("skipped shop")
                continue
            tab = _store_tab(shop_name)
            if not tab:
                skip("unrecognized shop")
                continue

            try:
                total = float(sale.get("calcTotal") or 0)
            except (ValueError, TypeError):
                total = 0.0
            if total <= 0:
                skip("refund / zero total")
                continue

            customer_id = str(sale.get("customerID") or "0")
            if customer_id in ("", "0"):
                skip("no customer on sale")
                continue

            lines = await client.get_sale_lines(str(sale_id))
            items = _line_items(lines)

            camera_hit = any(qty > 0 and cat_id in qual_ids for _, qty, cat_id in items)
            over_threshold = threshold > 0 and total >= threshold
            if not (camera_hit or over_threshold):
                skip("not a qualifying purchase")
                continue

            if customer_id not in customer_cache:
                customer_cache[customer_id] = await client.get_customer(customer_id)
            customer = customer_cache[customer_id]
            emails   = ls.customer_emails(customer)
            if not emails:
                skip("customer has no email")
                continue

            if str(sale_id) in existing[tab]:
                skip("already in sheet")
                continue

            first = (customer.get("firstName") or "").strip()
            last  = (customer.get("lastName") or "").strip()
            name  = f"{first} {last}".strip() or "(no name)"

            rows_by_tab[tab].append([
                ls.format_date(sale.get("timeStamp", "")),
                name,
                ls.customer_phone(customer),
                ", ".join(emails),
                _purchased_text(items),
                f"${total:,.2f}",
                employees.get(str(sale.get("employeeID", "")), ""),
                "",   # Emailed? — staff's column
                "",   # Notes — staff's column
                str(sale_id),
            ])
            existing[tab].add(str(sale_id))

        for tab in sh.STORE_TABS:
            await sheet.append_rows(tab, rows_by_tab[tab])
            summary["added"][tab] = len(rows_by_tab[tab])

        # Advance the cursor only after every append succeeded — a Sheets
        # failure means the whole batch is retried next run (the sheet-side
        # dedup makes retries harmless).
        if max_id > cursor:
            store.set("cursor", str(max_id))

        summary["ok"] = True
        log.info(f"Run complete: +{summary['added']} skipped={skipped}")
    except ls.AuthExpired as exc:
        summary["error"] = str(exc)
        log.error(f"Run failed — auth: {exc}")
    except Exception as exc:
        summary["error"] = f"{type(exc).__name__}: {exc}"
        log.exception("Run failed")

    store.set_json("last_run", summary)
    return summary


async def _run_job_guarded(trigger: str) -> None:
    global _job_running
    if _job_lock.locked():
        return
    async with _job_lock:
        _job_running = True
        try:
            # Hard deadline — a hung run must never wedge the scheduler
            # (lab-sync July 3 lesson: everything inside a lock gets a timeout).
            await asyncio.wait_for(run_job(trigger), timeout=1800)
        except asyncio.TimeoutError:
            store.set_json("last_run", {
                "started": datetime.now(tz=PACIFIC).strftime("%-m/%-d/%Y %-I:%M %p"),
                "trigger": trigger, "ok": False,
                "added": {t: 0 for t in sh.STORE_TABS}, "skipped": {},
                "error": "Run exceeded the 30-minute deadline and was aborted",
            })
            log.error("Run aborted at 30-minute deadline")
        finally:
            _job_running = False


# ── Scheduler ─────────────────────────────────────────────────────────────────

async def scheduler_loop() -> None:
    while True:
        now = datetime.now(tz=PACIFIC)
        nxt = now.replace(hour=RUN_HOUR, minute=0, second=0, microsecond=0)
        if nxt <= now:
            nxt += timedelta(days=1)
        store.set("next_run", nxt.strftime("%-m/%-d/%Y %-I:%M %p"))
        await asyncio.sleep((nxt - now).total_seconds())
        try:
            await _run_job_guarded("scheduled")
        except Exception:
            log.exception("Scheduled run crashed")


@app.on_event("startup")
async def startup() -> None:
    store.init()
    asyncio.create_task(scheduler_loop())


# ── Routes ────────────────────────────────────────────────────────────────────

@app.get("/", response_class=HTMLResponse)
async def home(request: Request):
    tokens = store.get_json("tokens") or {}
    return templates.TemplateResponse("index.html", {
        "request":      request,
        "connected":    bool(tokens.get("refresh_token")),
        "redirect_uri": REDIRECT_URI,
        "app_url":      APP_URL,
        "running":      _job_running,
        "last_run":     store.get_json("last_run"),
        "next_run":     store.get("next_run", ""),
        "config": {
            "Lightspeed client ID (LIGHTSPEED_CLIENT_ID)":            bool(CLIENT_ID),
            "Lightspeed client secret (LIGHTSPEED_CLIENT_SECRET)":    bool(CLIENT_SECRET),
            "Google service account (GOOGLE_SERVICE_ACCOUNT_JSON)":   bool(SA_JSON),
            "Spreadsheet ID (SHEET_ID)":                              bool(SHEET_ID),
        },
    })


@app.get("/health")
async def health():
    return {"ok": True}


@app.get("/api/status")
async def api_status():
    tokens = store.get_json("tokens") or {}
    return {
        "connected": bool(tokens.get("refresh_token")),
        "running":   _job_running,
        "last_run":  store.get_json("last_run"),
        "next_run":  store.get("next_run", ""),
    }


@app.post("/run")
async def trigger_run():
    if _job_lock.locked():
        return JSONResponse({"ok": False, "error": "A run is already in progress"}, status_code=409)
    asyncio.create_task(_run_job_guarded("manual"))
    return {"ok": True}


@app.get("/auth")
async def auth_start():
    if not CLIENT_ID:
        return HTMLResponse("LIGHTSPEED_CLIENT_ID is not set yet — add it in Railway first.", status_code=400)
    verifier, challenge = ls.pkce_pair()
    state = secrets.token_urlsafe(24)
    _pkce_states[state] = verifier
    if len(_pkce_states) > 20:   # drop abandoned attempts
        for k in list(_pkce_states)[:-10]:
            _pkce_states.pop(k, None)
    return RedirectResponse(ls.build_auth_url(CLIENT_ID, REDIRECT_URI, challenge, state))


@app.get("/auth/callback")
async def auth_callback(code: str = "", state: str = ""):
    verifier = _pkce_states.pop(state, None)
    if not code or verifier is None:
        return HTMLResponse("OAuth state mismatch — go back and click Connect again.", status_code=400)
    try:
        tokens = await ls.exchange_code(CLIENT_ID, CLIENT_SECRET, code, verifier, REDIRECT_URI)
    except httpx.HTTPStatusError as exc:
        return HTMLResponse(f"Token exchange failed ({exc.response.status_code}) — "
                            "check the client ID/secret and redirect URI match the "
                            "Lightspeed app registration exactly.", status_code=400)
    store.set_json("tokens", tokens)
    log.info(f"Connected to Lightspeed account {tokens['account_id']}")
    return RedirectResponse("/", status_code=303)
