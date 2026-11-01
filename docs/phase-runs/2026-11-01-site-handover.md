# Phase run: site lane, Muse Code handover (2026-11-01)

## Read in

- Read `AGENTS.md`, `docs/handover/2026-11-01-muse-code.md` in full (after the merge brought it in), `docs/coordinator.md`, `design/SPEC.md`, `docs/manifesto.md`, and the final Resume point (handover to Muse Code) in `docs/phase-runs/2026-10-31-site-phase-6.md`.
- Merged `origin/main` into `site-lane` (a merge, no rebase, no force push): HEAD `0599820d` (docs: record the 76185ee9 deploy).
- Replied to the coordinator session canvas-coma: `SEQ-SITE-OK site-lane 0599820d`.
- Read `~/isitlegit-data/handover/site-inbox.md` at this boundary: no new item after 2026-10-31 22:08 SAST; both 22:08 items are already acted on (privacy training wording in D07 T06 §8, demo seed approval in D07 T07 §1).

## Conflicts recorded

- Handover section 4 says Muse Code needs its own review route added and the operator asked which reviewer; the lane instruction for this session (later) says reviews run with `--writer muse` (Astra), and `.conclave/reviewers.toml` already has `muse = ["astra"]` at line 47. Later instruction wins; no route change needed.
- Handover section 11 recommends starting as one lane on `main`; the lane instruction for this session (later) keeps this session on `site-lane` in `~/isitlegit-site`. Later instruction wins.
- `python3 scripts/todo-graph.py query ready` lists only D07 T06 §20 as ready for this lane, while its section text (line 648) and the resume point both say the coordinator deploys. Resolved toward the section text: §20 is not runnable by a lane session.
- The lane instruction names the claim as D07 T06 §1 to §8 and D07 T07 §1 and §2; `todo/lanes.json` (through `query lane`) also lists later site sections and shared rows (D07 T06 §10 to §21, D07 T07 §3, D00 T01 §27, §30 to §32, D07 T08 §9, §19). No conflict in outcome: every extra row is stamped, blocked, deferred, or the coordinator's, as listed below.

## Lane state at 0599820d

- `python3 scripts/todo-graph.py query lane` reads `site` on branch `site-lane`.
- `python3 scripts/todo-graph.py query ready` reads one row: D07 T06 §20 (Deploy the site and read it back, Needs `cloudflare`), which the section itself assigns to the coordinator. No lane-runnable section is ready, so no section was started and nothing was invented.
- Blocked rows in the claim, with what each waits on:
- D07 T06 §11, §12, §14, §15, §16, §19: Needs `owner-decision`; deferred by the operator on 2026-11-01 until after the competition (standing ordering: deferrals with a stated time condition never become fill-in work). §13 keeps the `hello@` mailto until after the competition by the same decision.
- D07 T07 §2 (Judge demo organisation): waits on D04 T01 §4 (walkthrough lane) and Needs `meta-api`, `live-mail`.
- D07 T07 §3 (Production demo seed and read-back): waits on the operator protecting Fynbos Freight's identity; Needs `cloudflare`, `operator`.
- D07 T08 §19 (Help route on the site 500 page): Needs `owner-decision`.
- D00 T01 §31 (Wake acceptance on live sessions): Needs `operator`. D00 T01 §32 (Wake dispatched after each push): Needs `owner-decision` (the coordinator's decision to adopt a push wrapper).

## Deploy read-back prepared

- Refreshed `docs/live-checks.md`, "Site claims and the status of their owners", by running `taskset -c 3 node site/scripts/check-claims.ts` at `0599820d` (free memory 7139 MB available before the run).
- Result quoted: exit 1, `check-claims: refusing, 51 claim owner(s) not stamped`; 94 claims, 54 with every owner stamped, 40 blocked. The table in `docs/live-checks.md` now matches that run row for row, so the coordinator's §20 deploy can see exactly which claims still block or need rewording.
- No claim wording was changed, no deploy was run, and no paid call was made. The §20 read-backs that need live hosts (HTTPS, routes, Lighthouse, 404 and 500 wiring) stay with the coordinator.

## Next

- Parked, waiting on the coordinator's §20 deploy and on the blocked rows above. At the next boundary, read `~/isitlegit-data/handover/site-inbox.md` again and reply in `site-outbox.md`.

## Deploy-warm check, 2026-11-01 (coordinator assignment)

- Merged `origin/main` (`0d5e5608`) into `site-lane`: merge `e95e9b84` (concluded with `git commit --no-edit` after the plan check stopped it, plan current).
- Claims read-back re-run at the merged HEAD: `taskset -c 3 node site/scripts/check-claims.ts` exits 1, 51 unstamped owner references, 94 claims, 54 clear, 40 blocked. Unchanged from `0599820d`: the new main commits were deploy records, not stamps of claim owners. The count will be re-run and reported each time the coordinator announces a stamp.
- Site verified against current main: `taskset -c 3 pnpm --filter site build` exits 0 (10 pages built) and `taskset -c 3 pnpm --filter site test` exits 0 (222 pass, 0 fail). No breakage, no failing page to report.
- D07 T06 §20 stays the coordinator's; this prep only.
