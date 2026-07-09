"""Lightspeed Retail R-Series API client for the Follow-Up Sheets app.

Deliberately a trimmed, independent copy of the proven lab-sync client —
this app runs on its OWN OAuth client and NEVER shares tokens with lab-sync.

Hard-won lessons carried over from lab-sync (July 2026):
  - This Lightspeed account rejects timestamp filters on Sale.json.
    All fetching uses sort=-saleID pagination.
  - Refresh tokens ROTATE: the new refresh token must be persisted before
    anything else uses it, and refreshes must be serialized (one at a time)
    or Lightspeed revokes the whole grant.
  - 401s must be raised loudly, never swallowed as "no sales found".
"""

import asyncio
import base64
import hashlib
import logging
import secrets
import urllib.parse
from typing import Optional

import httpx

log = logging.getLogger("followup")

AUTH_URL    = "https://cloud.lightspeedapp.com/auth/oauth/authorize"
TOKEN_URL   = "https://cloud.lightspeedapp.com/auth/oauth/token"
API_BASE    = "https://api.lightspeedapp.com/API/V3/Account"
ACCOUNT_URL = "https://api.lightspeedapp.com/API/V3/Account.json"


class AuthExpired(Exception):
    """Raised when the Lightspeed grant is dead and /auth must be re-run."""


# ── PKCE / OAuth ──────────────────────────────────────────────────────────────

def pkce_pair() -> tuple[str, str]:
    verifier  = secrets.token_urlsafe(64)[:96]
    challenge = base64.urlsafe_b64encode(
        hashlib.sha256(verifier.encode()).digest()
    ).rstrip(b"=").decode()
    return verifier, challenge


def build_auth_url(client_id: str, redirect_uri: str, challenge: str, state: str) -> str:
    params = {
        "response_type":         "code",
        "client_id":             client_id,
        "redirect_uri":          redirect_uri,
        "code_challenge":        challenge,
        "code_challenge_method": "S256",
        "scope":                 "employee:all",
        "state":                 state,
    }
    return AUTH_URL + "?" + urllib.parse.urlencode(params)


async def exchange_code(client_id: str, client_secret: str,
                        code: str, verifier: str, redirect_uri: str) -> dict:
    payload = {
        "client_id":     client_id,
        "code":          code,
        "grant_type":    "authorization_code",
        "redirect_uri":  redirect_uri,
        "code_verifier": verifier,
    }
    if client_secret:
        payload["client_secret"] = client_secret

    async with httpx.AsyncClient() as http:
        r = await http.post(TOKEN_URL, data=payload, timeout=20)
        r.raise_for_status()
        tokens = r.json()

    async with httpx.AsyncClient() as http:
        r = await http.get(
            ACCOUNT_URL,
            headers={"Authorization": f"Bearer {tokens['access_token']}",
                     "Accept": "application/json"},
            timeout=15,
        )
        r.raise_for_status()
        acct_data = r.json()

    acct = acct_data.get("Account") or {}
    if isinstance(acct, list):
        acct = acct[0] if acct else {}

    return {
        "access_token":  tokens["access_token"],
        "refresh_token": tokens.get("refresh_token", ""),
        "account_id":    str(acct.get("accountID", "")),
    }


async def do_refresh(client_id: str, client_secret: str, refresh_token: str) -> dict:
    payload = {
        "client_id":     client_id,
        "refresh_token": refresh_token,
        "grant_type":    "refresh_token",
    }
    if client_secret:
        payload["client_secret"] = client_secret

    async with httpx.AsyncClient() as http:
        r = await http.post(TOKEN_URL, data=payload, timeout=20)
        r.raise_for_status()
        data = r.json()

    return {
        "access_token":  data["access_token"],
        "refresh_token": data.get("refresh_token", refresh_token),
    }


# ── API client ────────────────────────────────────────────────────────────────

