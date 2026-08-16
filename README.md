# HLSR Asset Tracker

Tool, cart, forklift and radio check-in / check-out for the Houston Livestock Show and Rodeo.
Website + installable PWA. Sibling app to [8 Second Rides](https://github.com/rugbyguyIT/8seconds-rides),
built on the same stack, the same design system and the same conventions.

**Stack:** Azure Static Web Apps (static front end + managed Azure Functions Node v4 API at `/api/*`),
Azure Database for PostgreSQL Flexible Server, Azure Blob Storage for photos, GitHub Actions CI/CD,
custom JWT auth. No build step — plain HTML/CSS/JS, deployed as-is.

## Roles

| Role | Signs in with | Session | Lands on | Can |
|---|---|---|---|---|
| `admin` | email + password | 12 h, `sessionStorage` | `/pages/admin.html` | everything |
| `staff` | email + password | 12 h, `localStorage` | `/pages/staff.html` | check equipment in and out |
| `leader` | email + password | 30 d, `localStorage` | `/pages/board.html` | read-only: what's out, who has it |

Every account is created by an admin. There is no self-service signup, no OTP, no PIN and no MFA.

**Loanees** — the volunteers who borrow equipment — are a separate table and never sign in. They're
chosen from a list at the counter. First name, last name, email, cell, position and sub-committee.

## How it works in one paragraph

Every status change goes through `api/src/assets-core.js`. A transition table declares, per action,
which states it may start from, which state it lands in and which roles may do it; a single
transaction then performs a guarded `UPDATE … WHERE status = ANY(from)` (zero rows → HTTP 409, never
a silent overwrite), writes an append-only `asset_events` row naming the actor, and queues any
notifications. Custody itself is a `loans` header plus one `loan_items` line per asset, so a cart of
six things is one handoff that can be returned item by item. A partial unique index —
`loan_items (asset_id) WHERE checked_in_at IS NULL` — makes it *impossible* for one asset to be on
two open loans, enforced by Postgres rather than by application code. "Overdue" is computed, never
stored, because Static Web Apps has no timer trigger to flip a stored flag.

Asset states: `available → checked_out → available` (or `→ maintenance`), plus `retired`.
An asset in maintenance cannot be checked out — not by a conditional, but because `check_out.from`
is `['available']` only. An asset that is checked out cannot be retired: check it in first, so
"every retired asset was physically accounted for" stays true.

## Group restrictions

Groups hold **loanees**, and an asset restricted to a group can only be issued to someone in that
group — the "ROC Cart 01 (Kyle ONLY)" pattern. An asset with no groups is open to everyone. The rule
lives in SQL as `public.asset_eligible(asset, loanee)` so the check-out guard, the asset picker and
the reports can never drift apart. Ineligible items show greyed out with the reason *before* anyone
tries to hand them over.

## Due dates

Check-out pre-fills a due date **12 hours out** (`app_settings.default_loan_hours`, editable in
Admin → Settings). Staff can change it, or clear it for an indefinite loan. Overdue items show in red
on the board and in the overdue report; `overdue_grace_hours` controls how late is late.

## Scanning

Rev 1 has no camera scanning — assets and people are found by typing. But the picker asks the server
for an *exact* match on asset tag, serial or email and auto-selects on Enter, which is precisely what
a USB or Bluetooth barcode scanner produces. **Handheld scanners work today with no scanner code in
the app.** Adding camera QR later is one module calling the same `onPick()` callback.

## Conventions inherited from 8 Seconds

- Azure SWA strips the `Authorization` header → all API calls use **`x-assets-token`**.
- Migrations are **manual** (`psql -f api/migrations/001_schema.sql`) — nothing auto-runs SQL.
- `profiles.token_version` = instant force-logout. Role changes, deactivations and password resets
  all bump it, because the role is baked into the JWT.
- Every route is `authLevel: 'anonymous'`; the real boundary is `requireRole()` inside each handler.
  `requireLogin()` in the browser is UX only.
- Stale JS after a deploy → bump `CACHE_VERSION` in `sw.js` and `APP_VERSION` in `js/config.js`.

## Getting started

**Deploying:** run `./scripts/setup-azure.sh` (from Azure Cloud Shell is easiest) — it provisions
every resource, wires the app settings and loads the schema, and is safe to re-run.
**[SETUP-GUIDE.md](SETUP-GUIDE.md)** has the full runbook and the same steps by hand.

**Running locally:**

```bash
createdb hlsr_assets
psql 'postgresql://…/hlsr_assets' -f api/migrations/001_schema.sql
cd api && npm install && cd ..

DATABASE_URL='postgresql://…/hlsr_assets' JWT_SECRET=dev BOOTSTRAP_SECRET=boot \
  node api/test/devserver.js        # → http://localhost:8080
```

`api/test/devserver.js` serves the static site and routes `/api/*` to the real handlers. It is a
development convenience only — in Azure, Static Web Apps does both jobs.

## Tests

Two suites, both running the real code:

```bash
# 131 API assertions against a real Postgres — auth, role gating, restrictions,
# concurrency, check-in/out, imports, reports, the audit trail
DATABASE_URL=… JWT_SECRET=test BOOTSTRAP_SECRET=boot node api/test/smoke.js

# 63 browser assertions driving the real pages in Chromium.
# Playwright is deliberately NOT a dependency of this repo — the app has no
# build step, and a root package.json would imply one. Install it globally:
npm install -g playwright && npx playwright install chromium
node api/test/devserver.js &                     # same env vars
NODE_PATH="$(npm root -g)" node api/test/ui.js   # screenshots land in /tmp/shots

# every mutating route must have a role gate — run before each release
node api/test/routes-audit.js
```

`smoke.js` stubs `@azure/functions` and invokes the handlers directly, so everything below the
handler — middleware, `db.js`, `assets-core.js`, the SQL, the constraints — is production code. It
includes a genuine concurrency test: two simultaneous check-outs of the same asset, one of which
must lose with a 409.

## Branding — four swap points, and only four

1. `js/config.js` — `APP_NAME`, `APP_SHORT`, `APP_ORG`, `APP_VERSION`
2. `css/brand.css` — a `:root` block overriding `--navy`, `--orange`, `--gold`. Every component is
   built on these tokens, so this re-skins the whole app; `css/style.css` never needs editing.
3. `icons/*` + `manifest.json` (bump the `?v=N`) — see `icons/README.md`
4. `login-logo.png` — the mark in the login orb; keep it under ~200 KB

No page hardcodes the app name: every `<title>`, nav wordmark and footer is written from `APP_NAME`
at runtime. Renaming the app is a four-file change, not a search-and-replace.

## Rev 1 scope

**In:** password auth and three roles · loanees with CSV/XLSX import · groups and asset restrictions ·
the asset catalog with Blob Storage photos · maintenance and retirement · cart-style check-out and
item-by-item check-in · the leadership PWA board · six reports with CSV export · a full audit and
application log.

**Deliberately deferred:** notifications of any kind (the `notification_outbox` table ships so this
is later a code change, not a migration) · camera-based QR scanning (the picker is already built for
it) · loanee self-service · label printing.
