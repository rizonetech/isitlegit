# Native PDF forensic limits diagnosis

D06 T02 §8, measured 2026-11-04. Coordinator approved this diagnostic scope at 10:14 SAST after reproduction found no established parser defect in the reported misses. This is not a detector repair, detection improvement, final-product evaluation or target-attainment claim. The original repair assignment is preserved in git history at 20f4747f; scope correction precedes plan review at 3b1966d6.

## Reproduction and source identity

The read-only command `taskset -c 9 node eval/forensics/score.ts --check eval/RESULTS.md` returned `PDF forensic report verified` in the eval checkout on 2026-11-04. The relevant corpus/scorer/metric/detector paths matched eval commit `a7db96191483812a5b13e1411b3bb61aa719ebf7`; unrelated active ablation edits were not read as measurement input or modified. Reproduce from a checkout containing those exact paths at that commit. The scorer validates all original file hashes and labels before analysis. Console does not duplicate or modify the eval-owned six PDF files or manifest.

- Manifest byte SHA-256: `865095aab42c446d587d5b2684053cc6f78127a21022c648146083ec0511bd8b`. The scorer reports canonical parsed-manifest SHA-256 `8b443a0db771e2054fdaecf2cdbe23ddc32f8c9f38de9c04554fbd29ac41c31d`; these hash different serializations, not different samples.
- Scorer `eval/forensics/score.ts` SHA-256: `f8e79d908017a37c2c760985bd842435bc7b22deb1bcc4953e7d14dc36daf225`.
- Detector `src/invoice/forensics.ts` SHA-256: `f2243269bb8763903c9dfcc322645095054391f83c3c890efee23b8fc1c1f71e`, byte-identical between eval and console.
- Parser `src/invoice/pdf.ts`: `5d7b4ef36aeaca6c02e1a86b7a5bc4e43e354cbc776fbd9dd39743d4c9daab9c`; content reader `src/invoice/pdf-content.ts`: `752667f58c7444c0ace1a3fef912eb2c6123362d008da09b001430b14ebd4e92`; filters `src/invoice/pdf-filters.ts`: `6bd49e5da22840408d59b1d1a7583b1a5ee5d3ef1e3ad8a7512656184e1679c5`. All three were byte-identical between checkouts.

## Exact native corpus

Labels, hashes and generator names below are unchanged from the pinned eval manifest. Each row is a fresh observation through `observe(loadManifest())` from the same scorer. Detection means high or critical evidence, not the mere presence of a finding. Forty raster files remain separately inventoried as unsupported by native PDF forensics; none is silently relabelled or included in PDF denominators. The separate PNG encoding repair changes no native-PDF bytes or labels.

| Path | Label / generator | SHA-256 | Findings | Coverage |
| --- | --- | --- | --- | --- |
| `eval/sets/pdf-forensics/proof-of-payment-genuine.pdf` | genuine / project-pdf-writer | `7c2e924d9dee421b02eb7b1ade3c158d81262eb018c39607c409e0f301425ff3` | none | complete |
| `eval/sets/pdf-forensics/proof-of-payment-doctored.pdf` | doctored / project-pdf-writer | `ab306eb16e0bdc6d98af60b737e0403bc12e529f110ab984b6d836af3c464528` | document.forensics.revisions:high, document.forensics.fonts:high | complete |
| `eval/sets/pdf-forensics/bank-letter-genuine.pdf` | genuine / project-pdf-writer | `7a3bc6337fcb22259e02e39d721b7103dffdecd06bd7bfc44d36e5ade16f4af7` | none | complete |
| `eval/sets/pdf-forensics/bank-letter-doctored.pdf` | doctored / project-pdf-writer | `10be6664bf65213f7ca8a008a41fcd96fee1e65491873e23187f45585e072338` | document.forensics.revisions:high, document.forensics.fonts:high | complete |
| `eval/sets/pdf-forensics/invoice-genuine.pdf` | genuine / project-pdf-writer | `07cd50c89193209a2f1c9a63785edf21ee96f7339aaca120333c9f5d490b47c2` | none | complete |
| `eval/sets/pdf-forensics/invoice-doctored.pdf` | doctored / project-pdf-writer | `87a9d27e32f6592836e5d21273781db25ca70fef28720b81333f18e0fc515f1c` | document.forensics.revisions:high, document.forensics.fonts:high | complete |
| `test/fixtures/pdf-forensics/chromium-invoice.pdf` | genuine / Chromium-Skia | `2c47f6db63c5491003ff09312a18a7ac510a4e67cb91bed15b7eb474c1977b33` | none | dates: unavailable: the document states no payment date |
| `test/fixtures/pdf-forensics/chromium-pop.pdf` | genuine / Chromium-Skia | `12dea7e9e203bf7038e2bc67a1dc6397b4e99152cfd26116e714ebe95fe1b245` | document.forensics.producer:medium | complete |
| `test/fixtures/pdf-forensics/gs-edited-pop.pdf` | doctored / Ghostscript-10.06.0 | `8471cb6d535098aa6c37188da1c9b287584693041d503ccd180e8e03c742490a` | document.forensics.revisions:medium | complete |
| `test/fixtures/pdf-forensics/gs-genuine-pop.pdf` | genuine / Ghostscript-10.06.0 | `0d7118a5165a7be8b6e56e2e0814dc0065328c06465a4aa783f10648771932a2` | none | complete |
| `test/fixtures/pdf-forensics/gs-logo.pdf` | genuine / Ghostscript-10.06.0 | `a999f86a3a1be600053d9012bd13c1267e3648832e8228ce11d97fe79604f522` | none | complete |
| `test/fixtures/pdf-forensics/gs-modified-pop.pdf` | doctored / Ghostscript-10.06.0 | `acdf3a753c77d9ce0a4d35a59e8082d9cba5ebd50e5e6f1c0e8e377ba25faa56` | document.forensics.dates:medium | complete |
| `test/fixtures/pdf-forensics/gs-pasted-image.pdf` | doctored / Ghostscript-10.06.0 | `85e7bb146452e9db60526c898caf15dd45700916994ae6b12c02bb405b31d2b6` | document.forensics.overlay:medium | complete |
| `test/fixtures/pdf-forensics/gs-substituted-font.pdf` | doctored / Ghostscript-10.06.0 | `709748665276c58553171ba9e979c33561f03e5370402c6d0e6c203fcc3c0383` | document.forensics.fonts:medium | complete |

