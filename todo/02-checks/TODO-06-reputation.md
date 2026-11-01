---
schema_version: 1
id: reputation
domain: 02-checks
status: active
title: "TODO-06 -- Reputation Signals and Weighting Rules"
frozen: true
track: day-3
---

# TODO-06 -- Reputation Signals and Weighting Rules

> **Goal:** Link and sender domains are checked against Google Web Risk (`uris.search` only), Cloudflare's malware-blocking resolver 1.1.1.2 and a well-known-sites list, with results cached and capped; the weighting rules guarantee a listing never decides a verdict alone, an IP listing never raises severity alone, counter-signals are shown, and every listing names its source, date and delisting page (design spec 4.3a).

> **Current state:** Measured 2026-10-26 20:00 SAST. No reputation code exists. The Web Risk key comes from D99 T01 §6. Spend during the event is US$0 (spec 4.3a).

## Inputs

- Design spec 4.3a (providers, rules, cache and budget, false-positive feedback); `sources/threat-intel/2026-10-26-reputation-apis.md` (local research).
- Google Web Risk `uris.search` reference (`https://cloud.google.com/web-risk/docs/reference/rest/v1/uris/search`); Cloudflare 1.1.1.2 families docs; RFC 8484 (DNS over HTTPS).
- -> XREF: D07 T03 §6 -- the "this was wrong" feedback that records which provider a disputed verdict leaned on
- -> XREF: D08 T02 §2 -- the eval metrics that report each provider's false-positive rate on our data

## Outcome

- A URL listed by Web Risk with no other evidence yields a medium "listed by Google Web Risk" item and the verdict stays at suspicious at most; the same URL plus a lookalike domain and a credential form yields high.
- A Web Risk outage yields "not checked", never "not listed".

**Adjacency:** list=not-applicable (listings appear per case); document=not-applicable (produces no document a user carries or files); settings=applicable @ D02 T06 §1; reporting=applicable @ D08 T02 §2; notifications=not-applicable (sends no notices of its own); permissions=not-applicable (no user action to permit or refuse); audit=applicable @ D02 T06 §1; exchange=applicable @ D02 T06 §3; reverse=not-applicable (pure checks)

**Adjacency rationale:** Caps and cache lifetimes are settings in code with the decision reference (§1); each provider call is logged (audit); the eval reports each provider's false-positive rate on our data (D08 T02 §2); the top-sites list is imported from an external file (§3).

## Implementation Order

| Order | Section | Deliverable | Depends On | Status |
| ----- | ------- | ----------- | ---------- | ------ |
| 1 | §1 | Web Risk lookup with cache, caps and outage handling | D02 T01 §2 | [ ] |
| 2 | §2 | Cloudflare 1.1.1.2 block check over DNS-over-HTTPS | D02 T01 §2 | [ ] |
| 3 | §3 | Well-known sites list loaded into KV | D02 T01 §2 | [ ] |
| 4 | §5 | Link and domain reputation read in the checks step | §1, §2, §3, D02 T07 §1 | [ ] |
| 5 | §4 | Reputation weighting rules | §1, §2, §3, §5, D02 T03 §2 | [ ] |

## 1. Web Risk lookup with cache, caps and outage handling

> **Started:** 2026-11-01T02:06Z

Google Web Risk Lookup API, `uris.search` only (never the Update API, which reprices lookups to US$50 per 1,000; spec 4.3a). Results cached in KV for 24 hours, 6 hours for "not listed"; a per-organisation and a global daily cap keep the free tier; an outage is "not checked".

