# Operations

How the operator runs, checks and recovers the live IsItLegit Worker (`https://isitlegit.derick-f5a.workers.dev`). Every command runs from a clean checkout with the local Wrangler login.

## Check the live Worker

```bash
node scripts/smoke.ts https://isitlegit.derick-f5a.workers.dev --commit <deployed commit>
```

It reads the smoke token from the vault (Conclave, "IsItLegit Smoke token") and the version serving all traffic, uses every binding once (D1, R2, KV, the analysis Workflow, Browser Run), and passes only if that version answered with the expected commit and every check is `ok`, and the same version still serves afterwards. It publishes nothing. `--rotate` makes a new token, stores it in the vault first, then sets it on the Worker, which publishes a new version of the same code, and checks that version. Vault calls go through `conclave-op`, the 1Password wrapper that loads the service account after checking its token file. When the Worker step fails, the script reads the newest version to learn what happened, and says which of three outcomes it met: the Worker kept the old token, so the vault was put back to it and nothing changed; the secret landed although the command failed, so the new token is kept and checked; or it could not tell. Only the last (or an interrupt mid-rotation) can leave the vault and the Worker disagreeing, and then plain runs fail with HTTP 404: run `--rotate` again, and its passing check proves the two agree. Cloudflare sets a secret only on the newest version, so while a rollback is in effect `--rotate` refuses before changing anything; rotate once a good commit is deployed again.

## Database migrations

