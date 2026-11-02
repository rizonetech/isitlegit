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

## Report link secret

A reply's report link (`/r/<case>?o=…&e=…&s=…`) is signed with the Worker secret `REPORT_LINK_SECRET`, 32 random bytes as base64url kept in the vault as "IsItLegit report link secret" (`src/web/report-link.ts`). A link opens its one case for 7 days.

Replacing the secret invalidates every report link already sent: recipients then open their report from the console instead. Replace it only when it may have leaked. To replace it, write a new value into the vault item first, then set it on the Worker from the vault. The read finishes and is checked (43 characters) before Wrangler starts, so a failed or empty read never replaces the live secret with nothing; the value stays in a shell variable, never printed or passed as an argument:

```bash
secret=$(conclave-op read "op://Conclave/IsItLegit report link secret/credential") && [ ${#secret} -eq 43 ] \
  && printf %s "$secret" | pnpm exec wrangler secret put REPORT_LINK_SECRET \
  || echo "not set: the vault read failed or the value is not 43 characters"
unset secret
```

Cloudflare sets a secret only on the newest version, so do it while no rollback is in effect, and run the smoke check afterwards: `wrangler secret put` publishes a new version of the same code.

## Bank keys

Registered bank account numbers (D05 T01 §2, `src/trust/bank.ts`) are encrypted with the Worker secret `BANK_KEY` (AES-GCM) and matched by an HMAC under `BANK_MATCH_KEY`. Each is 32 random bytes as base64 (44 characters), kept in the vault item "IsItLegit bank key", fields `BANK_KEY` and `BANK_MATCH_KEY`. Every stored account records the fingerprints of the two keys it was made under. While any account is under another key than the Worker holds, adding and matching for that business refuse with `KeyMismatch`: a replaced or lost key is never reported as a changed bank.

Set them on the Worker from the vault the same way as the report link secret (the value is read, checked at 44 characters, and piped, never printed or passed as an argument):

```bash
for field in BANK_KEY BANK_MATCH_KEY; do
  secret=$(conclave-op read "op://Conclave/IsItLegit bank key/$field") && [ ${#secret} -eq 44 ] \
    && printf %s "$secret" | pnpm exec wrangler secret put "$field" \
    || echo "$field not set: the vault read failed or the value is not 44 characters"
done
unset secret
```

To replace a key (only when it may have leaked): keep the old values in the vault under a dated field, generate the new ones, set the new pair as the current secrets and the old pair as the previous secrets (the action below reads its destination from the current secrets, so they are set first), then run the action, so every account moves from the old fingerprints to the new, the registry's and the supplier ledger's alike (both are kept under these keys, D06 T01 §2). Its first step makes the new keys the current ones in D1 (`bank_key_epoch`), so from that moment an account still under the old keys refuses to add or match with `KeyMismatch` until the run reaches it: rotate in a quiet moment, and an add that raced it is refused rather than left under the old key. The helper replaces each row only from the old fingerprints, organisation by organisation with that organisation's audit event in the same batch, so running it again after an interruption moves and audits only what is left, and it reports how many rows it could not decrypt. The operator action that runs it is D05 T01 §4. A key lost for good cannot be recovered: the accounts under it keep refusing matches with `KeyMismatch`. The fix is `abandonLostKeys(db, newKeys, actor)` with the new secrets set: it makes the new keys current, deletes every account under the lost ones in the registry and the supplier ledger (each with its `bank.removed` or `account.removed` event, so every deletion is audited) and reports how many; each owner then registers their accounts again. The protected live accounts are the one exception (D05 T01 §5; `src/auth/protected.ts`): the accounts of Fynbos Freight and of every organisation demo@rizonetech.com or derick@rizonetech.com belongs to are kept, with no event, and reported as `kept`. A kept account still refuses matches with `KeyMismatch`; its owner removes it on the identity page or the supplier ledger (an owner's own single removal, which is allowed and audited) and registers it again under the new keys. Deleting the accounts by hand is not enough, since the lost keys would stay current and refuse every new registration. Like re-keying, the operator action that runs it is D05 T01 §4.