**Corrected 2026-11-01** (at start, checked against `src/checks/rdap.ts` (the bounded KV cache and time budgets this follows), `src/pipeline/events.ts`, `src/db/migrations/0001_core.sql`, `docs/specs/2026-10-26-phishing-invoice-analyser-design.md` 4.3a and `scripts/check-webrisk-key.py`): (1) the key travels in the `X-Goog-Api-Key` header, never in the URL's `key=` parameter, so it cannot reach a log, an error or a cache key; the request URL carries only `uri` and the three `threatTypes`; (2) the privacy rule strips more than the query and fragment: user information (`user:pass@`) goes too, and the lookup is for the URL's scheme, host, port and path only; the cache key and the event hold a SHA-256 of that stripped URL, never the URL; (3) the daily caps are counted in D1, not KV, so 500 an organisation and 3,000 a day hold under concurrent cases: a new table `reputation_calls` (migration 0070, the number from the coordinator; `day` UTC date, `scope` `webrisk:<org id>` or `webrisk:*`, `calls`, primary key `day, scope`) with one atomic upsert that refuses past the cap; a call is reserved for the organisation first, then globally, and the organisation's reservation is released when the global cap refuses; a cached answer costs no call; the constants and the spec reference are in `src/checks/caps.ts`; (4) the call is logged with the existing `case_events` columns, no new one: step `reputation`, status `done` for an answered lookup (listed, not listed or capped) and `error` for one that was not checked, `ms` the latency, and `error` the identity `webrisk:<result>:<first 12 hex of the stripped URL's hash>`, a shape `recordEvent` (`src/pipeline/events.ts`) is given beside the budget class it already keeps whole; (5) a lookup has its own time budget (4 seconds, aborted) and KV reads and writes are given up after 500 ms, as the RDAP lookup does, so the checks step's time stays bounded; a rejected key or request (HTTP 400 or 403) is `not_checked` with the reason `rejected`, so a misconfigured key never reads as not listed; (6) this section builds the client only: the checks step asking it for a case's links is D02 T06 §5, filed from the phase audit, and the reputation checks that weigh the answer are §4.

**Corrected 2026-11-01** (plan review, two P1 and two P2): (7) a listed answer is cached until the earlier of 24 hours and the `expireTime` Google returns with it (its `ThreatUri` contract forbids keeping a listing past it), the expiry is stored with the entry and checked again on read, and a not-listed answer is cached 6 hours; spec 4.3a's "24 hours" for a listing is corrected to say so (`docs/specs/2026-10-26-phishing-invoice-analyser-design.md`); (8) the response is validated, never assumed: the body is read to at most 64 KiB, must be a JSON object, and only `{}` (no `threat`) is not listed; a `threat` must hold a non-empty `threatTypes` list of `MALWARE`, `SOCIAL_ENGINEERING` or `UNWANTED_SOFTWARE` and a valid `expireTime`, and is then listed with those types; invalid JSON, any other shape and an interrupted body are `not_checked` with the reason `malformed`, never cached; (9) a failed reservation (the D1 write throws) is `not_checked` and no provider request is made without both reservations confirmed; a failed release is left as it is (the count stays high, never a refund that may not have been owed); and a failed audit write is thrown as a database refusal for the step to retry, after the answer is cached so the retry costs no call; (10) a KV read that stalls or rejects falls back to a provider lookup under the caps, a KV write that stalls or rejects keeps the provider's answer, and each ends within the cache budget.

**Phase:** 3
**Needs:** none
**Surface:** no
**Freeze check:** `pnpm exec vitest run test/checks/webrisk.test.ts` passes unchanged.

**Build order:**

1. Write `src/checks/webrisk.ts`. Done when: stubbed tests cover listed, not listed, cached, capped and outage.

- [x] Write `webRiskSearch(url)` calling `GET https://webrisk.googleapis.com/v1/uris:search?uri=<url>&threatTypes=MALWARE&threatTypes=SOCIAL_ENGINEERING&threatTypes=UNWANTED_SOFTWARE&key=<WEB_RISK_API_KEY>`, stripping query strings and fragments first (spec 4.3a privacy rule). Done when: `test/checks/webrisk.test.ts` checks the request URL has no query string of the original link.
- [x] Cache by the stripped URL's hash in `CACHE`: listed until the earlier of 24 hours and Google's `expireTime` (stored and checked again on read), not listed for 6 hours, a failure or malformed answer never (corrections 7 and 8). Done when: a second lookup makes no call; an entry past its stored expiry is looked up again; a response with `expireTime` in an hour is cached one hour; the six-hour boundary holds on both sides; and invalid JSON, a wrong threat shape, an unknown threat type and an interrupted body each give `not_checked` (`malformed`), are not cached, and the next lookup recovers.
- [x] Enforce caps: 500 lookups per organisation and 3,000 globally per day (free tier is 100,000 a month), constants in `src/checks/caps.ts` with the spec reference, counted in D1 by migration 0070 (`src/db/migrations/0070_reputation_calls.sql`, table `reputation_calls`, correction 3). Done when: the 501st lookup of an organisation returns `capped` and logs it, the 3,001st of the day does for any organisation and gives the organisation's reservation back, two lookups racing for the last place of a cap cannot both take it, a cached answer costs no call, and a new UTC day starts at zero.
- [x] Map timeouts, 429 and 5xx to `not_checked` with the reason, never to not listed. Done when: the outage test passes. Cheaper substitute: treating an error as clean.
- [x] Handle D1 failing (correction 9) against the migrated database: a reservation that throws is `not_checked` and the provider is never called; a release that throws leaves the count where it is; an audit write that throws is thrown as a database refusal after the answer is cached. Done when: `test/checks/webrisk.test.ts` reads the persisted `reputation_calls` counts back after each case, including two lookups racing for the last place of a cap.
- [x] Prove the cache is bounded (correction 10). Done when: the test stalls and rejects KV reads and writes in turn: a read that stalls or rejects reaches the provider under the caps, a write that stalls or rejects keeps the answer, and each ends within the cache budget.
- [x] Log each call in `case_events` with step `reputation` (correction 4): status `done` for an answered lookup and `error` for one not checked, `ms` the latency, `error` the identity `webrisk:<result>:<12 hex of the stripped URL's hash>`, a shape `recordEvent` (`src/pipeline/events.ts`) keeps whole beside the budget class. Done when: the test finds the event for a listed, a not listed, a capped and a not-checked lookup, and an event never holds the URL, its host or the key.
- [x] Send the key in the `X-Goog-Api-Key` header, strip user information as well as the query and fragment, and bound the lookup (4 seconds) and the cache (500 ms) as the RDAP lookup does (corrections 1, 2 and 5). Done when: the test reads no key in any request URL, no `user:pass@` in it, and a lookup that stalls ends not checked in bounded time.
- [x] Write `test/checks/webrisk-api-guard.test.ts` failing on any `threatLists`, `computeDiff` or `hashes:search` in `src/`, since one such call reprices every lookup to US$50 per 1,000 (cloud.google.com/web-risk/pricing, read 2026-10-27). Done when: it passes now and fails on a planted `threatLists:computeDiff` string.
- [ ] Commit: `checks: Web Risk lookup with cache, caps and outage handling`

