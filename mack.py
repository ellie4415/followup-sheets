"""Mack warranty registrations (third output, Oct 2026).

Replaces the Forms on Fire tablet form. Two jobs:

1. Every hourly run: find each Mack warranty SOLD or RETURNED and send one
   "unit" per warranty to the Mack spreadsheet (docs/mack-bridge.gs). The
   sheet tracks which units still need registering, and returns cancel the
   unit they reverse (SaleLine.parentSaleLineID).

2. On demand (GET /mack/sale/{number}, called by the Mack spreadsheet's
   script on behalf of the Chrome extension's review panel): everything
   Lightspeed knows about one receipt (customer, items, brands, serials,
   prices) so staff only confirm which items are covered and type what
   Lightspeed doesn't have (usually the lens serial on a kit).

Isolation: a Mack failure must never stall the follow-up or manager sheets.
Units go into a persistent outbox (SQLite) at every checkpoint, BEFORE the
cursor advances, and are sent separately; anything that fails to send is
retried on the next run. The sheet dedups by unit key, so retries are safe.
"""

import logging
import os
import re
import time
from datetime import datetime
from zoneinfo import ZoneInfo

import httpx

import lightspeed as ls
import store

log = logging.getLogger("followup")

PACIFIC = ZoneInfo("America/Los_Angeles")

MACK_WEBAPP_URL = os.environ.get("MACK_WEBAPP_URL", "").strip()
MACK_SECRET     = os.environ.get("MACK_SECRET", "").strip()
# Lightspeed item names of Mack warranties start with "Mack" ("Mack 3 Yr Under
# $2000 Diamond OL"). Regex, case-insensitive.
MACK_ITEM_PATTERN = re.compile(os.environ.get("MACK_ITEM_PATTERN", r"^\s*mack\b"), re.I)
OUTBOX_KEY = "mack_outbox"
OUTBOX_CAP = 2000


def enabled() -> bool:
    return bool(MACK_WEBAPP_URL and MACK_SECRET)


# ── Small parsers ─────────────────────────────────────────────────────────────

def _fnum(v) -> float:
    try:
        return float(v or 0)
    except (ValueError, TypeError):
        return 0.0


def _qty(line: dict) -> int:
    try:
        return int(float(line.get("unitQuantity") or 0))
    except (ValueError, TypeError):
        return 0


def line_name(line: dict) -> str:
    item = line.get("Item") if isinstance(line.get("Item"), dict) else {}
    return ((line.get("itemDescription") or "").strip()
            or (item.get("description") or item.get("customSku") or "").strip())


def is_mack(name: str) -> bool:
    return bool(name and MACK_ITEM_PATTERN.search(name))


def parse_plan(name: str) -> dict:
    """'Mack 3 Yr Under $2000 Diamond OL' -> years 3, coverage 2000, New.
    Used warranties are their own items ('Mack 1 Yr Used Photo Under $1000 OL')."""
    years = re.search(r"(\d+)\s*-?\s*(?:yr|year)", name or "", re.I)
    under = re.search(r"under\s*\$?\s*([\d,]+)", name or "", re.I)
    return {
        "years":     int(years.group(1)) if years else None,
        "coverage":  int(under.group(1).replace(",", "")) if under else None,
        "condition": "Used" if re.search(r"\bused\b", name or "", re.I) else "New",
    }


def unit_price(line: dict) -> float:
    """What the customer paid per unit, after line discounts (instant rebates
    included), before tax. calcSubtotal is PRE-discount and calcLineDiscount
    is the line's discount (both signed like the line)."""
    qty = abs(_qty(line)) or 1
    sub = _fnum(line.get("calcSubtotal") or line.get("displayableSubtotal"))
    disc = _fnum(line.get("calcLineDiscount"))
    return round(abs(sub - disc) / qty, 2)


def regular_price(line: dict) -> float:
    """The item's normal selling price (Lightspeed 'Default' price), for
    employee purchases through a manufacturer program (Mack: use the
    pre-discount price). Falls back to the line's normal unit price."""
    item = line.get("Item") if isinstance(line.get("Item"), dict) else {}
    prices = item.get("Prices") if isinstance(item.get("Prices"), dict) else {}
    for p in ls.as_list(prices.get("ItemPrice")):
        if str(p.get("useType") or "").lower() == "default" and _fnum(p.get("amount")) > 0:
            return round(_fnum(p.get("amount")), 2)
    return round(_fnum(line.get("normalUnitPrice")) or unit_price(line), 2)