class LightspeedClient:
    """GET-only client. Paces requests and honors 429 Retry-After — this app
    is a background batch job and must never compete aggressively for the
    rate-limit bucket (it has its own bucket via its own OAuth client, but
    politeness costs nothing at daily cadence)."""

    PACE_SECONDS = 0.15

    def __init__(self, access_token: str, account_id: str):
        self.access_token = access_token
        self.account_id   = account_id

    @property
    def _headers(self) -> dict:
        return {"Authorization": f"Bearer {self.access_token}",
                "Accept": "application/json"}

    @property
    def _base(self) -> str:
        return f"{API_BASE}/{self.account_id}/"

    async def get(self, path: str, params: dict = None) -> dict:
        return await self.get_url(self._base + path, params)

    async def get_url(self, url: str, params: dict = None) -> dict:
        last_exc: Optional[Exception] = None
        for attempt in range(4):
            await asyncio.sleep(self.PACE_SECONDS)
            try:
                async with httpx.AsyncClient() as http:
                    r = await http.get(url, headers=self._headers,
                                       params=params, timeout=30)
                if r.status_code == 429:
                    wait = float(r.headers.get("Retry-After") or 2)
                    log.warning(f"429 from Lightspeed, sleeping {wait}s (attempt {attempt + 1})")
                    await asyncio.sleep(min(wait, 30))
                    continue
                r.raise_for_status()
                return r.json()
            except httpx.HTTPStatusError as exc:
                if exc.response.status_code == 401:
                    raise  # loud — caller decides to refresh or surface AuthExpired
                last_exc = exc
                await asyncio.sleep(1 + attempt)
            except httpx.HTTPError as exc:
                last_exc = exc
                await asyncio.sleep(1 + attempt)
        raise RuntimeError(f"Lightspeed GET failed after retries: {url} — {last_exc}")

    # ── Entities ──────────────────────────────────────────────────────────────

    async def get_shops(self) -> dict:
        data  = await self.get("Shop.json")
        shops = as_list(data.get("Shop"))
        return {str(s.get("shopID", "")): s.get("name", "") for s in shops}

    async def get_employees(self) -> dict:
        data = await self.get("Employee.json")
        emps = as_list(data.get("Employee"))
        return {
            str(e.get("employeeID", "")):
                f"{e.get('firstName', '')} {e.get('lastName', '')}".strip()
            for e in emps
        }

    async def get_categories(self) -> list:
        cats: list = []
        url: Optional[str] = None
        while True:
            if url:
                data = await self.get_url(url)
            else:
                data = await self.get("Category.json", params={"limit": 100})
            batch = as_list(data.get("Category"))
            cats.extend(batch)
            attrs = data.get("@attributes", {})
            url   = attrs.get("next") or data.get("next")
            if not url or not batch:
                break
        return cats

    async def get_sale_lines(self, sale_id: str) -> list:
        try:
            data  = await self.get("SaleLine.json", params={
                "saleID": sale_id, "limit": 100, "load_relations": '["Item"]',
            })
            lines = as_list(data.get("SaleLine"))
            if lines:
                return lines
        except httpx.HTTPStatusError as exc:
            if exc.response.status_code == 401:
                raise
            log.debug(f"get_sale_lines with Item relation failed ({sale_id}): {exc}")
        data = await self.get("SaleLine.json", params={"saleID": sale_id, "limit": 100})
        return as_list(data.get("SaleLine"))

    async def get_customer(self, customer_id: str) -> dict:
        for lr in ('["Contact"]', None):
            try:
                params = {"load_relations": lr} if lr else None
                data   = await self.get(f"Customer/{customer_id}.json", params)
                cust   = data.get("Customer", {})
                if isinstance(cust, list):
                    cust = cust[0] if cust else {}
                if lr is None or "Contact" in cust:
                    return cust
            except httpx.HTTPStatusError as exc:
                if exc.response.status_code == 401:
                    raise
            except Exception as exc:
                log.warning(f"get_customer({customer_id}, lr={lr!r}): {exc}")
        return {}


# ── Category qualification ────────────────────────────────────────────────────

def qualifying_category_ids(categories: list, root_names: list) -> set:
    """IDs of every category that IS one of the named roots or sits anywhere
    under one in the category tree (walks parentID chains — no reliance on
    fullPathName formatting)."""
    roots = {r.strip().lower() for r in root_names if r and r.strip()}
    if not roots:
        return set()
    by_id = {str(c.get("categoryID", "")): c for c in categories}
    ids: set = set()
    for cat in categories:
        node = cat
        for _ in range(25):  # tree-depth guard
            if (node.get("name") or "").strip().lower() in roots:
                ids.add(str(cat.get("categoryID", "")))
                break
            parent = by_id.get(str(node.get("parentID") or "0"))
            if not parent or parent is node:
                break
            node = parent
    return ids


# ── Data helpers ──────────────────────────────────────────────────────────────

def as_list(obj) -> list:
    if obj is None:
        return []
    if isinstance(obj, list):
        return [x for x in obj if isinstance(x, dict)]
    if isinstance(obj, dict):
        return [obj]
    return []


def customer_emails(customer: dict) -> list:
    contact    = customer.get("Contact") if isinstance(customer.get("Contact"), dict) else {}
    emails_obj = contact.get("Emails")
    if not isinstance(emails_obj, dict):
        return []
    seen, result = set(), []
    for entry in as_list(emails_obj.get("ContactEmail")):
        addr = (entry.get("address") or "").strip()
        if addr and "@" in addr and addr.lower() not in seen:
            seen.add(addr.lower())
            result.append(addr)
    return result


def customer_phone(customer: dict) -> str:
    contact    = customer.get("Contact") if isinstance(customer.get("Contact"), dict) else {}
    phones_obj = contact.get("Phones")
    phones     = as_list(phones_obj.get("ContactPhone") if isinstance(phones_obj, dict) else None)
    for p in phones:
        if p.get("useType", "").lower() == "mobile":
            return p.get("number", "")
    for p in phones:
        if p.get("number"):
            return p["number"]
    return ""


def format_date(iso_str: str) -> str:
    if not iso_str:
        return ""
    try:
        from datetime import datetime
        from zoneinfo import ZoneInfo
        dt    = datetime.fromisoformat(iso_str.replace("Z", "+00:00"))
        local = dt.astimezone(ZoneInfo("America/Los_Angeles"))
        return local.strftime("%-m/%-d/%Y")
    except Exception:
        return ""
