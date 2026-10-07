# Follow-Up Sheets

Logs qualifying Action Camera sales from Lightspeed to a Google Sheet (one tab
for Reno, one for Rocklin) so staff can send customer follow-up emails.

A sale qualifies when ALL of these are true:
- completed register sale, not a refund/void, not the online shop
- the customer has an email address on file (no email = deliberate opt-out = skipped)
- it contains an item under the **Cameras** or **Lenses** categories, **or**
  the sale total is at/over the dollar threshold

The threshold, category names, and skipped shops live on the sheet's
**Settings** tab — edit column B there, no code changes needed. Every line
item on a qualifying sale is listed in the Purchased column.

The app appends rows once a day (6 AM Pacific by default) and on demand via
the **Run now** button. It never edits existing rows, so the "Emailed?" and
"Notes" columns belong entirely to staff. It is read-only against Lightspeed
and runs on its own OAuth client, fully separate from the lab-sync app.

## One-time setup

### 1. Deploy to Railway
1. Push this repo to GitHub, create a new Railway project from it.
2. In Railway, add a **Volume** mounted at `/data`, and set env var `DATA_DIR=/data`.
3. Set `APP_URL` to the Railway-generated domain (e.g. `https://xxxx.up.railway.app`).

### 2. Connect the Google Sheet — Apps Script bridge (no Google Cloud needed)
1. Create a blank Google Sheet.
2. In the sheet: **Extensions → Apps Script** → delete any starter code →
   paste the contents of [`docs/sheets-bridge.gs`](docs/sheets-bridge.gs).
3. Replace `PASTE_SECRET_HERE` with a long random string.
4. **Deploy → New deployment → Web app** → Execute as: **Me** → Who has
   access: **Anyone** → Deploy (approve the permissions prompt).
5. Copy the deployment's `/exec` URL into Railway env var `SHEETS_WEBAPP_URL`,
   and the same random string into `SHEETS_SECRET`.

("Anyone" only means the URL doesn't require a Google login — every call is
rejected without the secret, and the script can only touch this one sheet.)

<details>
<summary>Alternative: Google Cloud service account (blocked by org policy on
some Google accounts)</summary>

1. console.cloud.google.com → create a project → enable the **Google Sheets API**.
2. IAM & Admin → Service Accounts → Create. No roles needed.
3. On the service account: Keys → Add key → JSON. Download it.
4. Paste the ENTIRE file contents into Railway env var `GOOGLE_SERVICE_ACCOUNT_JSON`.
5. Share the sheet with the service account's email as **Editor**.
6. Put the spreadsheet ID (long string in the sheet URL) in env var `SHEET_ID`.

If both routes are configured, the Apps Script bridge wins.
</details>

