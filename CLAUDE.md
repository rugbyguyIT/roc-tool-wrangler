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

Base64 payloads drift too, and there the damage is invisible: one wrong
character 9,823 bytes into `css/watermark.css` produced a PNG that no
decoder would open. Keep inlined binaries as small as the job allows —
fewer bytes is less surface for a bad character to land on — and decode
the deployed copy to prove it, not just diff it.

## A literal route under an `{id}` template is a live hazard

`GET /api/loans/open` matches both `loans/open` and `loans/{id}`, and the
Functions host **does not reliably prefer the literal** — in production the
template won, `loansGet` got `id="open"`, and Postgres answered *invalid
input syntax for type uuid*. The counter and the leader board both 500'd
while every other page worked, which made it look like a search bug. The
same collision existed on `loanees/lookup`, `loanees/committees` and
`assets/lookup`.

**Never rely on route precedence.** When a literal sits under a template:

1. Write the literal's logic as a plain named function.
2. Register the literal with that function as its handler.
3. Have the `{id}` handler check for the literal first and call the same
   function.
4. Have the `{id}` handler answer **404 for any non-UUID id**, so a bad
   path can never reach Postgres and become a 500 with a database error
   in the body.

`api/test/routing.js` holds this. The other suites structurally cannot:
their harness resolves a URL by taking the first matching registered route,
and the literal is registered first, so it always wins there. That suite
invokes the `{id}` handlers directly with the literal segment instead.

## Testing

```bash
DATABASE_URL=... JWT_SECRET=test BOOTSTRAP_SECRET=boot node api/test/smoke.js    # 131
DATABASE_URL=... JWT_SECRET=test BOOTSTRAP_SECRET=boot node api/test/roster.js   #  47
DATABASE_URL=... JWT_SECRET=test BOOTSTRAP_SECRET=boot node api/test/repairs.js  #  38
DATABASE_URL=... JWT_SECRET=test BOOTSTRAP_SECRET=boot node api/test/users.js    #  50
DATABASE_URL=... JWT_SECRET=test node api/test/routing.js                        #  11
node api/test/routes-audit.js    # every mutating route has a role gate
```

`routing.js` reads only and needs an active admin present, so run it after
`smoke.js`. A local Postgres is enough for all of them:

```bash
apt-get install -y postgresql
initdb -D /tmp/pgdata -A trust && pg_ctl -D /tmp/pgdata -o '-p 5433' start
createdb -p 5433 hlsrtest
for f in api/migrations/*.sql; do psql "postgresql://postgres@127.0.0.1:5433/hlsrtest" -q -f "$f"; done
```

`api/test/devserver.js` serves the static site and routes `/api/*` to the
real handlers, so the front end can be driven in a browser. It loads the
function modules once at boot — **restart it after editing anything under
`api/src/`**, or you will be testing the old code and believe the new code
is broken.

## Never send a placeholder through `push_files`

A commit went out with the literal string `PLACEHOLDER` as the body of
`api/src/functions/repairs.js`. Every function in an Azure Functions app
loads from one host, so a module that throws at load time does not break
one route — **the whole API returned 404 for about a minute**, health
check included.

`push_files` writes straight to `main`, which deploys straight to
production. There is no staging step and no review. So:

- assemble the real file content before opening the tool call, never a
  stand-in you intend to fill in
- after every push of **any** `.js` file, fetch the deployed copy back
  and parse it (`git show origin/main:<path>` → `new vm.Script(...)`)
  before moving on
- if the API ever answers **404 on every route including `/api/health`**,
  that is this failure mode, not a routing bug. Look at what the last
  commit did to a file under `api/src/`.

This happened **twice**: `PLACEHOLDER` into `api/src/functions/repairs.js`,
then `PENDING` into `js/picker.js` — the second one hours after writing the
paragraph above. Front-end files are not the safer case: `js/picker.js`
defines `attachPicker`, which `pages/staff.html` calls at boot, so the
counter page threw on load with nothing in the UI to say why. Writing the
rule down did not prevent the repeat; the fetch-back check is what caught
it. Run the check, every time, on every pushed file — treat it as part of
the push, not as a follow-up step that can be skipped when the change
looked simple.

## Two numbers beat one when a screen is empty

`/api/health` reports categories and locations as **both** active and
total counts. An empty dropdown has two possible causes — no rows, or
rows that are all inactive — and the pickers only request the active
ones, so a single total cannot tell them apart. The same reasoning is
why the asset form now names which of three things went wrong instead of
just rendering nothing.

## Diagnose from the app's own logs before theorising

The 500 above was diagnosed twice. The first diagnosis — a missing
`pg_trgm` extension — was reproducible in a local lab and completely wrong
about production. The actual cause was sitting in Admin → Logs → Errors the
whole time, one line, naming the function and the bad value. **Ask for the
logged error first.** A cause you can reproduce is not the same as the
cause that is happening.