def mack_date(iso_str: str) -> str:
    """Mack's file uses MM-DD-YYYY."""
    if not iso_str:
        return ""
    try:
        dt = datetime.fromisoformat(iso_str.replace("Z", "+00:00")).astimezone(PACIFIC)
        return dt.strftime("%m-%d-%Y")
    except ValueError:
        return ""


def customer_name(customer: dict) -> str:
    return f"{(customer.get('firstName') or '').strip()} {(customer.get('lastName') or '').strip()}".strip()


def customer_details(customer: dict) -> dict:
    """The registration's customer block from a Customer (+Contact)."""
    contact = customer.get("Contact") if isinstance(customer.get("Contact"), dict) else {}
    addrs = contact.get("Addresses") if isinstance(contact.get("Addresses"), dict) else {}
    addr = next(iter(ls.as_list(addrs.get("ContactAddress"))), {})
    emails = ls.customer_emails(customer)
    return {
        "id":       str(customer.get("customerID") or ""),
        "first":    (customer.get("firstName") or "").strip(),
        "last":     (customer.get("lastName") or "").strip(),
        "company":  (customer.get("company") or "").strip(),
        "address1": (addr.get("address1") or "").strip(),
        "address2": (addr.get("address2") or "").strip(),
        "city":     (addr.get("city") or "").strip(),
        "state":    (addr.get("state") or "").strip(),
        "zip":      (addr.get("zip") or "").strip(),
        "phone":    ls.customer_phone(customer).strip(),
        "email":    emails[0] if emails else "",
    }


# ── 1. Units for the hourly run ───────────────────────────────────────────────

def sold_units(sale: dict, lines: list, store_name: str, employees: dict,
               customer: dict) -> list:
    """One unit per Mack warranty on this sale: +1 per unit sold, -1 per unit
    returned. Keys are stable across runs: '<lineID>-<n>' for sales and
    'R<lineID>-<n>' for returns, so re-sending is harmless."""
    units = []
    sale_id = str(sale.get("saleID") or "")
    when = mack_date(sale.get("completeTime") or sale.get("timeStamp") or "")
    for line in lines:
        name = line_name(line)
        qty = _qty(line)
        if not qty or not is_mack(name):
            continue
        line_id = str(line.get("saleLineID") or "")
        seller = (employees.get(str(line.get("employeeID") or ""), "")
                  or employees.get(str(sale.get("employeeID") or ""), ""))
        for n in range(1, abs(qty) + 1):
            units.append({
                "key":         f"{'R' if qty < 0 else ''}{line_id}-{n}",
                "date":        when,
                "store":       store_name,
                "sale_id":     sale_id,
                "item":        name,
                "price":       unit_price(line),
                "qty":         1 if qty > 0 else -1,
                "customer":    customer_name(customer),
                "customer_id": str(sale.get("customerID") or ""),
                "salesperson": seller,
                "line_id":     line_id,
                "reverses":    str(line.get("parentSaleLineID") or "") if qty < 0 else "",
            })
    return units


def outbox_add(units: list) -> None:
    if not units:
        return
    box = store.get_json(OUTBOX_KEY, []) or []
    seen = {u.get("key") for u in box}
    box.extend(u for u in units if u.get("key") not in seen)
    if len(box) > OUTBOX_CAP:
        log.warning(f"Mack outbox over {OUTBOX_CAP}; dropping the oldest {len(box) - OUTBOX_CAP}")
        box = box[-OUTBOX_CAP:]
    store.set_json(OUTBOX_KEY, box)


async def send_outbox() -> dict:
    """Send pending units to the Mack sheet. Leaves them queued on failure."""
    box = store.get_json(OUTBOX_KEY, []) or []
    if not box:
        return {"sent": 0, "added": 0}
    data = await _bridge_post({"action": "sold", "units": box})
    store.set_json(OUTBOX_KEY, [])
    return {"sent": len(box), "added": int(data.get("added") or 0)}


async def _bridge_post(body: dict) -> dict:
    async with httpx.AsyncClient(follow_redirects=True) as http:
        r = await http.post(MACK_WEBAPP_URL, json={"secret": MACK_SECRET, **body}, timeout=60)
    if r.status_code == 404:
        raise RuntimeError("The Mack sheet returned 404. Check MACK_WEBAPP_URL is the "
                           "ACTIVE deployment's /exec URL (Manage deployments).")
    r.raise_for_status()
    try:
        data = r.json()
    except ValueError:
        raise RuntimeError("The Mack sheet did not return JSON. Check its web app "
                           "access is 'Anyone' and the URL ends in /exec.")
    if data.get("error"):
        raise RuntimeError(f"Mack sheet: {data['error']} (check MACK_SECRET matches "
                           "the SECRET in the Mack sheet's script)")
    return data


