# OakCraft FMS Dashboard — Setup Guide

A secure, salesperson-wise web dashboard on top of the `new_oc_offline_fms_v4` Google Sheet.
Built with **Google Apps Script** (backend + hosting) and **HTML/CSS/JS** (frontend). No extra servers or paid services.

---

## 1. How it works (architecture)

```
 Browser (HTML/CSS/JS)                Google Apps Script (runs as YOU)            Google Sheets
 ─────────────────────                ────────────────────────────────            ─────────────
 Login form  ──login──────────────▶   api() gateway                               FMS sheet (read-only use)
                                       ├─ verify password (salted + peppered)      ├─ o2d_for_pc   A9:O + CN
 token in sessionStorage ◀─token───    ├─ create session (CacheService)            └─ to_be_ordred A9:O + CE
 getData(token) ─────────────────▶    ├─ validate session on EVERY call
                                       ├─ filter rows by column L  ◀── isolation   Auth DB (private, separate file)
 only that user's rows ◀──────────    └─ role check for admin actions              ├─ Users
                                                                                   └─ Activity
```

**Why a standalone script (not one attached to the FMS sheet)?**
A script attached to the sheet can be opened by *anyone who can edit the sheet* — salespeople could read the code and secrets. A standalone project owned only by you, plus a **separate private Auth DB spreadsheet**, keeps credentials and logs out of their reach.

### Security model
| Threat | Protection |
|---|---|
| Seeing another salesperson's data | Rows are filtered **on the server** by column L before anything is sent. Client filters can't widen it (tested). |
| Calling the API directly / editing JS / changing URL | Every request carries a session token that is validated server-side; role & scope come from the server-side user record, never from the request. Admin actions are re-checked on the server and logged as `ACCESS_DENIED` if attempted. |
| Calling internal Apps Script functions from the browser | All internal functions end with `_` (Apps Script makes these uncallable). Only `doGet`, `api`, `initialSetup`, `emergencyResetAdmin` are public; the last two return nothing. |
| Password theft from the sheet | Passwords stored as salt + secret pepper (Script Properties) + iterated HMAC-SHA256. Plain passwords are never stored. |
| Brute force | 5 failed attempts → login ID locked 15 minutes. Generic error messages. |
| Stolen / stale sessions | 256-bit random tokens, only their hash is stored; 60-min idle timeout, 12-h max; tokens die on logout, password change/reset, deactivation, role/salesperson change, “force sign-out”, or “sign out all users”. |
| XSS / injection | All sheet values are HTML-escaped before display; image links restricted to `https://`; formula-injection guard on values written to sheets and on CSV export. Click-jacking blocked. |

---

## 2. One-time setup (≈10 minutes)

> Use the Google account that **owns or can open** the FMS spreadsheet. This account becomes the server identity.

### Step 1 — Create the project
1. Go to **https://script.google.com** → **New project**.
2. Rename it to **OakCraft FMS Dashboard**.

### Step 2 — Add the files
In the editor, create these files (the `+` next to **Files**) and paste each file's contents from the `src/` folder:

| Type | Name in editor | Source file |
|---|---|---|
| Script | `Config` | `src/Config.gs` |
| Script | `Util` | `src/Util.gs` |
| Script | `Data` | `src/Data.gs` |
| Script | `Users` | `src/Users.gs` |
| Script | `Auth` | `src/Auth.gs` |
| Script | `Audit` | `src/Audit.gs` |
| Script | `Setup` | `src/Setup.gs` |
| Script | `Code` | `src/Code.gs` (replace the default content) |
| HTML | `Index` | `src/Index.html` |
| HTML | `Styles` | `src/Styles.html` |
| HTML | `App` | `src/App.html` |

Then: **Project Settings (⚙)** → tick **Show "appsscript.json" manifest file** → open `appsscript.json` in the editor and replace its content with `src/appsscript.json`.

`Config.gs` already points to your FMS spreadsheet ID (`16Dwyzt5-BZWv6PdwRAARLGAeUdrQnHaoXsSiHwTXFow`), sheets, rows (from 9) and columns (A:O, CN, CE, salesperson in L).

### Step 3 — Run the setup
1. Select the **Setup** file, choose **`initialSetup`** in the function dropdown, click **Run**.
2. Approve the permission prompt (it only needs access to Google Sheets).
3. Open **Execution log**. You'll see:
   ```
   Auth DB (private): https://docs.google.com/...
   Admin login ID   : admin
   Temp password    : Cedar-4821-Nova#37
   ```
   A new spreadsheet **“OakCraft FMS Dashboard – Auth DB (PRIVATE – do not share)”** is created in your Drive. **Never share it.**

