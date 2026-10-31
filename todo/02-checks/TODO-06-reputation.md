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
| 4 | §4 | Reputation weighting rules | §1, §2, §3, D02 T03 §2 | [ ] |

## 1. Web Risk lookup with cache, caps and outage handling

Google Web Risk Lookup API, `uris.search` only (never the Update API, which reprices lookups to US$50 per 1,000; spec 4.3a). Results cached in KV for 24 hours, 6 hours for "not listed"; a per-organisation and a global daily cap keep the free tier; an outage is "not checked".

**Phase:** 3
**Needs:** none
**Surface:** no
**Freeze check:** `pnpm exec vitest run test/checks/webrisk.test.ts` passes unchanged.

**Build order:**

1. Write `src/checks/webrisk.ts`. Done when: stubbed tests cover listed, not listed, cached, capped and outage.

- [ ] Write `webRiskSearch(url)` calling `GET https://webrisk.googleapis.com/v1/uris:search?uri=<url>&threatTypes=MALWARE&threatTypes=SOCIAL_ENGINEERING&threatTypes=UNWANTED_SOFTWARE&key=<WEB_RISK_API_KEY>`, stripping query strings and fragments first (spec 4.3a privacy rule). Done when: `test/checks/webrisk.test.ts` checks the request URL has no query string of the original link.
- [ ] Cache by the stripped URL in `CACHE`: listed for 24 hours, not listed for 6 hours. Done when: a second lookup makes no call.
- [ ] Enforce caps: 500 lookups per organisation and 3,000 globally per day (free tier is 100,000 a month), constants in `src/checks/caps.ts` with the spec reference. Done when: the 501st lookup returns `capped` and logs it.
- [ ] Map timeouts, 429 and 5xx to `not_checked` with the reason, never to not listed. Done when: the outage test passes. Cheaper substitute: treating an error as clean.
- [ ] Log each call (stripped URL hash, result, latency) in `case_events` with step `reputation`. Done when: the test finds the event.
- [ ] Write `test/checks/webrisk-api-guard.test.ts` failing on any `threatLists`, `computeDiff` or `hashes:search` in `src/`, since one such call reprices every lookup to US$50 per 1,000 (cloud.google.com/web-risk/pricing, read 2026-10-27). Done when: it passes now and fails on a planted `threatLists:computeDiff` string.
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

## Verification

- Listings appear with source, date and delisting page; no listing decides a verdict alone; outages say "not checked".
- `pnpm test` passes; `python3 scripts/todo-graph.py validate` and `plan --check` pass.
