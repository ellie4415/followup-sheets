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

### 2. Google service account (writes the sheet)
1. console.cloud.google.com → create a project (any name) → enable the **Google Sheets API**.
2. IAM & Admin → Service Accounts → Create. No roles needed.
3. On the service account: Keys → Add key → JSON. Download it.
4. Paste the ENTIRE file contents into Railway env var `GOOGLE_SERVICE_ACCOUNT_JSON`.
5. Create a blank Google Sheet. Share it with the service account's email
   (the `...@...iam.gserviceaccount.com` address in the JSON) as **Editor**.
6. Put the spreadsheet ID (the long string in the sheet URL) in env var `SHEET_ID`.

### 3. Lightspeed API client (its OWN client — never reuse lab-sync's)
1. Lightspeed Retail → register a new API client, using:
   - Website: the `APP_URL` value
   - Redirect URI: `APP_URL` + `/auth/callback` (shown on the app's home page)
2. Put the client ID/secret in Railway env vars `LIGHTSPEED_CLIENT_ID` /
   `LIGHTSPEED_CLIENT_SECRET`.
3. Open the app, click **Connect Lightspeed**, approve.
4. Click **Run now**. First run pulls the last 7 days (`LOOKBACK_DAYS`).

## Env vars

| Variable | Purpose |
|---|---|
| `APP_URL` | Public base URL; drives the OAuth redirect URI |
| `LIGHTSPEED_CLIENT_ID` / `LIGHTSPEED_CLIENT_SECRET` | This app's own OAuth client |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Full JSON key file contents |
| `SHEET_ID` | Target spreadsheet ID |
| `DATA_DIR` | Volume mount path (`/data` on Railway) |
| `RUN_HOUR` | Daily run hour, Pacific (default 6) |
| `LOOKBACK_DAYS` | History window for the very first run (default 7) |
