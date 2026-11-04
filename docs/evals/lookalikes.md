# Accent-insensitive lookalike measurement

Measured 2026-11-04T15:35:24.382Z with Node v24.18.0, Unicode 17.0, ICU 78.3; linux/x64. Local Node timing, not Worker latency, CI, deployment or population accuracy.

Reproduce: `node scripts/fixtures/make-lookalikes.ts --check`, then `taskset -c 3 node scripts/measure-lookalikes.ts`. Add `--write` to replace this report. Generation is offline and deterministic, seed 20261104. Every name is fictional synthetic; no client data or model calls.

The target inventory contains all 20 logo-recall brands, all three invoice suppliers and six domain-check/demo names (deduplicated to 29); source digests are in positive.json. Each target has exactly one case in each of seven families, 203 positives. The 60 benign labels combine ten independently invented accented names and six trades, fixed before scoring; no label is removed or selected by detection results. These are constructed controls, not a representative business population or independent holdout.

Every one of 263 labels is compared with every one of 29 targets (7627 pairs). Detection means a positive matches any target; intended-target detection is also shown. A false flag means a benign label matches any target. Exact unchanged labels are excluded. All labels pass the same IDNA and LTR eligibility checks. Timings are median of three warmed complete passes, microseconds per candidate-target pair (both labels transformed), without corpus I/O or initial IDNA normalization; no cross-pair transformation cache. Amortized microseconds per label is derived as half the measured pair time, since each comparison consumes two labels.

| Technique | Detected | Intended target | False flags | Microseconds/pair | Amortized microseconds/label |
| --- | ---: | ---: | ---: | ---: | ---: |
| Skeleton equality | 29/203 | 29/203 | 0/60 | 2.851 | 1.425 |
| Distance <= 1 (length >= 6) | 116/203 | 116/203 | 0/60 | 5.321 | 2.661 |
| Distance <= 2 (length >= 6) | 145/203 | 145/203 | 0/60 | 4.378 | 2.189 |
| Added words | 29/203 | 29/203 | 0/60 | 6.791 | 3.395 |
| Accent-fold equality | 87/203 | 87/203 | 0/60 | 0.484 | 0.242 |
| Fold then skeleton equality | 116/203 | 116/203 | 0/60 | 1.966 | 0.983 |
| Reference skeleton equality | 29/203 | 29/203 | 0/60 | 2.334 | 1.167 |
| Existing combined | 174/203 | 174/203 | 0/60 | 14.993 | 7.496 |
| Combined plus exact accent-fold | 203/203 | 203/203 | 0/60 | 14.756 | 7.378 |

| Technique | accent-1 | accent-2 | accent-3 | swapped | doubled | confusable | added-word |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Skeleton equality | 0/29 | 0/29 | 0/29 | 0/29 | 0/29 | 29/29 | 0/29 |
| Distance <= 1 (length >= 6) | 29/29 | 0/29 | 0/29 | 29/29 | 29/29 | 29/29 | 0/29 |
| Distance <= 2 (length >= 6) | 29/29 | 29/29 | 0/29 | 29/29 | 29/29 | 29/29 | 0/29 |
| Added words | 0/29 | 0/29 | 0/29 | 0/29 | 0/29 | 0/29 | 29/29 |
| Accent-fold equality | 29/29 | 29/29 | 29/29 | 0/29 | 0/29 | 0/29 | 0/29 |
| Fold then skeleton equality | 29/29 | 29/29 | 29/29 | 0/29 | 0/29 | 29/29 | 0/29 |
| Reference skeleton equality | 0/29 | 0/29 | 0/29 | 0/29 | 0/29 | 29/29 | 0/29 |
| Existing combined | 29/29 | 29/29 | 0/29 | 29/29 | 29/29 | 29/29 | 29/29 |
| Combined plus exact accent-fold | 29/29 | 29/29 | 29/29 | 29/29 | 29/29 | 29/29 | 29/29 |

Measured advantage: 29 additional positive labels versus existing combined techniques, with 0/60 benign labels flagged. Against the reference skeleton alone, the extended combination detects 203/203 versus 29/203, by adding heuristics, not by improving UTS #39 conformance. The product skeleton has no detection advantage over the reference on this corpus; their match counts are identical. Timing differences are local observations, not a general speed claim.

Selected threshold: exact accent-fold equality only, after existing skeleton, added-word and edit comparisons. No increased edit-distance tolerance and no folding-plus-skeleton production expansion. Keep the UTS #39 skeleton unchanged, existing technique precedence, severity, trusted-domain exclusions, evidence/provenance and right-to-left refusal. The all-mark fold is NFD, remove every Unicode Mark, NFC. This is a separate heuristic, not identity or ownership proof. Accent distinctions can be meaningful; zero false flags here cannot establish a deployment false-positive rate.

The alternative is our separately implemented reference v1 in scripts/measure-lookalikes.ts, parsing the raw vendored Unicode 18.0.0 confusables table, digest 6ed3ee967c9dfdf6677d563c9985182fbc50a2efb7d6059cd57b2e2ce18f5b92. It shares source data and JavaScript normalization with production, covers this LTR corpus only, and is neither third-party validation nor full bidiSkeleton conformance. It fails closed on source-digest mismatch. No comparative claim about Chrome, ICU or other products follows from this experiment.

Measurement script SHA-256: 83469dd9c18a64cad0be9b56b1b738b141ce15716c46bba156b7b8f83cc0c089. Generator SHA-256: 18e56e0122fc7fa59cf621e07d167af1a9a23528e9ec4faf6d45b36a0ce0bdb2. Positive fixture SHA-256: 8fd79d7c1ee44705b40ef8912127b51bd319b00a18a2ec419cfa11ecc65ff574. Benign fixture SHA-256: 479e75f2edcbb68af2df6895548bb4ace8746a0f85a140c3e574b7b4394aee61.
