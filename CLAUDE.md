# Follow-Up Sheets — Developer Reference

Small FastAPI app on Railway: once a day (plus a manual Run button) it pulls
new completed sales from Lightspeed R-Series, keeps the ones worth a
follow-up email, and appends rows to a Google Sheet (tabs: Reno, Rocklin,
Settings). Owner: Ellie Doyen (non-developer — explain changes clearly).

## ⛔ Isolation from lab-sync is the design

This app exists SEPARATELY from `/Users/actioncamera/lab-sync` on purpose:
- **Own Lightspeed OAuth client** — own rate-limit bucket, own rotating
  refresh-token chain. NEVER point it at lab-sync's client ID or tokens;
  two processes refreshing one rotating token revoked the entire grant on
  July 2 2026 and killed order syncing for a day.
- Own repo, own Railway service, own SQLite state. No shared code imports,
  no shared DB. A bug here must never be able to touch lab order syncing.

## Two outputs, one run (since Sept 2026)

The same poll feeds two spreadsheets:
1. **Follow-up sheet** (SHEETS_WEBAPP_URL/SHEETS_SECRET, docs/sheets-bridge.gs)
   — the original product; rules below.
2. **Manager performance sheet** (MANAGER_WEBAPP_URL/MANAGER_SECRET,
   docs/manager-bridge.gs — a SEPARATE spreadsheet holding profit data;
   optional, disabled when unconfigured). SAME sale logic as the follow-up
   sheet (camera/lens item or the threshold) but DIRECTION-BLIND: a
   returned camera/lens qualifies too, and the threshold compares
   abs(qualifying_total) — exchanges and refunds must land here with the
   return attributed to the original seller (Ellie's sale-102042 example),
   so the refund/zero-total gate sits AFTER the manager block. Walk-ins
   included, no email requirement. Columns: Date | Customer | Cashier |
   Items — grouped ONE LINE PER SELLER: "Name (net $): item, item (return)"
   — | Total Profit (non-excluded lines: calcSubtotal − fifoCost×qty,
   avgCost fallback) | Sale ID (col F — that script's dedup column).
Both dedup by sale ID; the cursor advances only after BOTH sheets' appends
succeed, so a failure on either retries the whole batch harmlessly.

## Qualification rule (the follow-up product)

Sale is logged when: `completed == 'true'` AND not voided AND total > 0
AND shop maps to Reno/Rocklin (skip-shops list excludes "Action Camera
Online") AND customer exists with ≥1 email AND (any line's item category is
under a qualifying category root OR total ≥ threshold).

- No email = deliberate customer opt-out = skip entirely (owner decision).
- Category roots ("Cameras, Lenses"), threshold, and skip-shops are read from
  the sheet's **Settings** tab (column B) on every run — staff-editable.
- Category matching walks parentID chains (`qualifying_category_ids`), so
  anything anywhere under a root qualifies.
- A qualifying category line must have qty > 0 (a returned camera on an
  exchange doesn't qualify a sale).
- ALL line items of a qualifying sale go in the Purchased column.

## Behaviors that must not regress (inherited from lab-sync's outages)

1. **Token refresh is serialized** (`_refresh_lock`) and the rotated refresh
   token is persisted immediately in `get_client()`. Never call
   `ls.do_refresh` anywhere else.
2. **401s are loud** — they raise `AuthExpired`, which shows as a failed run
   with a reconnect message. Never swallow a 401 into "0 sales".
3. **This Lightspeed account rejects timestamp filters** on Sale.json.
   `fetch_new_sales` uses `sort=-saleID` pagination with a saleID cursor
   (first run: LOOKBACK_DAYS timestamp window, compared client-side).
4. **Everything inside the job lock has a deadline** — `_run_job_guarded`
   wraps the run in a 30-minute `wait_for`.
5. **Append-only Sheets writes.** The app never edits/deletes existing rows;
   "Emailed?" and "Notes" are staff-owned columns. Headers/defaults are
   written only to freshly created tabs.
6. **Cursor advances only after all appends succeed**; the sheet-side Sale ID
   dedup (column J) makes retries and cursor loss harmless.
7. Register carts show `completed='false'` until paid — a NORMAL TRANSIENT
   state, not terminal. Skipped open carts go on the `pending_carts` watch
   list (SQLite) and every run re-fetches each one individually until it
   completes (or 45 days pass). Never let the saleID cursor be the only
   gate: it advances past open carts, and without the watch list any cart
   completed after a run is lost forever (this bug shipped and ate real
   sales, July 10–14 2026 — recovered via /reimport).
8. `/debug-sale/{number}` (full qualification trace) and `/debug-tabs`
   (per-tab row counts + employee-vs-store consistency + watch list) are
   the first stop for any "why is/isn't this in the sheet" question.

## Files

| File | Role |
|---|---|
| `main.py` | Routes, OAuth flow, the run job, daily scheduler |
| `lightspeed.py` | R-Series client (GET-only, paced, 429-aware), category tree logic, contact parsing |
| `sheets.py` | Two Sheets backends, same interface: `BridgeSheets` (Apps Script web app in the sheet, shared-secret auth — the deployed route; Google org policy blocked service-account key creation July 2026) and `Sheets` (service-account REST, fallback). Bridge script: `docs/sheets-bridge.gs`; POSTs to Apps Script 302-redirect, so `follow_redirects=True` is required. |
| `store.py` | SQLite key/value on the Railway volume: `tokens`, `cursor`, `last_run` |
| `templates/index.html` | Status page: connection, config checklist, Run now, last-run summary |

State keys: `tokens` (JSON: access/refresh/account_id), `cursor` (max
processed saleID), `last_run` / `next_run` (display).