### Step 4 — Deploy the web app
1. **Deploy → New deployment** → type **Web app**.
2. **Execute as:** *Me* · **Who has access:** *Anyone*
   (Salespeople sign in with the IDs you create, so they don't need Google accounts. If all salespeople have `@oakcraft.in` Google Workspace accounts you may choose *Anyone within oakcraft.in* for an extra layer.)
3. Click **Deploy** and copy the **Web app URL**. That's the dashboard link to share.

### Step 5 — First sign-in
1. Open the URL, sign in as `admin` with the temporary password, and set your own password.
2. Go to **Users & Access**. The blue banner lists salespeople found in column L who don't have an account yet — click **Create for …**, or use **Add user**.
3. Leave the password blank to auto-generate a strong one; it is shown **once** with a Copy button. Users must change it at first sign-in.

---

## 3. Everyday administration

| Task | Where |
|---|---|
| Create a salesperson login & link it to column L name | Users & Access → Add user (role *Salesperson*, pick the name) |
| Give someone read-only access to everything (sales head) | Role *Manager* |
| Reset a password | ⋯ menu → Reset password (signs the user out everywhere) |
| Deactivate / reactivate | ⋯ menu → Deactivate account (immediate) |
| Kick a user out of all devices | ⋯ menu → Force sign-out |
| Unlock after too many wrong passwords | ⋯ menu → Unlock account |
| Hide a sheet tab or CSV export from a user | Edit → Access checkboxes (sheet access is enforced on the server) |
| See who logged in, failed logins, exports, denied attempts | Activity Log |
| Data looks stale | System & Security → Force data re-sync |
| Suspected breach | System & Security → Sign out all users, then reset passwords |

**Salesperson name matching:** a user sees rows where column L equals their assigned name. Matching ignores case and extra spaces (`niti  kumari` = `NITI KUMARI`), but spelling must match. If you assign a name that isn't in the sheet, the app warns you.

**Data freshness:** the server caches sheet data for 60 seconds; dashboards auto-refresh every 2 minutes (and when the tab regains focus). The refresh button forces a sync.

---

## 4. Updating the app later
Edit the files, then **Deploy → Manage deployments → ✎ (edit) → Version: New version → Deploy**. The URL stays the same. Users stay signed in unless you change security settings.

### Tunable settings (`Config.gs`)
| Setting | Default |
|---|---|
| `SESSION_IDLE_MINUTES` | 60 |
| `SESSION_MAX_HOURS` | 12 |
| `MAX_FAILED_ATTEMPTS` / `LOCKOUT_MINUTES` | 5 / 15 |
| `HASH_ITERATIONS` | 100 (Apps Script is slow at hashing; existing hashes keep working) |
| `DATA_CACHE_SECONDS` / `CLIENT_SYNC_SECONDS` | 60 / 120 |
| `SOURCES.*.statusCol` | 92 (CN) / 83 (CE) — change if columns move |

### Locked out as admin?
Project Settings → Script properties → add `ALLOW_RECOVERY` = `true` → run **`emergencyResetAdmin`** → read the new temp password in the Execution log. The property deletes itself after one use.

---

## 5. Notes & limits
* **Product images** come from Google Drive thumbnail links. They show only if the Drive files are shared (e.g. “Anyone with the link”) or the viewer is signed into a Google account with access; otherwise a placeholder is shown.
* Google shows a small banner *“This application was created by another user”* to non-owners on consumer Apps Script web apps — this is normal.
* Apps Script allows ~30 simultaneous executions per script; that's plenty for a sales team. For hundreds of concurrent users, move the same API to Cloud Run/Firebase with the Sheets API.
* CSV export only contains rows the user is already allowed to see.

## 6. Tests (optional, for developers)
`test/` contains a Node harness that emulates Apps Script and runs the real server code: 34 security checks (isolation, forged tokens, admin-only endpoints, revocation, lockout, injection) plus Playwright UI checks on desktop, tablet and mobile.
```
cd test && node security.test.js && node ui.test.js
```

---

## GitHub Pages version (second link)

The same dashboard is also published at **https://weboakcraft.github.io/oakcraft-fms-dashboard/**.

* `docs/index.html` is generated from `src/` by `node tools/build-pages.js` (it inlines Styles/App and swaps `google.script.run` for `fetch()` calls to the Apps Script web app's `doPost()` endpoint).
* All login, salesperson filtering and permissions still run in Apps Script — GitHub only hosts the static page. Both links use the same accounts and data.
* After changing anything in `src/`: update Apps Script + deploy a new version (same URL), then rebuild `docs/index.html` and commit it. If the Apps Script web-app URL ever changes, rebuild with `API_URL=<new exec URL> node tools/build-pages.js`.
