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
| Deploy of main after the 71d8ecb5 gate, with migration 0046 (`canaries`) and the reference logo load (generation 20261031T115449Z, dry run first) | main, walkthrough | 2026-10-31 14:35 |
| Live limits check (D09 T01 §1) approved, run by the coordinator later today on a test organisation at a time the operator is not signing in | eval | 2026-10-31 14:35 |
| Meta spend for the synthetic South African set (D08 T01 §3): hard cap US$2.00 (the lane asked for US$1.50, estimate US$0.93), through the shared ledger inside the $15 day cap | eval | 2026-10-31 15:20 |
| The production Fireworks key (vault "IsItLegit Fireworks") must be inference-only: the Glimmer lane found it could PATCH the Loupe deployment (a no-op, settings unchanged). Fix: narrow that service account's role to `inference-user` (as docs/specs/2026-10-26-tech-stack-design.md:71 already intends), after the Glimmer lane confirms none of its deployment tooling uses this key; a new scoped key only if the role can't be narrowed | main, glimmer | 2026-10-31 15:45 |
| Lanes checks, app, walkthrough, trust and eval parked to free memory (each stops its own processes, commits and pushes its work unstamped, records its resume point); Glimmer and the coordinator keep running; resume on the operator's word. Fireworks: isitlegit-meta-api-user narrowed to `inference-user` at 15:51 (read back) | main, all lanes | 2026-10-31 15:52 |
| Two more lanes from the app lane's backlog: `console` (D07 T04 §2 to §12, D07 T05, D07 T08; branch `console-lane`, `../isitlegit-console`) and `site` (D07 T06 §1 to §8, D07 T07; branch `site-lane`, `../isitlegit-site`), by section. After the 15:57 SAST crash (hard reset, no dump): every lane runs in a plain terminal, not VS Code, the media lane is closed until about 80 to 90% of the code is done, and the 8 GB `/swapfile` added at 12:12 is replaced by a 2 GB one, 4 GB of swap in all (the operator runs the sudo step) | main, app, console, site | 2026-10-31 16:35 |

### For the operator, morning of 2026-10-31

