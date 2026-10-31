# Coordinator record

The coordinator lane's standing record (`docs/specs/2026-10-30-four-lanes-design.md`): the operator's manual steps, prepared to the step only the operator can take, and the D1 migration numbers handed out to lanes. Updated by the coordinator session on `main`; the TODO sections stay the contract, this file only tracks what is asked and when.

## Operator steps

Batches are asked at a time the operator chooses. Each step names the section it releases; the coordinator verifies the result (a vault item by title only, never its value) and records the `Operator ready:` or decision line in that section.

### Batch 1 (asked 2026-10-30, 14:55 SAST)

| Step | Releases | Status |
| ---- | -------- | ------ |
| Cloudflare API token, Zone Analytics Read on `isitlegit.co.za`, vault "IsItLegit Cloudflare analytics token" | D01 T02 §6 (checks) | done 15:16, verified; recorded by checks in 4cb39cf |
| Google service account with API Keys Viewer only, JSON key in vault "IsItLegit Google API keys viewer" | D99 T01 §10 (main) | done 15:31, verified (apiTargets: webrisk only) |
| SMTP2GO account-level read-only key with API keys view, vault "IsItLegit SMTP2GO admin" | D99 T01 §11 (main) | done 15:50; admin key kept full, sending key narrowed, tracking kept |
| Decision: a sign-in code beside the link, `Code sign-in: yes or no` | D07 T02 §11 (app) | done: yes (2026-10-30 14:58) |

### Decisions, 2026-10-30 evening

| Decision | For | Recorded |
| -------- | --- | -------- |
| Exchange probe rule kept until D01 T02 §9's live proof | checks | 17:25 |
| Cases list (D07 T04 §1) moved into Phase 2, built before sign-in | app | 18:20 |
| Deploy of 6d051b3 with `CF_ANALYTICS_TOKEN` and `SMTP2GO_API_KEY` set | main | 18:39 |
| Media lane registered, uncoordinated (D10) | media | 18:45 |
| Remotion licence: free (up to 3 people) | media, D10 T01 §2 | 19:10 |
| Video 01 shows the method as it runs; the Muse Wonder final review shown as available but off | media | 19:10 |
| Repository private until submission, public again Tue 3 Nov | main, D99 T02 §5 | 20:05 |
| Exchange probe rule kept for future testing (it is harmless); D01 T02 §9 stamps without its removal | checks | 2026-10-31 11:27 |
| Deploy of e26b53c6 with migrations 0040 and 0042 to 0045 and the 1-minute retry cron | main | 2026-10-31 11:27 |
| Report confidence bands kept: high 0.8 and above, medium 0.5 and above, low below | app, D07 T03 §2 | 2026-10-31 11:27 |
| Authorised mailbox checking (D01 T01 §18) stays after the event | checks | 2026-10-31 11:27 |
| Production bank-detail keys created in vault item "IsItLegit bank key" (BANK_KEY, BANK_MATCH_KEY), set at the deploy that first carries D05 T01 §2 | trust | 2026-10-31 11:25 |
| Three more lanes (walkthrough, trust, eval) to speed the build | main | 2026-10-31 11:12 |
| Unrelated services stopped for the build (operator, 12:15): MariaDB (`sudo systemctl stop mariadb`, run by the operator), `hermes-gateway.service` and `opencode serve`; conclave-dev, Hermes and MariaDB stay enabled and start again at the next WSL start; free memory 2.7 GB to 6.2 GB | machine | 2026-10-31 12:16 |
| An 8 GB swap file in WSL (`/swapfile`, in /etc/fstab; 10 GB swap in all): the 2 GB partition was always full, so earlyoom killed test runs and VS Code servers at every memory peak | machine (operator ran it) | 2026-10-31 12:12 |
| Coordinator stopped the operator's `conclave-dev.service` (a systemd user service, Conclave's local dev console) under critical memory: earlyoom had killed it and systemd restarted it 105 times, and the churn took lanes' test runs down with it. Stopped, not disabled; undo with `systemctl --user start conclave-dev.service` | machine | 2026-10-31 12:06 |
| Invite codes: one message for every unusable code ("a guess learns nothing"), board's three kept as an A2 Deviation | app, D07 T02 §13 | 2026-10-31 00:46 |

### For the operator, morning of 2026-10-31