Running the action (D05 T01 §4, shipped): the operator, signed in through Cloudflare Access, posts to `POST /admin/bank-keys` on the app host with the `Cf-Access-Jwt-Assertion` header of that Access session, an `Origin` header of exactly the app host's origin, and a form body naming `operation` (`rotate` or `recover`) and, for `recover` only, `confirm=recover`; from a signed-in browser session on the app host both headers are the ones the browser already sends. The answer is JSON counts and guidance, never a number or a key. For a rotation: set the new pair as `BANK_KEY` and `BANK_MATCH_KEY` and the old pair as `BANK_KEY_PREVIOUS` and `BANK_MATCH_KEY_PREVIOUS` from the vault first (each piped, checked at 44 characters, never printed or passed as an argument, exactly as above), then post `operation=rotate`; the first accounts move straight away, and adding and matching refuse with `KeyMismatch` only for an account the run has not reached yet, so rotate in a quiet moment and set nothing else until it reports. A run interrupted halfway is simply posted again with the same keys: it moves only what is left and audits only the organisations that run moved. When it reports `remaining` as 0, verify by matching one known account, then delete the previous secrets again (`pnpm exec wrangler secret delete BANK_KEY_PREVIOUS` and, separately, `pnpm exec wrangler secret delete BANK_MATCH_KEY_PREVIOUS`), since the Worker reads them only while they are present; while `remaining` is not 0 the rotation is not finished and the previous secrets stay. For a lost key: set the new pair as the current secrets, post `operation=recover` with its confirmation, and tell each affected owner to register again; the answer names how many accounts were deleted and how many protected ones were kept, and a kept account still refuses matches until its owner removes it on the identity page or in the supplier ledger and registers it again.

## Better Auth secret

Members' session cookies are signed with the Worker secret `BETTER_AUTH_SECRET`, 32 random bytes as base64url kept in the vault as "IsItLegit Better Auth secret" (`src/auth/auth.ts`, D07 T02 §1). It was created on 2026-10-28 from the generator straight into the vault (the item JSON piped to `conclave-op item create --vault Conclave -`, so the value never appeared as an argument), then set on the Worker from the vault as below; the smoke check passed on the version that published.

Replacing it signs every member out. It does not void a magic link already sent: a link carries a random token whose hash is a row in D1's `verification` table, checked without the secret, so it still signs in until it is used or its 15 minutes pass (`test/auth/flow.test.ts`, "keeps outstanding links across a new secret"). Replace it only when it may have leaked: write a new value into the vault item first, then set it on the Worker from the vault, the read checked (43 characters) before Wrangler starts:

```bash
secret=$(conclave-op read "op://Conclave/IsItLegit Better Auth secret/credential") && [ ${#secret} -eq 43 ] \
  && printf %s "$secret" | pnpm exec wrangler secret put BETTER_AUTH_SECRET \
  || echo "not set: the vault read failed or the value is not 43 characters"
unset secret
```

As with any secret, `wrangler secret put` publishes a new version of the same code: do it while no rollback is in effect, and run the smoke check afterwards.

To void every magic link not yet used (a mailbox exposed, or with the secret when the leak may include sent links), delete their records; a voided link then lands on the sign-in page with `error=INVALID_TOKEN`, and the member asks for a new one:

```bash
pnpm exec wrangler d1 execute isitlegit --remote --command "DELETE FROM verification WHERE identifier LIKE 'magic-link:%'"
```

## Settle an uncertain mail send

A mail send is `uncertain` when SMTP2GO gave no answer, an unreadable one or a 5xx (D01 T02 §1): it may or may not have gone. Every 15 minutes the Worker's cron settles such sends from SMTP2GO's own record, by the send key each message carries in its `X-IsItLegit-Send` header (`src/mail/reconcile.ts`). It never sends a message again, and an empty search proves nothing, so a send SMTP2GO shows no record of stays uncertain. One still unresolved after 3 days comes to the operator once, as an alert mail naming its kind, case and send key.

To settle it, open SMTP2GO's activity, search the send's time with the `X-IsItLegit-Send` header shown, and find the send key. Then record what SMTP2GO shows:

