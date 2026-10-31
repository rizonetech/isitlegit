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
| Invite codes: one message for every unusable code ("a guess learns nothing"), board's three kept as an A2 Deviation | app, D07 T02 §13 | 2026-10-31 00:46 |

### For the operator, morning of 2026-10-31

| Step or decision | For | Recommendation |
| ---------------- | --- | -------------- |
| Delete the Exchange rule `IsItLegit forward probe (delete after test)` in the rizonetech.com tenant, then say "rule deleted" | D01 T02 §9 (checks) | do it first: it releases the live-proof stamp |
| Approve the next deploy: Cases list, sign-in, signup and invitation pages, hidden-text, HTML-attachment and archive checks, and migration 0040 (deletes the two bad probe-3 rows on live D1) | main | approve; 0040 was reviewed clean |
| Confidence bands on the report: high at 0.8 and above, medium at 0.5 and above, low below (the 0.6 header-missing cap reads as medium); recorded as a SPEC M3 Deviation by the app lane | app, D07 T03 §2 | keep, unless you want missing headers to read as low |

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
| Main's merges take an unstamped Glimmer commit only when it is offline tooling (`scripts/glimmer`, `test/node`, `tests/scripts`); anything under `src/`, `public/` or the Worker config waits for its stamp | every glimmer merge | rule set 2026-10-31 00:52 at `475759c` |

## Deploys

| When (SAST) | Commit | Version | Migrations applied | Verified |
| ----------- | ------ | ------- | ------------------ | -------- |
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

The next free number is 0041.
