## Completion review: astra (`gpt-6-astra` via `codex`)

- Writer: muse
- Run: 2026-11-03T00:19:37Z
- Candidate: d854ca42cb5e8428357e435efa0cb5cc29c04504
- Effort: medium
- Pin: ce29c18a398871b473c634630dbf588c04ec5ef2
- Lines: 37
- Digest: cff1563c3c3119c9

**Needs attention.** Reviewed candidate `d854ca42cb5e8428357e435efa0cb5cc29c04504` against section 7 and its Corrected line. No files changed. Read-only probes confirmed malformed-response and truncation failures; the full Vitest checkpoint was not run.

**Part 1: completeness**

| Required piece | Assessment and evidence |
| --- | --- |
| Source and terms | **Present:** crt.sh adapter at [ct.ts:75](../../../src/monitor/ct.ts#L75). **Missing-in-scope:** substantiated usage terms. [NOTICE.md:16](../../../NOTICE.md#L16) asserts permission but links only to the homepage. The retrieved [crt.sh homepage](https://crt.sh/) does not establish the claimed terms. This is an evidence gap, not a finding that use is prohibited. |
| Token derivation | **Present:** verified-domain first labels and display-name words, normalization, minimum length, stopwords, deduplication and eight-token cap at [ct.ts:15](../../../src/monitor/ct.ts#L15). Empty tokens skip CT at [run.ts:308](../../../src/monitor/run.ts#L308). **Missing-in-scope:** correct substring query semantics, finding 1 below. |
| Query bounds and parsing | **Present:** eight sequential requests, 10-second timeout, streamed 1 MiB limit, hostname validation and wildcard/multiline handling at [ct.ts:6](../../../src/monitor/ct.ts#L6), [ct.ts:26](../../../src/monitor/ct.ts#L26) and [ct.ts:53](../../../src/monitor/ct.ts#L53). **Missing-in-scope:** explicit incomplete status for excess records and invalid response shapes, finding 2. |
| Failure semantics | **Present:** HTTP, timeout, JSON syntax and byte-limit failures name the token; successful tokens survive at [ct.ts:70](../../../src/monitor/ct.ts#L70). Run errors persist at [run.ts:160](../../../src/monitor/run.ts#L160), and CT failures make the run partial at [run.ts:453](../../../src/monitor/run.ts#L453). **Missing-in-scope:** malformed JSON shapes and record truncation currently appear successful. |
| Merge and cap policy | **Present:** CT first, known matching hosts next, generated candidates last; deduplication, owned-domain/subdomain exclusion and shared 300 cap at [run.ts:314](../../../src/monitor/run.ts#L314). **Missing-in-scope:** retained-host continuity under saturation, finding 3. |
| Persistence of discoveries | **Present:** successful DNS observations, including nonresolving names, upsert `monitor_hosts` before capture at [run.ts:330](../../../src/monitor/run.ts#L330); known token-matching hosts rejoin at line 316. **Missing-in-scope:** discoveries survive neither initial DNS failure nor displacement by the cap, findings 3 and 4. |
| Production wiring | **Present in source:** daily cron at [wrangler.jsonc:109](../../../wrangler.jsonc#L109), dispatch at [index.ts:228](../../../src/index.ts#L228), production adapter at [workflow.ts:129](../../../src/monitor/workflow.ts#L129), eligibility before CT/DNS at [run.ts:284](../../../src/monitor/run.ts#L284). **Missing-out-of-scope:** deployment and live discovery proof; this review establishes source wiring only. |
| Tests | **Present:** three tests cover basic tokens/names, one HTTP failure, CT-only DNS resolution, ownership exclusion and repeat-run retention at [ct.test.ts:11](../../../test/monitor/ct.test.ts#L11). **Missing-in-scope:** exact query assertions, timeout/byte/record boundaries, malformed shapes, saturated-cap retention, DNS-failure recovery, ineligible/no-token no-request assertions, and stored observation/error readback. The “later day” test actually repeats the same current day with another run ID at [ct.test.ts:63](../../../test/monitor/ct.test.ts#L63). |

The concrete defects are:

1. **P2, in-scope: the query misses the intended lookalikes.** [ct.ts:75](../../../src/monitor/ct.ts#L75) sends `%.fynbos.%`, requiring dots around the token. A certificate naming `fynbos-pay.example` or `fynbosfreight.example` does not match, although both contain the brand token. The test returns `fynbos-pay.example` regardless of the requested query. crt.sh’s [query implementation](https://github.com/crtsh/certwatch_db/blob/master/fnc/web_apis.fnc) uses LIKE/ILIKE matching; the owning adapter needs substring semantics and a query-sensitive regression test.

2. **P2, in-scope: incomplete or invalid responses become successful searches.** [ct.ts:54](../../../src/monitor/ct.ts#L54) treats a non-array response as no names; line 56 silently slices records. Direct probes returned `{names:[], failed:[]}` for `{"error":"upstream unavailable"}` and 5,000 names with no failure for 5,001 records. Expected: explicit partial/unavailable status, preserving usable results where appropriate.

3. **P2, in-scope: current results can permanently crowd out retained discoveries.** At [run.ts:317](../../../src/monitor/run.ts#L317), 300 current CT names exclude every distinct previously discovered host before DNS. Repeated responses repeat that exclusion indefinitely. The corrected continuity promise needs bounded scheduling or an explicitly revised retention contract, with dropped/deferred coverage surfaced.

4. **P2, in-scope: initial DNS failure loses a discovery.** At [run.ts:331](../../../src/monitor/run.ts#L331), a failed lookup skips persistence. If CT discovers a host today, DNS fails, and tomorrow’s CT response is empty or unavailable, that host has no retained row and is never retried. Persist discovery independently of DNS success.

**Part 2: excellence**

My strongest architectural alternative is **continuous CT-log ingestion with durable checkpoints, replay/backfill and brand matching**, using a real-time feed such as [CertStream](https://certstream.calidog.io/) as an ingestion component. CertStream documents real-time certificate updates; durable recovery would remain an explicit system responsibility.

- **In-scope:** reliable substring discovery, honest incomplete-result reporting and durable discoveries. Findings 1 to 4 prevent this bounded daily implementation from meeting its own promise.
- **Out-of-scope:** near-real-time detection. Daily polling introduces up to roughly one scheduling interval before discovery, plus source indexing delay. “Before the fake site is used” is an opportunity, not a guarantee.
- **Out-of-scope:** checkpointed incremental ingestion and backfill. This implementation re-queries history without certificate timestamps or cursors, so growing responses can repeatedly exceed its bounds.
- **Out-of-scope:** broader Unicode/confusable matching and measured discovery recall. Exact ASCII tokens provide narrower coverage than a dedicated brand-monitoring pipeline.
- **In-scope:** evidence for the selected source’s usage conditions and tests proving the corrected contract. Neither requires replacing crt.sh or expanding the subsystem.

COMPLETION: gaps
OVERALL: needs-attention

- Implemented: substring query semantics with a query-sensitive test in (round after d854ca42)
- Implemented: non-array and truncated answers state the token failed in (round after d854ca42)
- Implemented: retained discoveries take priority inside the shared cap in (round after d854ca42)
- Implemented: CT discoveries persist before any DNS lookup in (round after d854ca42)
- Implemented: NOTICE.md states crt.sh's published position honestly in (round after d854ca42)


