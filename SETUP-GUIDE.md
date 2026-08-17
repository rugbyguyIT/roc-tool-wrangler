# HLSR Asset Tracker — Azure Setup Runbook

Zero to a live URL you can sign into, create equipment on, and check something out.
Mirrors the 8 Second Rides deployment, so the shape of it should feel familiar.

**Budget:** Static Web Apps Standard + a burstable B1ms Postgres + a small storage account
is roughly $25–45/month. The Free SWA tier works for testing but has no custom domain SLA.

**Time:** about 45 minutes, most of it waiting for Azure to create things.

---

# The fast path: run the script

`scripts/setup-azure.sh` does sections 1–3 of this guide in one go — resource group, Postgres,
firewall rules, the extension allow-list *and the restart it needs*, the storage account, the Static
Web App linked to your repo, all four app settings, and the schema load.

```bash
az login                      # skip this in Azure Cloud Shell — you're already signed in
./scripts/setup-azure.sh      # from the repo root
```

Azure Cloud Shell ([shell.azure.com](https://shell.azure.com)) is the easiest place to run it: it
has the Azure CLI and `psql` already, so there's nothing to install.

**It is safe to re-run.** Every step checks whether the resource already exists and skips it, and
generated secrets are reused rather than regenerated — so if it dies halfway (a taken storage-account
name, a throttled region, a dropped connection) you fix the cause and run it again instead of
unpicking a half-built environment by hand.

Names default to the `roc-tool-wrangler-*` set. Override any of them inline:

```bash
STORAGE=rocwranglerpics SWA_LOCATION=eastus2 ./scripts/setup-azure.sh
```

The script writes `.azure-secrets.env` (gitignored, chmod 600) containing your database password,
JWT secret and bootstrap secret. **Copy those into a password manager and delete the file.**

When it finishes it prints your app URL and the exact `curl` to create the first admin — jump to
[section 4](#4-create-the-first-admin-1-min).

Everything below is the same work done by hand, for when you want to understand what was created or
something needs doing differently.

---

## 1. Azure resources (~20 min, Azure Portal)

### 1.1 Resource group
Create **`roc-tool-wrangler-rg`** in **South Central US** (same region as the rides app — keeping the
database and the web app in one region is what keeps queries fast).

### 1.2 PostgreSQL Flexible Server
- **Name:** `roc-tool-wrangler-db` → host `roc-tool-wrangler-db.postgres.database.azure.com`
- **Workload:** Development · **Compute:** Burstable B1ms · **Version:** 16
- **Auth:** PostgreSQL authentication, admin user `assetsadmin`, strong password.
  **Avoid `$` in the password** — it makes the connection string painful to quote in a shell.
- **Networking:** turn ON *"Allow public access from any Azure service"*, and add your own IP so
  you can run `psql`. Leave *SSL required* ON.

### 1.3 ⚠️ Enable the two extensions — do this BEFORE step 2
The schema uses `pgcrypto` (for UUIDs) and `pg_trgm` (for the fuzzy asset/person search behind
every picker). Neither is available by default on Azure Flexible Server.

> **Server parameters → search `azure.extensions` → tick `PGCRYPTO` and `PG_TRGM` → Save → restart the server.**

If you skip this, `CREATE EXTENSION` fails on the first line of the migration and nothing else runs.

### 1.4 Storage account (for asset photos)
- **Name:** `roctoolwranglerphotos` (lowercase, no dashes — Azure's rule)
- **Kind:** StorageV2 · **Redundancy:** LRS · **Tier:** Hot
- Nothing else to configure. The container `asset-photos` is created automatically on the first
  upload. Photos are stored public-read at the blob level (unguessable URLs, but not authenticated)
  — fine for pictures of forklifts, and deliberately documented in `api/src/blob.js` as *not*
  suitable for anything sensitive.

### 1.5 Static Web App
- **Name:** `roc-tool-wrangler` · **Plan:** Standard · **Region:** closest to South Central
- **Source:** GitHub → `rugbyguyIT/roc-tool-wrangler`, branch `main`
- **Build presets:** Custom → App location `/` · Api location `api` · Output location *(blank)*

Creating it auto-commits `.github/workflows/azure-static-web-apps-*.yml` to the repo with its own
deploy token. **That file is your CI/CD — don't hand-write it, and don't delete it.** The first
deploy starts immediately.

---

## 2. Database schema (~5 min)

From Azure Cloud Shell or a local terminal. **Single-quote the URL** — that's the 8 Seconds rule and
it still applies:

```bash
psql 'postgresql://assetsadmin:<PASSWORD>@roc-tool-wrangler-db.postgres.database.azure.com:5432/postgres?sslmode=require' \
  -f api/migrations/001_schema.sql
```

This creates every table, the `asset_eligible()` function, the `v_open_loan_items` view, and seeds
the starter categories, locations and groups. Every statement is `IF NOT EXISTS` guarded, so it is
safe to re-run.

Then apply the roster migration, which adds Member Number, Title and the roster-sync bookkeeping:

```bash
psql "$DATABASE_URL" -f api/migrations/002_roster.sql
```

Also idempotent. `scripts/setup-azure.sh` runs both for you on a fresh install; you only need these
by hand when upgrading an environment that already exists.

Expect a wall of `CREATE TABLE` / `CREATE INDEX`. If you see
`ERROR: extension "pg_trgm" is not allow-listed`, go back and do step 1.3.

---

## 3. App settings (SWA → Settings → Environment variables)

| Setting | Value | Needed for |
|---|---|---|
| `DATABASE_URL` | the full postgres URL from step 2, including `?sslmode=require` | everything |
| `JWT_SECRET` | a long random string — `openssl rand -base64 48` | auth |
| `BOOTSTRAP_SECRET` | another random string — **delete it after step 4** | creating the first admin |
| `AZURE_STORAGE_CONNECTION_STRING` | Storage account → Access keys → Connection string | asset photos |

Photos degrade cleanly: without the storage setting, photo upload returns a clean *"Photo storage is
not configured yet"* rather than an error page, and everything else works.

Save, and wait for the app to restart (about a minute).

---

## 4. Create the first admin (~1 min)
<a id="4-create-the-first-admin-1-min"></a>

```bash
curl -X POST https://<your-swa>.azurestaticapps.net/api/auth/bootstrap \
  -H "Content-Type: application/json" \
  -d '{"bootstrap_secret":"<BOOTSTRAP_SECRET>",
       "email":"rugbyguytx@gmail.com",
       "password":"<pick something at least 10 characters>",
       "first_name":"Kyle","last_name":"Sandoval"}'
```

Then **delete the `BOOTSTRAP_SECRET` app setting.** Removing it permanently disables that endpoint —
no code change needed. (It also refuses to run once any admin exists, so it can't be used to add a
second back door.)

Check everything is wired up:

```bash
curl https://<your-swa>.azurestaticapps.net/api/health
```

You want `"db":"up"`, `"jwt_configured":true`, `"blob_configured":true` and — after deleting the
setting — `"bootstrap_open":false`.

---

## 5. Smoke test (~15 min)

Work through this in order the first time. It's the same path your staff will use daily.

1. **Sign in** at the SWA URL with the admin email and password from step 4.
2. **Admin → App users:** create one `staff` account and one `leader` account. Give them the
   generated passwords directly — they can change their own under *Change my password*.
3. **Admin → Lookups:** the seeded categories and locations are editable. Rename or hide anything
   that doesn't match how you actually talk about the equipment.
4. **Admin → Loanees:** add one person by hand. Then use **Import CSV / Excel** with a handful of
   rows from your Reftab export — the preview shows exactly what will happen before anything is
   saved, and the failed rows come back as a CSV you can fix and re-upload.
5. **Admin → Groups:** create a group, add that person to it.
6. **Assets → New Asset:** create a forklift. Add a photo. Then **Restrictions** → tick your group.
7. **Check In / Out:** pick a person *not* in that group and try to add the forklift — it should
   appear greyed out with the reason. Pick the person who *is* in the group and it goes through.
8. Check out **several items at once** to one person. Note the due date pre-filled 12 hours out.
9. **Out Now:** open it on your phone, and add it to the home screen. This is the leadership view.
10. **Check In** two of the items, leaving one out. Mark one *Damaged* and confirm it goes to
    maintenance rather than back on the shelf.
11. **Reports:** run *By person* and *Out now*, then **Export CSV** and open it in Excel.
12. **Admin → Logs:** every sign-in (successful or not) and every change is there, with IP addresses.

---

## 6. Before going live

- **Custom domain:** SWA → Custom domains. The managed certificate is free and automatic.
- **Backups:** Postgres → Backup and restore. Set retention to at least 7 days.
- **Query Store:** Postgres → Server parameters → `pg_qs.query_capture_mode` = `TOP`. Cheap
  insurance for diagnosing a slow report later.
- **Confirm `BOOTSTRAP_SECRET` is gone** from app settings.
- **Rotate `JWT_SECRET`** if it was ever pasted anywhere it shouldn't have been. Rotating signs
  everyone out, which is the point.
- **Import the full Reftab export** and check the board and reports at real volume.
- **Freeze Reftab to read-only**, run the final import, and go live.

---

## Troubleshooting

**Every API call returns 401.** Check the browser is sending `x-assets-token`, not `Authorization` —
Azure SWA strips `Authorization` before requests reach the API. This is the single most common
inherited gotcha.

**`CREATE EXTENSION` fails.** Step 1.3. `azure.extensions` must list `PGCRYPTO` and `PG_TRGM`, and
the server needs a restart after saving.

**`psql` can't connect.** Single-quote the whole URL, and check the server firewall allows your
current IP (it changes).

**Deploys aren't firing.** The SWA-generated workflow file in `.github/workflows/` is the source of
truth. Confirm it's still there and that you pushed to `main`.

**Stale JavaScript after a deploy.** Bump `CACHE_VERSION` in `sw.js` and `APP_VERSION` in
`js/config.js` together, then redeploy. Same rule as 8 Seconds.

**Photo upload returns 503.** `AZURE_STORAGE_CONNECTION_STRING` isn't set, or the app hasn't
restarted since you set it.

**The setup script fails on the storage account.** Storage account names are globally unique across
all of Azure, so `roctoolwranglerphotos` may already be taken by someone else. Re-run with
`STORAGE=somethingelse ./scripts/setup-azure.sh` — the script checks availability before trying, and
everything already created is skipped.

**The setup script fails on the schema with an extension error.** The restart in step 4 of the
script may still have been settling. Wait a minute and run the script again; it will skip straight
to the schema.

**A report is empty when you expect rows.** Check the date range at the top of the page first — it
defaults to the last 30 days, not all time.

**Someone can't sign in and you're not sure why.** Admin → Logs → *Sign-in & changes*. Failed
attempts are logged with the email tried, the IP and the reason.

---

## Anything periodic

Static Web Apps' managed Functions are **HTTP-only — there is no timer trigger.** If you later want
overdue reminders, a nightly digest, or a sweep of abandoned import batches, the pattern is a
scheduled GitHub Actions workflow that `curl`s a secret-protected endpoint (8 Second Rides does
exactly this for its notification outbox). Worth knowing before promising anyone automated reminders.