| Step or decision | For | Recommendation |
| ---------------- | --- | -------------- |
| Whether links are checked automatically and at click time (D02 T07 §5, Needs: owner-decision; filed 2026-10-31 by the checks lane) | checks | recommendation when the checks lane reaches it |
| Who may remove a case checked by mistake, and what stays for audit (D07 T04 §12, Phase 6, Needs: owner-decision) | app, with the checks lane for storage | decide before Phase 6; recommendation to follow when the app lane reaches it |
| Should a refused forward alert at its first sighting, before its alias is known (an early, unattributed alert), or wait until the alias is known as today (D01 T02 §15, Needs: owner-decision, Phase 6; filed 2026-10-31 by the checks lane) | checks | decide before Phase 6; recommendation when the checks lane reaches it |
| A slash shortcut that focuses the Cases search (D07 T04 §15, Needs: owner-decision; filed 2026-10-31 by the console lane) | console | recommendation when the console lane reaches it |
| The set of threat kinds shown under "Malicious or suspicious" on the weekly stats (the board's "5 phishing, 3 invoice, 1 impersonation") and which evidence decides each kind: no check stores a case-level kind and no spec defines the set (D07 T04 §18, Phase 7, Needs: owner-decision; filed 2026-10-31 by the console lane) | console, checks | recommendation when the console lane reaches it; the checks lane would store the kind |
| The counts export's reporting period (D07 T04 §19, Needs: owner-decision; filed 2026-10-31 by the console lane) | console | recommendation when the console lane reaches it |
| An opt-in weekly counts email to owners (D07 T04 §20, Needs: owner-decision; filed 2026-10-31 by the console lane) | console | recommendation when the console lane reaches it |
| Several addresses in the Team page's invite field at once: whether, the separator, the per-submit limit (proposed 10) and how each address's outcome is listed; a SPEC M7 change first (D07 T04 §22, Needs: owner-decision) | console | recommendation when the console lane reaches it |
| Team history for owners on the Team page (role changes, revocations, removals): whether, where it sits, its columns, action and date filters, empty and error states; a SPEC M7 change first (D07 T04 §23, Needs: owner-decision) | console | recommendation when the console lane reaches it |
| The home page's one-step demo check (D07 T06 §10, Needs: owner-decision; filed 2026-10-31 by the site lane): a visitor sees a sample verdict in one action with no signup, from a prerendered sample (no spend) or a live pipeline run (Meta spend per visit); then approve its board in design/mockups | site | recommendation: prerendered sample, no spend and no abuse surface |
| Passkey-first sign-in, and a passkey kept on another device (D07 T02 §18 and §19, Phase 6, Needs: owner-decision on a change to design board A1; filed 2026-10-31 by the app lane) | app | decide before Phase 6; recommendation to follow |
| Seed a 10,000-case demo organisation on the deployed Worker for the live phone latency check against Gmail (D07 T04 §16, Needs: attended) | console, coordinator | the coordinator prepares it when the console lane reaches §16 |
| At the next deploy: migration 0046 (`canaries`), and the reference logo load (D03 T03 §2, after its stamp merges): from this machine (store at ~/isitlegit-data/reference-logos/20261031T115449Z), `node scripts/load-reference-logos.ts load --remote --dry-run --generation 20261031T115449Z`, then the same without `--dry-run`, then `node scripts/load-reference-logos.ts --check --remote` expecting `reference logos: 20 brands in R2 (2 fictional, 3 missing; generation 20261031T115449Z)`; reverse with `load --remote --restore`. 23 objects under `ref/logos/` in isitlegit-artefacts, nothing outside it touched, no lifecycle rule covers `ref/` | walkthrough | in the next deploy question |
| Live WHOIS proof (D02 T03 §9, deployed since e26b53c6): sign in at https://app.isitlegit.co.za/upload and upload the synthetic `\\wsl.localhost\Ubuntu\home\derickpayne\isitlegit-data\live\whois-live-20261031.eml` (From notices@standardbank.co.za, marked SYNTHETIC); give the coordinator the case link, and the checks lane confirms the domain-age item and records it | checks, D02 T03 §9 | a 1-minute upload; no mail is sent from your account |
| Approve the live limits check (D09 T01 §1), run by the coordinator from eval-lane at 56449a15 or later: `node eval/launch/check-limits.ts --confirm-production --org <test org>` with a test member's session and the SMTP2GO key in env only. In production it: refuses unless the session's org is the test org; makes two 25 MiB + 1 byte uploads (expects 413, no case); sets the test org's daily cap to today's count + 1, admits ONE synthetic case (one analysis), expects 429 on the next, then restores the cap exactly (recovery file first); trips three sign-in rate limits, locking this machine's IP out of sign-in for up to 10 minutes twice (about 21 minutes in all: nobody should sign in from this network meanwhile); sends ONE 26 MiB synthetic mail from alerts@ to check@ through SMTP2GO, expecting a size rejection; reads the R2 lifecycle rules | eval, D09 T01 §1 | approve, at a time you are not signing in; needs a test organisation and a signed-in test member (the coordinator can set both up) |

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
| Add D03 T03 §5 (logos for blocked brands and variants) to the walkthrough lane's sections in todo/lanes.json | in the merge of D03 T03 §2's stamp, which brings §5 to main | asked 2026-10-31 13:17 |
| Main's merges take an unstamped Glimmer or eval commit only when it is reviewed offline tooling (`scripts/glimmer`, `eval/`, `test/node`, `tests/scripts`); anything under `src/`, `public/` or the Worker config waits for its stamp | every glimmer merge | rule set 2026-10-31 00:52 at `475759c` |

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
| 2026-10-31 18:25 | `2a430fba` | `ec3e8231-0faf-49e3-b729-1af0f40f70a6` | 0047, 0051, 0052 | `/health` reports the commit; smoke 12 s (DB, ARTEFACTS, CACHE, ANALYSIS, BROWSER ok); three crons deployed (`*/15`, `* * * * *`, FORWARD_CRON `5,10,20,25,35,40,50,55 * * * *`); 0051 row counts equal before and after (evidence 12, outcomes 69) with none lacking a run |
| 2026-10-31 11:30 | `e26b53c6` | `2148fdf1-7b0b-4508-b597-27d450ca318a` | 0040, 0042, 0043, 0044, 0045 | `/health` reports the commit; smoke 16 s; both crons (`*/15`, `* * * * *`) deployed |
| 2026-10-31 14:45 | `46e92188` | `f8b06e7f-c9a4-445b-bd81-363c72562f8d` | 0046 | `/health` reports the commit; smoke 22 s; reference logos loaded after a dry run (23 objects under `ref/logos/`, generation 20261031T115449Z), check: 20 brands in R2 (2 fictional, 3 missing) |
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
| 0047 | trust | `identities`, `trust_events` (D05 T01 §1; new tables only, FK to organization ON DELETE CASCADE) | 2026-10-31; on main at the 7577c673 merge, applied locally |
| 0048 | trust | encrypted bank accounts (D05 T01 §2) | 2026-10-31, held |
| 0049 | trust | supplier ledger (D06 T01 §2) | 2026-10-31, held |
| 0050 | walkthrough | `walkthrough_actions` (D04 T02 §3, contained walkthrough driver): one row per action, FK to cases ON DELETE CASCADE | 2026-10-31, held |
| 0051 | checks | `evidence` and `check_outcomes` rebuilt with `run_id` in the key, every row backfilled with its case's current run (D01 T01 §19, a retried run's findings kept apart) | 2026-10-31; on main at the 9b61b18b merge (gated green, main c2666e50), applied locally; a table rebuild, so check row counts before and after on the remote apply |
| 0052 | console | `cases.search_text` (D07 T04 §7, case search folded beyond ASCII, since D1's lower() folds ASCII only; refilled by the main cron for older rows) | 2026-10-31; on main at the 60bf8799 merge (gate pending), applied locally |
| 0053 | checks | `check_outcomes.revision` (D02 T01 §4, the check revision stored with each outcome; nullable ADD COLUMN, no rebuild), with the `version_metadata` binding CF_VERSION_METADATA in wrangler.jsonc | 2026-10-31, held |

The next free number is 0054. 0041 is held and not yet built, so 0042 lands first; Wrangler applies any unapplied migration in order of name, and the two touch unrelated tables.