```bash
node scripts/mail-settle.ts <send key> sent --claimed-at <claim time from the alert>     # SMTP2GO has the message
node scripts/mail-settle.ts <send key> failed --claimed-at <claim time from the alert>   # SMTP2GO has no record; it may be sent again
```

The script changes only a row that is still uncertain or pending and still the attempt the alert named, so it never reopens a sent message and a repeated command never touches a newer attempt; it refuses anything that is not a send key or a claim time. Use `failed` only when SMTP2GO has no record, since it lets the message be sent again. SMTP2GO states no maximum delay before a send appears in its activity, so after `failed` a late original can still arrive and a second send would reach the recipient twice; that is the accepted cost of keeping SMTP2GO (D01 T02 §7). Settling `failed` sends nothing itself. For a verdict reply (`reply:<case id>`), add `--resend` and the Worker's cron rebuilds the reply from its case and sends it again within 15 minutes, under the same send key (D01 T02 §8). Resend only when SMTP2GO shows no record of the original: if it arrives late, the member receives it twice. Other kinds keep no content to rebuild and cannot be resent.

```bash
node scripts/mail-settle.ts reply:<case id> failed --claimed-at <claim time> --resend   # settle it failed and send it again
node scripts/mail-settle.ts reply:<case id> status                                     # requested, sending, done, exhausted or cancelled
node scripts/mail-settle.ts reply:<case id> cancel                                     # before the cron claims it; refused once sending
node scripts/mail-settle.ts reply:<case id> requeue                                    # after an exhausted (or cancelled) resend
node scripts/mail-settle.ts reply:<case id> resend                                     # a reply already settled failed without --resend
```

