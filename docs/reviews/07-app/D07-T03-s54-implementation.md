# D07 T03 §54 implementation evidence

This is implementation evidence, not a review receipt or approval. The genuine plan self-review is in D07-T03-s54.md and approved candidate 12906df965fd9a99bbecb32940e8f1b608fb550c. The unchanged approved obligations are in todo/07-app/TODO-03-report-page.md §54.

## Owning layers and scope

The raw artefact preview route owns bounded header serialization and authorization. openOriginal owns dialog pagination, response validation, request generations and announcements. Only these product regions changed; console's casesFailure hunk is untouched. Each slice is at most 204800 UTF-8 bytes, with byte offsets and a SHA-256 revision of the actual complete serialized header list. This is neither raw wire-byte fidelity nor bounded R2 reads. Message previews and raw downloads retain their prior contract. The approved local M3 reference export is separate from held marketing/video/public capture.

## Regression and gate evidence

- Before route implementation, the new Worker regression failed because offset was undefined rather than 0; ten existing tests passed. app-s54-worker-before.log retains the failure.
- Before client implementation, the new browser regression failed because Show the next part was absent. app-s54-browser-before.log retains the failure.
- Final Worker checkpoint: 13 tests passed, including exact three-plus-slice joins, multibyte boundaries, malformed cursors, exact EOF, changed revision, valid and invalid capabilities, cross-tenant denial, membership loss, expiry, raw removal and read outage. app-s54-worker-final.log.
- Browser checkpoint:23 tests passed on the final candidate. Covers exact complete text, temporary failure/retry, malformed nonprogressing response, restart, pending deduplication, late JSON, close/reopen, same-tab refresh, queued announcements, denied access, empty/missing/gone/expiry/deadline/download and both themes at 360/1280 px. app-s54-browser-candidate.log records all 23 passing; app-s54-scroll.log and app-s54-remainder-timeout.log retain the additional targeted proofs.
- Typecheck, dry build and lint passed. Lint reports 24 warnings and 2 infos; no lint error. Graph validation 600 sections and publication scan passed. Design check reports 0 problems after the approved source import and one-board export. No live deployment or CI success is inferred from these gates.

## Scoped accessibility workaround

The new paginated headers state exposes axe 4.11 color-contrast uncertainties on the header explanation, progress note and preformatted text. Inspection of axe's synthetic background-stack comparison and native text-range hit stacks shows identical unobscured native stacks terminating in opaque dialog/region backgrounds; the synthetic stacks vary beneath the native top-layer dialog. Product CSS was not changed to hide the scanner result. A marked WORKAROUND in this section's browser test resolves only those exact overlap uncertainties after verifying native hits across every text line, opaque backgrounds, no filters/translucency and measured contrast of at least 4.5:1. Every actual violation and other uncertainty still fails. A deliberately same-color foreground/background mutation remains a failing accessibility result. No shared allowlist was broadened.

## Review tooling boundary

Coordinator REVIEW-JOURNAL-37-RELEASE authorized exactly scripts/review-dispatch.py and scripts/tests/test_review_dispatch.py from b939d683a878e8c3aac37e9a6b6bfbd921ec5d42. Setup 1290e37afb86ffe40cf03699aaa12bef170b5a25 preserves the original pin, plan and journal state, verifies both exact SHA256 values and passed 48 JournalDurability/TwoPass/Reconciliation tests on cores 8,9. It is local regression proof, not physical power-loss or Windows durability proof. Completion review may resume after that acknowledged setup; no new review result has been fabricated.
