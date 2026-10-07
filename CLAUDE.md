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
   — | Immediate Profit (non-excluded lines: calcSubtotal − calcLineDiscount
   − avgCost×qty; FIFO fallback — equals Lightspeed's Sales Listings profit
   to the cent) | Total Profit (same but only (1−DISCOUNT_RECOVERY_PCT/100)
   of the discount counts; 80% = Ellie's vendor-recovery rule) | Sale Total
   | Sale ID (col H — that script's dedup column). The app checks
   `script_version()` from doGet and writes the 7-wide pre-v8 layout to
   older scripts so app and script never disagree about the dedup column.
Both dedup by sale ID; the cursor advances only after BOTH sheets' appends
succeed, so a failure on either retries the whole batch harmlessly.

3. **Mack warranty sheet (Oct 2026)**, see the section below. Unlike the two
   above it can NEVER hold up the cursor.

## Mack warranties (Oct 2026): replaces the Forms on Fire tablet form

Pieces: `mack.py` (detection + receipt bundle), `docs/mack-bridge.gs` (the
Mack sheet's script: statuses, Melinda's weekly file, reminders, the
extension's API), and the Chrome extension `~/retail-sidebar-toolkit/edited`
(`mack.js`, `mack-rules.js`, background.js `MACK_REQUEST`). Data path for the
review panel: extension -> Mack sheet web app (STAFF_KEY) -> `GET
/mack/sale/{n}` here (header `X-Mack-Secret` = MACK_SECRET) -> Lightspeed. The
extension never talks to Railway directly (no new Chrome host permission =
no re-approval prompt on the store computers) and never holds Lightspeed keys.

- **Units.** One per warranty: `<saleLineID>-<n>` sold, `R<saleLineID>-<n>`
  returned (`reverses` = SaleLine.parentSaleLineID). Detected for EVERY shop,
  refunds and walk-ins included, so the hook sits BEFORE the shop/refund
  gates in `run_job`. Item match: `MACK_ITEM_PATTERN` (default `^\s*mack\b`).
- **Isolation (must not regress).** Units go to the SQLite outbox
  (`mack_outbox`) inside `flush()` BEFORE the cursor moves; `send_outbox()`
  runs after the final flush in its own try/except and only warns. A dead
  Mack sheet never stops the follow-up/manager sheets; units retry next run.
  The sheet dedups by unit key. `_lines_for` now runs before the shop gate
  (free in bulk mode; in per-sale fallback mode it adds a call for skipped
  shops).
- **Statuses live in the sheet** (`computeStatuses_`, pure, tested with
  jsc). A return cancels the unit whose line it reverses, else same customer
  + same item; it prefers an unsent, then unregistered twin. Registration
  rows: Ready to send / Needs WarrType code / Sent / Returned, don't send /
  Cancel with Mack / Cancelled.
- **Registrations tab = Melinda's Mack file layout**, A..AB exactly
  (28 columns, tab name in the export `API  use dates or po#` with TWO
  spaces), tracking columns from AC. DealerInvoice# = the GEAR's receipt
  (Ellie, Oct 7 2026: the gear's transaction ID is what matters when the
  warranty is bought later). WarrType codes are filled by Melinda on the
  Codes tab; rows without one are held out of the file.
- Item names ending in "+" carry California's fee in Lightspeed: the "+"
  is stripped from models (server `model_from`, panel `cleanModel`). Kit
  models come from the sheet's Kits tab (camera, lens 1, lens 2) when
  present, else from splitting "w/ A & B". Every covered item needs a real
  serial (no N/A) and its own price; EquipmentValue = the prices added up;
  any item, kit lenses included, can be removed (Ellie, Oct 7 2026).
- `/mack/preview?days=N` lists detected units with no customer details;
  `/mack/rescan?days=N` re-sends a window (home-page button and the sheet's
  Mack > Load past warranties both call it). Anything registered some other
  way then shows as Waiting: Mack > Mark selected rows as registered before
  this sheet fills the Sold tab's "Handled Outside" column.
- **Gear bought somewhere else** (panel's third gear option, Oct 7 2026):
  staff type the items, the seller, their receipt/order number and date,
  and confirm a copy of the original receipt is kept. DealerInvoice# = OUR
  warranty receipt, OriginalInvoiceNumber = their number (a guess pending
  Mack's confirmation; one line in registrationRow_ / the panel's save).
- **Problems column (AP, script v3).** Any text there = status "Needs
  fixing" (or "Sent, needs fixing"), held out of Mack's file until fixed and
  cleared. Filled by **Mack > Import a Forms on Fire export** (Drive CSV link
  or the open tab): `fofRegistrations_` matches each tablet row to its Sold
  unit (receipt, receipt suffix like 20000104429, else last name within 3
  days; ties by price/coverage), so those sales show Registered, and flags
  missing fields, N/A serials, email-domain typos, bad phone/zip/receipt,
  value above the plan limit, price/coverage different from Lightspeed,
  >30 days. Asks whether the batch was already sent to Mack. Re-importing
  skips rows by Registration ID `FoF-<Row Id>`. Never commit real exports.
- Tests: `python tests/test_mack.py` (needs requirements installed) and
  `jsc docs/mack-bridge.gs tests/test_mack_bridge.js`.

**Sales of the Week (manager sheet, Sept 2026):** `weekly_job` runs after
the last sync of WEEKLY_DAY (Thursday, 8 PM) and via POST /weekly. It
scans ALL transactions of the past 7 days (no camera/threshold filter),
ranks per store by merchandise profit (same definition as Total Profit —
lab/service lines have no cost data and would win on phantom profit),
skips refunds/exchanges, and appends ONE marker row per store tab:
Date "Week M/D–M/D/YYYY", Customer "SALES OF THE WEEK", Items = top
TOP_SALES_PER_WEEK entries, seller first so the script colors it. A sale
that already has its own row on the sheet gets ONE line ("Seller — #1 ·
$profit ($immediate immediate) · sale N (see its row)"); a sale that did
NOT qualify for a row (no camera/lens, under threshold) gets the summary
line plus its FULL item list indented beneath in the normal "Seller —
Item" format (Ellie: the weekly row is the only place those items
appear). Sale ID
"WEEK-YYYY-MM-DD" (the idempotency sentinel — never a real sale ID). The
bridge script (v6) paints WEEK- rows gold+bold and gives every calendar
month its OWN Date-cell fill (12-entry MONTH_TINTS) so Sheets'
"Filter by color" isolates a month.

**Manager tabs are per store per YEAR** ("Reno 2026") — `_year_tab()` picks
the tab from the sale's own date (weekly rows use the week-end year), so
January rolls over with no human action; doPost auto-creates unknown tabs
and `ensureSetup_` renames a legacy un-yeared "Reno"/"Rocklin" tab into
the current year's name once. Manager dedup is fetched lazily per year
tab. The script's maintenance helpers iterate `dataSheets_()` (every tab
whose name starts with a store name).

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
   completes or WATCH_CART_HOURS (default 72) pass — Lightspeed leaves
   abandoned carts open forever and they basically never complete after a
   couple of days (Ellie, Sept 2026), so a short window keeps the list to a
   few dozen at hourly cadence. Never let the saleID cursor be the only
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
| `store.py` | SQLite key/value on the Railway volume: `tokens`, `cursor`, `last_run`, `mack_outbox` |
| `mack.py` | Mack warranty units for the hourly run + the receipt bundle for the extension's review panel |
| `templates/index.html` | Status page: connection, config checklist, Run now, last-run summary |

State keys: `tokens` (JSON: access/refresh/account_id), `cursor` (max
processed saleID), `last_run` / `next_run` (display).