| Step or decision | For | Recommendation |
| ---------------- | --- | -------------- |
| Who may remove a case checked by mistake, and what stays for audit (D07 T04 §12, Phase 6, Needs: owner-decision) | app, with the checks lane for storage | decide before Phase 6; recommendation to follow when the app lane reaches it |
| At the next deploy: migration 0046 (`canaries`), and the walkthrough lane's reference logo load into R2 `ref/logos/` (D03 T03 §2, its command handed over at its stamp), run by the coordinator | walkthrough | in the next deploy question |
| After the next deploy that carries D02 T03 §9: forward a case from a `.co.za` sender and check its report shows the domain's age read from `whois://coza-whois.registry.net.za`; record it in `docs/live-checks.md` ("Registration dates from ZACR's WHOIS") | checks, D02 T03 §9 | the coordinator runs the probe after your deploy approval |
| Approve the live limits check (D09 T01 §1): the eval lane's eval/launch/check-limits.ts run by the coordinator against production: a test organisation with a cap of 3, sign-in rate limits, R2 lifecycle read-back, then the test data removed | eval, D09 T01 §1 | approve when the script is stamped; it is the launch proof that limits hold |

### Waiting on a lane first

| Step | Releases | Waits on |
| ---- | -------- | -------- |
| Forward the near-limit message to check@ as an attachment, from Outlook | D01 T01 §14 (checks) | the checks lane sending it to the operator's mailbox |
| Approve board `Report-EvidenceViewer` | D07 T03 §8 (app) | the app lane drawing it, after D07 T03 §3 |
| Approve the `Error-410` renewal button | D07 T08 §7 (app) | the app lane drawing it, after D07 T08 §1 |
| Sign up with an invite code, verify `rizonetech.com`, invite staff, `Dogfooding since:` | D99 T02 §1 (main) | D07 T02 §7 (sign-in and signup pages) live on the deployment |
| Exchange Online mail flow rule rejecting the test subject, removed after | D01 T02 §6 live check (checks) | the checks lane reaching that item |
| Microsoft 365 admin deploys the Outlook add-in | D01 T01 §10 (checks, Phase 6) | the add-in built |
| Paste new Discord project posts, Sun 1 Nov and Tue 3 Nov | D99 T02 §6 (main) | the dates |
| Make the repository public again (private since 2026-10-30 20:05), verified logged out | D99 T02 §5 (main) | Tue 3 Nov, before the submission |
| Record the demo footage, then assemble, caption and upload the video, then submit by Wed 4 Nov 18:00 SAST | D99 T02 §3 to §5 (main) | the core path stamped and the demo script |

### After the event (Phase 7)

D99 T01 §5 (WhatsApp test number), D01 T03 §10 (AAC decoding, legal advice first), D01 T01 §15 (second inbound route), D07 T01 §11 and §12 (shortcut and switcher boards).

## Coordinator follow-ups

| Item | Lands with | Why |
| ---- | ---------- | --- |
| CI "Project script tests": `pip install -r scripts/glimmer/requirements.txt` beside the design-tool install, and `REQUIRE_GLIMMER_DATA_TOOLS: "1"` in that step's env | the merge that brings glimmer-screener's `c79b864` (D03 T04 §28) | the file is not on main before it; 25 converter tests skip until then; wheels exist for Python 3.12 |
| XREF pair: D07 T03 §7 (reply email template, its optional "Headers checked" panel) <-> D01 T02 §11 (`ReplyInput.headers`) | once both sections are on main | agreed 2026-10-31 09:17 |
| The Muse Code final review (`[schedule.final] mode`) back to "optional", and efforts back up where they help, for the polishing and final sections | when the plan reaches its polish and final stage | operator, 2026-10-31 11:37 (every pass at medium from 11:35) |
| `LIGHT_INCLUDES_PAGES` (scripts/lib/todo_graph.py) on: pages and eval may be light | only if the build truly runs out of time, with the operator's go | operator, 2026-10-31 11:40: off, it felt like downgrading quality |
| XREF pair and Depends On: D07 T03 §29 (the instruction in an invisible-character card) <-> D02 T05 §6 (`detail.instruction: { text, offset }`) | once D02 T05 §6 is on main (§29 already is) | agreed 2026-10-31 11:48 |
| The run guard's stall breaker counts a long job outside the tree (a 10-minute live capture) as no progress, and ended the walkthrough run at 2 trips; file a D00 T01 section so a tracked background job in progress is progress | when D00 work next comes up | seen 2026-10-31 12:20 (walkthrough run 9deb2696c9a2) |
| XREF pair and Depends On: D06 T02 §3 (forensics checks registered) waits on D07 T03 §30 (document forensics cards) | once D07 T03 §30 is on main (app-lane 39ec1bc8, todo-only commits may be merged early) | agreed 2026-10-31 13:01; §3 must not stamp before §30's cards are on main, or the CHECK_WORDS registry test goes red |
| Main's merges take an unstamped Glimmer commit only when it is offline tooling (`scripts/glimmer`, `test/node`, `tests/scripts`); anything under `src/`, `public/` or the Worker config waits for its stamp | every glimmer merge | rule set 2026-10-31 00:52 at `475759c` |

