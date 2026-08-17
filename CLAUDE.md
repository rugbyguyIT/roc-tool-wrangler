# Working conventions for this project

## Kyle runs everything in Azure Cloud Shell, and it is ephemeral

Assume **nothing persists between commands**. Every Cloud Shell session may
start with:

- no shell variables (`$DB_URL` and friends are gone)
- no cloned repo (`~/roc-tool-wrangler` may not exist)
- a **different public IP**, so the database firewall rule no longer admits it
- no `.azure-secrets.env`

He also gets disconnected mid-task fairly often, so a block that half-ran is
the normal case, not the exception.

### Therefore: every command block must be self-contained and re-runnable

Give one paste-able block that sets its own variables, clones if needed, and
fixes the firewall. Never write a block that depends on something an earlier
block set up. Never say "then run…" as a separate step that assumes state.

The standard preamble:

```bash
cd ~
[ -d roc-tool-wrangler ] || git clone https://github.com/rugbyguyIT/roc-tool-wrangler.git
cd roc-tool-wrangler && git pull

DB_URL=$(az staticwebapp appsettings list -g roc-tool-wrangler-rg -n roc-tool-wrangler \
         --query "properties.DATABASE_URL" -o tsv)
MYIP=$(curl -s https://api.ipify.org)
az postgres flexible-server firewall-rule update -g roc-tool-wrangler-rg \
  -s roc-tool-wrangler-db -n ClientIP \
  --start-ip-address "$MYIP" --end-ip-address "$MYIP" -o none
```

`DB_URL` is read back from the deployed app rather than from a local file,
because the local file is usually gone. End blocks with a verification line
so he can see it worked without asking.

## Migrations are idempotent on purpose

`api/migrations/*.sql` are all `IF NOT EXISTS` / `ON CONFLICT` guarded, so
re-running after a dropped connection is safe and is the recommended
recovery. `scripts/setup-azure.sh` applies all of them in order.

`scripts/setup-azure.sh` is also safe to re-run from a bare Cloud Shell: with
no `.azure-secrets.env` it adopts the secrets already deployed rather than
generating new ones (which would overwrite `DATABASE_URL` with a password the
server does not have).

## Verify Azure CLI flags against the docs before writing them

Four separate failures in this project came from assumed flag names
(`--database-name` on flexible-server create, `-d` vs `-n` on `db create`,
`--rule-name` on `firewall-rule`, and `--public-access None` meaning "public
access off"). A stubbed `az` that accepts any arguments proves the script's
logic and nothing about its interface — `scripts/setup-azure.sh`'s test stub
now rejects known-bad signatures for this reason.

## Pushing to GitHub

`git push` is blocked by the session proxy for this repo. Files reach GitHub
through the GitHub MCP tools instead. Content retyped into a tool call
silently mis-transcribes long runs of box-drawing characters (─ ═) in the
comment banners, so **always verify by comparing `git hash-object` against
the blob SHA GitHub returns**, and reconstruct locally until the hash matches
before pushing.

## Testing

```bash
DATABASE_URL=... JWT_SECRET=test BOOTSTRAP_SECRET=boot node api/test/smoke.js    # 131
DATABASE_URL=... JWT_SECRET=test BOOTSTRAP_SECRET=boot node api/test/roster.js   #  47
DATABASE_URL=... JWT_SECRET=test BOOTSTRAP_SECRET=boot node api/test/repairs.js  #  38
node api/test/routes-audit.js    # every mutating route has a role gate
```
