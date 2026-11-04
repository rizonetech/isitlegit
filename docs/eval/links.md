# Link extraction measurement

Measured 2026-11-04 on clean source commit `00a1ffbbcfb216d4339475d405937b7050b09882` (`sourceDirty: false`) using `taskset -c 2,3 node eval/links.ts`. This is a ten-input synthetic component measurement, not verdict accuracy or a production performance claim. Raw per-case observations, expected-link counts, missed links, unread reasons and repeated timings are in [links-observations.json](links-observations.json).

The actual production extractor found **60 of 67 expected distinct URLs (89.5522% recall)** and **0 false links among 60 observed URLs (0%)**. All 10 inputs remain in the case denominator: six complete, three partial and one unread. All coverage expectations matched. Undefined rates are null; the damaged PDF's unknown destination is not invented as an expected URL, so its zero-link denominator does not establish recall for unread content.

| Input | Coverage | Matched/expected URLs | False links | p50 ms | p95 ms |
| --- | --- | --- | --- | --- | --- |
| `message.txt` | complete | 2/2 | 0 | 1 | 12 |
| `negative.txt` | complete | 0/0 | 0 | 0 | 1 |
| `boundary.txt` | complete | 1/1 | 0 | 1 | 1 |
| `message.html` | complete | 3/3 | 0 | 1 | 4 |
| `logo.svg` | complete | 1/1 | 0 | 0 | 1 |
| `invoice.pdf` | complete | 1/1 | 0 | 0 | 2 |
| `damaged.pdf` | unread | 0/0 | 0 | 0 | 0 |
| `many.txt` | partial | 50/55 | 0 | 0 | 1 |
| `large.html` | partial | 1/2 | 0 | 44 | 64 |
| `large.pdf` | partial | 1/2 | 0 | 322 | 347 |

The seven missed URLs are retained findings: five after the 50-link cap in `many.txt`, one after the 5 MiB HTML read cap in `large.html`, and one after the 10 MiB PDF read cap in `large.pdf`. No expected link was removed or changed to match the extractor. The HTML case also records parser-damaged coverage while preserving its earlier link. These safety caps remain unchanged. There is no claim about the unknowable destination of the deliberately dangling PDF URI reference.

## Method and limits

The corpus lives at `eval/components/links/`, with project-owned synthetic provenance in NOTICE.md and LICENSE.txt. `labels.json` uses the unchanged strict D08 schema; the section-owned strict manifest binds each loaded label path exactly once to its SHA-256, media type, expected normalized distinct links and coverage. `loadSets("eval/components")` reads all 10; default verdict discovery under `eval/sets` excludes them. This path corrects the original approved `eval/sets/links` location under coordinator LINK-QUALITY-DECISION-01 while preserving every corpus byte, expectation and original plan/report. Neither the shared loader/schema nor the mail-only dataset tests changed.

The Node entrypoint launches an isolated local workerd test through pinned `@cloudflare/vitest-plugin` 1.4.8. Node is v24.18.0; CPU affinity is 2,3. Each input is decoded and SHA-256 checked inside workerd, then extracted five times using `linksOf` and production `htmlAttachmentsOf`. Plain text enters the production truncated-body streaming path, HTML/SVG enter the attachment path, and PDF enters the PDF attachment path. R2 is an exact-byte stub with fresh streams, full object size and requested byte ranges. No browser navigation, external URL, model, provider or paid operation occurs.

Timings use Worker `performance.now()` and include extraction plus HTML/SVG preparation. Payload decode/hash and process startup are outside those timings. Full harness wall time was 7364.358 ms, including setup, transport and teardown. Workerd's clock quantizes short synchronous work, so zero milliseconds means below observed resolution, not free execution. Nearest-rank p50/p95 use five samples; p95 is therefore the largest observation. These are small local samples on a shared WSL machine, not stable latency percentiles or an SLA. The corpus tests selected structures and bounds; ten synthetic inputs do not estimate real-mail prevalence, language coverage or general-world extraction quality.

The Node boundary requires successful harness exit and one result payload; it rejects missing/duplicate cases, wrong identities or hashes, malformed/duplicate URLs, invalid timing counts and dishonest complete coverage. Missing or invented links remain findings in a successful measurement instead of being deleted from denominators. Every returned repeat must produce identical extraction results.

## Owning-layer repair and verification

The initial oversized HTML run failed with `TypeError: Parser error: The memory limit has been exceeded.` A failing-first Worker regression reproduced this at the real HTMLRewriter boundary. `src/checks/html-attachment.ts` now handles only that exact parser resource rejection at the parsing operations, retains already observed positive features and links, marks the existing damaged/unread coverage, and continues to the next attachment. Direct `analyseHtml` callers still receive parser errors. Storage failures and unrelated exceptions are not caught as document damage. No unread type, cap or severity floor changed. The incomplete-read note now describes partial work accurately; its regression failed on the former wording before the correction.

Verification: 89 targeted Worker tests passed across existing link/HTML-attachment checks and the new parser regressions; the final wording regression passed separately (2 tests). Thirteen measurement boundary tests plus ten unchanged dataset documentation/mail tests passed. Dedicated `tsc --noEmit -p eval/links.tsconfig.json`, scoped Biome, Worker dry-run build, publication scan and TODO validation passed. The exact clean-source command above completed with all 10 results and all coverage expectations matching. These are local checks, not CI, deployment or a completed section stamp.
