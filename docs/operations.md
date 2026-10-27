# Operations

How the operator runs, checks and recovers the live IsItLegit Worker (`https://isitlegit.derick-f5a.workers.dev`). Every command runs from a clean checkout with the local Wrangler login.

## Check the live Worker

```bash
node scripts/smoke.ts https://isitlegit.derick-f5a.workers.dev --commit <deployed commit>
```

It reads the smoke token from the vault (Conclave, "IsItLegit Smoke token") and the version serving all traffic, uses every binding once (D1, R2, KV, the analysis Workflow, Browser Run), and passes only if that version answered with the expected commit and every check is `ok`, and the same version still serves afterwards. It publishes nothing. `--rotate` makes a new token, stores it in the vault first, then sets it on the Worker, which publishes a new version of the same code.

## Roll back a broken deploy

Roll back when a deploy breaks the live Worker: `/health` fails or reports the wrong commit, the smoke check fails, or members see errors.

```bash
node scripts/rollback.ts --reason "<what broke>"            # the previous good version
node scripts/rollback.ts --reason "<what broke>" --to <id>  # a named version
```

The script reads the active version from `wrangler deployments status`, not from `/health`, and the history from `wrangler deployments list`. Without `--to` it picks the newest earlier version whose commit differs from the active one, skipping versions an earlier run rolled away from (listed in `build/rollback-rejected.json`, local to this checkout). It refuses before changing anything when no version is eligible or the named one is gone. After `wrangler rollback` it reads back the active version, checks `/health` for the chosen commit, runs the smoke check, and reads back the active version again. It succeeds only if all of that holds. On any failure, or Ctrl+C, it says whether the deployment changed: `no`, `yes` or `uncertain`. When it is uncertain, read `wrangler deployments status` before doing anything else.

A rollback changes only which code version serves traffic. It never changes D1, R2 or KV data. It does not undo a D1 schema migration either, so code older than a migration may meet a newer schema: check `migrations/` between the two commits before rolling back across one.

When the incident is over and a good deploy is live, delete `build/rollback-rejected.json`, so later rollbacks may choose those versions again.

## Redeploy a known-good commit

Cloudflare keeps only the 100 most recent versions, and every rotation of the smoke token or other secret publishes one. When no rollback target is left, redeploy from source:

1. `git checkout <known-good commit>` in a clean tree (`git status --porcelain` prints nothing).
2. Run the gates: `pnpm typecheck`, `pnpm lint`, `pnpm test`, `python3 scripts/check-publication.py`.
3. `pnpm exec wrangler deploy --var COMMIT_SHA:$(git rev-parse HEAD)`.
4. `curl -s https://isitlegit.derick-f5a.workers.dev/health` reports that commit, and the smoke check passes for it.
5. Return to `main` (`git checkout main`) and fix forward.
