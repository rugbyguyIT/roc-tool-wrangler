#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
# ROC Tool Wrangler — provision Azure and deploy, in one run.
#
#   ./scripts/setup-azure.sh
#
# Designed to be run in Azure Cloud Shell (https://shell.azure.com), which
# already has everything it needs: the Azure CLI, node, and psql. Nothing
# to install, and you are already signed in.
#
# The Static Web App is linked to the GitHub repo, exactly like 8 Second
# Rides: Azure commits a deploy workflow to the repo, and from then on
# every push to main redeploys the app on its own. Creating that link is
# the one step that opens a browser to authorise Azure against GitHub.
#
# SAFE TO RE-RUN. Every step checks whether the thing already exists and
# skips it, and generated secrets are reused rather than rotated. If a run
# dies halfway, fix the cause and run it again.
#
# Secrets land in .azure-secrets.env (chmod 600, gitignored). Copy them
# into a password manager and delete the file.
# ═══════════════════════════════════════════════════════════════════════
set -euo pipefail

# ── Configuration ──────────────────────────────────────────────────────
# Override inline, e.g.:  STORAGE=rocwranglerpics ./scripts/setup-azure.sh
RG="${RG:-roc-tool-wrangler-rg}"
LOCATION="${LOCATION:-southcentralus}"          # database + storage
DB_SERVER="${DB_SERVER:-roc-tool-wrangler-db}"
DB_NAME="${DB_NAME:-rocassets}"
DB_ADMIN="${DB_ADMIN:-assetsadmin}"
STORAGE="${STORAGE:-roctoolwranglerphotos}"     # 3-24 chars, lowercase letters+digits ONLY
SWA_NAME="${SWA_NAME:-roc-tool-wrangler}"
# Static Web Apps runs in a short list of regions and southcentralus is not
# one of them. centralus is nearest. Only affects where the front end and
# managed Functions live; the database stays in $LOCATION.
SWA_LOCATION="${SWA_LOCATION:-centralus}"
SWA_SKU="${SWA_SKU:-Standard}"                  # Free has no custom-domain SLA
REPO_URL="${REPO_URL:-https://github.com/rugbyguyIT/roc-tool-wrangler}"
REPO_BRANCH="${REPO_BRANCH:-main}"

SECRETS_FILE=".azure-secrets.env"

# ── Output helpers ─────────────────────────────────────────────────────
BOLD=$'\e[1m'; DIM=$'\e[2m'; GREEN=$'\e[32m'; YELLOW=$'\e[33m'; RED=$'\e[31m'; RESET=$'\e[0m'
step()  { printf '\n%s▸ %s%s\n' "$BOLD" "$1" "$RESET"; }
ok()    { printf '  %s✓%s %s\n' "$GREEN" "$RESET" "$1"; }
skip()  { printf '  %s·%s %s %s(already there)%s\n' "$DIM" "$RESET" "$1" "$DIM" "$RESET"; }
warn()  { printf '  %s!%s %s\n' "$YELLOW" "$RESET" "$1"; }
die()   { printf '\n%s✗ %s%s\n' "$RED" "$1" "$RESET" >&2; exit 1; }

# ── Preflight ──────────────────────────────────────────────────────────
step "Checking prerequisites"

command -v az   >/dev/null 2>&1 || die "Azure CLI not found. Easiest fix: run this in Azure Cloud Shell — https://shell.azure.com"
[[ -f "api/migrations/001_schema.sql" ]] || die "Run this from the project folder (api/migrations/001_schema.sql not found). Try: cd roc-tool-wrangler"

az account show >/dev/null 2>&1 || die "Not signed in to Azure. Run 'az login' first."
ok "Azure CLI signed in — subscription: $(az account show --query name -o tsv)"

HAVE_PSQL=1
command -v psql >/dev/null 2>&1 || { HAVE_PSQL=0; warn "psql not found — the schema step will be printed for you to run manually."; }

