# Operations

How the operator runs, checks and recovers the live IsItLegit Worker (`https://isitlegit.derick-f5a.workers.dev`). Every command runs from a clean checkout with the local Wrangler login.

## Check the live Worker

```bash
node scripts/smoke.ts https://isitlegit.derick-f5a.workers.dev --commit <deployed commit>
```

It reads the smoke token from the vault (Conclave, "IsItLegit Smoke token") and the version serving all traffic, uses every binding once (D1, R2, KV, the analysis Workflow, Browser Run), and passes only if that version answered with the expected commit and every check is `ok`, and the same version still serves afterwards. It publishes nothing. `--rotate` makes a new token, stores it in the vault first, then sets it on the Worker, which publishes a new version of the same code, and checks that version. Vault calls go through `conclave-op`, the 1Password wrapper that loads the service account after checking its token file. When the Worker step fails, the script reads the newest version to learn what happened, and says which of three outcomes it met: the Worker kept the old token, so the vault was put back to it and nothing changed; the secret landed although the command failed, so the new token is kept and checked; or it could not tell. Only the last (or an interrupt mid-rotation) can leave the vault and the Worker disagreeing, and then plain runs fail with HTTP 404: run `--rotate` again, and its passing check proves the two agree. Cloudflare sets a secret only on the newest version, so while a rollback is in effect `--rotate` refuses before changing anything; rotate once a good commit is deployed again.

## Roll back a broken deploy

Roll back when a deploy breaks the live Worker: `/health` fails or reports the wrong commit, the smoke check fails, or members see errors.

```bash
node scripts/rollback.ts --reason "<what broke>"            # the previous good version
node scripts/rollback.ts --reason "<what broke>" --to <id>  # a named version
```

The script checks the whole command line first: a misspelt flag or a `--to` without a version id is refused before anything runs. It reads the active version from `wrangler deployments status`, not from `/health`, and the history from `wrangler deployments list`. Without `--to` it picks the newest earlier version whose commit differs from the active one, skipping every version and commit an earlier run rolled away from (listed in `build/rollback-rejected.json`, local to this checkout), so a retry never returns to broken code through another version of it. It refuses before changing anything when no version is eligible, the named one is gone, the record is damaged, or Wrangler cannot be read.

It deploys the chosen version through Cloudflare's API without `force`. When a secret changed since that version was deployed (a smoke-token rotation, a new API key), Cloudflare refuses, and the script reports the secrets by name and that nothing changed: rolling back would bring back the old secret values, which may be revoked keys. Redeploy the known-good commit from source instead (below), which keeps today's secrets. Wrangler's own `wrangler rollback` answers yes to that question by itself when it runs unattended, so do not script it.

After the change it reads back the active version, waits for `/health` to report the chosen commit (a rollback takes a few seconds to reach every location), runs the smoke check, and reads back the active version again. It succeeds only if all of that holds. It prints each stage, the elapsed time every 10 seconds while it waits, what `/health` answers meanwhile, and the total. One deadline bounds the whole run, with time kept back to report. On any failure, or Ctrl+C, it says whether the deployment changed: `no`, `yes` or `uncertain`. When it is uncertain, read `wrangler deployments status` before doing anything else.

A rollback changes only which code version serves traffic. It never changes D1, R2 or KV data. It does not undo a D1 schema migration either, so code older than a migration may meet a newer schema: check `migrations/` between the two commits before rolling back across one.

Each run says what it recorded. A rollback records the version and commit it leaves; a roll-forward (`--to` a newer version) records nothing and clears its target, which you have just vouched for. When the incident is over and a good deploy is live, delete `build/rollback-rejected.json`, so later rollbacks may choose those versions again.

### A split deployment

A gradual deployment serves two versions at once (say 90% and 10%). `wrangler deployments status` lists every serving version and its percentage. The script will not guess which side is good: without `--to` it refuses a split before changing anything and names it. Choose the version to restore and name it:

```bash
pnpm exec wrangler deployments status                     # the serving versions and their percentages
node scripts/rollback.ts --reason "<what broke>" --to <id>  # one side of the split, or an older version
```

It moves the named version to 100%, then verifies it as for any rollback. The record follows the same rules: a rollback records every serving version other than the target, with its commit; when the target is newer than every serving version, it is a roll-forward and records nothing. Whether the deployment changed is judged on the whole deployment (every version and its percentage): `no` when the split is as it was (a refused or failed call), `yes` when anything moved, and `uncertain` only when the deployment cannot be read.

## Redeploy a known-good commit

Cloudflare keeps only the 100 most recent versions, and every rotation of the smoke token or other secret publishes one. Redeploy from source when no rollback target is left, or when the rollback was refused because secrets changed. The old commit is built in a separate worktree, and today's `main` checks it: an older commit's own `scripts/smoke.ts` may mint a token or publish a version, which would leave the vault and the Worker disagreeing.

1. `git worktree add ../isitlegit-recover <known-good commit>`, then `cd ../isitlegit-recover && pnpm install --frozen-lockfile`.
2. Run the gates there: `pnpm typecheck`, `pnpm lint`, `pnpm test`. (The publication check ran when that commit was made; its client list is git-ignored and stays in the main checkout.)
3. Deploy from there: `pnpm exec wrangler deploy --var COMMIT_SHA:$(git rev-parse HEAD)`. A deploy keeps today's secrets.
4. Back in the main checkout, on `main`: `curl -s https://isitlegit.derick-f5a.workers.dev/health` reports that commit, and `node scripts/smoke.ts https://isitlegit.derick-f5a.workers.dev --commit <known-good commit>` passes.
5. `git worktree remove ../isitlegit-recover`, and fix forward on `main`.
