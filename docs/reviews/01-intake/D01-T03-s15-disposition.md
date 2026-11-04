# D01 T03 §15 completion repair disposition

The original approved contract is unchanged in `todo/01-intake/TODO-03-upload-and-voice.md` §15. Exact values, complete original spans, full-transcript parsing before quote selection, strict optional storage, historical compatibility and original-quote fallback remain required. No finding is reclassified as optional.

Original plan candidate: `5541268f0beac32735d9903f41e32e7681650bbe`, with pre-code plan corrections at `96119269`. Original review chain: `docs/reviews/01-intake/D01-T03-s15.md`, plan, one implementation round and final completion. Failed completion candidate: `13dc5731ab8cc1d36fb4c29494fa49ab00ad4484`, digest `015d51de86b2da2c`, returned `COMPLETION: gaps` at 2026-11-04T10:56:48Z. All original review bytes and pins are retained.

## Original completion finding

1. P2: repeated ampersands let a later component of an unsupported compound become structured evidence. The exact example is `Please pay R100 & 50 thousand & 20 thousand today`, previously yielding `20 thousand` with value `20000`. This violates the approved whole-expression and quote-only fallback requirements. Repair commit `7c3b367e` adds ampersand consumption to the owning `compositeEnd` parser in `src/voice/figures.ts`, alongside its existing word joins, instead of filtering evidence afterward. `test/voice/figures-evidence.test.ts` adds the exact example, a longer mixed-currency compound and a negative mixed and/ampersand compound through verified claim, StoredVoice, actual evidence production and D1 save/read-back. The exact example and negative case failed before the repair; the longer compound already passed and remains a guard. The original quote stays available; no amount is invented.

## Evidence and intervening changes

- `build/voice-completion-red.log`: 2 failed, 16 passed persisted-evidence tests before the parser repair.
- `build/voice-completion-repair.log`: 61 passed after the repair, comprising 43 parser and 18 persisted-evidence tests. Biome passed on both changed source/test files.
- Earlier checkpoint at the original completion candidate: full five-file checkpoint 87/87 before the final combined-negative ordering case, then 58/58 affected tests afterward. Full typecheck and dry build passed on that source. The new product change is one additional character in the rejected-compound grammar and three regression cases, not a type or import change.
- The original round's two P2 findings, spaced signs and unsupported compound components, retain their six persisted regressions. Both remain obligations for this verification.
- Coordinator release `e4401838e1a23986f2536fc6d71d4811b883c8b7` adds the authorized two-pass/reconciliation tooling and new lane assignments at the clean boundary. It changes no product source or this section contract. Setup hashes and actual tests are recorded separately in the lane handover. The voice chain remains legacy three-pass with its actual round; it is not transitioned or relabeled.

The reconciliation must verify the repair, all original obligations and every intervening change on its exact candidate. No stamp, release CI, deployment, live model measurement or whole-branch approval is claimed by this disposition. Unreviewed verification integration remains held outside this section. If reconciliation returns gaps, the section stays unstamped and the lane continues other owned work.