# Storage names are the fussiest thing in Azure. Catch it now, not later.
[[ "$STORAGE" =~ ^[a-z0-9]{3,24}$ ]] || die "STORAGE ('$STORAGE') must be 3-24 characters, lowercase letters and digits only."

# ── Secrets ────────────────────────────────────────────────────────────
step "Preparing secrets"
if [[ -f "$SECRETS_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$SECRETS_FILE"
  ok "Re-using the secrets already in $SECRETS_FILE"
else
  # Alphanumeric on purpose: a password containing $ ! @ / or : turns every
  # connection string into a quoting exercise and eventually someone pastes
  # a broken one into app settings.
  #
  # Note the fixed-chunk read rather than the usual
  # `tr -dc ... </dev/urandom | head -c N` — that idiom has head close the
  # pipe on tr, which under `set -o pipefail` exits the script before it
  # creates anything.
  gen() {
    local n="$1" out=""
    while (( ${#out} < n )); do
      out+="$(LC_ALL=C head -c 512 /dev/urandom | LC_ALL=C tr -dc 'A-Za-z0-9' || true)"
    done
    printf '%s' "${out:0:n}"
  }
  DB_PASSWORD="$(gen 28)"; JWT_SECRET="$(gen 64)"; BOOTSTRAP_SECRET="$(gen 32)"
  umask 077
  cat > "$SECRETS_FILE" <<EOF
# ROC Tool Wrangler — generated $(date -u +%Y-%m-%dT%H:%M:%SZ)
# KEEP PRIVATE. Store these in a password manager, then delete this file.
DB_PASSWORD='$DB_PASSWORD'
JWT_SECRET='$JWT_SECRET'
BOOTSTRAP_SECRET='$BOOTSTRAP_SECRET'
EOF
  ok "Generated new secrets → $SECRETS_FILE"
fi

# ── 1. Resource group ──────────────────────────────────────────────────
step "1/8  Resource group: $RG"
if [[ "$(az group exists --name "$RG")" == "true" ]]; then
  skip "$RG"
else
  az group create --name "$RG" --location "$LOCATION" --output none
  ok "Created in $LOCATION"
fi

# ── 2. PostgreSQL ──────────────────────────────────────────────────────
step "2/8  PostgreSQL: $DB_SERVER   ${DIM}(5-10 minutes — this is the slow one)${RESET}"
if az postgres flexible-server show -g "$RG" -n "$DB_SERVER" >/dev/null 2>&1; then
  skip "$DB_SERVER"
else
  az postgres flexible-server create \
    --resource-group "$RG" --name "$DB_SERVER" --location "$LOCATION" \
    --admin-user "$DB_ADMIN" --admin-password "$DB_PASSWORD" \
    --tier Burstable --sku-name Standard_B1ms --storage-size 32 --version 16 \
    --database-name "$DB_NAME" --public-access None --yes --output none
  ok "Created (Burstable B1ms, PostgreSQL 16, database '$DB_NAME')"
fi
DB_HOST=$(az postgres flexible-server show -g "$RG" -n "$DB_SERVER" --query fullyQualifiedDomainName -o tsv)
ok "Host: $DB_HOST"

# ── 3. Firewall ────────────────────────────────────────────────────────
step "3/8  Firewall"
# 0.0.0.0-0.0.0.0 is Azure's magic value for "other Azure services" — it is
# NOT the public internet. The Static Web App's Functions need it.
if az postgres flexible-server firewall-rule show -g "$RG" -n "$DB_SERVER" --rule-name AllowAzureServices >/dev/null 2>&1; then
  skip "AllowAzureServices"
else
  az postgres flexible-server firewall-rule create -g "$RG" -n "$DB_SERVER" \
    --rule-name AllowAzureServices --start-ip-address 0.0.0.0 --end-ip-address 0.0.0.0 --output none
  ok "Azure services allowed"
fi

MY_IP="$(curl -fsS --max-time 10 https://api.ipify.org 2>/dev/null || true)"
if [[ -n "$MY_IP" ]]; then
  if az postgres flexible-server firewall-rule show -g "$RG" -n "$DB_SERVER" --rule-name ClientIP >/dev/null 2>&1; then
    az postgres flexible-server firewall-rule update -g "$RG" -n "$DB_SERVER" \
      --rule-name ClientIP --start-ip-address "$MY_IP" --end-ip-address "$MY_IP" --output none
  else
    az postgres flexible-server firewall-rule create -g "$RG" -n "$DB_SERVER" \
      --rule-name ClientIP --start-ip-address "$MY_IP" --end-ip-address "$MY_IP" --output none
  fi
  ok "This machine allowed ($MY_IP)"
else
  warn "Could not detect your public IP — add a firewall rule by hand if psql can't connect."
fi

# ── 4. Extensions ──────────────────────────────────────────────────────
# The step everyone misses doing this by hand. pgcrypto gives us UUIDs,
# pg_trgm powers the fuzzy search behind every picker. Neither exists on
# Azure until allow-listed AND the server restarted — and the migration's
# first two lines are CREATE EXTENSION, so without this nothing gets built.
step "4/8  Allow-listing pgcrypto and pg_trgm"
CURRENT_EXT=$(az postgres flexible-server parameter show -g "$RG" -s "$DB_SERVER" \
  --name azure.extensions --query value -o tsv 2>/dev/null || echo "")

if [[ "$CURRENT_EXT" == *"PGCRYPTO"* && "$CURRENT_EXT" == *"PG_TRGM"* ]]; then
  skip "already allow-listed"
else
  WANT="PGCRYPTO,PG_TRGM"
  if [[ -n "$CURRENT_EXT" && "$CURRENT_EXT" != "None" ]]; then
    # Merge rather than clobber — don't drop anything already allow-listed.
    WANT=$(printf '%s,PGCRYPTO,PG_TRGM' "$CURRENT_EXT" | tr ',' '\n' | awk 'NF && !seen[$0]++' | paste -sd, -)
  fi
  az postgres flexible-server parameter set -g "$RG" -s "$DB_SERVER" \
    --name azure.extensions --value "$WANT" --output none
  ok "azure.extensions = $WANT"
  az postgres flexible-server restart -g "$RG" -n "$DB_SERVER" --output none
  ok "Server restarted so it takes effect"
fi

# ── 5. Storage ─────────────────────────────────────────────────────────
step "5/8  Storage account: $STORAGE   ${DIM}(asset photos)${RESET}"
if az storage account show -g "$RG" -n "$STORAGE" >/dev/null 2>&1; then
  skip "$STORAGE"
else
  # Storage names are globally unique across all of Azure, so this can
  # legitimately be taken by a stranger. Fail early with the fix.
  if [[ "$(az storage account check-name --name "$STORAGE" --query nameAvailable -o tsv)" != "true" ]]; then
    die "Storage name '$STORAGE' is taken (they're globally unique). Re-run as: STORAGE=somethingelse ./scripts/setup-azure.sh"
  fi
  az storage account create -g "$RG" -n "$STORAGE" -l "$LOCATION" \
    --sku Standard_LRS --kind StorageV2 --access-tier Hot \
    --min-tls-version TLS1_2 --allow-blob-public-access true --output none
  ok "Created"
fi
# The 'asset-photos' container is created by the app on first upload.
STORAGE_CONN=$(az storage account show-connection-string -g "$RG" -n "$STORAGE" --query connectionString -o tsv)
ok "Connection string retrieved"

# ── 6. Static Web App ──────────────────────────────────────────────────
step "6/8  Static Web App: $SWA_NAME"
if az staticwebapp show -g "$RG" -n "$SWA_NAME" >/dev/null 2>&1; then
  skip "$SWA_NAME"
else
  # Linked to the GitHub repo, same as 8 Second Rides: Azure commits a
  # deploy workflow to the repo and every push to main redeploys itself.
  warn "A browser window will open so Azure can authorise against GitHub."
  warn "That is what lets it commit the deploy workflow to your repo."
  az staticwebapp create -g "$RG" -n "$SWA_NAME" -l "$SWA_LOCATION" \
    --sku "$SWA_SKU" \
    --source "$REPO_URL" --branch "$REPO_BRANCH" \
    --app-location "/" --api-location "api" --output-location "" \
    --login-with-github --output none
  ok "Created and linked to $REPO_URL — Azure has committed the deploy workflow"
fi
SWA_HOST=$(az staticwebapp show -g "$RG" -n "$SWA_NAME" --query defaultHostname -o tsv)
APP_URL="https://$SWA_HOST"
ok "URL: $APP_URL"

# ── 7. App settings ────────────────────────────────────────────────────
# Set BEFORE deploying so the Functions have their config the moment they
# start, rather than booting once without a database and erroring.
step "7/8  Application settings"
DATABASE_URL="postgresql://${DB_ADMIN}:${DB_PASSWORD}@${DB_HOST}:5432/${DB_NAME}?sslmode=require"
az staticwebapp appsettings set -g "$RG" -n "$SWA_NAME" --setting-names \
  "DATABASE_URL=$DATABASE_URL" \
  "JWT_SECRET=$JWT_SECRET" \
  "BOOTSTRAP_SECRET=$BOOTSTRAP_SECRET" \
  "AZURE_STORAGE_CONNECTION_STRING=$STORAGE_CONN" \
  --output none
ok "DATABASE_URL · JWT_SECRET · BOOTSTRAP_SECRET · AZURE_STORAGE_CONNECTION_STRING"

grep -q '^DATABASE_URL=' "$SECRETS_FILE" 2>/dev/null || {
  printf "DATABASE_URL='%s'\nAPP_URL='%s'\n" "$DATABASE_URL" "$APP_URL" >> "$SECRETS_FILE"
}

# ── 8. Deploy ──────────────────────────────────────────────────────────
step "8/8  Deployment"
# Nothing to do here: linking the repo above started a GitHub Actions run,
# and every future push to main redeploys automatically. Watch it at:
#   $REPO_URL/actions
ok "GitHub Actions is building and deploying — watch $REPO_URL/actions"
ok "First run takes 3-5 minutes"

# ── Schema ─────────────────────────────────────────────────────────────
step "Loading the database schema"
if [[ "$HAVE_PSQL" == "1" ]]; then
  if PGPASSWORD="$DB_PASSWORD" psql \
      "host=$DB_HOST port=5432 dbname=$DB_NAME user=$DB_ADMIN sslmode=require" \
      -v ON_ERROR_STOP=1 -q --set=client_min_messages=warning \
      -f api/migrations/001_schema.sql; then
    ok "Schema loaded — tables, functions, views and starter lookup data"
  else
    die "Schema load failed. If it mentions an extension, the restart in step 4 may still be settling — wait a minute and re-run this script."
  fi
else
  warn "Run this yourself:"
  printf '\n    psql %s -f api/migrations/001_schema.sql\n' "'$DATABASE_URL'"
fi

# ── Done ───────────────────────────────────────────────────────────────
cat <<EOF

${BOLD}${GREEN}Done. Your app is live at ${APP_URL}${RESET}

${BOLD}One last step — create your login.${RESET} Copy and paste this whole block,
changing only the password:

curl -X POST $APP_URL/api/auth/bootstrap \\
  -H "Content-Type: application/json" \\
  -d '{"bootstrap_secret":"$BOOTSTRAP_SECRET",
       "email":"rugbyguytx@gmail.com",
       "password":"PutARealPasswordHere",
       "first_name":"Kyle","last_name":"Sandoval"}'

Then shut that door permanently:

az staticwebapp appsettings delete -g $RG -n $SWA_NAME --setting-names BOOTSTRAP_SECRET

Now sign in at ${BOLD}$APP_URL${RESET}

${DIM}Health check any time:  curl $APP_URL/api/health
Secrets are in $SECRETS_FILE — save them somewhere safe, then delete it.${RESET}
EOF
