# Phase run: Phase 2, the checks lane

Started 2026-10-30 12:15 UTC by `process-plan`, scope plan, on branch `checks-lane` (`docs/specs/2026-10-30-four-lanes-design.md`): this lane works D01, D02, D04, D08 and D09 only. Until D00 T01 §19 (lane scoping, the coordinator's) lands, `query ready` lists every lane's rows, and this run skips the other lanes' by hand. Continues `docs/phase-runs/2026-10-30-phase-2.md`, ended by the operator's stop for the lane split.

## Plan audit

- Graph: `validate` reports 263 valid sections; `plan --check` current; `scripts/tests` and `tests/scripts` pass.
- Ready rows: 36 in the plan, 20 in this lane's domains: Phase 2 `D02 T02 §1` first (8 rows, `D08 T03 §1` needing `meta-api`), Phase 3 `D01 T03 §3` first (5), Phase 4 `D04 T02 §2`, Phase 6 `D01 T01 §10` first (3, two needing `attended` or `live-mail`), Phase 7 `D01 T01 §11` first (3).
- Blocked: 138 rows in the plan, waiting on dependencies or on Needs this lane cannot reach here (`attended`, `live-mail`, `operator`: the coordinator prepares those).
- Phase started: 2, the lowest phase with a ready row of this lane, resuming `D02 T02 §1`, open and built as work in progress (`42ac0cf`, `c4bc74c`).

## Sections

- D01 T02 §6 Forwarding failures detected and reported (Phase 1): stamped (plan review 1 P1 + 5 P2 folded in; two live probes, the second reading a refusal as NDR notices; completion 7 gaps fixed, the live proof filed as D01 T02 §9; rounds 1 to 3 fixed (P1 + 3 P2, 2 P1 + P2, P2), round 4 clean). 323 tests across mail, scheduled, intake and pipeline. Migration 0036; needs `CF_ANALYTICS_TOKEN` at deploy (the coordinator's).

- D02 T02 §4 Display name, Reply-To and Return-Path checks: stamped (plan review 1 P1 + 4 P2 fixed; completion 5 gaps fixed, 2 filed to D04 T01 §2 and D07 T03 §3; rounds 1 and 2 fixed (2 P1 + 3 P2, a P1), round 3 clean). 414 tests across the checks, intake, pipeline and auth folders. The brand table now reaches the view from KV through the checks step; `brandForMailbox` answers mail domains.

- D02 T02 §3 ARC chain evidence: stamped (plan review 1 P1 + 3 P2 fixed; completion 2 gaps fixed, 2 filed to their owners D07 T03 §3 and D04 T01 §4; rounds 1 to 3 fixed (2 P2 + a P3, a P2, a P2), round 4 clean). 391 tests across the checks, intake, pipeline and auth folders.

- D02 T02 §2 SPF, DKIM and DMARC alignment evidence: stamped (plan review 2 P1 + 3 P2 fixed; completion 3 gaps fixed, 2 filed to their owners D04 T01 §2 and D07 T03 §3; rounds 1 to 3 fixed (2 P1 + 3 P2, a P1 + a P2, a P2), round 4 clean). 374 tests across the checks, intake, pipeline and auth folders; the whole Worker suite waits for the coordinator's slot.

- D02 T02 §1 Trusted Authentication-Results parsing: stamped (plan review 2 P1 + 2 P2 fixed; completion 4 gaps fixed, 1 filed as D02 T02 §6; rounds 1 to 4 fixed (2 P1 + 2 P2, then a P1 each), round 5 clean). The whole Worker suite passed at 862 on the build; the affected folders (319 tests) on the final code. Trust now rests on what each receiver can prove: Microsoft 365 and Google by their topmost stamp, any other receiver only above its topmost hop, its inner chain left to §6.

## Critical events
- 2026-10-30T12:15Z run guard: session `3be2e4be-a8fb-4ea8-9e8b-6d8060daa291`, heartbeat job `5c1771a3`, generation `9c2b46bb7ebd`, run `94de7fd7e7d6`, scope plan, lane checks.
- 2026-10-30T13:00Z merged main (483e65a, D00 T01 §19 lane scoping) into checks-lane at 6234ec2; the run file renamed to the lane convention (`checks-phase-N`); the heartbeat is recreated from §19's prompt.
- 2026-10-30T13:01Z guard re-pointed: heartbeat job `3fccf94f` from §19's prompt, generation `7340bf970e34`, run `40dfd8b5ef89`, run file renamed; the old job `5c1771a3` deleted. `campaign_guard.py rows` reads lane=checkout (the guard follows this worktree's lane), open=70, ready=22, next D02 T02 §2.
- 2026-10-30T13:49Z D01 T02 §6 (Phase 1) released by the operator's analytics token, restarted and plan-reviewed; its review showed a controlled failure must be probed before the detector is written, so it waits on the operator's Exchange mail flow rule again (Needs `operator`), asked of the coordinator with migration 0035 and the fallback-mailbox decision.
- 2026-10-30T16:16Z red on checks-lane (Worker gates, run 41085518886, commit 1f3bd82): `test/mail/forwarding.test.ts` timed out at 15 s writing 10,000 forwards one D1 call each in CI; a production flaw too (a backlog that size in one scheduled run), fixed at its layer by writing forwards in batches of 100, with a regression counting what reaches D1 (fails on the per-event code).
- 2026-10-30T19:53Z D02 T03 §4 reviewed (plan, completion, round 1 fixed, round 2 clean) but its stamp refused: the plan review's candidate eaa665b is one commit after the Started commit dd17122 (only the two RDAP fixtures re-formatted). The coordinator decided a narrowed tooling rule, D00 T01 §28 (a later candidate accepted when the section body and product code are unchanged in between); §4 waits on it, owned here, then stamps as it is. Reversal cost: none, the code is reviewed at 2253fa4.
- 2026-10-30T19:53Z D01 T02 §9: probe 4 proven (one clean alert in both mailboxes, 19:15 UTC); migration 0040 repairs probe 3's rows, reviewed clean; §9 waits on the operator's removal of the Exchange rule, then stamps.
- bookkeeping: heartbeat resumed 2026-10-31T01:02Z (D02 T05 §2's completion review running on 798b3cf; D02 T04 §3 stamped at 71b5333)