## Merge gates

Every merge into `main` is gated in GitHub CI (operator, 2026-10-31, made permanent at 12:00):

1. Merge the lane's stamp locally (`git merge --no-ff <stamp>`, then `git commit --no-edit` when it stops on todo/), and run `python3 scripts/todo-graph.py validate`.
2. Push the merged tip to the gate branch: `git push origin HEAD:refs/heads/coordinator-gate` (a fast-forward; the branch only ever follows `main`'s line).
3. Watch its run: `gh run watch <id> --exit-status`. Every job must be green, the three Worker shards included.
4. Locally meanwhile: `pnpm build` (the dry-run deploy) and `pnpm db:migrate:local` when the merge carries a migration. No full suite on this machine.
5. Push `main` to the gated commit (docs-only commits on top may ride along). A red run: the owning lane is told with the failing test, and `main` does not move.

## Deploys

| When (SAST) | Commit | Version | Migrations applied | Verified |
| ----------- | ------ | ------- | ------------------ | -------- |
| 2026-10-31 11:30 | `e26b53c6` | `2148fdf1-7b0b-4508-b597-27d450ca318a` | 0040, 0042, 0043, 0044, 0045 | `/health` reports the commit; smoke 16 s; both crons (`*/15`, `* * * * *`) deployed |
| 2026-10-30 20:27 | `c69c8c3` | `d184c2a2-0771-4fae-b6d7-3f6ed63511a8` | 0037, 0038, 0039 | `/health` reports the commit; smoke 13 s |
| 2026-10-30 18:39 | `6d051b3` | `9599a7bb-06a6-446d-b5cc-41aeaca60f08` (after the two secrets) | 0036 | `/health`, smoke 15 s, `check-smtp2go.py`, `/dev/components` 404 |
| 2026-10-30 17:05 | `3670dfe` (from `9b6dfc9`, 458 commits) | `86106996-37bb-4388-9cf2-6f37244d4d09` | 0034, 0035 | `/health` reports the commit; `scripts/smoke.ts` passed in 13 s (DB, ARTEFACTS, CACHE, ANALYSIS, BROWSER ok) |

## Migration numbers

| Number | Lane | For | Handed out |
| ------ | ---- | --- | ---------- |
| 0034 | checks | `org_receivers`, `receiver_lookups` (D02 T02 §1) | 2026-10-30; live 17:05 |
| 0035 | app | `signin_codes` (D07 T02 §11) | 2026-10-30; live 17:05 |
| 0036 | checks | forwarding incidents and scan progress (D01 T02 §6) | 2026-10-30; live 18:39 |
| 0037 | checks | `org_sender_salts`, `sender_observations` (D02 T02 §5) | 2026-10-30; live 20:27 |
| 0038 | checks | `cases` original subject and sender (D01 T01 §16) | 2026-10-30; live 20:27 |
| 0039 | checks | `cases.uploaded_by` (D01 T03 §11) | 2026-10-30; live 20:27 |
| 0040 | checks | data repair of probe 3's forward_incidents rows (D01 T02 §9): brackets trimmed, the false incident folded | 2026-10-30 |
| 0041 | checks | `case_verdicts.meaning` (D04 T01 §2) | 2026-10-31, held |
| 0042 | checks | `check_outcomes` (D02 T01 §3) | 2026-10-31; on main at the 515a5ad0 merge, applied locally |
| 0043 | checks | `cases.upload_name`, `cases.upload_media_type` (D02 T04 §4) | 2026-10-31; on main at the 9be6ecf1 merge, applied locally |
| 0044 | checks | `cases.run_id`, `cases.run_checked_at`, `case_events.actor`, `case_events.run_id` (D01 T01 §17, retry of a failed check; also adds a 1-minute cron for the retry sweep, dispatched on `controller.cron`) | 2026-10-31; on main at the 00e18287 merge (restamped a074bd28), applied locally |
| 0045 | app | `feedback` (D07 T03 §6, "This was wrong"): one row per member per case | 2026-10-31; on main at the 27760e6c merge, applied locally |
| 0046 | walkthrough | `canaries` (D04 T02 §2, per-case canary credentials) | 2026-10-31; on main at the 7749e582 merge, applied locally |
| 0047 | trust | protected identities (D05 T01 §1) | 2026-10-31, held |
| 0048 | trust | encrypted bank accounts (D05 T01 §2) | 2026-10-31, held |
| 0049 | trust | supplier ledger (D06 T01 §2) | 2026-10-31, held |

The next free number is 0050. 0041 is held and not yet built, so 0042 lands first; Wrangler applies any unapplied migration in order of name, and the two touch unrelated tables.
