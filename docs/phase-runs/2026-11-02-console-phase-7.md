
## 02:15 SAST: D07 T05 §2 built, completion review answered, round 1 P2s in fix loop

- Candidate so far: d54dbba2 (implementation, 12+3 tests), 9752cd8 (guard pass-through), 71b4253f (completion gaps), c87e538d (filings §4 §5), 81622cdf (round-1 part 1).
- Gates on the tip: worker suite 15 passed, browser suite 5 passed, typecheck clean, lint clean on touched files, validate 483 sections, plan current, check-design 0 problems, check-publication clean.
- Round 1 (Astra, medium, all lenses + design): HIGHEST P2 with three P2s. Two fixed and committed in 81622cdf: organisation creation dates (table, phone list, CSV, SPEC X1 Deviation) and inclusive expiry days (sastExpiry + worker pin). Third (retry-safe creation) needs a single-use form-key table: asked the coordinator for the next migration number after 0074 in the outbox (WAITING: migration number for invite_creation_keys).
- Failing-first proof kept: the revoked test fails without the signup change (201 instead of 400) and passes with it.
- Self-review notes: blank cap refused without saving zero; unknown plans read Unknown with no fabricated cap; CSV reads rows only; median/p95 read by ordered offset; cap posts carry the search through; invite hashing decoupled from signup so browser tests keep their DOM-safe graph; guard tests expect the overview downstream.

Resume: when the migration number arrives, write the invite_creation_keys migration, wire mint/consume/replay onto GET+POST /admin/invites with tests, run round 2, then stamp.

- Idempotency keys implemented and green (provisional 0075, uncommitted): mint-on-GET, consume-on-POST, repeat POST renders already-submitted naming the label, stale keys re-render with values kept. Worker 16 passed, browser 5 passed, typecheck/lint/validate clean. Waiting on the coordinator's number before committing (rename + rerun if it differs).
