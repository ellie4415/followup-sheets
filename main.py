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
import sys
import time
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import httpx
from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from fastapi.templating import Jinja2Templates

import lightspeed as ls
import sheets as sh
import store

# Log to STDOUT, not stderr — Railway paints all stderr output red, which
# makes routine INFO lines look like a wall of errors in the deploy log.
logging.basicConfig(level=logging.INFO, stream=sys.stdout,
                    format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("followup")

# ── Config ────────────────────────────────────────────────────────────────────

APP_URL       = os.environ.get("APP_URL", "http://localhost:8000").rstrip("/")
if APP_URL and "://" not in APP_URL:
    APP_URL = "https://" + APP_URL   # a scheme-less APP_URL makes the OAuth redirect loop
CLIENT_ID     = os.environ.get("LIGHTSPEED_CLIENT_ID", "")
CLIENT_SECRET = os.environ.get("LIGHTSPEED_CLIENT_SECRET", "")
SA_JSON       = os.environ.get("GOOGLE_SERVICE_ACCOUNT_JSON", "")
SHEET_ID      = os.environ.get("SHEET_ID", "")
WEBAPP_URL    = os.environ.get("SHEETS_WEBAPP_URL", "")   # Apps Script bridge (preferred)
SHEETS_SECRET = os.environ.get("SHEETS_SECRET", "")
MANAGER_WEBAPP_URL = os.environ.get("MANAGER_WEBAPP_URL", "")   # manager sheet bridge (optional)
MANAGER_SECRET     = os.environ.get("MANAGER_SECRET", "")
# Values pasted into Railway sometimes carry a trailing space/newline — which
# makes a correct-looking secret fail as "bad secret". Strip them all.
CLIENT_ID, CLIENT_SECRET, SHEET_ID, WEBAPP_URL, SHEETS_SECRET, MANAGER_WEBAPP_URL, MANAGER_SECRET = (
    v.strip() for v in (CLIENT_ID, CLIENT_SECRET, SHEET_ID, WEBAPP_URL, SHEETS_SECRET,
                        MANAGER_WEBAPP_URL, MANAGER_SECRET))
CHECKPOINT_EVERY = 150   # sales processed between progress checkpoints (see run_job)
MIN_CAMERA_PRICE = float(os.environ.get("MIN_CAMERA_PRICE", "100"))  # cheap disposables/novelty cameras don't qualify
# Discounts: the store usually recovers ~80% of a discount from the vendor
# (Ellie, Sept 2026), so only the unrecovered 20% counts against profit.
# 0 = Lightspeed's own report math (full discount hits profit); 100 = ignore discounts.
DISCOUNT_RECOVERY_PCT = float(os.environ.get("DISCOUNT_RECOVERY_PCT", "80"))
WATCH_CART_HOURS = int(os.environ.get("WATCH_CART_HOURS", "72"))     # how long an open cart stays on the watch list
WEEKLY_DAY       = int(os.environ.get("WEEKLY_DAY", "3"))            # 0=Mon … 3=Thu: sales-of-the-week night
TOP_SALES_PER_WEEK = int(os.environ.get("TOP_SALES_PER_WEEK", "2"))
RUN_HOURS_START = int(os.environ.get("RUN_HOURS_START", "8"))   # first hourly run (Pacific)
RUN_HOURS_END   = int(os.environ.get("RUN_HOURS_END", "20"))    # last hourly run (Pacific)
if not (0 <= RUN_HOURS_START <= RUN_HOURS_END <= 23):
    RUN_HOURS_START, RUN_HOURS_END = 0, 23
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

REFRESH_COOLDOWN = 600   # reuse a <10-min-old access token instead of refreshing


async def get_client() -> ls.LightspeedClient:
    """Return a ready client, refreshing the token only when the current one
    is older than REFRESH_COOLDOWN. Refreshes are serialized and the rotated
    refresh token is persisted BEFORE the function returns — losing a rotated
    token kills the whole grant (lab-sync, July 2 2026). The cooldown also
    keeps ad-hoc endpoints like /debug-sale from hammering the token endpoint
    into a 429."""
    import time as _time

    tokens = store.get_json("tokens")
    if not tokens or not tokens.get("refresh_token"):
        raise ls.AuthExpired("Not connected to Lightspeed — visit /auth")

    def _still_fresh(t: dict) -> bool:
        try:
            return (t.get("access_token")
                    and _time.time() - float(t.get("refreshed_at") or 0) < REFRESH_COOLDOWN)
        except (ValueError, TypeError):
            return False

    if _still_fresh(tokens):
        return ls.LightspeedClient(tokens["access_token"], tokens["account_id"])

    async with _refresh_lock:
        tokens = store.get_json("tokens")  # re-read: another coroutine may have rotated it
        if _still_fresh(tokens):
            return ls.LightspeedClient(tokens["access_token"], tokens["account_id"])
        try:
            fresh = await ls.do_refresh(CLIENT_ID, CLIENT_SECRET, tokens["refresh_token"])
        except httpx.HTTPStatusError as exc:
            if exc.response.status_code in (400, 401):
                raise ls.AuthExpired(
                    "Lightspeed rejected the refresh token — reconnect via /auth"
                ) from exc
            if exc.response.status_code == 429:
                raise RuntimeError(
                    "Lightspeed's token endpoint is rate-limiting us — wait a "
                    "minute and try again (no harm done)"
                ) from exc
            raise
        tokens["access_token"]  = fresh["access_token"]
        tokens["refresh_token"] = fresh["refresh_token"]
        tokens["refreshed_at"]  = _time.time()
        store.set_json("tokens", tokens)

    return ls.LightspeedClient(tokens["access_token"], tokens["account_id"])


# ── Sale fetching (sort=-saleID pagination; this account rejects timestamp filters) ──

BULK_RELATIONS = '["SaleLines","SaleLines.Item","Customer","Customer.Contact","SalePayments","SalePayments.PaymentType"]'
# Sales paid ENTIRELY with these payment types are charged to a customer
# account (POs pushed through the register) — no money received that day, so
# they never count as a Sale of the Week (Ellie, Sept 11 2026).
PO_PAYMENT_TYPES = [t.strip().lower() for t in
                    os.environ.get("PO_PAYMENT_TYPES", "Credit Account").split(",") if t.strip()]


async def _sale_payments(client: ls.LightspeedClient, sale: dict) -> list:
    """[{type, amount}] — embedded by the bulk fetch when available, else one call."""
    emb = sale.get("SalePayments")
    raw = ls.as_list(emb.get("SalePayment")) if isinstance(emb, dict) else None
    if raw is None:
        raw = await client.get_sale_payments(str(sale.get("saleID")))
    out = []
    for sp in raw:
        pt = sp.get("PaymentType") if isinstance(sp.get("PaymentType"), dict) else {}
        out.append({"type": str(pt.get("name") or sp.get("paymentTypeID") or "?"),
                    "amount": _fnum(sp.get("amount"))})
    return out


def _is_po(payments: list, total: float) -> bool:
    """True when the on-account payments cover the whole sale."""
    if total <= 0:
        return False
    on_account = sum(p["amount"] for p in payments
                     if any(k in p["type"].lower() for k in PO_PAYMENT_TYPES))
    return on_account >= total - 0.01


def _bulk_relations_ok() -> bool:
    return store.get("bulk_relations", "yes") != "no"


async def _lines_for(client: ls.LightspeedClient, sale: dict) -> list:
    """Line items: embedded by the bulk fetch when available, else one call."""
    emb = sale.get("SaleLines")
    if isinstance(emb, dict):
        lines = ls.as_list(emb.get("SaleLine"))
        if lines or emb == {} or "SaleLine" in emb:
            return lines
    return await client.get_sale_lines(str(sale.get("saleID")))


async def _customer_for(client: ls.LightspeedClient, sale: dict, cache: dict) -> dict:
    """Customer (+Contact): embedded by the bulk fetch when available, else one
    call, memoized per run."""
    cid = str(sale.get("customerID") or "0")
    if cid in ("", "0"):
        return {}
    emb = sale.get("Customer")
    if isinstance(emb, dict) and emb.get("customerID"):
        cache.setdefault(cid, emb)
        return emb
    if cid not in cache:
        cache[cid] = await client.get_customer(cid)
    return cache[cid]


async def fetch_new_sales(client: ls.LightspeedClient, cursor: int,
                          window_days: int = 0) -> list:
    """All sales with saleID > cursor, oldest first. When there is no cursor
    yet (first run) — or window_days is given — uses a timestamp window
    instead (reimport_days override, else LOOKBACK_DAYS)."""
    since_str = ""
    if window_days or cursor <= 0:
        cursor = 0
        days = window_days or int(store.get("reimport_days") or 0) or LOOKBACK_DAYS
        store.set("reimport_days", "")   # one-shot: consumed now, not on success
        since = datetime.now(tz=PACIFIC) - timedelta(days=days)
        since_str = since.astimezone(ZoneInfo("UTC")).strftime("%Y-%m-%dT%H:%M:%S+00:00")
        log.info(f"Lookback window: {days} days (since {since_str})")

    collected: list = []
    url = None
    for page in range(1, 61):
        try:
            if url:
                data = await client.get_url(url)
            else:
                params = {"limit": 100, "sort": "-saleID"}
                if _bulk_relations_ok():
                    # Line items + customer embedded in the list response: one
                    # request per 100 sales instead of 1-2 requests PER sale.
                    # This is what turns a 30-minute re-import into ~2 minutes.
                    params["load_relations"] = BULK_RELATIONS
                try:
                    data = await client.get("Sale.json", params=params)
                except httpx.HTTPStatusError as exc:
                    if exc.response.status_code == 400 and "load_relations" in params:
                        log.warning("Sale.json rejected load_relations — falling back "
                                    "to per-sale fetches for this account")
                        store.set("bulk_relations", "no")
                        data = await client.get("Sale.json",
                                                params={"limit": 100, "sort": "-saleID"})
                    else:
                        raise
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

def _sheets_configured() -> bool:
    return bool(WEBAPP_URL and SHEETS_SECRET) or bool(SA_JSON and SHEET_ID)


def _make_sheets():
    """Apps Script bridge when configured (no Google Cloud needed), else the
    service-account REST backend."""
    if WEBAPP_URL and SHEETS_SECRET:
        return sh.BridgeSheets(WEBAPP_URL, SHEETS_SECRET)
    return sh.Sheets(SA_JSON, SHEET_ID)


def _make_manager_sheets():
    """The manager performance sheet (docs/manager-bridge.gs) — optional;
    None disables that output entirely."""
    if MANAGER_WEBAPP_URL and MANAGER_SECRET:
        return sh.BridgeSheets(MANAGER_WEBAPP_URL, MANAGER_SECRET,
                               secret_name="MANAGER_SECRET")
    return None


def _year_tab(tab: str, date_str: str) -> str:
    """Manager-sheet tab per store per YEAR ('Reno 2026'), decided by the
    sale's own date so the January rollover needs no human action."""
    year = date_str.split("/")[-1] if date_str and date_str.count("/") == 2 \
        else str(datetime.now(tz=PACIFIC).year)
    return f"{tab} {year}"


def _store_tab(shop_name: str) -> str:
    n = (shop_name or "").lower()
    if "reno" in n:
        return "Reno"
    if "rocklin" in n:
        return "Rocklin"
    return ""


def _fnum(v) -> float:
    try:
        return float(v or 0)
    except (ValueError, TypeError):
        return 0.0


def _line_items(lines: list) -> list:
    """One dict per real line on the sale. employee_id is the LINE's employee
    — who actually sold the item — which can differ from whoever completed
    the sale at the register. cost is the line's cost basis (average cost, falling back to FIFO) scaled by quantity, for the manager sheet's profit
    column."""
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
        fifo = _fnum(sl.get("fifoCost"))
        avg  = _fnum(sl.get("avgCost"))
        # AVERAGE cost first: it reproduces the Cost/Profit columns of
        # Lightspeed's own Sales Listings report to the cent (verified on
        # sale 101770, Sept 2026); FIFO is the fallback when avg is 0.
        unit_cost = avg if avg > 0 else fifo
        out.append({
            "name":     name,
            "qty":      qty,
            "cat_id":   str(item.get("categoryID") or sl.get("categoryID") or ""),
            "subtotal": _fnum(sl.get("calcSubtotal") or sl.get("displayableSubtotal")),
            "emp_id":   str(sl.get("employeeID") or ""),
            "cost":     unit_cost * qty,
            "discount": _fnum(sl.get("calcLineDiscount")),   # signed like the line
            "fifo_raw": fifo,
            "avg_raw":  avg,
        })
    return out


def _purchased_text(items: list) -> str:
    # One line item per line — multiline cell in Sheets.
    parts = []
    for li in items:
        parts.append(f"{li['name']} ×{li['qty']}" if li["qty"] > 1 else li["name"])
    return "\n".join(parts)


def _money(v: float) -> str:
    return f"−${abs(v):,.2f}" if v < 0 else f"${v:,.2f}"


def _unit_price(li: dict) -> float:
    """Absolute per-unit price of a line (works for returns: -$1,150 ÷ -1 = $1,150)."""
    qty = abs(li["qty"]) or 1
    return abs(li["subtotal"]) / qty


def _line_profit(li: dict, recovery_pct: float = None) -> float:
    """subtotal − unrecovered discount − cost. calcSubtotal is PRE-discount
    and calcLineDiscount is the line's discount (verified Sept 2026: at 0%
    recovery this reproduces Lightspeed's Sales Listings profit exactly)."""
    rec = DISCOUNT_RECOVERY_PCT if recovery_pct is None else recovery_pct
    return li["subtotal"] - li["discount"] * (1 - rec / 100.0) - li["cost"]


def _is_camera_line(li: dict, qual_ids: set, excl_ids: set) -> bool:
    """A camera/lens line that counts as such: right category tree, not
    excluded, and at/above the price floor — a $30 keychain camera is not a
    camera purchase (MIN_CAMERA_PRICE, Ellie's rule Sept 10 2026)."""
    return (li["cat_id"] in qual_ids and li["cat_id"] not in excl_ids
            and _unit_price(li) >= MIN_CAMERA_PRICE)


def _manager_items_text(items: list, employees: dict, cashier: str) -> str:
    """'Seller — Item ×2 (return)' one per line (Ellie's chosen format).
    The leading 'Name — ' is load-bearing: the manager bridge script parses
    it to color the name — keep the separator exactly ' — '."""
    parts = []
    for li in items:
        who   = employees.get(li["emp_id"], "") or cashier or "?"
        label = li["name"]
        if li["qty"] > 1:
            label += f" ×{li['qty']}"
        if li["subtotal"] < 0:
            label += " (return)"
        parts.append(f"{who} — {label}")
    return "\n".join(parts)


def _salespeople(items: list, qual_ids: set, excl_ids: set,
                 employees: dict, sale_emp_id: str) -> list:
    """Names of who sold the qualifying item(s), not whoever rang the sale
    out. Priority: employees on qualifying camera/lens lines → employees on
    any counted (non-excluded) line → the sale's employee."""
    def names_for(emp_ids: list) -> list:
        seen: list = []
        for e in emp_ids:
            nm = employees.get(e, "")
            if nm and nm not in seen:
                seen.append(nm)
        return seen

    names = names_for([li["emp_id"] for li in items
                       if li["qty"] > 0 and _is_camera_line(li, qual_ids, excl_ids)
                       and li["emp_id"] not in ("", "0")])
    if not names:
        names = names_for([li["emp_id"] for li in items
                           if li["cat_id"] not in excl_ids
                           and li["emp_id"] not in ("", "0")])
    if not names:
        names = names_for([sale_emp_id])
    return names


def _employee_tab(name: str) -> str:
    """Sheet-tab-safe employee name; blank when it can't be a tab."""
    tab = name.strip()
    if not tab or tab in sh.STORE_TABS or tab == sh.SETTINGS_TAB:
        return ""
    return tab[:80]


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
        if not (CLIENT_ID and _sheets_configured()):
            raise RuntimeError("Missing configuration — check the checklist on the home page")

        client = await get_client()
        sheet  = _make_sheets()
        await sheet.ensure_setup()
        settings = await sheet.read_settings()
        threshold = settings["threshold"]

        categories = await client.get_categories()
        qual_ids   = ls.category_ids_under(categories, settings["categories"])
        excl_ids   = ls.category_ids_under(categories, settings["excluded"])
        for kind, roots in (("qualifying", settings["categories"]),
                            ("excluded", settings["excluded"])):
            for miss in ls.unmatched_roots(categories, roots):
                summary.setdefault("warnings", []).append(
                    f"{kind.capitalize()} category {miss!r} matches nothing in "
                    "Lightspeed — check the spelling on the Settings tab")
        shops     = await client.get_shops()
        employees = await client.get_employees()

        cursor = int(store.get("cursor") or 0)
        sales  = await fetch_new_sales(client, cursor)

        # Re-check sales previously skipped as open register carts. Carts can
        # complete hours or DAYS after first seen — long after the cursor has
        # moved past their saleID — so without this watch list they would be
        # lost forever (lab-sync lesson: completed='false' is a normal
        # transient state, not a terminal one).
        now = time.time()
        batch_ids  = {str(s.get("saleID") or "") for s in sales}
        prior      = store.get_json("pending_carts", []) or []
        first_seen = {str(p.get("id")): float(p.get("first_seen") or now) for p in prior}
        # Carts that don't complete within a couple of days basically never
        # do (Ellie, Sept 2026 — Lightspeed leaves abandoned carts open
        # forever). The real losses were same-day / next-day completions, so
        # a short window (WATCH_CART_HOURS, default 72 — covers a weekend)
        # catches those while keeping the list to a few dozen carts.
        pending_next: list = []
        recheck_ids: set = set()   # carts already on the watch list — a re-check
                                   # that's STILL open is not a new "skip"
        for p in prior:
            pid = str(p.get("id") or "")
            if not pid or pid in batch_ids:
                continue
            if now - first_seen[pid] > WATCH_CART_HOURS * 3600:
                continue   # abandoned — stop watching
            try:
                data = await client.get(f"Sale/{pid}.json")
                s = data.get("Sale")
                if isinstance(s, dict) and s:
                    recheck_ids.add(pid)
                    sales.append(s)   # re-evaluated below like any new sale
            except ls.AuthExpired:
                raise
            except Exception as exc:
                log.warning(f"Open-cart re-check {pid} failed, keeping on watch list: {exc}")
                pending_next.append(p)
        sales.sort(key=lambda s: int(s.get("saleID") or 0))

        existing = {}
        for tab in sh.STORE_TABS:
            existing[tab] = await sheet.existing_sale_ids(tab)

        manager = _make_manager_sheets()
        mgr_rows: dict = {}        # year tab ('Reno 2026') -> rows
        mgr_existing: dict = {}    # year tab -> sale IDs already there (fetched lazily)
        if manager is not None:
            await manager.ensure_setup()

        rows_by_tab: dict = {t: [] for t in sh.STORE_TABS}
        customer_cache: dict = {}
        max_id = cursor
        cursor_now = cursor

        async def flush(upto: int) -> None:
            """Checkpoint: append everything buffered so far to both sheets,
            advance the cursor to the last FULLY processed sale, persist the
            watch list. A run that dies later resumes from here instead of
            starting over — an aborted big re-import used to leave cursor=0
            and every hourly run re-attempted (and re-aborted) the whole
            window: the lab-sync July 3 rescan loop, recreated Sept 11."""
            nonlocal cursor_now
            for tab, rows in list(rows_by_tab.items()):
                if rows:
                    await sheet.append_rows(tab, rows)
                    summary["added"][tab] = summary["added"].get(tab, 0) + len(rows)
                    rows_by_tab[tab] = []
            if manager is not None:
                for ytab, rows in list(mgr_rows.items()):
                    if rows:
                        await manager.append_rows(ytab, rows)
                        key = f"{ytab} (manager)"
                        summary["added"][key] = summary["added"].get(key, 0) + len(rows)
                        mgr_rows[ytab] = []
            if upto > cursor_now:
                store.set("cursor", str(upto))
                cursor_now = upto
            store.set_json("pending_carts", pending_next[-500:])

        processed = 0
        last_done_id = cursor
        for sale in sales:
            sale_id = int(sale.get("saleID") or 0)
            # Checkpoint BEFORE touching this sale, with the cursor at the
            # previous sale — never past a sale that isn't fully processed.
            if processed and processed % CHECKPOINT_EVERY == 0:
                await flush(last_done_id)
                log.info(f"Checkpoint at sale {last_done_id} ({processed} processed)")
            processed += 1
            last_done_id = sale_id
            max_id  = max(max_id, sale_id)

            if str(sale.get("completed")) != "true":
                if str(sale_id) not in recheck_ids:   # NEW open cart
                    skip("not completed (open register cart)")
                pending_next.append({"id": str(sale_id),
                                     "first_seen": first_seen.get(str(sale_id), now)})
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
            # NOTE: the refund/zero-total gate moved BELOW the manager block —
            # exchanges (return + add-ons, often net-negative) belong on the
            # manager sheet with the return attributed to the original seller.

            customer_id  = str(sale.get("customerID") or "0")
            has_customer = customer_id not in ("", "0")

            lines = await _lines_for(client, sale)
            items = _line_items(lines)

            camera_hit = any(li["qty"] > 0 and _is_camera_line(li, qual_ids, excl_ids)
                             for li in items)
            # Threshold counts qualifying merchandise only: pre-tax, excluded
            # categories (repairs, lab work) don't count. Negative lines
            # (returns on an exchange) net against it.
            qualifying_total = sum(li["subtotal"] for li in items
                                   if li["cat_id"] not in excl_ids)
            over_threshold = threshold > 0 and qualifying_total >= threshold
            fu_candidate   = camera_hit or over_threshold

            # Manager sheet: SAME sale logic as the follow-up sheet — a
            # camera/lens item or the dollar threshold — but direction-blind
            # (a RETURNED camera also qualifies, threshold on absolute value)
            # so exchanges land with the return attributed to the original
            # seller. Walk-ins included, no email requirement.
            mgr_camera    = any(_is_camera_line(li, qual_ids, excl_ids) for li in items)
            mgr_threshold = threshold > 0 and abs(qualifying_total) >= threshold
            sale_date     = ls.format_date(sale.get("timeStamp", ""))
            ytab          = _year_tab(tab, sale_date)
            mgr_candidate = manager is not None and (mgr_camera or mgr_threshold)
            if mgr_candidate:
                if ytab not in mgr_existing:
                    mgr_existing[ytab] = await manager.existing_sale_ids(ytab)
                mgr_candidate = str(sale_id) not in mgr_existing[ytab]

            customer: dict = {}
            if has_customer and (mgr_candidate or (fu_candidate and total > 0)):
                customer = await _customer_for(client, sale, customer_cache)

            if mgr_candidate:
                c_first = (customer.get("firstName") or "").strip()
                c_last  = (customer.get("lastName") or "").strip()
                cashier = employees.get(str(sale.get("employeeID", "")), "")
                profit  = sum(_line_profit(li) for li in items
                              if li["cat_id"] not in excl_ids)
                # "Immediate" = Lightspeed's own number (full discount hits
                # profit); "Total" = after the vendor's recovery share.
                immediate = sum(_line_profit(li, 0) for li in items
                                if li["cat_id"] not in excl_ids)
                # Profit/total as plain NUMBERS: the manager sheet is a Sheets
                # Table with typed columns (Date / Currency), and "−$36.07"
                # text (Unicode minus) can't be parsed into a Currency column.
                row = [
                    sale_date,
                    f"{c_first} {c_last}".strip() or "(Walk-in)",
                    cashier,
                    _manager_items_text(items, employees, cashier),
                ]
                # Script v8+ has the Immediate Profit column before Total
                # Profit (Sale ID in H); older scripts read Sale ID from G, so
                # keep the 7-wide layout for them — never let the app and the
                # script disagree about the dedup column (Sept 10 lesson).
                if manager.script_version() >= 8:
                    row.append(round(immediate, 2))
                row += [round(profit, 2), round(total, 2), str(sale_id)]   # Sale ID last = dedup column
                mgr_rows.setdefault(ytab, []).append(row)
                mgr_existing[ytab].add(str(sale_id))

            # ── Follow-up sheet (original rules: customer + email required) ──
            if total <= 0:
                skip("refund / zero total")
                continue
            if not has_customer:
                skip("no customer on sale")
                continue
            if not fu_candidate:
                skip("not a qualifying purchase")
                continue
            emails = ls.customer_emails(customer)
            if not emails:
                skip("customer has no email")
                continue

            if str(sale_id) in existing[tab]:
                skip("already in sheet")
                continue

            first = (customer.get("firstName") or "").strip()
            last  = (customer.get("lastName") or "").strip()
            name  = f"{first} {last}".strip() or "(no name)"

            sellers = _salespeople(items, qual_ids, excl_ids, employees,
                                   str(sale.get("employeeID", "")))
            row = [
                ls.format_date(sale.get("timeStamp", "")),
                name,
                ls.customer_phone(customer),
                ", ".join(emails),
                _purchased_text(items),
                f"${total:,.2f}",
                ", ".join(sellers),
                "",   # Emailed? — staff's column
                "",   # Notes — staff's column
                str(sale_id),
            ]
            rows_by_tab[tab].append(row)
            existing[tab].add(str(sale_id))

            # A copy on each seller's own tab so staff can work just their
            # customers. Store tabs remain the master lists.
            if sheet.supports_dynamic_tabs():
                for seller in sellers:
                    emp_tab = _employee_tab(seller)
                    if not emp_tab:
                        continue
                    if emp_tab not in existing:
                        existing[emp_tab] = await sheet.existing_sale_ids(emp_tab)
                    if str(sale_id) in existing[emp_tab]:
                        continue
                    rows_by_tab.setdefault(emp_tab, []).append(row)
                    existing[emp_tab].add(str(sale_id))
            elif sellers:
                w = ("Employee tabs need the updated bridge script — repaste "
                     "docs/sheets-bridge.gs into Extensions → Apps Script (keep "
                     "your secret), then Deploy → Manage deployments → New version")
                if w not in summary.setdefault("warnings", []):
                    summary["warnings"].append(w)

        # Final checkpoint: appends whatever is left, cursor to the batch max.
        # A Sheets failure here leaves the cursor at the last good checkpoint;
        # the sheet-side dedup makes the retry harmless.
        await flush(max_id)
        summary["watching_open_carts"] = len(pending_next)
        summary["fetch_mode"] = "bulk (lines+customer embedded)" if _bulk_relations_ok() else "per-sale"

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


async def _weekly_candidates(client, settings: dict, excl_ids: set, shops: dict,
                             days: int = 7) -> dict:
    """Per store tab: every completed, paid, non-refund sale of the window
    with its merchandise profit — (profit, immediate, total, sale, items)."""
    sales = await fetch_new_sales(client, 0, window_days=days)
    candidates: dict = {t: [] for t in sh.STORE_TABS}
    for sale in sales:
        if str(sale.get("completed")) != "true" or str(sale.get("voided")) == "true":
            continue
        shop_name = shops.get(str(sale.get("shopID", "")), "")
        if shop_name.strip().lower() in settings["skip_shops"]:
            continue
        tab = _store_tab(shop_name)
        if not tab:
            continue
        total = _fnum(sale.get("calcTotal"))
        if total <= 0:
            continue   # refunds/exchanges are never the sale of the week
        items  = _line_items(await _lines_for(client, sale))
        profit = sum(_line_profit(li) for li in items if li["cat_id"] not in excl_ids)
        if profit > 0:
            immediate = sum(_line_profit(li, 0) for li in items
                            if li["cat_id"] not in excl_ids)
            candidates[tab].append((profit, immediate, total, sale, items))
    return candidates


async def _pick_top(client, cands: list, n: int) -> tuple:
    """Highest-profit sales first, skipping POs (fully charged to a customer
    account). Payments are only inspected for sales near the top, so the
    check costs at most a handful of extra calls even on the fallback path."""
    picked, po_skipped = [], 0
    for cand in sorted(cands, key=lambda c: c[0], reverse=True):
        if len(picked) >= n:
            break
        profit, immediate, total, sale, items = cand
        if _is_po(await _sale_payments(client, sale), total):
            po_skipped += 1
            continue
        picked.append(cand)
    return picked, po_skipped


async def weekly_job(trigger: str) -> dict:
    """Sales of the Week: rank the past 7 days of ALL transactions per store
    by merchandise profit (same definition as the Total Profit column) and
    append one gold marker row per store tab listing the top N — the week
    divider Chris reads from in the Friday meeting. Idempotent per week via
    the WEEK-<date> sale-ID sentinel."""
    now_p = datetime.now(tz=PACIFIC)
    week_end   = now_p.date()
    week_start = week_end - timedelta(days=6)
    week_id    = f"WEEK-{week_end:%Y-%m-%d}"
    summary = {
        "started": now_p.strftime("%-m/%-d/%Y %-I:%M %p"),
        "trigger": trigger, "ok": False, "week": f"{week_start:%-m/%-d}–{week_end:%-m/%-d}",
        "added": {}, "error": "",
    }
    try:
        manager = _make_manager_sheets()
        if manager is None:
            raise RuntimeError("Manager sheet is not configured")
        client = await get_client()
        sheet  = _make_sheets()
        await sheet.ensure_setup()
        settings = await sheet.read_settings()
        await manager.ensure_setup()

        categories = await client.get_categories()
        qual_ids   = ls.category_ids_under(categories, settings["categories"])
        excl_ids   = ls.category_ids_under(categories, settings["excluded"])
        shops      = await client.get_shops()
        employees  = await client.get_employees()

        candidates = await _weekly_candidates(client, settings, excl_ids, shops, days=7)

        for tab in sh.STORE_TABS:
            ytab = f"{tab} {week_end.year}"
            on_sheet = await manager.existing_sale_ids(ytab)
            if week_id in on_sheet:
                summary["added"][ytab] = "already posted"
                continue
            ranked, po_skipped = await _pick_top(client, candidates[tab], TOP_SALES_PER_WEEK)
            if po_skipped:
                summary.setdefault("po_skipped", {})[ytab] = po_skipped
            lines = []
            for rank, (profit, immediate, total, sale, items) in enumerate(ranked, start=1):
                sellers = _salespeople(items, qual_ids, excl_ids, employees,
                                       str(sale.get("employeeID", ""))) or ["?"]
                cust = await _customer_for(client, sale, {})
                cname = f"{(cust.get('firstName') or '').strip()} {(cust.get('lastName') or '').strip()}".strip() or "Walk-in"
                sid   = str(sale.get("saleID"))
                with_ = f" · with {', '.join(sellers[1:])}" if len(sellers) > 1 else ""
                # Seller name FIRST so the bridge script colors it like any row.
                head  = (f"{sellers[0]} — #{rank}{with_} · {_money(profit)} profit "
                         f"({_money(immediate)} immediate)")
                if sid in on_sheet:
                    # It qualified for its own row: point at it, keep this short.
                    lines.append(f"{head} · sale {sid} (see its row)")
                else:
                    # No camera/lens and under the threshold, so the sheet has
                    # no row for it — this is the only place its items appear.
                    cashier = employees.get(str(sale.get("employeeID", "")), "")
                    lines.append(f"{head} on {_money(total)} · {cname} · sale {sid} "
                                 "(not on sheet — all items:)")
                    lines.append("\n".join("    " + ln for ln in
                                           _manager_items_text(items, employees, cashier).split("\n")))
            if not lines:
                lines = ["No transactions with merchandise profit this week"]
            # A real date in the Date column (keeps the Table's column type
            # happy); the week label lives in the Customer cell.
            blanks = 3 if manager.script_version() >= 8 else 2   # profit cols + Sale Total
            row = [
                f"{week_end:%-m/%-d/%Y}",
                f"SALES OF THE WEEK  {week_start:%-m/%-d}–{week_end:%-m/%-d}",
                "",
                "\n".join(lines),
            ] + [""] * blanks + [week_id]
            await manager.append_rows(ytab, [row])
            summary["added"][ytab] = len(ranked)

        summary["ok"] = True
        log.info(f"Sales of the week posted: {summary['added']}")
    except ls.AuthExpired as exc:
        summary["error"] = str(exc)
    except Exception as exc:
        summary["error"] = f"{type(exc).__name__}: {exc}"
        log.exception("Weekly job failed")
    store.set_json("last_weekly", summary)
    return summary


async def _guarded(fn, trigger: str, key: str = "last_run") -> None:
    global _job_running
    if _job_lock.locked():
        return
    async with _job_lock:
        _job_running = True
        try:
            # Hard deadline — a hung run must never wedge the scheduler
            # (lab-sync July 3 lesson: everything inside a lock gets a timeout).
            # Big scans (re-imports, the weekly ranking, a run starting from
            # cursor 0) legitimately take a while; incremental runs don't.
            big = (trigger == "re-import" or key == "last_weekly"
                   or int(store.get("cursor") or 0) == 0)
            limit = 3 * 3600 if big else 1800
            await asyncio.wait_for(fn(trigger), timeout=limit)
        except asyncio.TimeoutError:
            store.set_json(key, {
                "started": datetime.now(tz=PACIFIC).strftime("%-m/%-d/%Y %-I:%M %p"),
                "trigger": trigger, "ok": False,
                "added": {t: 0 for t in sh.STORE_TABS}, "skipped": {},
                "error": f"Run exceeded the {limit // 60}-minute deadline and was aborted "
                         "(progress up to the last checkpoint is kept)",
            })
            log.error(f"Run aborted at {limit // 60}-minute deadline")
        finally:
            _job_running = False


async def _run_job_guarded(trigger: str) -> None:
    await _guarded(run_job, trigger, "last_run")


async def _run_weekly_guarded(trigger: str) -> None:
    await _guarded(weekly_job, trigger, "last_weekly")


# ── Scheduler ─────────────────────────────────────────────────────────────────

async def scheduler_loop() -> None:
    # Hourly at the top of the hour, open hours only (RUN_HOURS_START..END
    # Pacific, inclusive). Overnight it sleeps until the next morning's first
    # run, which also carries the daily full watch-list sweep (>20h gate).
    while True:
        now = datetime.now(tz=PACIFIC)
        nxt = now.replace(minute=0, second=0, microsecond=0) + timedelta(hours=1)
        while not (RUN_HOURS_START <= nxt.hour <= RUN_HOURS_END):
            nxt += timedelta(hours=1)
        store.set("next_run", nxt.strftime("%-m/%-d/%Y %-I:%M %p"))
        await asyncio.sleep((nxt - now).total_seconds())
        try:
            await _run_job_guarded("scheduled")
        except Exception:
            log.exception("Scheduled run crashed")
        # Sales of the Week: after the LAST sync of WEEKLY_DAY (Thursday
        # night by default), so the Friday meeting has the full Fri–Thu week.
        if nxt.weekday() == WEEKLY_DAY and nxt.hour == RUN_HOURS_END \
                and _make_manager_sheets() is not None:
            try:
                await _run_weekly_guarded("scheduled")
            except Exception:
                log.exception("Weekly job crashed")


@app.on_event("startup")
async def startup() -> None:
    # Route uvicorn's own loggers (server + access lines) to stdout too —
    # same Railway red-stderr reason as the basicConfig above.
    out = logging.StreamHandler(sys.stdout)
    out.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
    for name in ("uvicorn", "uvicorn.access", "uvicorn.error"):
        lg = logging.getLogger(name)
        lg.handlers = [out]
        lg.propagate = False
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
        "last_weekly":  store.get_json("last_weekly"),
        "manager_on":   _make_manager_sheets() is not None,
        "next_run":     store.get("next_run", ""),
        "config": {
            "Lightspeed client ID (LIGHTSPEED_CLIENT_ID)":            bool(CLIENT_ID),
            "Lightspeed client secret (LIGHTSPEED_CLIENT_SECRET)":    bool(CLIENT_SECRET),
            "Google Sheets connection (SHEETS_WEBAPP_URL + SHEETS_SECRET, "
            "or service account)":                                    _sheets_configured(),
            "Manager sheet — optional (MANAGER_WEBAPP_URL + "
            "MANAGER_SECRET)":                                        _make_manager_sheets() is not None,
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


@app.post("/weekly")
async def trigger_weekly():
    """Post Sales of the Week now (past 7 days). Idempotent per week."""
    if _job_lock.locked():
        return JSONResponse({"ok": False, "error": "A run is already in progress"}, status_code=409)
    if _make_manager_sheets() is None:
        return JSONResponse({"ok": False, "error": "Manager sheet is not configured"}, status_code=400)
    asyncio.create_task(_run_weekly_guarded("manual"))
    return {"ok": True}


@app.post("/reimport")
async def trigger_reimport(days: int = 0):
    """Reset the cursor and re-pull the lookback window (?days=N overrides
    the default for this one run, max 60). Safe to run any time: sale IDs
    already on the sheet are skipped, so this only fills gaps — to REGENERATE
    rows (new format/rules), delete them from the sheet first."""
    if _job_lock.locked():
        return JSONResponse({"ok": False, "error": "A run is already in progress"}, status_code=409)
    store.set("reimport_days", str(min(max(days, 0), 60)))
    store.set("cursor", "0")
    asyncio.create_task(_run_job_guarded("re-import"))
    return {"ok": True}


@app.get("/debug-tabs")
async def debug_tabs():
    """Row counts + cross-tab consistency: which employee-tab sale IDs are
    missing from the store (master) tabs, plus the open-cart watch list."""
    try:
        sheet = _make_sheets()
        await sheet.ensure_setup()
        tabs = await sheet.all_sale_ids()
        store_ids: set = set()
        for t in sh.STORE_TABS:
            store_ids |= tabs.get(t, set())
        # Raw per-tab ID lists (bridge only) reveal duplicate rows, which the
        # deduplicated sets can't show.
        raw_lists = getattr(sheet, "_state", {}).get("existing", {})
        report = {}
        for tab, ids in sorted(tabs.items()):
            entry = {"rows": len(ids)}
            raw = raw_lists.get(tab)
            if raw is not None and len(raw) != len(ids):
                entry["DUPLICATE_ROWS"] = len(raw) - len(ids)
            if tab not in sh.STORE_TABS:
                entry["sale_ids_missing_from_store_tabs"] = sorted(ids - store_ids)
                for t in sh.STORE_TABS:   # which store tab holds this person's sales
                    entry[f"on_{t}"] = len(ids & tabs.get(t, set()))
            report[tab] = entry
        return {
            "tabs":               report,
            "cursor":             store.get("cursor"),
            "pending_open_carts": store.get_json("pending_carts", []),
        }
    except Exception as exc:
        log.exception("debug-tabs failed")
        return JSONResponse({"error": f"{type(exc).__name__}: {exc}"}, status_code=500)


@app.get("/debug-weekly")
async def debug_weekly(days: int = 7, top: int = 5):
    """Preview the Sales-of-the-Week ranking without posting: top N per
    store with payment types, PO flag, and whether each sale has its own row."""
    try:
        manager = _make_manager_sheets()
        client  = await get_client()
        sheet   = _make_sheets()
        await sheet.ensure_setup()
        settings   = await sheet.read_settings()
        categories = await client.get_categories()
        excl_ids   = ls.category_ids_under(categories, settings["excluded"])
        shops      = await client.get_shops()
        employees  = await client.get_employees()
        cands = await _weekly_candidates(client, settings, excl_ids, shops, days=days)
        out = {}
        for tab in sh.STORE_TABS:
            ytab = f"{tab} {datetime.now(tz=PACIFIC).year}"
            on_sheet = set()
            if manager is not None:
                await manager.ensure_setup()
                on_sheet = await manager.existing_sale_ids(ytab)
            rows = []
            for profit, immediate, total, sale, items in sorted(cands[tab], key=lambda c: c[0], reverse=True)[:top]:
                pays = await _sale_payments(client, sale)
                rows.append({
                    "sale_id":   str(sale.get("saleID")),
                    "sellers":   _salespeople(items, set(), excl_ids, employees,
                                              str(sale.get("employeeID", ""))),
                    "profit":    _money(profit), "immediate": _money(immediate),
                    "total":     _money(total),
                    "payments":  [f"{p['type']} {_money(p['amount'])}" for p in pays],
                    "is_PO_excluded": _is_po(pays, total),
                    "has_own_row":    str(sale.get("saleID")) in on_sheet,
                    "items":     [li["name"] for li in items],
                })
            out[tab] = rows
        return {"window_days": days, "po_payment_types": PO_PAYMENT_TYPES, "ranking": out}
    except ls.AuthExpired as exc:
        return JSONResponse({"error": str(exc)}, status_code=503)
    except Exception as exc:
        log.exception("debug-weekly failed")
        return JSONResponse({"error": f"{type(exc).__name__}: {exc}"}, status_code=500)


@app.get("/debug-sale/{number}")
async def debug_sale(number: str):
    """Full qualification trace for one sale (ticket number or saleID) —
    shows exactly why it was or wasn't added."""
    try:
        client = await get_client()
        sheet  = _make_sheets()
        await sheet.ensure_setup()
        settings = await sheet.read_settings()

        categories = await client.get_categories()
        qual_ids   = ls.category_ids_under(categories, settings["categories"])
        excl_ids   = ls.category_ids_under(categories, settings["excluded"])
        shops      = await client.get_shops()
        employees  = await client.get_employees()

        # Ticket number first (what staff/the sheet show) — full tickets are
        # stored 8 digits ("00096017"), so also try the padded form. This
        # account can 400 on ticketNumber queries entirely (same family of
        # quirk as its timestamp filter), so tolerate failures and fall back
        # to treating the number as a raw saleID.
        sale = None
        candidates = [number]
        if number.isdigit() and len(number) < 8:
            candidates.append("00" + number.zfill(6))
        for cand in candidates:
            try:
                data  = await client.get("Sale.json", params={"ticketNumber": cand, "limit": 5})
                found = ls.as_list(data.get("Sale"))
                if found:
                    sale = found[0]
                    break
            except ls.AuthExpired:
                raise
            except Exception:
                continue
        if sale is None and number.isdigit():
            try:
                data = await client.get(f"Sale/{number}.json")
                s = data.get("Sale")
                if isinstance(s, dict) and s:
                    sale = s
            except ls.AuthExpired:
                raise
            except Exception:
                pass
        if sale is None:
            return JSONResponse({"error": f"Sale {number!r} not found in Lightspeed"},
                                status_code=404)

        sale_id = str(sale.get("saleID", ""))
        lines   = await client.get_sale_lines(sale_id)
        items   = _line_items(lines)

        try:
            total = float(sale.get("calcTotal") or 0)
        except (ValueError, TypeError):
            total = 0.0
        threshold = settings["threshold"]

        line_report = []
        for li in items:
            qualifies = li["qty"] > 0 and _is_camera_line(li, qual_ids, excl_ids)
            excluded  = li["cat_id"] in excl_ids
            line_report.append({
                "item":            li["name"],
                "qty":             li["qty"],
                "subtotal":        li["subtotal"],
                "unit_price":      round(_unit_price(li), 2),
                "category":        ls.category_path(categories, li["cat_id"]),
                "sold_by":         employees.get(li["emp_id"], "(none on line)"),
                "qualifying_item": qualifies,
                "excluded":        excluded,
                "counts_toward_threshold": not excluded,
                "cost_basis":      {"fifoCost": li["fifo_raw"], "avgCost": li["avg_raw"],
                                    "cost_used": round(li["cost"], 2)},
                "discount":        li["discount"],
                "profit_lightspeed_style": round(_line_profit(li, 0), 2),
                "profit":          round(_line_profit(li), 2),
            })

        camera_hit = any(l["qualifying_item"] for l in line_report)
        qualifying_total = sum(l["subtotal"] for l in line_report if not l["excluded"])
        over_threshold = threshold > 0 and qualifying_total >= threshold

        shop_name = shops.get(str(sale.get("shopID", "")), "")
        checks = {
            "completed":            str(sale.get("completed")) == "true",
            "not_voided":           str(sale.get("voided")) != "true",
            "shop":                 shop_name,
            "shop_recognized":      bool(_store_tab(shop_name)),
            "shop_not_skipped":     shop_name.strip().lower() not in settings["skip_shops"],
            "sale_total":           total,
            "sale_discount":        _fnum(sale.get("calcDiscount")),
            "discount_recovery_pct": DISCOUNT_RECOVERY_PCT,
            "total_positive":       total > 0,
            "has_customer":         str(sale.get("customerID") or "0") not in ("", "0"),
            "camera_or_lens_item":  camera_hit,
            "threshold":            threshold,
            "min_camera_price":     MIN_CAMERA_PRICE,
            "qualifying_total_pre_tax_non_excluded": round(qualifying_total, 2),
            "over_threshold":       over_threshold,
        }
        would_add = all([
            checks["completed"], checks["not_voided"], checks["shop_recognized"],
            checks["shop_not_skipped"], checks["total_positive"], checks["has_customer"],
            (camera_hit or over_threshold),
        ])

        cashier       = employees.get(str(sale.get("employeeID", "")), "")
        mgr_camera    = any(_is_camera_line(li, qual_ids, excl_ids) for li in items)
        mgr_threshold = threshold > 0 and abs(qualifying_total) >= threshold
        mgr_profit    = sum(_line_profit(li) for li in items
                            if li["cat_id"] not in excl_ids)
        manager_view = {
            "configured": _make_manager_sheets() is not None,
            "would_add": all([checks["completed"], checks["not_voided"],
                              checks["shop_recognized"], checks["shop_not_skipped"],
                              (mgr_camera or mgr_threshold)]),
            "camera_or_lens_item_any_direction": mgr_camera,
            "abs_total_vs_threshold": abs(round(qualifying_total, 2)),
            "cashier": cashier,
            "items_lines":
                _manager_items_text(items, employees, cashier).split("\n"),
            "total_profit": _money(mgr_profit),
            "total_profit_lightspeed_style": _money(sum(_line_profit(li, 0) for li in items
                                                        if li["cat_id"] not in excl_ids)),
            "sale_total": _money(total),
        }

        pays = await _sale_payments(client, sale)
        return {
            "sale_id":      sale_id,
            "ticket":       str(sale.get("ticketNumber", "")),
            "payments":     [f"{p['type']} {_money(p['amount'])}" for p in pays],
            "is_PO_(excluded_from_sales_of_the_week)": _is_po(pays, total),
            "would_add":    would_add,
            "added_because": ("camera/lens item" if camera_hit else
                              "over threshold" if over_threshold else "—"),
            "checks":       checks,
            "lines":        line_report,
            "manager_sheet": manager_view,
            "note": "customer email is checked at run time and not shown here",
        }
    except ls.AuthExpired as exc:
        return JSONResponse({"error": str(exc)}, status_code=503)
    except Exception as exc:
        log.exception("debug-sale failed")
        return JSONResponse({"error": f"{type(exc).__name__}: {exc}"}, status_code=500)


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