**Test checkpoint:** `pnpm exec vitest run test/checks/webrisk.test.ts` passes and fails if an outage returns "not listed".

## 2. Cloudflare 1.1.1.2 block check over DNS-over-HTTPS

A second, independent opinion: Cloudflare's malware-blocking resolver answers `0.0.0.0` for blocked domains (spec 4.3a). Queried over DNS-over-HTTPS (RFC 8484) at `https://security.cloudflare-dns.com/dns-query`.

**Phase:** 3
**Needs:** none
**Surface:** no
**Freeze check:** `pnpm exec vitest run test/checks/cf-block.test.ts` passes unchanged.

**Build order:**

1. Write `cloudflareBlocked(domain)`. Done when: stubbed answers for blocked, resolved and failed give blocked, clear and not checked.

- [ ] Query `https://security.cloudflare-dns.com/dns-query?name=<domain>&type=A` with `accept: application/dns-json` and read an answer of `0.0.0.0` as blocked. Done when: `test/checks/cf-block.test.ts` covers the three outcomes.
- [ ] Cache for 24 hours and record the terms caveat (no SLA, confirm terms before launch) in the evidence detail. Done when: the item's detail carries it.
- [ ] Commit: `checks: Cloudflare 1.1.1.2 block check`

**Test checkpoint:** `pnpm exec vitest run test/checks/cf-block.test.ts` passes.

## 3. Well-known sites list loaded into KV

A counter-signal against false positives on big legitimate sites (spec 4.3a): Tranco if its licence allows commercial use, else Majestic Million (CC BY 3.0, credited). The licence decision is made from the provider's own page and recorded before any data is loaded.

**Phase:** 3
**Needs:** none
**Surface:** no
**Freeze check:** `pnpm exec vitest run test/checks/top-sites.test.ts` passes unchanged.

**Build order:**

1. Decide the list from its licence. Done when: `NOTICE.md` names the chosen list, its licence and its source URL.
2. Load the top 100,000 registrable domains into KV. Done when: `isWellKnown("microsoft.com")` is true and a random new domain is false.

- [ ] Read the licence on the Tranco site and the Majestic Million page, choose the one whose terms allow our commercial use, and add the `NOTICE.md` row (with attribution text if CC BY). Done when: the row names the list and licence with the URL. Cheaper substitute: picking a list without reading its licence.
- [ ] Write `scripts/load-top-sites.ts` downloading the list, keeping the top 100,000 registrable domains, and writing KV shards `top:<first two letters>` with the list date. Done when: a local run writes the shards.
- [ ] Write `isWellKnown(domain)` reading the shard. Done when: `test/checks/top-sites.test.ts` passes with a fixture shard.
- [ ] Commit: `checks: well-known sites list in KV`

**Test checkpoint:** `pnpm exec vitest run test/checks/top-sites.test.ts` passes.

## 4. Reputation weighting rules

The rules matter more than the providers (spec 4.3a): granularity sets the weight (exact URL strong, domain medium, IP weak and never raising severity alone); a listing alone caps the verdict at suspicious; counter-signals (verified in the trust network, well-known, years of history, DMARC aligned) are shown beside it; every listing names provider, what was listed, when, and the delisting page.

