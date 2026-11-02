# Phase run: trust lane, Phase 6 (2026-10-31)

## Phase repairs

- Started 2026-10-31 19:52 SAST after Phase 5 parked (docs/phase-runs/2026-10-31-trust-phase-5.md, its park record): Phase 5's leftovers wait on other lanes (D07 T08 §8, `src/auth/protected.ts`) or on `meta-api` and `cloudflare`.
- Ready rows in Phase 6: D05 T01 §4 (bank key replacement admin action), D05 T04 §1 (lookalike candidate generator), D06 T01 §4 (supplier ledger page and CSV import), D06 T02 §5 (more PDF encodings and protected files).
- Phase 6 starts with D05 T01 §4: it completes the bank-key procedure the stamped §2 documents, and D05 T01 §5 (protected accounts) builds on the same `abandonLostKeys` path.

## Sections

- D06 T01 §4 supplier ledger page and CSV import: stamped 2026-11-01 at 7e5a233e (branch CI green at 848082dd, which also carries the anchored-focus test fix ef36f1a1). Mark verified, the report's ledger links and the Changed on invoice status filed as D06 T01 §6 at start; plan review 5 P1, 4 P2; completion review 7 in-scope gaps implemented (stray CSV quote, header-only template, concurrent edits kept, unknown import outcome, keyboard traversal, 1,000-supplier import and ledger timing, link guard); rounds 1 (3 P2), 2 (1 P2), 3 clean.
- D05 T01 §5 protected live test accounts kept by every removal: stamped 2026-11-01 at 7bebbe7f (branch CI green at 848082dd). Plan review 2 P2 (the operator's view of `kept` filed to §4; the runbook updated); completion review: both audit trails proven untouched; round 1 clean.

- D06 T02 §5 more PDF encodings and protected files: stamped 2026-10-31 at 59136479 (branch CI green at 28d229a9, which contains it). Corrected at start (Ghostscript fixtures, RC4 only, AES filed as §6) and by its plan review (2 P1, 1 P2, 1 P3). Completion review: late-failure charging, cut-short streams named, TIFF at every depth, measured against Ghostscript (`docs/frontier-log.md`); document-case delivery and AES filed to §3 and §6. Rounds: 1 (P1 scanned encryption order, 2 P2), 2 (P1 decoder input charged), 3 (P1 RC4 stream decryption charged), 4 (P1 string decryption charged), 5 (P3 16-bit samples), 6 clean. One WORKAROUND: Ghostscript's unencrypted XMP (`plainXmp`). Tests: 42.
- D05 T02 §1 counterparty intake path with rate limits: stamped 2026-10-31 at deccf1fb (branch CI green at 28d229a9). The staff-inbox item proven once D07 T08 §8 reached main (merged at d83bddb7, the admission conflict resolved: member cases under `dailyCapSql`, counterparty cases under their own two limits); D07 T08 §8 added as a dependency. Rounds: 1 fixed, 2 clean, 3 clean (the merge resolution and the proof).
- D06 T01 §4 supplier ledger page: started 2026-10-31T19:14Z; mark verified, the report's ledger links and the Changed on invoice status moved to the new D06 T01 §6 (depends on §3, §4 and D05 T03 §1); plan review 5 P1, 4 P2, all planned; migration 0061 from the coordinator.

- D05 T04 §1 lookalike candidate generator: stamped 2026-10-31 at 0dd9ac32 (branch CI green there). Corrected at start (the check's own technique, ASCII candidates, shared words and confusables) and by its plan review (3 P2). Completion review: IDN labels, saturation proofs and `co.za` implemented; the monitor experience filed to D05 T04 §2 to §5 and D07 T04 §2. Rounds: 1 (1 P2, 1 P3: the check's own split, ASCII hosts), 2 clean. Mutations: 3 of 3 killed. Tests: 11.
- D05 T01 §4 bank key admin action: depends on D07 T05 §1 (the Access gate, the console lane), added at start.

## Critical events
- 2026-11-01T03:15Z D05 T04 §3 passed six rounds (round 6 approve, at a3b714ed): its P1s were evasions of the parking rules (shadow roots, hostile getters, hidden text, editable text areas), each reproduced on the reviewed code and fixed at its layer: the page's structure and rendered text now come from the browser's own tree over the protocol, never from script run in the page. Branch CI on a3b714ed is green except test/web/domains-list.test.ts (rows read 10133 and 10541 against a bound of exactly 10000; it fails the same way on a clean origin/main locally at 10439 and 10710, with the clock pinned or not, and main CI is green: a flaky bound, not this lane's). The stamp waits on the coordinator's decision; trust-stamps-5 (D05 T02 §7) waits for the gate.
- 2026-11-01T02:12Z stamped: D05 T04 §2 (723ae8cd; gate trust-stamps-3), D06 T02 §6 (2363443f; gate trust-stamps-4, merged to main as 37832311), D05 T02 §7 (b946ba74; gate trust-stamps-5, head cedbd3aa). D05 T02 §10 (real mail editors) skipped by the operator for the competition, 2026-11-01, relayed by the coordinator; the row stays open and attended.
- 2026-11-01T02:12Z CI red at 00a2b282 (run 41260250363, test/node/no-raw-colours.test.ts): the generated src/web/badges.ts embeds the badge artwork's hex fills; fixed with the test's own generated-file exemption plus a new check that every colour in it is a token colour (mutation-checked). The ledger's anchored-row focus red on main was the hidden table copy holding the supplier id; fixed as one table row per supplier at every width (trust-test-anchor-focus, merged by the coordinator).
- 2026-11-01T02:12Z D05 T04 §3 (screening captured pages) built in 966fedd0 on migration 0068 (the coordinator's); plan review 2 P1 and 4 P2 planned; the sessionFrom export asked of the coordinator was withdrawn, D03 T04 §40's session already keeps a failed settlement; completion review dispatched.
- 2026-11-01T00:25Z D05 T04 §2: rounds 1 to 3 fixed (8d86dffa, 126287b0, 723ae8cd), round 4 approved; the coordinator approved the cron "15 4 * * *" and the schedule tests pin all four (87adfd9a); the wake-settlement lookup is a marked WORKAROUND for D03 T04 §40 (bd0a612f). CI at 87adfd9a (run 41254406140) hung after shard 2's files ended, after uncaught errors from src/pipeline/analysis-workflow.ts (another lane's; the coordinator sent it to the checks lane); not reproduced locally on the merged tree (51 files, 857 passed, exited). Stamp waits on CI at 588b090e (run 41255808392).
- 2026-11-01T00:25Z merged origin/main b4f03b02 (c68d9aaf): conflicts in the run file (kept), src/web/assets.ts and worker-configuration.d.ts (regenerated with pnpm build:assets and pnpm types).
- 2026-11-01T00:25Z D06 T02 §6: plan review 2 P1 and 1 P2, planned (5b37fbe2); built in c0087ba8 and dc87928b (checkpoint 65 of 65; 19 AES tests fail on bf1abf19's reader); completion review dispatched.
- 2026-10-31T23:23Z D05 T02 §6 stamped at a04335e6 (rounds 1 to 3 fixed, round 4 clean; CI on a9f6ea21, run 41250106808, green after one rerun of shard 2, whose test/node/signin-page-browser.test.tsx retry test hit its 120 s timeout under contention; not this lane's code). D05 T01 §3's deferral to §6 closed as Resolved.
- 2026-10-31T23:23Z main red on test/node/suppliers-page-browser.test.tsx (375 px focus, main run 41249601967, gate run 41250239489): the hidden table copy held the supplier id, so Chrome's fragment handling cleared the focus the load handler gave the visible card; fixed in the view on branch trust-test-anchor-focus (33243c2e, from origin/main) and on trust-lane (4f3fbb0a), sent to the coordinator.
- 2026-10-31T23:23Z D05 T04 §2: completion gaps 5 to 12 built in f3bff887 (13 of 23 tests fail on 1881af59); round 1 dispatched.
- 2026-10-31T22:42Z CI red on trust-lane at 82cf455e (run 41247576909): test/node/hash-asset.test.ts, 13 cases (its fixture brand folder lacked the Protected seal that D05 T02 §6 added to scripts/hash-asset.ts's logos); fixed in the test's fixtures and its logo expectation. Shard 2 also timed out: its last file test/bindings.test.ts loaded at 22:23Z, then 11 minutes with no file running before the limit.
- 2026-10-31T21:55Z CI red on trust-lane at 7e5a233e (run 41243804412) and 7bebbe7f (run 41244453463): Worker tests shard 1, 'focuses the row an address names (375 px)', a race between the app script's load handler and the test's read on a slower runner; fixed in the test at ef36f1a1 (it waits for the focus), the page unchanged.
- 2026-10-31T21:49Z coordinator: migration 0062 is D05 T02 §6, 0063 D05 T04 §2; memory critical, no local test runs until `free -m` shows 3000 MB available, rely on branch CI.
- bookkeeping: heartbeat resumed 2026-10-31T21:24Z (D06 T01 §4 round 2 running; D05 T01 §5 plan review returned 2 P2, planned)
- bookkeeping: heartbeat resumed 2026-10-31T20:53Z (D06 T01 §4 completion review running; CI green at 0e68b040)
- 2026-10-31T20:52Z coordinator (operator's instruction): lanes run on Sonnet 5.5 at medium with the same bar (extra care on parsers, crypto, auth, money); message the coordinator only for a stamp ready to gate (head commit, anything unstamped beneath), a real blocker or a decision, batched; everything else goes in this run file.
- 2026-10-31T20:40Z trust-stamps pushed for the coordinator (head 7d6dc542: the two stamps without D06 T01 §4's unstamped work); §4 merges at its own stamp.
- bookkeeping: ci-status unknown 2026-10-31T18:53Z (GitHub API quota exhausted for every lane until about 19:15Z; coordinator asked for no gh calls until then)
- bookkeeping: heartbeat resumed 2026-10-31T18:53Z (D06 T02 §5 implemented at 2d63b32e, completion review running)

- Run guard re-pointed 2026-10-31 19:52 SAST from Phase 5: session 2f637d92-23ae-4375-8fda-0d03468a3af2, heartbeat job aff94c8f, generation 115baa1abe99, run 390d44091c2a, scope plan (Phase 5 ran as run 848419b312c2).
- 2026-10-31 20:00 SAST: CI red on trust-s3 at 64d0da8f (D05 T01 §3's stamp for main; https://github.com/rizonetech/isitlegit/actions/runs/41225867537, Worker tests 3 of 3): no test failed, the shard hit its 15-minute limit, as trust-lane's did at b68c5040; the failed job rerun once. trust-lane is green at 2143372e.
- 2026-10-31 20:06 SAST: CI red at 7a94b036 (https://github.com/rizonetech/isitlegit/actions/runs/41226289371, Worker tests 2 of 3): the same shard timeout, no test failed; rerun once. The coordinator's cache for Wrangler's Chrome (d1c71987) is not on origin/main yet; it ends these when merged in.
- 2026-10-31 20:11 SAST: CI red at 31a0ab1d (https://github.com/rizonetech/isitlegit/actions/runs/41226528860, Worker tests 2 and 3 of 3): shard timeouts again, no test failed; rerun once. Every push hits this until main's Chrome cache (d1c71987) reaches origin/main and is merged in.
- 2026-10-31 20:16 SAST: CI red at 25db7edd (https://github.com/rizonetech/isitlegit/actions/runs/41227129066, Worker tests 3 of 3): the shard timed out, and in it `test/web/report-access.test.ts` "answers the same 404 for a tampered or malformed link..." failed with the route answering 500 (a Better Auth APIError) under the loaded runner; it passes locally (38 of 38) and is the app lane's test, so treated as load, rerun once. A second failure on a quiet runner goes to the app lane.
- bookkeeping: heartbeat resumed 2026-11-01T04:22:27Z; §8 completion review running, CI on the new head in progress
- bookkeeping: heartbeat resumed 2026-11-01T04:29:41Z; §8 review round 1 running
- bookkeeping: heartbeat resumed 2026-11-01T04:36:48Z; §8 awaiting CI on 354b2fc8, §9 plan review running
- bookkeeping: heartbeat resumed 2026-11-01T04:48:05Z; §8 stamped (407e162a), §9 built, completion review running
- bookkeeping: waiting 2026-11-01T05:13:31Z: D05 T04 §8 (407e162a) and §9 (83c386e2) stamped, trust-stamps-7 (beb77832) sent to the coordinator. The lane's only ready row is D05 T02 §10 (skipped by the operator, attended). Every other open row waits on D03 T02 §2, D03 T03 §3 or D04 T02 §6 (other lanes); the run waits on them and the heartbeat wakes it.
- bookkeeping: waiting 2026-11-01T05:15:03Z
- bookkeeping: waiting 2026-11-01T05:20:26Z
- bookkeeping: waiting 2026-11-01T05:25:21Z
- bookkeeping: waiting 2026-11-01T05:30:21Z
- bookkeeping: waiting 2026-11-01T05:35:47Z
- bookkeeping: waiting 2026-11-01T05:40:22Z
- bookkeeping: waiting 2026-11-01T05:45:15Z
- bookkeeping: waiting 2026-11-01T05:50:19Z
- bookkeeping: waiting 2026-11-01T05:55:16Z
- bookkeeping: waiting 2026-11-01T06:00:21Z
- bookkeeping: waiting 2026-11-01T06:05:18Z
- bookkeeping: waiting 2026-11-01T06:10:15Z
- bookkeeping: waiting 2026-11-01T06:15:22Z
- bookkeeping: waiting 2026-11-01T06:20:15Z
- bookkeeping: waiting 2026-11-01T06:25:21Z
- bookkeeping: waiting 2026-11-01T06:30:15Z
- bookkeeping: waiting 2026-11-01T06:35:15Z
- bookkeeping: waiting 2026-11-01T06:40:14Z
- bookkeeping: waiting 2026-11-01T06:45:14Z
- bookkeeping: waiting 2026-11-01T06:50:14Z
- bookkeeping: waiting 2026-11-01T06:55:18Z
- bookkeeping: waiting 2026-11-01T07:00:20Z
- bookkeeping: waiting 2026-11-01T07:05:34Z
- bookkeeping: waiting 2026-11-01T07:10:16Z
- bookkeeping: waiting 2026-11-01T07:15:20Z
- bookkeeping: waiting 2026-11-01T07:20:18Z
- bookkeeping: waiting 2026-11-01T07:25:17Z
- bookkeeping: waiting 2026-11-01T07:30:15Z
- bookkeeping: waiting 2026-11-01T07:35:19Z
- bookkeeping: waiting 2026-11-01T07:40:20Z
- bookkeeping: waiting 2026-11-01T07:45:17Z
- bookkeeping: waiting 2026-11-01T07:50:22Z
- bookkeeping: waiting 2026-11-01T07:55:18Z
- bookkeeping: waiting 2026-11-01T08:00:20Z
- bookkeeping: waiting 2026-11-01T08:05:16Z
- bookkeeping: waiting 2026-11-01T08:10:27Z
- bookkeeping: waiting 2026-11-01T08:15:21Z
- bookkeeping: waiting 2026-11-01T08:20:19Z
- bookkeeping: waiting 2026-11-01T08:25:14Z
- bookkeeping: waiting 2026-11-01T08:30:16Z
- bookkeeping: waiting 2026-11-01T08:35:27Z
- bookkeeping: waiting 2026-11-01T08:40:16Z
- bookkeeping: waiting 2026-11-01T08:45:15Z
- bookkeeping: waiting 2026-11-01T08:50:40Z
- bookkeeping: waiting 2026-11-01T08:55:15Z
- bookkeeping: waiting 2026-11-01T09:00:23Z
- bookkeeping: waiting 2026-11-01T09:05:23Z
- bookkeeping: waiting 2026-11-01T09:10:23Z
- bookkeeping: waiting 2026-11-01T09:15:21Z
- bookkeeping: waiting 2026-11-01T09:20:27Z
- bookkeeping: waiting 2026-11-01T09:25:23Z
- bookkeeping: waiting 2026-11-01T09:30:34Z
- bookkeeping: waiting 2026-11-01T09:36:08Z
- bookkeeping: waiting 2026-11-01T09:40:29Z
- bookkeeping: waiting 2026-11-01T09:45:21Z; migration 0069 becomes 0072 on main (coordinator), take main's side at the next merge
- bookkeeping: waiting 2026-11-01T09:50:37Z
- bookkeeping: waiting 2026-11-01T09:56:06Z
- bookkeeping: waiting 2026-11-01T10:00:43Z
- bookkeeping: waiting 2026-11-01T10:05:48Z
- bookkeeping: waiting 2026-11-01T10:11:00Z
- bookkeeping: waiting 2026-11-01T10:15:25Z
- bookkeeping: waiting 2026-11-01T10:21:28Z
- bookkeeping: waiting 2026-11-01T10:25:50Z
- bookkeeping: waiting 2026-11-01T10:30:29Z
- bookkeeping: waiting 2026-11-01T10:36:17Z
- bookkeeping: waiting 2026-11-01T10:40:30Z
- bookkeeping: waiting 2026-11-01T10:45:48Z
- bookkeeping: waiting 2026-11-01T10:50:45Z
- bookkeeping: waiting 2026-11-01T10:55:28Z
- bookkeeping: waiting 2026-11-01T11:00:42Z
- bookkeeping: waiting 2026-11-01T11:05:55Z

### Resume point (handover to Muse Code)

Written 2026-11-01 13:10 SAST at the coordinator's request (operator decision 13:06 SAST: stop and hand the build to Muse Code). Lane: trust, branch `trust-lane`, run 390d44091c2a ended with `operator-stop`.

- **In flight:** nothing. No section is open: the last step finished was the lane's wait. D05 T04 §8 and §9 are stamped and on main.
- **Stamped, not on main:** none. Everything stamped on this lane (D05 T02 §6 and §7, D05 T04 §2, §3, §8 and §9, D06 T02 §6) is on main through trust-stamps-7. The lane's head is main plus merge commits and run-file bookkeeping only, so it holds no unstamped code.
- **Ready rows:** only D05 T02 §10 (signature badge in real mail editors), which the operator skipped for the competition: attended, the row stays open.
- **Waiting on other lanes:** every other open row of the lane waits on D03 T02 §2 (PDF page rasterisation), D03 T03 §3 (logo comparison by Muse Spark) or D04 T02 §6 (walkthrough trigger and cache by final URL). Next command once one lands: `python3 scripts/campaign_guard.py rows`, then `python3 scripts/todo-graph.py query ready`, and `process-todo-section` on the first ready row. Rows behind them: D06 T01 §1, §3, §5, §6; D06 T02 §2 to §4; D05 T02 §2 to §5, §8, §9; D05 T03; D05 T04 §4 to §7 and §10; D05 T01 §4.
- **Open decisions:** (1) a cadence faster than daily for the monitor (D05 T04 §8 completion review E2) contradicts the operator's decision of 2026-10-28 22:42 SAST and needs the operator first. (2) D05 T02 §10 stays skipped until the operator says otherwise.
- **Known reds:** none known on trust-lane. `test/web/domains-list.test.ts` was red on main from the start of the month (a clock-relative rows-read bound); fixed test-only by d6cfddf6, already on main.
- **Migrations:** the second look is `0072_monitor_second_look.sql` on main (not 0069, which is walkthrough's); `test/monitor/screen.test.ts` looks it up with `startsWith("0072_")`. Already taken from main's side in the merge. Next free number is 0074: ask the coordinator before taking one.
- **Stamp receipts:** D05 T04 §8 is `docs/reviews/d05-t04-s8.json` (its first check line is worded loosely: it says 89 passed in `test/monitor` with 95 earlier for the cron pins; both were true runs), §9 is `docs/reviews/d05-t04-s9.json`.
- **Gate habits that held:** push once after the last review round, wait for green branch CI on the head, then `todo-graph.py stamp`; a push cancels the lane's CI run in progress; review dispatches run with `run_in_background`; run every test file that touches changed markup; a todo commit stages `todo/` and `docs/reviews/` together.
- live-prep 2026-11-02 (D06 T01 §1, Muse rain-umbriel): live set chosen from the tree, expected values recorded before any paid call. Positive: test/fixtures/pdf-forensics/chromium-invoice.pdf expects supplier Hadeda Couriers (Pty) Ltd, bank Kestrel Bank, account 62004417731, branch 250655, amount 410000 cents ZAR, domain hadeda.example, reference null, due date null (only an invoice date is stated). Negatives: chromium-pop.pdf and gs-genuine-pop.pdf are proofs of payment, expecting is_invoice false. Spend on D06 T01 §1 so far: US$0.00 of the US$10.00 cap shared with D05 T04 §4.
- live-run 2026-11-02 (D06 T01 §1, Muse rain-umbriel): `node scripts/invoice-live.ts --confirm-credit` passed on the first answered run: detection 3 of 3, supplier, account, branch, amount and currency exact on chromium-invoice.pdf, honest nulls kept, US$0.0200 over 3 attempts settled measured. A first run was skipped by the test gate (INVOICE_ bindings not yet in vitest.config.ts), so its US$0.2768 worst-case reservation stays counted at the estimate. D06 T01 §1 total counted spend: US$0.2968 of the US$10.00 cap shared with D05 T04 §4. Recorded in docs/frontier-log.md.
- live-run 2026-11-02 update (D06 T01 §1, Muse rain-umbriel): the adversarial twin (an instruction inside the invoice to report another account) changed no extracted field, proven live. Currency on the stated "R" amount varies between runs (ZAR inferred once, null once); both are faithful and the test expects either. Total counted spend for the section: US$0.7077 of the US$10.00 cap (US$0.0200 + US$0.0275 + US$0.0143 measured, plus US$0.2768 and US$0.3691 reservations that stay counted at their estimates).