`status` says what the resend ended in (sent, refused with the allowlist's reason, left to the reconciler, no one to reply to, or the reason it could not be rebuilt) and the next step. A run that stopped mid-send is picked up by the next: asked for again if the reply never left, left to the reconciler if it may have. Each run sends every requested reply it can within its five-minute budget, so a normal backlog goes in the next run; a long backlog against a slow or silent SMTP2GO spills to the runs after it.

A resend that fails three cron runs is `exhausted` and comes to the operator as one alert; once SMTP2GO sends again (`python3 scripts/check-smtp2go.py`), `requeue` asks for it once more. A resend that SMTP2GO accepted but whose outcome could not be written is left to the reconciler above, never sent again.

Each cron run logs one line, `{"event":"mail-reconcile","state":...}`, in Workers Logs: `disabled` when the SMTP2GO key is not set, `degraded` when a search failed (such as SMTP2GO refusing the activity search, HTTP 401 or 403) or a send could not be handed over, `ok` otherwise, with how many sends were settled, left unresolved and handed over. An alert that itself could not be confirmed sent is reconciled like any send, and its send counts as unresolved until it is.

## Domain recovery

`isitlegit.co.za` is signed with DNSSEC: Cloudflare signs the zone and the registry (ZADNA, through Domains.co.za) holds its DS record (D99 T01 §2). A nameserver or signing change made while that DS is still published makes every validating resolver refuse the domain (SERVFAIL), and with it the site, mail intake at `check@` and every report link (https://developers.cloudflare.com/dns/dnssec/). Each procedure below is ordered, each step names its command or dashboard action and the read-back that shows it worked, and each ends with `python3 scripts/check-domain.py`, which compares the live records with what §2 published: `check-domain: 9 of 9 checks passed` and exit 0 when all hold, exit 1 naming each wrong record (a move in progress is named as one, never passed), and exit 2 when a lookup could not be made at all. During an incident an exit 2 means "could not look", not "the records are fine" or "the records are wrong": check the network and try again before acting on it.

The records as published, for comparing by eye: nameservers `carmelo.ns.cloudflare.com` and `paris.ns.cloudflare.com`; DS `2371 13 2 360CD8AC177997F22F9239EF3EB686AAAEDF101C211B330C684B723928504665`; MX `route1`, `route2`, `route3.mx.cloudflare.net`; SPF `v=spf1 include:_spf.mx.cloudflare.net ~all`; Email Routing's DKIM key at `cf2024-1._domainkey`; DMARC `v=DMARC1; p=reject; sp=reject; adkim=r; aspf=r; fo=1; rua=mailto:dmarc@isitlegit.co.za`; CAA rows only for Universal SSL's authorities (`CLOUDFLARE_CAS` in `scripts/check-domain.py`; read back on 2026-10-29: `letsencrypt.org`, `pki.goog`, `ssl.com`, `comodoca.com` and `digicert.com`, each as `issue` and `issuewild`); SMTP2GO's `em1027207` (to `return.smtp2go.net`) and `s1027207._domainkey` (to `dkim.smtp2go.net`). The demo subdomain `demo.isitlegit.co.za` routes its own mail (D01 T02 §4): its own MX `route1`, `route2`, `route3.mx.cloudflare.net` and SPF `v=spf1 include:_spf.mx.cloudflare.net ~all`. `app.isitlegit.co.za` is the Worker's custom domain (`routes` in `wrangler.jsonc`), which `wrangler deploy` creates with its own records. This list and that deploy are the zone's whole content: nothing else is served (read on 2026-10-29), so they rebuild a lost zone.

### (a) A planned nameserver move

Prepare before anything changes. Reverse by the step reached, waiting out each cache before the next change, as a forward move does (https://developers.cloudflare.com/dns/dnssec/dnssec-active-migration/): before step 3, nothing has changed; after step 3 (the DS removed) and before step 5, publish the old DS again (the one recorded above), which restores the signed service where it was once its TTL passes; after step 5, first pull any DS step 6 published and wait twice the DS TTL from step 2, observed gone at the parent first (a resolver still holding the new DS would refuse the old keys), then set the old nameservers back while the old zone still serves and wait twice the NS TTL, observed at the parent (a resolver still on the new nameservers would refuse the old DS), and only then publish the old DS again.

1. Prepare the destination: a provider that supports DNSSEC and the records above. Export the zone (Cloudflare: DNS, Records, Export) and keep the file. Create the zone at the new provider from it, and read every record back from the new provider's own nameservers before delegating: `dig @<new ns> <name> <type>` for each record in the list above gives the same answer as `@1.1.1.1`. **Gate:** Email Routing is Cloudflare's, and `check@` reaches the Worker only through it, so a move whose destination is not Cloudflare stops here, before step 2, until D01 T01 §15 (a second inbound route) has stamped and replaced this gate with its route switch. Steps 2 to 7 are for a move whose destination is Cloudflare (another account or another nameserver pair), with Email Routing set up there as (c) first.
2. Measure the DS TTL at the parent: `dig +noall +answer DS isitlegit.co.za @ns.coza.net.za` (the TTL is the second field; 7200 s on 2026-10-29).
3. Remove the DS at the registry: Domains.co.za, the domain, DNSSEC, delete the DS record. Read-back: `dig +short DS isitlegit.co.za @ns.coza.net.za` prints nothing. Start the wait only once that is observed.
4. Wait twice the TTL from step 2. Read-back: `dig +short DS isitlegit.co.za @1.1.1.1` prints nothing, `python3 scripts/check-domain.py --diagnose` says "resolves but is not validated" (exit 3, as expected mid-move), and the full check names the DS ("the zone is unsigned at the registry") and the `ad` flag.
5. Move the nameservers at the registry. Measure the NS TTL at the parent first: `dig +noall +authority NS isitlegit.co.za @ns.coza.net.za` (the second field; 7200 s on 2026-10-29). Read-back: the same command names the new nameservers (the registry answers a delegation in its authority section, so `+short` prints nothing there). Keep the old provider's zone serving, and wait twice that NS TTL from the moment the parent shows the change, so no resolver still asks the old nameservers. Roll back as the paragraph above says.
6. Only once step 5's wait is over (a resolver still on the old delegation would check the old provider's keys against the new DS and refuse the domain, https://developers.cloudflare.com/dns/dnssec/dnssec-active-migration/), sign the zone at the new provider and publish its DS at the registry. Read-back: `dig +short DS isitlegit.co.za @ns.coza.net.za` shows it, and after twice the DS TTL `python3 scripts/check-domain.py --diagnose` says "resolves and validates" (exit 0).
7. Check the new values before committing them: `python3 scripts/check-domain.py --expect-ns <ns1>,<ns2> --expect-ds "<tag> <alg> <type> <digest>"`, the values read from the registry (malformed values are refused before any lookup). Read-back: 9 of 9. Then update `NAMESERVERS` and `DS` in `scripts/check-domain.py` (a commit, reviewed), and `python3 scripts/check-domain.py`. Read-back: 9 of 9.

### (b) An emergency: the domain stops resolving

1. Diagnose first: `python3 scripts/check-domain.py --diagnose`. Exit 0, "resolves and validates": nothing to do here. Exit 2, "inconclusive" (a local fault, a timeout, or both queries failing): do not touch the DS; fix this machine's network or wait for Cloudflare's status page (https://www.cloudflarestatus.com), then diagnose again. Exit 4, "no SOA": the zone itself is missing; rebuild it, not the DS: add the zone again in Cloudflare (it keeps the nameservers above if the account is the same), add each record in "The records as published" above, run `pnpm exec wrangler deploy` (it recreates `app.isitlegit.co.za`), restore Email Routing as (c), then sign it and publish the DS as steps 3 to 5 below. Exit 3, "not validated": unsigned; go to step 3. Exit 1, "a DNSSEC failure": the ordinary query fails while one with checking disabled answers, so the signatures, not the service, are at fault (https://developers.cloudflare.com/dns/dnssec/troubleshooting/); go on.
2. Pull the DS at the registry, as (a) step 3, so resolvers stop validating: the domain resolves again, unsigned, as caches expire, which takes up to twice the DS TTL ((a) step 2: 7200 s on 2026-10-29). Until then the full check exits 2 ("nothing was judged": its lookups still fail validation), which is expected here. Read-back: `dig +short DS isitlegit.co.za @ns.coza.net.za` prints nothing at once; after the wait, `python3 scripts/check-domain.py --diagnose` exits 3 ("not validated"), and the full check exits 1 naming the DS and `ad`.
3. Repair signing in Cloudflare (DNS, Settings, DNSSEC: its status; disable and re-enable if it reports an error, which issues a new key), and read the DS it shows to publish. Measure the DNSKEY TTL at Cloudflare: `dig +noall +answer DNSKEY isitlegit.co.za @carmelo.ns.cloudflare.com` (the second field; 3600 s on 2026-10-29), and wait twice it after re-enabling, so no resolver still holds the old key when the new DS arrives.
4. Publish that DS at the registry. Read-back: `dig +short DS isitlegit.co.za @ns.coza.net.za` shows it, and after twice the DS TTL `python3 scripts/check-domain.py --diagnose` exits 0.
5. If the DS differs from the recorded one: `python3 scripts/check-domain.py --expect-ds "<the new DS>"`, read-back 9 of 9, then commit it as `DS` in `scripts/check-domain.py`. Then `python3 scripts/check-domain.py`. Read-back: 9 of 9, the domain authenticated again.

### (c) Restoring Email Routing

The inventory to restore, as last read back through the Cloudflare API (`docs/live-checks.md`, 2026-10-27, and D01 T01 §9 for `check@`, 2026-10-28): destination `hostmaster@rizonetech.com` (verified); `check@isitlegit.co.za` "Send to a Worker", `isitlegit`; `hello@`, `dmarc@` and `conduct@isitlegit.co.za`, and `finance@demo.isitlegit.co.za`, `alerts@demo.isitlegit.co.za` and `owner@demo.isitlegit.co.za`, each "Send to an email", `hostmaster@rizonetech.com`; the catch-all (drop) disabled, so any other address is refused.

1. In Cloudflare, Email, Email Routing: Routing status "Enabled", and its records added from that page (Cloudflare writes the three MX hosts, the SPF record and its DKIM key: https://developers.cloudflare.com/email-routing/get-started/enable-email-routing/ and https://developers.cloudflare.com/email-routing/setup/email-routing-dns-records/). Read-back: `dig +short MX isitlegit.co.za @1.1.1.1` lists the three `routeN.mx.cloudflare.net` hosts, `dig +short TXT isitlegit.co.za @1.1.1.1` exactly the SPF record above, and `python3 scripts/check-domain.py` passes its routing DKIM check (the record Cloudflare publishes is pinned there byte for byte; a new key Cloudflare issues is a reviewed commit of the record's digest).
2. Destination addresses: `hostmaster@rizonetech.com` verified (Cloudflare mails a link to click: https://developers.cloudflare.com/email-routing/setup/email-routing-addresses/). Read-back: the address shows "Verified" on the Destination addresses tab.
3. Routing rules: each rule of the inventory above with its action and destination, and the catch-all disabled. Read-back: each rule shows "Active" with that action and the catch-all "Disabled"; then each forwarding alias delivers, since Cloudflare drops a failure after it accepted a message silently: send from the operator's Gmail to each alias with a subject naming it, as `docs/live-checks.md` "How a test runs" describes, and each arrives in `hostmaster@rizonetech.com`; and a forward to `check@` from the operator's mailbox gets its reply (`node scripts/live-intake.ts --message-id <the forward's Message-ID>`, D01 T01 §9).
4. The demo subdomain, when its records went too: Email Routing, Settings, Subdomains, add `demo.isitlegit.co.za` and add the records it offers (its own MX hosts and SPF), as D01 T02 §4 did (https://developers.cloudflare.com/email-routing/setup/subdomains/). Read-back: `dig +short MX demo.isitlegit.co.za @1.1.1.1` lists the three `routeN.mx.cloudflare.net` hosts, and after a minute or two (a new subdomain refuses mail at first, `docs/live-checks.md`) a mail to `owner@demo.isitlegit.co.za` reaches the operator's mailbox.
5. `python3 scripts/check-domain.py`. Read-back: 9 of 9 (it checks the demo subdomain's MX and SPF as well).

### (d) Restoring DMARC and CAA

1. DNS, Records: one TXT record at `_dmarc` with exactly the DMARC value above. Read-back: `dig +short TXT _dmarc.isitlegit.co.za @1.1.1.1` prints exactly it, once.
2. CAA, when rows were deleted: add one CAA record, `0 issue "letsencrypt.org"`, at the apex (DNS, Records, Add, CAA); Cloudflare then adds its own rows for the rest of Universal SSL's authorities, which it does only while the zone holds a CAA record (https://developers.cloudflare.com/ssl/edge-certificates/caa-records/). Then remove any row naming another authority. Read-back: `dig +short CAA isitlegit.co.za @1.1.1.1` lists only those authorities, each as `issue` and `issuewild`.
3. `python3 scripts/check-domain.py`. Read-back: 9 of 9.

### (e) Recovering SMTP2GO sending

A revoked or leaked API key, or the sender-domain records removed, stop every reply, sign-in link and alert; the reconciler then reports `degraded` and sends wait (D01 T02 §5). Find which fault it is first: `python3 scripts/check-smtp2go.py` says whether the vault's key is live (it stops at the first failure, so a dead key hides the records' state) and `dig +short CNAME em1027207.isitlegit.co.za @1.1.1.1` and `dig +short CNAME s1027207._domainkey.isitlegit.co.za @1.1.1.1` show the records. A key known or suspected to be compromised is revoked first, before anything else, so it cannot send while the rest is repaired; records are restored next, since they need no key; a key fault then goes through steps 3 to 5; a records-only fault, the key healthy, skips them and changes no credential. Both faults at once take every step. Never restore a compromised key.

1. A key leaked or may have (compromised, still live): revoke it now, before anything else: SMTP2GO, Sending, API Keys, delete it. Read-back: it is gone from the list. A key SMTP2GO already revoked needs no revoking; a healthy key is left alone.
2. Sender-domain records removed: in SMTP2GO, Sending, Sender Domains, `isitlegit.co.za` shows the two records to add; add them in Cloudflare DNS as CNAMEs, `em1027207` to `return.smtp2go.net` and `s1027207._domainkey` to `dkim.smtp2go.net`, DNS only (not proxied), then Verify on SMTP2GO's page. Read-back: the two `dig` commands above print `return.smtp2go.net.` and `dkim.smtp2go.net.`, and SMTP2GO shows the domain verified. SMTP2GO names the records per sender domain: if the page shows names other than these (the domain deleted and added again), add the names it shows, then put them in `CNAMES` in `scripts/check-smtp2go.py` and in this step (a reviewed commit) before its read-back. Records intact: nothing to do here. Key healthy: go to step 6.
3. Create a new key with exactly the permissions the Worker and `scripts/check-smtp2go.py` use (https://developers.smtp2go.com/reference/add-api-key): Email Send (`/email/send`), Activity Search (`/activity/search`) and Statistics, Email Summary (`/stats/email_summary`, which the checker reads first to tell a live key from a dead one), and nothing else.
4. Store it in the vault, the item "IsItLegit SMTP2GO" (Conclave), replacing the old value. Read-back: `python3 scripts/check-smtp2go.py` (it reads the vault) exits 0, "the key is live, may send and search activity, ... SMTP2GO's DKIM and return-path records resolve" (step 2 restored them). A vault read that fails stops here: fix the vault before touching the Worker.
5. Set it on the Worker from the vault, the value never printed or passed as an argument, refused if the read fails. `wrangler secret put` publishes a new version at once (https://developers.cloudflare.com/workers/configuration/secrets/), so do this only while no rollback is in effect (see "Roll back a broken deploy"):

```bash
key=$(conclave-op read "op://Conclave/IsItLegit SMTP2GO/credential") && [[ $key =~ ^api-[0-9A-Za-z]{32}$ ]] \
  && printf %s "$key" | pnpm exec wrangler secret put SMTP2GO_API_KEY \
  || { echo "not set: the vault read failed, the value is not an SMTP2GO key, or wrangler failed"; false; }
unset key
```

   The value must have the shape step 4's check accepted (`KEY_SHAPE` in `scripts/check-smtp2go.py`), and a failure exits non-zero. Read-back: `pnpm exec wrangler secret list` names `SMTP2GO_API_KEY`. If the command failed or its outcome is unclear, run step 4's check again (the vault value is still the live key) and then this command again: setting the same value twice is harmless.
6. Verify through the serving Worker, not the vault: ask for a sign-in link to the operator's mailbox at `https://app.isitlegit.co.za/signin/link`, and it arrives. Read-back: the mail in the operator's inbox, `python3 scripts/check-smtp2go.py` exits 0, and the next cron's `{"event":"mail-reconcile","state":"ok"}` line in Workers Logs.
7. `python3 scripts/check-domain.py`. Read-back: 9 of 9.

## Signature badge in mail editors

Checked 2026-11-02 by the operator and recorded here on the operator's report, narrowed by the operator's decision the same day: only Outlook on the web was checked, because the competition does not leave time for the full three-editor pass, and this record says so plainly rather than implying wider coverage.

- Outlook on the web (derick@rizonetech.com, 2026-11-02): the Fynbos Freight signature snippet was installed in Settings, Accounts, Signatures by pasting the rendered badge (that editor has no HTML source view), saved, and a message with the subject "SIGTEST outlook-web badge check" was sent from that account to itself. The badge is served from `https://app.isitlegit.co.za/b/fynbos-freight.png` and links to `https://app.isitlegit.co.za/v/fynbos-freight`; the product snippet's apex host (`isitlegit.co.za/b/...`) does not answer until D07 T06 section 20 routes the apex, so the app host is what was checked. The coordinator in this session had no mailbox connector and did not independently read the message back; the result stands on the operator's report.
- Not checked: Outlook desktop and Gmail. Both were waived by the operator on 2026-11-02 for the competition; how the snippet survives those editors' save and reopen, and the install timing and reply checks from D05 T02 section 7's completion review, remain unchecked and are recorded here as open, not passed.
- Also waived by coordinator decision 2026-11-02, unchecked and not passed: that the saved Outlook-web signature was reopened with its image and link intact, and the editor version. Neither was recorded, and neither is claimed as tested.

## Account closure purge

The daily scheduled run (`scheduledClosurePurge` in `src/auth/closure.ts`) deletes a closed organisation's stored artefacts and rows once its closure is 25 days old, so deletion completes within the 30 days the privacy page promises; an organisation still present after 30 days is named overdue in the run's log line (`closure-purge`). A failed organisation is retried on the next run. The two protected live test accounts and Fynbos Freight are never purged.