### 3. Lightspeed API client (its OWN client — never reuse lab-sync's)
1. Lightspeed Retail → register a new API client, using:
   - Website: the `APP_URL` value
   - Redirect URI: `APP_URL` + `/auth/callback` (shown on the app's home page)
2. Put the client ID/secret in Railway env vars `LIGHTSPEED_CLIENT_ID` /
   `LIGHTSPEED_CLIENT_SECRET`.
3. Open the app, click **Connect Lightspeed**, approve.
4. Click **Run now**. First run pulls the last 7 days (`LOOKBACK_DAYS`).

## Manager performance sheet (optional second output)

A separate spreadsheet for managers: every completed merchandise sale
(walk-ins included, no email filter), columns Date | Customer | Cashier |
Items — each item tagged with who sold it — | Immediate Profit (Lightspeed's
number) | Total Profit (after the vendor's discount recovery) | Sale Total |
Sale ID.
Setup mirrors the follow-up sheet: create a NEW blank spreadsheet (it holds
profit data — share with managers only), paste
[`docs/manager-bridge.gs`](docs/manager-bridge.gs) into its Apps Script with
its own secret, deploy as a web app, and set `MANAGER_WEBAPP_URL` +
`MANAGER_SECRET` in Railway. Backfill it with the **Re-import** button.

**Sales of the Week:** every Thursday after the last sync (and on demand via
the "Sales of the week now" button) the app ranks the past 7 days of *all*
transactions per store by profit and appends a gold row to each manager tab
listing the top 2 — the week divider for the Friday meeting. Every month
has its own Date-cell color (use "Filter by color" to view one month), and
each store gets a fresh tab per year ("Reno 2026" → "Reno 2027"),
created automatically on the first sale of the new year.

## Mack warranty sheet (optional third output, Oct 2026)

Replaces the Forms on Fire tablet form. Every hour the app logs each Mack
warranty sold or returned to a "Mack Warranties" spreadsheet. Staff register
each one from **Mack** in the Lightspeed sidebar (the Action Camera Sidebar
Toolkit extension, 0.13.0+), which fills in the customer, gear and most
serial numbers from Lightspeed. Melinda makes the weekly file for Mack from
the sheet's **Mack** menu, in the same columns as her current file.

Setup, in this order:

1. **Spreadsheet.** Create a new blank Google Sheet named "Mack Warranties"
   (it holds customer contact details: share it with managers only). The
   account that deploys the script is the one reminder emails come from.
2. **Script.** Extensions > Apps Script > paste
   [`docs/mack-bridge.gs`](docs/mack-bridge.gs). Fill in `SECRET` and
   `STAFF_KEY` (two different long random strings) and check `APP_URL`.
   Press Ctrl+S (Cmd+S). Deploy > New deployment > Web app > Execute as: Me >
   Who has access: Anyone > Deploy, and approve the permissions. Copy the
   `/exec` URL. Reload the spreadsheet: the tabs and the **Mack** menu appear.
3. **Railway.** Set `MACK_WEBAPP_URL` (the /exec URL) and `MACK_SECRET` (the
   same value as `SECRET`). The app redeploys; the home page checklist shows
   the Mack sheet as configured.
4. **Load past warranties.** In the sheet: Mack > Load past warranties
   from Lightspeed (or the "Load past Mack warranties" button on the app
   page). They land on the Sold tab as Waiting. For the ones already
   registered on the tablet, select their rows and use Mack > Mark selected
   rows as registered before this sheet. (`/mack/preview?days=14` on the app
   lists what it finds without adding anything.)
5. **Fill in the sheet.** Codes tab: the WarrType code for each warranty
   item (new items appear on their own, highlighted until coded). Kits tab:
   the camera and lens names Mack should get for each kit, Lens 2 for
   two-lens kits (kits looked up in the panel are added on their own). Staff
   tab: an email for each salesperson. Settings tab: the manager email for
   the daily summary.
6. **Extension.** Upload 0.13.0 to the Chrome Web Store. Once it's on the
   store computers, open its settings: paste the /exec URL as the Mack sheet
   address and `STAFF_KEY` as the Mack key (Chrome sync copies both to every
   computer), then set "This computer's store" on each computer.
7. **Go live.** Tell staff to use Mack in the sidebar instead of the tablet.
   When you're ready for emails, use Mack > Turn on daily reminders.

**Moving over from the tablet:** Mack > Import a Forms on Fire export takes
a Forms on Fire CSV (paste its Google Drive link). Each row becomes a
registration linked to its sale on the Sold tab, and anything wrong with a
row goes in its **Problems** column. Those rows show "Needs fixing" and stay
out of Mack's file until someone fixes the row and clears the Problems cell.

Updating the script to a newer version of `docs/mack-bridge.gs`: copy
your `SECRET`, `STAFF_KEY` and `APP_URL` lines first, paste the new file,
put those three lines back, Ctrl+S, then Deploy > Manage deployments >
pencil > Version: New version > Deploy. Saving alone does not update what
the web app runs.

## Env vars

| Variable | Purpose |
|---|---|
| `APP_URL` | Public base URL; drives the OAuth redirect URI |
| `LIGHTSPEED_CLIENT_ID` / `LIGHTSPEED_CLIENT_SECRET` | This app's own OAuth client |
| `SHEETS_WEBAPP_URL` / `SHEETS_SECRET` | Apps Script bridge URL + shared secret (preferred route) |
| `MANAGER_WEBAPP_URL` / `MANAGER_SECRET` | Manager performance sheet bridge (optional) |
| `MACK_WEBAPP_URL` / `MACK_SECRET` | Mack warranty sheet (optional; see above) |
| `MACK_ITEM_PATTERN` | Regex for Mack warranty item names (default `^\s*mack\b`) |
| `GOOGLE_SERVICE_ACCOUNT_JSON` / `SHEET_ID` | Service-account fallback route |
| `DATA_DIR` | Volume mount path (`/data` on Railway) |
| `RUN_HOURS_START` / `RUN_HOURS_END` | Hourly-sync window, Pacific hours (default 8–20) |
| `WATCH_CART_HOURS` | How long an open register cart stays on the re-check list (default 72) |
| `WEEKLY_DAY` / `TOP_SALES_PER_WEEK` | Sales-of-the-week day (0=Mon, default 3=Thu) and how many to list (default 2) |
| `DISCOUNT_RECOVERY_PCT` | Share of a discount the vendor reimburses; only the rest counts against profit (default 80; 0 = Lightspeed's report math) |
| `MIN_CAMERA_PRICE` | Camera/lens items under this per-unit price don't qualify a sale (default 100) |
| `LOOKBACK_DAYS` | History window for the very first run (default 7) |
