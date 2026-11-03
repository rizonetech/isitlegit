## Completion review: astra (`gpt-6-astra` via `codex`)

- Writer: muse
- Run: 2026-11-03T00:46:06Z
- Candidate: 9850c411d763d6961ea50867a486c60ea8197eab
- Effort: medium
- Pin: ce29c18a398871b473c634630dbf588c04ec5ef2
- Lines: 30
- Digest: 98f2e52c69ed0690

The candidate has **in-scope gaps**, including a query that misses the intended lookalikes and responses that silently conceal incomplete coverage.

Reviewed `d854ca42cb5e8428357e435efa0cb5cc29c04504` through Git objects, including section 7’s Corrected line. References below are candidate-relative. No files changed; tests were inspected, not run. This is source evidence, not deployment proof.

**Part 1: completeness**

| Required piece | Assessment and evidence |
| --- | --- |
| Source and terms | **Source present; terms evidence missing-in-scope.** `src/monitor/ct.ts:75` selects crt.sh. `NOTICE.md:16` claims its terms permit use but links only the homepage, with no identifiable permission text. The [homepage](https://crt.sh/) does not substantiate that assertion. This is missing evidence, not a finding that use is prohibited. |
| Token derivation | **Present.** `src/monitor/ct.ts:15` derives lowercase tokens from verified domains’ first labels and display-name words, removes stopwords, requires four characters, deduplicates and caps at eight. `src/monitor/run.ts:308` skips queries when none remain. |
| Matching query | **Missing-in-scope: correct substring search.** `src/monitor/ct.ts:75` queries `%.fynbos.%`, requiring literal dots around the token under crt.sh’s [ILIKE matching](https://github.com/crtsh/certwatch_db/blob/master/fnc/web_apis.fnc). It misses `fynbos-pay.example`, the feature’s own test example, and `fynbos.example`. The stub at `test/monitor/ct.test.ts:27` returns that name without checking whether the requested pattern could retrieve it. |
| Query bounds | **Present, with incomplete-result handling missing-in-scope.** `src/monitor/ct.ts:6`, `:26` and `:73` implement ten seconds per request, streamed 1 MiB, eight sequential requests and processing of 5,000 records. However, `:56` silently slices larger arrays without reporting truncation. |
| Failure semantics | **Partly present; missing-in-scope for malformed responses.** HTTP errors, exceptions and oversized bodies become failed tokens at `src/monitor/ct.ts:79`. The run records CT errors and becomes partial at `src/monitor/run.ts:309`, `:457`, with persistence at `:160`. But HTTP 200 containing `{ "error": "unavailable" }` becomes a successful empty result through `ct.ts:54`; malformed records are silently skipped at `:57`. These are indistinguishable from genuine zero matches. |
| Merge and cap policy | **Present.** `src/monitor/run.ts:314` excludes owned domains and subdomains, deduplicates CT, known and generated names, prioritises CT and applies the shared 300 cap. Production CT names are lowercased and validated at `src/monitor/ct.ts:59`. |
| Persistence of discoveries | **Partly present; continued coverage missing-in-scope under saturation.** `src/monitor/run.ts:343` stores successful positive or negative DNS observations; `:316` reintroduces known token-matching hosts. But 300 current CT names precede every retained host at `:317`, so a previously discovered host absent from today’s response can stop receiving DNS checks indefinitely. Overflow is neither retained as a pending discovery nor counted as deferred. This defeats the Corrected line’s continued-monitoring promise. |
| Production wiring | **Present in source.** `src/monitor/workflow.ts:129` supplies the adapter, `:299` invokes the production monitor, `src/index.ts:227` dispatches it, and `wrangler.jsonc:109` schedules it daily. Eligibility precedes CT at `src/monitor/run.ts:284`. Live deployment verification is **missing-out-of-scope** for this candidate review. |
| Tests | **Present but incomplete-in-scope.** `test/monitor/ct.test.ts:12`, `:26` and `:38` cover basic tokens, parsing, HTTP failure, owned-name exclusion and retained discovery. Missing assertions cover actual query semantics, timeout, byte/record overflow, malformed-success responses, eight-token enforcement, saturation, CT suppression for ineligible organisations, and stored run-status readback. The “later day” test at `:75` changes the run ID without advancing the clock. |

**Part 2: excellence**

My strongest architectural alternative for this purpose is **continuous CT-log ingestion with durable replay and local brand matching**, implemented with a CertStream-compatible collector and a durable queue. For example, the [Certstream documentation](https://certstream.dev/docs.html) describes certificate timestamps, source indices, log-health reporting and JetStream consumers that resume after disconnection. A bare WebSocket alone does not provide that durability.

The candidate falls short in these ways:

- **In-scope:** Incorrect query matching, silent malformed/truncated responses and starvation of retained discoveries prevent reliable delivery of the bounded daily-search feature. A streaming replacement is unnecessary to fix these.
- **Out-of-scope:** Daily polling cannot promise discovery before a fake site is used. A certificate issued just after the run can wait nearly a day, plus indexing delay. Continuous ingestion reduces that window; neither approach guarantees advance warning.
- **Out-of-scope:** There is no certificate-level checkpoint, replay or provenance. `src/monitor/ct.ts:57` extracts only names; the stored first observation is DNS time, not certificate issuance or log-observation time.
- **Out-of-scope:** Literal tokens cannot discover lookalikes that contain none of those tokens. Confusable and typo matching over an incoming certificate stream would broaden discovery beyond this section’s substring-search scope.

COMPLETION: gaps

- Implemented: substring query semantics with a query-sensitive test in a80f0375
- Implemented: non-array, truncated and malformed answers state the token failed in a80f0375 and d7922e0e
- Implemented: retained discoveries inside the shared cap with daily full-cap rotation in a80f0375, d7922e0e and 9850c411
- Implemented: CT discoveries persist before any DNS lookup in a80f0375
- Implemented: NOTICE.md and the section record crt.sh's published position and the operator's standing choice in a80f0375 and d7922e0e
- Implemented: saturated multi-day coverage regression test in the stamp candidate