**Phase:** 3
**Needs:** none
**Surface:** no
**Freeze check:** `pnpm exec vitest run test/checks/reputation-rules.test.ts` passes unchanged.

**Build order:**

1. Register `reputation.listing` and `reputation.counter_signal` with the weighting function. Done when: the rule fixtures pass.

- [ ] Write `weighListing({ provider, granularity, corroborated })` returning high only when corroborated by our own evidence (lookalike, credential form, authentication failure, bank change), else medium for URL and domain listings and low for IP listings. Done when: `test/checks/reputation-rules.test.ts` covers each combination.
- [ ] Register `reputation.listing` with `detail.provider`, `detail.listed` (URL, domain or IP), `detail.listed_at` when known, and `detail.delist_url` (Web Risk: `https://safebrowsing.google.com/safebrowsing/report_error/`; Cloudflare: `https://radar.cloudflare.com/domains/feedback`). Done when: each item carries the four fields.
- [ ] Register `reputation.counter_signal` (info) for a well-known site, a domain over 3 years old, a DMARC-aligned pass or a verified trust-network domain. Done when: a listed but well-known domain shows both items.
- [ ] Mark a listing-only case with `detail.cap = "suspicious"` for the deterministic floor (D04 T01 §1) to honour. Done when: the test asserts the flag.
- [ ] Name each provider by a stable id in `detail.provider` on every `reputation.listing` and `reputation.counter_signal` item, from one exported list, `REPUTATION_PROVIDERS` in `src/checks/reputation.ts`: `google-web-risk` (§1), `cloudflare-security-dns` (§2), `tranco` or `majestic-million` (§3, whichever the licence decision keeps), and for counter-signals that rest on our own checks `domain-age`, `dmarc-aligned` and `trust-network`; an id once shipped is never renamed (a retired provider keeps its id), since D07 T03 §6's "This was wrong" feedback stores the ids a disputed verdict leaned on for D08 T02 §2's per-provider false-positive rates. Done when: `test/checks/reputation.test.ts` asserts every item's `detail.provider` is in the list and the list's ids are the ones above. Source: the app lane's contract question via the coordinator, 2026-10-31.
- [ ] Commit: `checks: reputation weighting rules`

**Test checkpoint:** `pnpm exec vitest run test/checks/reputation-rules.test.ts` passes and fails if an uncorroborated listing is high.

## 5. Link and domain reputation read in the checks step

Filed 2026-11-01 from the phase audit (checks lane, run e78fd72088d9): §1 and §2 write the lookups and §4 registers the checks that weigh their answers, but no section has the checks step ask them. A check never reaches the network (`src/pipeline/analysis-workflow.ts`, `checks`: the header domains' ages are looked up there, `domainAgesOf`, and handed to the checks on the view), so without this section §4's checks read nothing.

**Phase:** 3
**Needs:** none
**Surface:** no
**Freeze check:** `pnpm exec vitest run test/pipeline/reputation-step.test.ts` passes unchanged.

**Build order:**

1. Look up each link and its domain in the checks step and hand the answers to the checks. Done when: a case whose link Web Risk lists, and whose domain Cloudflare's resolver blocks, carries both answers on its view, and an outage reads as not checked.

- [ ] Add `reputation` to `CaseView` (`src/checks/case-view.ts`): per stripped URL its Web Risk answer (`webRiskSearch`, §1: listed, not listed, capped or not checked with its reason), per registrable domain its Cloudflare answer (`cloudflareBlocked`, §2) and whether it is a well-known site (§3), each bounded (the case's first `MAX_LINKS` links, `src/checks/links.ts`, the rest counted as not looked up), null when the case has no links. Done when: `test/pipeline/reputation-step.test.ts` reads the view's `reputation` for a case with a listed link, a blocked domain and a well-known one, from stubbed providers.
- [ ] Fill it in the checks step (`checks`, `src/pipeline/analysis-workflow.ts`) from `view.links`, as `domainAges` is filled, the lookups run together under one time budget so the step stays within its own, a provider that fails or times out read as not checked with its reason, never as not listed. Done when: the test reads an outage as not checked, and a replay of the step makes no second provider call (the cache, §1).
- [ ] Commit: `checks: link and domain reputation read in the checks step`

**Test checkpoint:** `pnpm exec vitest run test/pipeline/reputation-step.test.ts` passes and fails if an outage reads as not listed.

## Verification

- Listings appear with source, date and delisting page; no listing decides a verdict alone; outages say "not checked".
- `pnpm test` passes; `python3 scripts/todo-graph.py validate` and `plan --check` pass.
