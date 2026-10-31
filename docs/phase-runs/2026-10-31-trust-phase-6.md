# Phase run: trust lane, Phase 6 (2026-10-31)

## Phase repairs

- Started 2026-10-31 19:52 SAST after Phase 5 parked (docs/phase-runs/2026-10-31-trust-phase-5.md, its park record): Phase 5's leftovers wait on other lanes (D07 T08 §8, `src/auth/protected.ts`) or on `meta-api` and `cloudflare`.
- Ready rows in Phase 6: D05 T01 §4 (bank key replacement admin action), D05 T04 §1 (lookalike candidate generator), D06 T01 §4 (supplier ledger page and CSV import), D06 T02 §5 (more PDF encodings and protected files).
- Phase 6 starts with D05 T01 §4: it completes the bank-key procedure the stamped §2 documents, and D05 T01 §5 (protected accounts) builds on the same `abandonLostKeys` path.

## Sections

- D06 T02 §5 more PDF encodings and protected files: stamped 2026-10-31 at 59136479 (branch CI green at 28d229a9, which contains it). Corrected at start (Ghostscript fixtures, RC4 only, AES filed as §6) and by its plan review (2 P1, 1 P2, 1 P3). Completion review: late-failure charging, cut-short streams named, TIFF at every depth, measured against Ghostscript (`docs/frontier-log.md`); document-case delivery and AES filed to §3 and §6. Rounds: 1 (P1 scanned encryption order, 2 P2), 2 (P1 decoder input charged), 3 (P1 RC4 stream decryption charged), 4 (P1 string decryption charged), 5 (P3 16-bit samples), 6 clean. One WORKAROUND: Ghostscript's unencrypted XMP (`plainXmp`). Tests: 42.
- D05 T02 §1 counterparty intake path with rate limits: stamped 2026-10-31 at deccf1fb (branch CI green at 28d229a9). The staff-inbox item proven once D07 T08 §8 reached main (merged at d83bddb7, the admission conflict resolved: member cases under `dailyCapSql`, counterparty cases under their own two limits); D07 T08 §8 added as a dependency. Rounds: 1 fixed, 2 clean, 3 clean (the merge resolution and the proof).
- D06 T01 §4 supplier ledger page: started 2026-10-31T19:14Z; mark verified, the report's ledger links and the Changed on invoice status moved to the new D06 T01 §6 (depends on §3, §4 and D05 T03 §1); plan review 5 P1, 4 P2, all planned; migration 0061 from the coordinator.

- D05 T04 §1 lookalike candidate generator: stamped 2026-10-31 at 0dd9ac32 (branch CI green there). Corrected at start (the check's own technique, ASCII candidates, shared words and confusables) and by its plan review (3 P2). Completion review: IDN labels, saturation proofs and `co.za` implemented; the monitor experience filed to D05 T04 §2 to §5 and D07 T04 §2. Rounds: 1 (1 P2, 1 P3: the check's own split, ASCII hosts), 2 clean. Mutations: 3 of 3 killed. Tests: 11.
- D05 T01 §4 bank key admin action: depends on D07 T05 §1 (the Access gate, the console lane), added at start.

## Critical events
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
