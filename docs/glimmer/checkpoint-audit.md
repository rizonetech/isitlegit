# Checkpoint input evidence audit

Measured 4 November 2026, 09:44 SAST, for D03 T04 §51. This is an offline artifact audit, not model evaluation, review approval or permission to promote. The running trainer was not stopped, restarted or given replacement inputs.

The first immutable receipt is `<store>/runs/audits/loupe-1.1-20261104T0741.json`, produced by commit `54e6d348b1620ee6fc1f774e5caf5620a14bdc26`. It records measured hashes, artifact issues, the auditor source digest and timestamp. The receipt contains no page text or images and is kept outside the repository with the training records.

| Artifact | Measured lines | SHA-256 |
| --- | ---: | --- |
| 1.1 training | 72,375 | `5fb1d93b4549bd8b64c69c943ad5f23a7411cdfc8d4d3f2e339f0442d2eb253b` |
| 1.1 evaluation | 1,301 | `b240c7144a27e51cbca1364c13d153e82d82bc3a47307f07b25b7c658a6869cc` |
| 1.0 training | 52,019 | `e8c693be6d5a0eba4ce25ec1cc8e6d5d8585d62b32a8209a74172ada0f3adc9e` |
| 1.0 evaluation | 1,000 | `a23db3ab1f0abae747c6023167b5bcd67a4882002804ff639a00f01cf49716a8` |

The active 1.1 input independently hashes to the recorded 1.1 training digest. Its historical `selection.json` records the same dataset digest, input digest and 72,375 selected lines. The current bytes therefore match that recorded selection; this does not certify missing build provenance or prove that training has finished.

The 1.1 publication lacks its version page archive, protected held-out source-item list and reference export. Its summary lacks freeze identity, floors, split-balance results, hard-negative counts and held-out provenance. The independent raw freeze exists, but it cannot retroactively supply a missing binding in the publication. The available 1.0 archive is also partial: 51,943 training rows and 965 evaluation rows have no corresponding archived page; the audit did not find `raw/FROZEN-1.0.json`. Missing evidence remains incomplete and is not reconstructed from current mutable source pages.

The two ordinary evaluation files have different digests, so comparing their existing per-version metrics cannot satisfy §50. Metadata inspection also found 257 IDs from the 1.1 evaluation in 1.0 training. The 1.0 evaluation has no page IDs in 1.1 training, making it a possible common set only after the remaining content and group-isolation evidence is verified. Matching IDs or file digests alone never prove template or near-duplicate exclusion.

The audit reports `comparison_ready: false`. §45 and §50 remain unstamped. The 09:30 promotion target was missed; no checkpoint export or production promotion was performed. A separately reviewed scope must bind a provider-confirmed promotable checkpoint to an immutable model identity, obtain valid common-held-out evidence and pass the quality gate before the existing release path is used.

Run the audit with `python3 scripts/glimmer/checkpoint-audit.py --version 1.1 --previous 1.0 --trainer-input <actual-input> --run <actual-run>`. Without `--receipt` it writes nothing. An explicit receipt destination must be a new file beneath `<store>/runs/audits/`; concurrent or repeated publication cannot replace an existing receipt. Exit 0 means the requested checks verified, 1 means evidence blocks verification, and 2 means invocation or receipt publication failed. JSON rows and standalone JSON evidence are bounded at 64 MiB; oversized rows are hashed and skipped without loading the whole row or losing the following row.

Targeted validation after the initial live audit: `python3 -m unittest tests.scripts.test_checkpoint_audit tests.scripts.test_version_gate` passed 27 tests. Regression cases demonstrate refusal of a changed historical selection, swapped metadata, mismatched labels, missing provenance, unmet floor reports, oversized rows and receipt overwrite. Missing files are classified as absent evidence rather than as contradictory contents. These tests do not substitute for the live receipt, the section reviews or a production measurement.

The implementation self-review identified and the writer reproduced three audit defects: malformed image URL handling, empty reference-summary acceptance and ID-only source-item evidence. Repairs add strict validation and regression coverage. Related repairs validate reference JSON and archived page-text bindings and prohibit receipt writes inside any Git checkout. A fresh live receipt is required before the final completion review.