The schema lives in `src/db/migrations/` (the `DB` binding's `migrations_dir`). Apply a new migration to the live database before deploying the code that needs it, so the old code keeps working against the new schema while the deploy lands:

```bash
pnpm db:migrate:local                                   # try it on a local database first
pnpm db:migrate:remote                                  # then the live one
pnpm exec wrangler d1 migrations list DB --remote        # reads back "No migrations to apply"
```

Write migrations that only add (new tables, new nullable columns), so code one deploy behind still runs. A rollback never reverts a migration (below).

When `pnpm db:migrate:remote` fails or is cut off (an SQL error, a lost connection, Ctrl+C), do not deploy. D1 runs each migration as a unit: one that fails is rolled back whole, the ones before it stay applied with their data, and the failed one stays pending. So:

1. `pnpm exec wrangler d1 migrations list DB --remote` shows which migrations are still to apply.
2. Fix the migration file that failed (it was never recorded as applied, so editing it is safe), and try it with `pnpm db:migrate:local` first.
3. Run `pnpm db:migrate:remote` again; it applies only what is pending.
4. Deploy only once `migrations list --remote` reads "No migrations to apply".

Rehearsed 2026-10-27 on a local database: a second migration that created a table and then failed left the first migration's table and its row in place, created nothing, and stayed pending; fixed and applied again, it applied alone and the row was still there.

## Roll back a broken deploy

Roll back when a deploy breaks the live Worker: `/health` fails or reports the wrong commit, the smoke check fails, or members see errors.

```bash
node scripts/rollback.ts --reason "<what broke>"            # the previous good version
node scripts/rollback.ts --reason "<what broke>" --to <id>  # a named version
```

The script checks the whole command line first: a misspelt flag or a `--to` without a version id is refused before anything runs. It reads the active version from `wrangler deployments status`, not from `/health`, and the history from `wrangler deployments list`. Without `--to` it picks the newest earlier version that served traffic (never one only staged at 0%) whose commit differs from the active one, skipping every version and commit an earlier run rolled away from (listed in `build/rollback-rejected.json`, local to this checkout), so a retry never returns to broken code through another version of it. It refuses before changing anything when no version is eligible, the named one is gone, the record is damaged, or Wrangler cannot be read.

It deploys the chosen version through Cloudflare's API without `force`. When a secret changed since that version was deployed (a smoke-token rotation, a new API key), Cloudflare refuses, and the script reports the secrets by name and that nothing changed: rolling back would bring back the old secret values, which may be revoked keys. Redeploy the known-good commit from source instead (below), which keeps today's secrets. Wrangler's own `wrangler rollback` answers yes to that question by itself when it runs unattended, so do not script it.

After the change it reads back the active version, waits for `/health` to report the chosen commit (a rollback takes a few seconds to reach every location), runs the smoke check, and reads back the active version again. It succeeds only if all of that holds. It prints each stage, the elapsed time every 10 seconds while it waits, what `/health` answers meanwhile, and the total. One deadline bounds the whole run, with time kept back to report. On any failure, or Ctrl+C, it says whether the deployment changed: `no`, `yes` or `uncertain`. When it is uncertain, read `wrangler deployments status` before doing anything else.

A rollback changes only which code version serves traffic. It never changes D1, R2 or KV data. It does not undo a D1 schema migration either, so code older than a migration may meet a newer schema: check `migrations/` between the two commits before rolling back across one.

Each run says what it recorded. A rollback records the version and commit it leaves, before it deploys. A roll-forward is `--to` a version whose code descends (in git) from what serves, not merely a later upload; it records nothing, and clears its target from the record only once the target is verified. The deployment is read again just before anything is written or deployed, and a run that finds it changed meanwhile (another deploy) stops without doing anything. A target without a `COMMIT_SHA` cannot be proven by `/health` or the smoke check, so it is refused; deploy a known-good commit instead. When the incident is over and a good deploy is live, delete `build/rollback-rejected.json`, so later rollbacks may choose those versions again.

### A split deployment

A gradual deployment serves two versions at once (say 90% and 10%). `wrangler deployments status` lists every serving version and its percentage. The script will not guess which side is good: without `--to` it refuses a split before changing anything and names it. Choose the version to restore and name it:

```bash
pnpm exec wrangler deployments status                     # the serving versions and their percentages
node scripts/rollback.ts --reason "<what broke>" --to <id>  # one side of the split, or an older version
```

It moves the named version to 100%, then verifies it as for any rollback. The record follows the same rules: a rollback records every serving version other than the target, with its commit; when the target's code descends from every serving version's, it is a roll-forward and records nothing until verified. A version listed at 0% serves nothing and is ignored. Whether the deployment changed is judged on the whole deployment (every version and its percentage): `no` when the split is as it was (a refused or failed call), `yes` when anything moved, and `uncertain` only when the deployment cannot be read.

## Redeploy a known-good commit

Cloudflare keeps only the 100 most recent versions, and every rotation of the smoke token or other secret publishes one. Redeploy from source when no rollback target is left, or when the rollback was refused because secrets changed. The old commit is built in a separate worktree, and today's `main` checks it: an older commit's own `scripts/smoke.ts` may mint a token or publish a version, which would leave the vault and the Worker disagreeing.

1. `git worktree add ../isitlegit-recover <known-good commit>`, then `cd ../isitlegit-recover && pnpm install --frozen-lockfile`.
2. Run the gates there: `pnpm typecheck`, `pnpm lint`, `pnpm test`. (The publication check ran when that commit was made; its client list is git-ignored and stays in the main checkout.)
3. Deploy from there: `pnpm exec wrangler deploy --var COMMIT_SHA:$(git rev-parse HEAD)`. A deploy keeps today's secrets.
4. Back in the main checkout, on `main`: `curl -s https://isitlegit.derick-f5a.workers.dev/health` reports that commit, and `node scripts/smoke.ts https://isitlegit.derick-f5a.workers.dev --commit <known-good commit>` passes.
5. `git worktree remove ../isitlegit-recover`, and fix forward on `main`.

## Snapshot and restore the AI Gateway configuration

Gateway `isitlegit`'s settings, its `meta` custom provider and the provider's pricing rules live in the Cloudflare account, so a Worker rollback does not bring them back. `infra/ai-gateway.json` is their committed snapshot. Both commands read the admin token from the vault (Conclave, "IsItLegit AI Gateway admin token", through `conclave-op`): a snapshot needs AI Gateway Read, a restore AI Gateway Write. `node scripts/gateway-config.ts --help` lists everything offline.

```bash
node scripts/gateway-config.ts snapshot        # after any change in the dashboard; commit infra/ai-gateway.json
node scripts/gateway-config.ts restore --dry   # what a restore would change; sends nothing
node scripts/gateway-config.ts restore         # put the account back to the file
```

A snapshot is written whole or not at all: if a read or the write fails, the previous file stays as it was. It leaves out ids, account fields and timestamps, which change when a resource is re-created, and names the gateway by its id, the provider by its slug and a pricing rule by its model.

A restore checks the whole file before it sends anything, creates what is missing (the provider's logo is set after it is created), updates what differs and never deletes. Afterwards it reads the account back and passes only when it matches the file. Exit codes: 0 done or nothing to change, 1 failed, 2 refused before any change.

To go back to an earlier configuration without touching the committed snapshot, write the old file somewhere else and restore that:

```bash
git log --oneline -- infra/ai-gateway.json
git show <commit>:infra/ai-gateway.json > /tmp/ai-gateway-<commit>.json
node scripts/gateway-config.ts restore --dry --file /tmp/ai-gateway-<commit>.json
node scripts/gateway-config.ts restore --file /tmp/ai-gateway-<commit>.json
```

When it refuses or fails:

- **"the token needs AI Gateway Read" or "AI Gateway Write"**: the admin token lost a permission or expired. It is an account API token (D99 T01 §8): check it in the dashboard (Manage Account, Account API Tokens), fix it, store any new value in the Conclave item, and run again.
- **"the provider's headers is set" or "the gateway's otel / stripe is set"**: these fields can hold a credential, which must not enter git, so neither command handles them. Clear the field in the dashboard (AI, AI Gateway), or keep the credential in Cloudflare's Secrets Store, then run again. The message names the field, never its value.
- **"is not a snapshot" or "cannot be read as JSON"**: the file is damaged. Restore it from git (`git checkout -- infra/ai-gateway.json`) or take a fresh snapshot. Nothing was sent.
- **"uncertain"**: a change was sent and no answer came back, so it may have landed. Run restore again: it finds what landed by id, slug and model, and creates nothing twice.
- **"the live pricing rule ... is not in the file; it is kept"**: a rule exists in the account that the snapshot lacks. Restore never deletes; remove it by hand in the dashboard if it should go, or take a snapshot if it should stay.
- **"still differs ... after restoring"**: Cloudflare accepted the change but kept another value. The message names the field; set it in the dashboard and run `restore --dry` to confirm.

## AI Gateway log retention

This account's AI Gateway logs are kept in Workers Logs, not Legacy Logs. Read on 2026-10-27 from the Workers observability API: dataset `ai-gateway` holds gateway `isitlegit`'s `request-logs` events. Cloudflare's account settings do not name the log store, and the account (created 2023-08-28) has audit entries only from 2026-05-22, so the audit log cannot rule out an earlier gateway; the dataset is the deciding evidence. ([AI Gateway pricing: logs](https://developers.cloudflare.com/ai-gateway/reference/pricing/), [AI Gateway limits](https://developers.cloudflare.com/ai-gateway/reference/limits/).)

The limits are those of Workers Logs ([Workers Logs limits](https://developers.cloudflare.com/workers/observability/logs/workers-logs/#limits)):

| Limit | Value |
| --- | --- |
| Retention | 7 days, then the log is gone |
| Volume | 5 billion logs per account per day; past that, a 1% sample for the rest of the day |
| Size | 256 KB per log; a larger one is truncated |

The gateway's own `log_management` (10,000,000) and `log_management_strategy` (`DELETE_OLDEST`) are Legacy Logs settings and do not apply to this account. Nothing needs deleting by hand: a log older than 7 days is gone, so evidence that must last longer (such as `docs/meta-smoke-test.md`) is written to the repository at the time.

The events hold metadata only: the model, path, user agent, status, duration, token counts and cost. All 22 events of 2026-10-27 were checked and none holds a request or response body, which matches the gateway's logs API answering 404 code 7002 for every body (D00 T01 §7).