# ── 2. One receipt, for the review panel ──────────────────────────────────────

_manufacturers: dict = {}   # manufacturerID -> name, kept for the process lifetime


async def _brand(client: ls.LightspeedClient, item: dict) -> str:
    mid = str(item.get("manufacturerID") or "0")
    if mid in ("", "0"):
        return ""
    if mid not in _manufacturers:
        try:
            data = await client.get(f"Manufacturer/{mid}.json")
            m = data.get("Manufacturer")
            m = m[0] if isinstance(m, list) and m else m
            _manufacturers[mid] = (m.get("name") or "").strip() if isinstance(m, dict) else ""
        except ls.AuthExpired:
            raise
        except Exception as exc:
            log.warning(f"Manufacturer {mid} lookup failed: {exc}")
            return ""
    return _manufacturers[mid]


async def _serials(client: ls.LightspeedClient, line_id: str) -> list:
    """Serial numbers Lightspeed recorded for this sale line (serialized items)."""
    try:
        data = await client.get("Serialized.json", params={"saleLineID": line_id, "limit": 20})
    except ls.AuthExpired:
        raise
    except httpx.HTTPStatusError as exc:
        if exc.response.status_code == 401:
            raise
        log.warning(f"Serialized lookup for line {line_id} failed: {exc}")
        return []
    out = []
    for s in ls.as_list(data.get("Serialized")):
        serial = (s.get("serial") or "").strip()
        if serial and serial not in out:
            out.append(serial)
    return out


def model_from(name: str, brand: str) -> str:
    """Item name without the leading brand ('Canon EOS R7' -> 'EOS R7')."""
    n = (name or "").strip()
    if brand and n.lower().startswith(brand.lower()):
        n = n[len(brand):].strip(" -")
    return n


async def sale_bundle(client: ls.LightspeedClient, number: str, ctx: dict) -> dict:
    """Everything the review panel needs for one receipt. ctx carries
    shops, employees, categories and the camera/lens category IDs."""
    sale = await client.find_sale(number)
    if sale is None:
        return {"error": f"Receipt {number} was not found in Lightspeed."}
    sale_id = str(sale.get("saleID") or "")
    lines = await client.get_sale_lines(sale_id)
    customer: dict = {}
    cid = str(sale.get("customerID") or "0")
    if cid not in ("", "0"):
        customer = await client.get_customer(cid)

    employees = ctx.get("employees", {})
    out_lines = []
    for line in lines:
        name = line_name(line)
        qty = _qty(line)
        if not name or not qty:
            continue
        item = line.get("Item") if isinstance(line.get("Item"), dict) else {}
        line_id = str(line.get("saleLineID") or "")
        mack = is_mack(name)
        brand = "" if mack else await _brand(client, item)
        cat_id = str(item.get("categoryID") or line.get("categoryID") or "")
        price = unit_price(line)
        out_lines.append({
            "line_id":   line_id,
            "name":      name,
            "brand":     brand,
            "model":     model_from(name, brand),
            "qty":       qty,
            "price":     price,
            "regular_price": regular_price(line),
            "category":  ls.category_path(ctx.get("categories", []), cat_id),
            "camera_or_lens": (cat_id in ctx.get("qual_ids", set())
                               and price >= ctx.get("min_camera_price", 100)),
            "serials":   [] if (mack or qty < 0) else await _serials(client, line_id),
            "salesperson": employees.get(str(line.get("employeeID") or ""), ""),
            "is_mack":   mack,
            "plan":      parse_plan(name) if mack else None,
            "reverses":  str(line.get("parentSaleLineID") or "") if qty < 0 else "",
        })

    when = sale.get("completeTime") or sale.get("timeStamp") or ""
    return {
        "sale_id":    sale_id,
        "ticket":     str(sale.get("ticketNumber") or ""),
        "date":       mack_date(when),
        "completed":  str(sale.get("completed")) == "true",
        "voided":     str(sale.get("voided")) == "true",
        "store":      ctx.get("shops", {}).get(str(sale.get("shopID") or ""), ""),
        "salesperson": employees.get(str(sale.get("employeeID") or ""), ""),
        "customer":   customer_details(customer) if customer else None,
        "lines":      out_lines,
        "fetched_at": int(time.time()),
    }