## What the misses mean

All four Ghostscript doctored fixtures intentionally isolate one signal: `gs-edited-pop.pdf` has revisions; `gs-modified-pop.pdf` has conflicting payment/file dates; `gs-pasted-image.pdf` has an overlay; `gs-substituted-font.pdf` has a font difference. The generator `test/node/make-pdf-forensics.ts` and `test/fixtures/pdf-forensics/PROVENANCE.md` describe those independent edits. Each detector finds its intended signal. `forensicsEvidence` requires two independent groups for high severity, so every isolated signal remains medium. The three project-writer doctored files each have both revisions and fonts and reach high. No corroboration has been added to the four misses.

The Chromium invoice generator states `Invoice date: 2026-10-12` and does not state a payment date. `datesOf` deliberately searches payment-date labels, then reports `the document states no payment date` when none exists. Treating the invoice date as a payment date would invent a comparison. This file remains in its genuine denominator and its date coverage remains unavailable, rather than complete. The other seven existing generated fixtures have complete forensic coverage. The genuine Chromium POP has a medium producer finding, which is not a verdict-level false positive.

## Unchanged measured limits

| Group | Detection | False positives | Complete coverage |
| --- | --- | --- | --- |
| All native PDFs | 3/7 (42.9%) | 0/7 (0.0%) | 13/14 |
| Proof of payment | 1/5 (20.0%) | 0/4 (0.0%) | 9/9 |
| Bank letter | 1/1 (100.0%) | 0/1 (0.0%) | 2/2 |
| Invoice | 1/1 (100.0%) | 0/2 (0.0%) | 2/3 |
| Ghostscript | 0/4 (0.0%) | 0/2 (0.0%) | 6/6 |
| Chromium | 0/0 (not measured) | 0/2 (0.0%) | 1/2 |
| Project PDF writer | 3/3 (100.0%) | 0/3 (0.0%) | 6/6 |

The 95 percent detection target and complete-coverage requirement remain unmet. The 2 percent false-positive target is unchanged; seven genuine synthetic files cannot establish a population false-positive rate. This diagnosis does not establish production accuracy, model contribution, or a new tool-performance comparison. The earlier peepdf/ExifTool comparison in `docs/frontier-log.md` is historical evidence, not rerun here. The advantage of this diagnostic artifact over an unqualified aggregate is that every miss retains its labelled denominator, exact source bytes, actual signal and stated limitation.

No additional independent detector opportunity was established from these intentionally isolated edits. A future detection change needs a supported hypothesis, genuinely independent evidence and a separately designed labelled evaluation; merely raising these medium findings or decorating them with a second name is prohibited. Existing broader fixture work does not itself prove native-PDF detection improvement.

## Regression proof

`test/invoice/forensics-generated.test.ts` pins all eight existing generated-file hashes and asserts exact evidence severities, missing-date reason and coverage. The four Ghostscript misses and all genuine controls remain non-detections. The section checkpoint also runs `test/invoice/pdf-filters.test.ts`. Mutation observations and final gate results are recorded below after execution; no passing result is inferred from source inspection.

Observed counterfactuals on 2026-11-04: changing `groups.size >= 2` to `groups.size >= 1` made five new invariant tests fail (the four isolated Ghostscript edits and genuine Chromium POP). Changing the missing-payment-date branch to `{ status: "ran", reason: null }` made the Chromium invoice invariant fail. Each mutant ran separately with `taskset -c 9 pnpm exec vitest run --project worker test/invoice/forensics-generated.test.ts -t "native PDF diagnostic invariants"`; each exited 1. The original source was restored after each run; its SHA-256 again matched `f2243269bb8763903c9dfcc322645095054391f83c3c890efee23b8fc1c1f71e`, and git reported no production-source diff. Full logs remain in the session scratch files `/tmp/console-pdf-mutation-single-signal.log` and `/tmp/console-pdf-mutation-missing-date.log`; these are local test evidence, not deployment proof.

After restoring both mutants, the exact section checkpoint passed: 97 tests across the generated-fixture and PDF-filter files. Full `pnpm run typecheck`, changed-file Biome, `pnpm run build` (dry-run only), and publication scan passed. Existing AI-binding and asset-route warnings were retained and reported to the coordinator; no binding or route configuration changed. These results prove diagnostic invariants and local buildability, not target attainment, CI success or deployment.
