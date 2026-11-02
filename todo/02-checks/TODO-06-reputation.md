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
| 1 | §1 | Web Risk lookup with cache, caps and outage handling | D02 T01 §2 | [x] |
| 2 | §2 | Cloudflare 1.1.1.2 block check over DNS-over-HTTPS | D02 T01 §2 | [x] |
| 3 | §3 | Well-known sites list loaded into KV | D02 T01 §2 | [x] |
| 4 | §5 | Link and domain reputation read in the checks step | §1, §2, §3, D02 T07 §1 | [x] |
| 5 | §4 | Reputation weighting rules | §1, §2, §3, §5, D02 T03 §2 | [x] |
| 6 | §6 | Well-known sites list loaded into | §3 | [ ] |
| 7 | §7 | Well-known list provenance kept for reports | §3, §4 | [ ] |
| 8 | §8 | Well-known list kept fresh, staleness stated | §6 | [ ] |
| 9 | §9 | One reputation result stored per provider | §5 | [ ] |

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
- [x] Commit: `checks: Web Risk lookup with cache, caps and outage handling`

**Test checkpoint:** `pnpm exec vitest run test/checks/webrisk.test.ts` passes and fails if an outage returns "not listed".

> **Verified:** 2026-11-01 | §1 | ccfc26c0d441782c28b10f8e88f0b5ad615a24ce
> **Review:** `docs/reviews/d02-t06-s1.json`

## 2. Cloudflare 1.1.1.2 block check over DNS-over-HTTPS

> **Started:** 2026-11-01T02:30Z

A second, independent opinion: Cloudflare's malware-blocking resolver answers `0.0.0.0` for blocked domains (spec 4.3a). Queried over DNS-over-HTTPS (RFC 8484) at `https://security.cloudflare-dns.com/dns-query`.

**Corrected 2026-11-01** (at start, from §1's reviews and `src/checks/webrisk.ts`): (1) the plumbing §1 proved (the bounded KV read and write, the SHA-256 hash, the response body read to a size limit, the deadline raced against the fetch, an unused body cancelled) moves into one module, `src/checks/lookup-io.ts`, which §1 and this section share, so there is one tested copy; (2) only a host name leaves the Worker, and only a valid one: letters, digits and hyphens in labels, at least two labels, at most 253 characters, lower-cased, in its ASCII (punycode) form; an IP literal, a single label or anything else is `not_checked` (`invalid_name`); (3) the answer is validated as DNS JSON, never assumed: an object with an integer `Status`; `Answer`, when present, a list of objects with an integer `type` and a string `data`; the domain is `blocked` when `Status` is 0 and an A record (type 1) answers `0.0.0.0`, `clear` when `Status` is 0 without one (including no answer) or 3 (the name does not exist), and any other `Status` (2, 5 and the rest) or any other shape is `not_checked` (`unavailable` or `malformed`); an answer is never read as clear because it could not be read; (4) a lookup has its own 4-second deadline and size limit as §1's, the request is `redirect: error`, an error answer's body is cancelled, KV reads and writes are given up after 500 ms, and a failure is never cached; (5) the terms caveat (Cloudflare publishes no uptime commitment for 1.1.1.2 and its terms are to be confirmed before launch) is a constant, `CLOUDFLARE_TERMS_CAVEAT`, that the result carries on `blocked` and `clear`, so §4's `reputation.listing` item, which is where evidence is made, has it in its `detail`; the client makes no evidence item; (6) no daily cap: the resolver publishes no quota for this endpoint and a lookup is one small query, bounded in time and size; the number of domains a case asks about is §5's; (7) each lookup is logged in `case_events` as §1's are (step `reputation`), with the identity `cloudflare:<result>:<12 hex of the name's hash>`, a shape `recordEvent` keeps whole beside `webrisk:`; a failed audit write is thrown after the answer is cached; (8) the cache is by the name's hash, each entry stored with its expiry and checked again on read: `blocked` for 24 hours and `clear` for six, as spec 4.3a keeps a negative answer (plan review P1: a domain blocked after a clear lookup must not read clear for a day); the expiry is the writer's, proved by reading the stored entry back, and the boundary tested on both sides for both states; (9) the body is read through the shared size limit and the same deadline as the request (plan review P2): an oversized body and a body that stalls after a 200 are each `not_checked` (`malformed` and `timeout`), their reads cancelled, nothing cached, and the next lookup recovers.

**Phase:** 3
**Needs:** none
**Surface:** no
**Freeze check:** `pnpm exec vitest run test/checks/cf-block.test.ts` passes unchanged.

**Build order:**

1. Write `cloudflareBlocked(domain)`. Done when: stubbed answers for blocked, resolved and failed give blocked, clear and not checked.

- [x] Move §1's shared plumbing into `src/checks/lookup-io.ts` (correction 1). Done when: §1's tests pass unchanged and `webrisk.ts` imports it.
- [x] Write `cloudflareBlocked(name, deps)` in `src/checks/cf-block.ts`: query `https://security.cloudflare-dns.com/dns-query?name=<name>&type=A` with `accept: application/dns-json`, and read the answer as corrections 2 and 3 say. Done when: `test/checks/cf-block.test.ts` covers blocked (`0.0.0.0`, also behind a CNAME), clear (an address, no answer, NXDOMAIN), and not checked for SERVFAIL, REFUSED, a 429, a 5xx, a rejected request, a timeout, a body that is invalid JSON, a wrong shape or cut off, and an invalid name; none of the failures is cached and the next lookup recovers.
- [x] Cache and bound it (corrections 4, 8 and 9). Done when: a second lookup makes no call; `blocked` is kept 24 hours and `clear` six, each tested one second inside and one second past its lifetime, and the stored entry's expiry read back from KV; an entry past its expiry is looked up again; stalled and rejected KV reads and writes are each given up within the cache budget with the answer kept; and a 200 whose body is oversized, and one that stalls, are each not checked, cancelled, uncached and recovered from on the next lookup.
- [x] Carry the terms caveat and log each lookup (corrections 5 and 7). Done when: `blocked` and `clear` carry `CLOUDFLARE_TERMS_CAVEAT`, the test finds one `case_events` row a lookup with the `cloudflare:` identity and never the name or its host, and a failed audit write is thrown after the answer is cached.
- [x] Commit: `checks: Cloudflare 1.1.1.2 block check`

**Test checkpoint:** `pnpm exec vitest run test/checks/cf-block.test.ts` passes.

> **Verified:** 2026-11-01 | §2 | 68352b1d938014f6748cc5ae8785e46cb73fab9a
> **Review:** `docs/reviews/d02-t06-s2.json`

## 3. Well-known sites list loaded into KV

> **Started:** 2026-11-01T03:01Z

A counter-signal against false positives on big legitimate sites (spec 4.3a): Tranco if its licence allows commercial use, else Majestic Million (CC BY 3.0, credited). The licence decision is made from the provider's own page and recorded before any data is loaded.

**Corrected 2026-11-01** (at start, from the providers' own pages read on 2026-11-01, `scripts/load-brands.ts` and `src/checks/lookup-io.ts`): (1) the licence decision: Tranco's page (tranco-list.eu) says its default list is built from five providers, one of them Cloudflare Radar "available under a CC BY-NC 4.0 license" and another the Chrome UX Report under CC BY-SA 4.0, so its default list is not safe for a commercial service; Majestic's page (majestic.com/reports/majestic-million) says "Licensed under a Creative Commons Attribution 3.0 Unported License", which allows commercial use with attribution. **Majestic Million is the list**; the `NOTICE.md` row names it, its licence, its source (`https://downloads.majestic.com/majestic_million.csv`, page `https://majestic.com/reports/majestic-million`) and the attribution text, and a counter-signal item that reports it (§4) carries the credit in its `detail.source`; (2) the list is rank-ordered registrable domains (`Domain` is already registrable, e.g. `bbc.co.uk`); the loader keeps the first 100,000 valid, lower-cased, de-duplicated names and refuses a download with fewer than 90,000 valid rows, a wrong header, or more than 120 MB, so a truncated or substituted file never replaces the list; the download goes into its own empty temporary directory and is read line by line, never run or imported; (3) KV holds `top:<first two characters of the domain>` shards (`{ "domains": [sorted names] }`) and one `top:meta` key (`{ source, date, count, shards }`, the date the file was downloaded); a load writes the shards in bulk, reads back the meta and every shard's size, and deletes shards of an earlier list that the new one does not have; (4) `isWellKnown(domain, deps)` (`src/checks/top-sites.ts`) reduces any host to its registrable domain with the public suffix list (`registrable`, `src/checks/brand-schema.ts`), reads that shard under the cache budget, and answers `known`, `unknown` (not in the list: no counter-signal, never a mark against the domain), `not_loaded` (no `top:meta`) or `not_checked` (KV failed or stalled), never a guess; (5) the load is a local run here (Wrangler's local storage), as the section asks; loading production KV is §6 (correction 12); (6) the tests: `test/checks/top-sites.test.ts` (Worker, fixture shards in KV) and `test/node/load-top-sites.test.ts` (parsing, sharding, refusals and the Wrangler calls, with a fixture file and a fake Wrangler).

**Corrected 2026-11-01** (plan review, one P1, five P2, one P3; corrections 3 and 4 above are replaced where these say so): (7) the list is published by generation, never written over (replaces correction 3): a load writes every shard of the new generation under its own keys `top:<generation>:<first two characters>` (`{ "domains": [sorted names] }`), where the generation is the SHA-256 of the dataset (first 12 hex), reads each shard back and compares its whole text, and only then writes `top:meta` (`{ generation, source, date, count, shards: { "<xx>": <domains in it> } }`), which is what makes it live; the meta it replaces is first kept as `top:meta:previous`, so `--restore` makes the previous list live again; the generation before that is deleted only after the new meta reads back, so an interrupted load leaves the live list exactly where it was and a retry works, and a reader that sees the new meta before a shard has reached its location gets `not_checked`, never a negative; (8) read-back compares the exact text of every shard and the meta, not sizes, retries within a bound (60 seconds) for KV's eventual consistency, and exits non-zero when one never matches; (9) the source's `Domain` column is not all registrable (its published ranking holds `support.google.com` and `player.vimeo.com`): every name is reduced to its registrable domain with the same public suffix list and private-domain policy the Worker uses (`registrable`, `src/checks/brand-schema.ts`) before de-duplication and counting, the best rank kept; a name that is itself a public suffix (`github.io`) has no registrable domain and is dropped, so one tenant's rank is never another's; (10) a reader's states (correction 4 extended): `known`, `unknown` (the prefix has no shard in the meta, or the shard does not hold the name), `not_loaded` (no `top:meta`), and `not_checked` for a KV read that fails or stalls, malformed meta, a shard the meta lists that is missing, and a shard whose text is not the format or whose count is not the meta's; the last two are never `unknown`; (11) the loader is bounded and clean: the download has a 120-second deadline and a stall deadline on its body, a temporary-file write failure, an interrupted body and a stalled or failing Wrangler command (30 seconds each) are actionable non-zero failures, the temporary directory is removed on every exit, and each leaves the live list as it was (the new generation is not live until its meta is written); (12) production: loading the production namespace and proving the list there is filed as §6, the coordinator's, and §4's well-known counter-signal is not enabled until §6 reads back; a local load alone leaves production at `not_loaded`; (13) the Test checkpoint runs the loader's suite too.

**Phase:** 3
**Needs:** none
**Surface:** no
**Freeze check:** `pnpm exec vitest run test/checks/top-sites.test.ts` passes unchanged.

**Build order:**

1. Decide the list from its licence. Done when: `NOTICE.md` names the chosen list, its licence and its source URL.
2. Load the top 100,000 registrable domains into KV. Done when: `isWellKnown("microsoft.com")` is true and a random new domain is false.

- [x] Read the licence on the Tranco site and the Majestic Million page, choose the one whose terms allow our commercial use, and add the `NOTICE.md` row (with attribution text if CC BY). Done when: the row names the list and licence with the URL, and the reading of both pages is recorded (correction 1). Cheaper substitute: picking a list without reading its licence.
- [x] Write `src/checks/top-sites.ts` with the list's shape (shard key, meta, `parseList`, `shardsOf`) shared by the loader and the Worker, and `isWellKnown(domain, deps)` (correction 4). Done when: `test/checks/top-sites.test.ts` reads `known` for `microsoft.com` and for `www.microsoft.com` (its registrable domain), `unknown` for a random new domain and for a prefix the meta has no shard for, `not_loaded` with no meta, and `not_checked` (never `unknown`) for a KV read that stalls or fails within the cache budget, malformed meta, a shard the meta lists that is missing, a shard that is not the format and one whose count is not the meta's (correction 10).
- [x] Write `scripts/load-top-sites.ts` (corrections 2, 7, 8, 9 and 11): download the list into its own temporary directory, reduce every name to its registrable domain, keep the top 100,000, publish the generation as correction 7 says, read every shard back whole, delete only the generation before the previous one, and `--restore`. Done when: `test/node/load-top-sites.test.ts` loads a fixture list through a fake Wrangler and reads the shards and meta back; reduces subdomains (`support.google.com` to `google.com`), keeps `bbc.co.uk`, drops `github.io` and keeps `a.github.io` and `b.github.io` apart; refuses a short, mis-headed or oversized file; leaves the live meta untouched after a partial write, an interrupted publication, a Wrangler failure or stall, a stalled download and a temporary-file failure, and a retry then succeeds; fails non-zero on a same-size substitution and on a read that never converges; and restores the previous list. A local run against Wrangler's local storage writes the shards.
- [x] Commit: `checks: well-known sites list in KV`

**Test checkpoint:** `pnpm exec vitest run test/checks/top-sites.test.ts test/node/load-top-sites.test.ts` passes.

> **Verified:** 2026-11-01 | §3 | 52747dd2d3ed02ec1a3fc6834fc09226c57238b8
> **Review:** `docs/reviews/d02-t06-s3.json`

## 4. Reputation weighting rules

> **Started:** 2026-11-01T15:25Z

The rules matter more than the providers (spec 4.3a): granularity sets the weight (exact URL strong, domain medium, IP weak and never raising severity alone); a listing alone caps the verdict at suspicious; counter-signals (verified in the trust network, well-known, years of history, DMARC aligned) are shown beside it; every listing names provider, what was listed, when, and the delisting page.

**Corrected 2026-11-01** (at start, checked against `src/agent/floor.ts`, `src/checks/auth.ts`, `src/checks/domain-lookalike.ts`, `src/checks/links.ts` and §5's view): (1) the floor already honours the cap: `floor.ts` weighs a `reputation.*` item with `detail.cap = "suspicious"` at the lower of its severity and high, so this section's part is marking every `reputation.listing` item with that cap and never emitting a severity above high from `weighListing`; (2) corroboration is read from the view, as every check reads it: a lookalike link or landing host (`domain-lookalike`'s own reading of the view's brands and trusted domains), a credential form on a followed landing page (`link.credential_form`'s reading of the view's expansions), or an authentication failure among the trusted results (§2's reading of the headers) corroborates a listing; a bank change is D06's evidence, which is not on the view yet, so it joins this list when that check lands and is not invented here; (3) a counter-signal is emitted beside a listing for the same registrable domain: well-known (§3, provider `majestic-million`, the licence §3 kept), over 3 years old in `domainAges` (provider `domain-age`), a DMARC-aligned pass for the sender domain (provider `dmarc-aligned`), or a domain the organisation trusts (provider `trust-network`, from `tenant.trusted`); (4) `not_checked`, `capped`, `not_loaded` and the past-bounds count from §5 are said in an info item per case (`reputation.counter_signal`'s sibling, named in the build), never read as a negative answer; (5) the checks register last in `src/checks/index.ts`, after the link and landing checks whose readings they rest on.

**Phase:** 3
**Needs:** none
**Surface:** no
**Freeze check:** `pnpm exec vitest run test/checks/reputation-rules.test.ts` passes unchanged.

**Build order:**

1. Register `reputation.listing` and `reputation.counter_signal` with the weighting function. Done when: the rule fixtures pass.

- [x] Write `weighListing({ provider, granularity, corroborated })` returning high only when corroborated by our own evidence (lookalike, credential form, authentication failure, bank change), else medium for URL and domain listings and low for IP listings. Done when: `test/checks/reputation-rules.test.ts` covers each combination. (**Corrected 2026-11-01**, plan review, `docs/reviews/02-checks/D02-T06-s4.md`: (6) output is bounded as the lookalike check's is: at most 20 listing items and 20 counter-signal items a check, the rest counted in one more item with its count, so a maximum-size case keeps its findings under the runner's `MAX_ITEMS_PER_CHECK` through the real runner; (7) the floor interaction is proven through `floorFor` (`src/agent/floor.ts`), not only the flag: listing-only evidence never floors at malicious, an uncorroborated IP listing never raises the floor, and independent critical evidence still floors at malicious; every listing carries the cap (correction 1), corroborated or not.)
- [x] Register `reputation.listing` with `detail.provider`, `detail.listed` (URL, domain or IP), `detail.listed_at` when known, and `detail.delist_url` (Web Risk: `https://safebrowsing.google.com/safebrowsing/report_error/`; Cloudflare: `https://radar.cloudflare.com/domains/feedback`). Done when: each item carries the four fields.
- [x] Register `reputation.counter_signal` (info) for a well-known site, a domain over 3 years old, a DMARC-aligned pass or a verified trust-network domain. Done when: a listed but well-known domain shows both items. (**Corrected 2026-11-01**, plan review: (8) `trust-network` names only the organisation's own verified domains (`tenant.trusted.own`, from `org_domains` in the verified state); a supplier's domain is never claimed as a verified trust-network domain, and other verified businesses' domains are not on the view, so that counter-signal is deferred to the D05 section that first puts them there, filed at this section's completion; (9) every provider gets a positive and a negative fixture: the three-year boundary on both sides, an aligned pass for the sender's own domain and not another's, the same registrable domain matching, age data unavailable, and a well-known answer that is not `known`.)
- [x] Read corroboration from the view with association rules (**Added 2026-11-01**, plan review): a lookalike corroborates only the listing whose registrable domain a link or landing host imitates (the comparison of `domain-lookalike`, its targets the view's brands and trusted domains, its own domains exempt); a credential form corroborates only the listing for the domain of the link that was followed to it (the expansions' form scans); an authentication failure among the trusted results (D02 T02 §2's semantics, never an unavailable result and never an untrusted header) corroborates the case's listings; bank change joins when D06's evidence is on the view, deferred to the D06 section filed at this section's completion. Done when: `test/checks/reputation-rules.test.ts` proves each source alone, an unrelated link's form or lookalike corroborating nothing, and no duplicate evidence beside the checks that own those readings.
- [x] Register `reputation.coverage` (**Added 2026-11-01**, plan review): one info item with `detail.checked = false` naming what was not checked (a Web Risk or Cloudflare `not_checked` or `capped`, the well-known list `not_loaded` or `not_checked`, the §5 count past the bounds, and inputs present while the view carries no reputation), the successful listings beside it kept; the listing check's outcome reads `partial` while it stands. Done when: the tests cover each state and a mixed case (one listed, one not checked) keeps the listing.
- [x] Mark a listing-only case with `detail.cap = "suspicious"` for the deterministic floor (D04 T01 §1) to honour. Done when: the test asserts the flag.
- [x] Name each provider by a stable id in `detail.provider` on every `reputation.listing` and `reputation.counter_signal` item, from one exported list, `REPUTATION_PROVIDERS` in `src/checks/reputation.ts`: `google-web-risk` (§1), `cloudflare-security-dns` (§2), `tranco` or `majestic-million` (§3, whichever the licence decision keeps), and for counter-signals that rest on our own checks `domain-age`, `dmarc-aligned` and `trust-network`; an id once shipped is never renamed (a retired provider keeps its id), since D07 T03 §6's "This was wrong" feedback stores the ids a disputed verdict leaned on for D08 T02 §2's per-provider false-positive rates. Done when: `test/checks/reputation.test.ts` asserts every item's `detail.provider` is in the list and the list's ids are the ones above. Source: the app lane's contract question via the coordinator, 2026-10-31.
- [x] Commit: `checks: reputation weighting rules`

**Test checkpoint:** `pnpm exec vitest run test/checks/reputation-rules.test.ts test/checks/reputation.test.ts` passes and fails if an uncorroborated listing is high.

> **Verified:** 2026-11-02 | §4 | 08e1b4725d7a8ff0a6182af90537f9d532522060
> **Review:** `docs/reviews/d02-t06-s4.json`

## 5. Link and domain reputation read in the checks step

> **Started:** 2026-11-01T14:43Z

Filed 2026-11-01 from the phase audit (checks lane, run e78fd72088d9): §1 and §2 write the lookups and §4 registers the checks that weigh their answers, but no section has the checks step ask them. A check never reaches the network (`src/pipeline/analysis-workflow.ts`, `checks`: the header domains' ages are looked up there, `domainAgesOf`, and handed to the checks on the view), so without this section §4's checks read nothing.

**Corrected 2026-11-01** (at start, checked against `src/checks/webrisk.ts`, `src/checks/cf-block.ts`, `src/checks/top-sites.ts`, `src/checks/rdap.ts` and `src/pipeline/analysis-workflow.ts`): (1) the filler is `reputationOf(links, deps)` in a new `src/checks/reputation.ts`, the module §4's `REPUTATION_PROVIDERS` will join: it takes the case's `Links` (its first `MAX_LINKS` items and `more`, the count past them) and answers `{ links, domains, notLookedUp }`, one entry per distinct stripped URL (`stripUrl`, §1; an item whose URL does not strip is counted in `notLookedUp`, never looked up) and one per distinct registrable domain of those URLs' hosts (`listName`, §3's reduction, at most `MAX_LINKS` of each, a domain past the bound counted in `notLookedUp`); (2) `ReputationDeps` names the three provider functions (`webRisk`, `cloudflare`, `wellKnown`), so the step's test stubs the providers and a second test wires the real ones (`reputationDeps` in `src/pipeline/analysis-workflow.ts`, like `rdapDeps`: Web Risk with `WEB_RISK_API_KEY`, a new optional secret typed in `src/types/secrets.d.ts` and set by the coordinator from the vault at deploy, KV `CACHE`, D1, the case and organisation; Cloudflare and the well-known list with the same cache); without the key Web Risk answers `not_checked` (`no_key`), never not listed; (3) the lookups run together (`Promise.all` over each distinct URL and domain) under one budget of `REPUTATION_BUDGET_MS` (10 seconds): a provider answer that has not arrived by then is read as `not_checked` with the reason `timeout`, distinguished from the provider's own reasons, and a provider that rejects is `not_checked` (`unavailable`), never not listed, blocked's opposite, or unknown; (4) `reputation` joins `CaseView` as `Reputation | null` (null when the case has no links, and when the step was given no deps, as `domainAges` is), `caseViewOf` initialising it null; `checks` takes the deps as its last parameter and fills the view from `view.links` beside `domainAges`; (5) a replay makes no second provider call because §1's and §2's caches answer (KV by the stripped URL's and the name's hash), which the step test proves with counting stub fetches behind the real `webRiskSearch` and `cloudflareBlocked`, and the well-known read is KV only.

**Phase:** 3
**Needs:** none
**Surface:** no
**Freeze check:** `pnpm exec vitest run test/pipeline/reputation-step.test.ts` passes unchanged.

**Build order:**

1. Look up each link and its domain in the checks step and hand the answers to the checks. Done when: a case whose link Web Risk lists, and whose domain Cloudflare's resolver blocks, carries both answers on its view, and an outage reads as not checked.

- [x] Add `reputation` to `CaseView` (`src/checks/case-view.ts`): per stripped URL its Web Risk answer (`webRiskSearch`, §1: listed, not listed, capped or not checked with its reason), per registrable domain its Cloudflare answer (`cloudflareBlocked`, §2) and whether it is a well-known site (§3), each bounded (the case's first `MAX_LINKS` links, `src/checks/links.ts`, the rest counted as not looked up), null when the case has no links. Done when: `test/pipeline/reputation-step.test.ts` reads the view's `reputation` for a case with a listed link, a blocked domain and a well-known one, from stubbed providers. (**Corrected 2026-11-01**, plan review, `docs/reviews/02-checks/D02-T06-s5.md`: (6) the domains also include the original sender's domain (`originalSender`, `src/checks/senders-seen.ts`, its domain validated as the links' are; the file's Goal checks sender domains too), deduplicated with the links' domains and under the same bound, so a linkless case with a sender domain carries `reputation` with no link entries, and null only when there is neither a link nor a sender domain; (7) the tests also assert stripped-URL and domain deduplication, the `MAX_LINKS` and `more` accounting, an invalid name, empty inputs, a capped and a no-key answer, the well-known list's `not_loaded` and `not_checked`, and fast and stalled providers mixed under the one budget; an answer not in by the budget reads `not_checked` with the reason `timeout`, the same word as a provider's own deadline, since both mean no answer in time and §4 reads the state. **Corrected 2026-11-01** (completion review, same file): (13) all providers start together against one absolute deadline and a late answer is excluded when it settles, with no rejection ever converted, so a delayed audit refusal still fails the step; the providers' own bounds (their 4-second deadlines and 500 ms cache reads) and the Workflow step's timeout bound the wait; (14) a case whose every input was refused returns empty lists with its `notLookedUp` count, so incomplete coverage is never indistinguishable from nothing to check; null is only for genuine absence.)
- [x] Fill it in the checks step (`checks`, `src/pipeline/analysis-workflow.ts`) from `view.links`, as `domainAges` is filled, the lookups run together under one time budget so the step stays within its own, a provider that fails or times out read as not checked with its reason, never as not listed. Done when: the test reads an outage as not checked, and a replay of the step makes no second provider call (the cache, §1). (**Corrected 2026-11-01**, plan review: (8) a provider rejection is never converted: §1's and §2's clients throw only when their audit write fails, and that refusal propagates so the step retries, as their contracts say; the test proves an audit-write failure fails the filler and the next run recovers, reading the persisted `case_events` row back; (9) the lookups start when the links are read and run beside the link-following and domain-age reads, awaited before the view is built, so they add no serial time beyond their 10-second budget from their start, and the step test proves a stalled provider leaves the step finishing with `not_checked` answers, not hanging; (10) the observation point is a probe check the test registers (`probe.reputation`), capturing the view `checks()` actually hands the checks through the real runner, so the test fails if the filler works but the step never attaches its result; (11) `AnalysisWorkflow.run()` passes `reputationDeps(this.env, caseId, orgId)` at its `checks` call, tested with the key absent (Web Risk `not_checked`, `no_key`, no fetch) and present (a stubbed fetch answering); (12) the replay guarantee covers only a successful, unexpired, successfully cached answer: a failure is never cached (§1, §2), so a replay after an outage asks again and can then return the real answer, which the test proves.)
- [x] Commit: `checks: link and domain reputation read in the checks step`

**Test checkpoint:** `pnpm exec vitest run test/pipeline/reputation-step.test.ts` passes and fails if an outage reads as not listed.

> **Verified:** 2026-11-01 | §5 | 3ba50205513ae4361e2fcca4bfe6a3cb60931951
> **Review:** `docs/reviews/d02-t06-s5.json`

## 6. Well-known sites in KV

> **Started:** 2026-11-02T05:16Z

Filed 2026-11-01 from §3's plan review (production handoff): §3 loads the list into Wrangler's local storage and proves the loader and the reader; the production namespace stays at `not_loaded` until someone runs the loader against it. That is a deploy step of the coordinator's, like the brand table (`scripts/load-brands.ts`), and §4's well-known counter-signal must not be enabled before it reads back.

**Phase:** 7
**Needs:** cloudflare
**Surface:** no
**Freeze check:** `pnpm exec vitest run test/checks/top-sites.test.ts test/node/load-top-sites.test.ts` passes unchanged.

**Build order:**

1. Load and prove the list in production. Done when: `top:meta` in the production `CACHE` namespace reads back the generation §3's loader published, and the deployed Worker answers `known` for `microsoft.com` and `unknown` for a random new domain.

- [x] Run `node scripts/load-top-sites.ts --remote` (the coordinator, from this machine, after §3 is merged and deployed), keeping `top:meta:previous`. Done when: the loader exits 0 and its read-back matches, and the date and count are recorded in `docs/live-checks.md`. (**Corrected 2026-11-02**, plan review, `docs/reviews/02-checks/D02-T06-s6.md`: the target is named: binding `CACHE`, namespace `ea28d6e83ede4a83bfb06898d8791a16` in `wrangler.jsonc`; before the load, read the active `top:meta` with `wrangler kv key get top:meta --binding CACHE --remote` and record it as the pre-load generation (none on the first load). On an uncertain publication, an interruption or a cleanup warning: read the active meta again, compare it with the pre-load and intended generations, resolve the warning, and repeat the consumer proof below after any recovery. Rollback is `node scripts/load-top-sites.ts --remote --restore`, verified by reading the restored generation and the consumer answers back; on the first production load no previous meta exists, `--restore` refuses, and restoring the original `not_loaded` state means deleting only the `top:` keys this load wrote, never the namespace or unrelated cache data.)
- [ ] Read the list through the deployed consumer: the checks step's `isWellKnown` (§5 wires it, and §5 is stamped and deployed) on a case whose link is `microsoft.com`, and on a random new domain verified absent from the published list. (**Corrected 2026-11-02**, completion review, `docs/reviews/02-checks/D02-T06-s6.md`: this item was ticked on the local-reader probe; its Done when requires recorded deployed-Worker cases tied to the deployed version and generation, and `docs/live-checks.md` records that no authenticated deployed case was run, so the item is unticked until the coordinator gate provides that proof.) Done when: the recorded case's evidence shows the well-known counter-signal for the first and none for the second, the pair tied to the deployed version and the published generation: the first case proving the reader works rules out `not_loaded` and `not_checked` for the second, whose absence then reads `unknown`. (§5's deployed state replaces the metadata-and-one-shard stand-in this item first allowed; that stand-in no longer proves completion.)
- [x] Commit: `checks: well-known sites list in production KV`

**Test checkpoint:** `docs/live-checks.md` records the production load's generation, date and count, and a `known` and an `unknown` answer.

## 7. Well-known list provenance kept for reports

Filed 2026-11-01 from §3's completion review (Part 2 item 2): a decision that a domain was well known can be traced to the list only while its generation is still in KV, and the loader deletes generations older than the previous one. An investigator reading an older report could not reconstruct what the list said then.

**Phase:** 7
**Needs:** none
**Surface:** no
**Freeze check:** `pnpm exec vitest run test/checks/top-provenance.test.ts` passes unchanged.

**Build order:**

1. Keep what a report needs to be reproduced. Done when: a report older than the previous generation can still be answered "was this domain on the list that was used".

- [ ] Carry the generation `isWellKnown` answered from (§3 returns it) in the `reputation.counter_signal` item's `detail` (§4's item), with the list's source, date and attribution. Done when: `test/checks/top-provenance.test.ts` reads all four from the stored evidence of a case.
- [ ] Keep each generation's shards, once a case has used it, for the report retention period (decided with the retention policy, D05), by moving them out of the loader's deletion into an archive prefix that the loader never deletes before that period, and read an archived generation back by its id. Done when: a generation used by a stored case survives two later loads, and a generation no case used is deleted as before.
- [ ] Commit: `checks: well-known list provenance`

**Test checkpoint:** `pnpm exec vitest run test/checks/top-provenance.test.ts` passes.

## 8. Well-known list kept fresh, staleness stated

Filed 2026-11-02 from §6's completion review (gaps 2 and 3, out of scope there): the reader answers from the list's metadata without reading its date, so a list loaded once stays authoritative for ever; no refresh owner, cadence or missed-refresh signal exists. The comparison baseline named in that review (a maintained ranking refreshed weekly) sets the target cadence.

**Phase:** 7
**Needs:** none
**Surface:** no
**Freeze check:** `pnpm exec vitest run test/checks/top-sites.test.ts test/node/load-top-sites.test.ts` passes unchanged.

**Build order:**

1. Keep the list fresh and say when it is not. Done when: a stale list no longer lends its counter-signal silently, and a missed refresh is visible to the operator.

- [ ] Give the reader an age rule in `src/checks/top-sites.ts`: read the active metadata's date and, past an agreed age limit in days named beside the loader's constants, answer `not_checked` with the reason `stale` instead of a membership answer. Done when: `test/checks/top-sites.test.ts` covers fresh, boundary and stale metadata and the freeze check passes.
- [ ] Name the refresh owner and cadence (weekly, matching the comparison baseline) in `docs/live-checks.md` with the loader command of §6 item 1, and record each production refresh's generation, date and count there. Done when: the page names the owner, the cadence and the first scheduled refresh date.
- [ ] Report a missed refresh: the scheduled run that reads the list states `stale` in its log line when the age rule trips, so the operator sees it without a case having to arrive. Done when: a test of that run's log line covers the stale and fresh states.
- [ ] Commit: `checks: well-known list freshness and staleness`

**Test checkpoint:** `pnpm exec vitest run test/checks/top-sites.test.ts test/node/load-top-sites.test.ts` passes, and fails if a stale list still answers membership.

## 9. One reputation result stored per provider

> **Started:** 2026-11-02T19:52Z

Filed 2026-11-02 from the coordinator's routing (report lane, D07 T09 §5): the reputation step weighs provider answers into evidence, but no stored record keeps one result per provider per subject, so the report cannot show each provider's own answer. This section stores, per subject checked, each provider's result (listed, clear or unavailable), when it was obtained, and whether it came from the cache.

**Corrected 2026-11-02** (at start, checked against the tree): (1) the answers live on the case view (`Reputation` in `src/checks/reputation.ts`: Web Risk per stripped URL with `cached`, Cloudflare per registrable domain with `cached`, the well-known list per domain), and no stored table holds them per provider, so storage is a new table `reputation_results` (case, run, provider, subject, state, obtained time, cached flag) under migration `0085` (the coordinator's, 2026-11-02T22:12, applied through this section's gate, never directly); (2) states map at the store: Web Risk `listed`/`not_listed`/`not_checked` and Cloudflare `blocked`/`clear`/`not_checked` read as listed, clear and unavailable, and the well-known answer keeps its own states (known, unknown, unavailable) in the same table, never renamed a listing; (3) the checks step writes the rows from the same answers it weighs, in the same run as the evidence, so a stored result can never disagree with the evidence it sits beside, and a re-run replaces the run's rows.

**Corrected 2026-11-02** (plan review, `docs/reviews/02-checks/D02-T06-s9.md`): (4) the full state mapping: Web Risk `capped` also maps to unavailable with its cap reason kept in the row's note, and well-known `not_loaded` and `not_checked` both map to unavailable; no refusal or outage ever reads as clear or disappears, each proven through persisted read-back; (5) answer age: the provider contracts gain the answer's obtained time (Web Risk and Cloudflare results and their cache entries carry when the answer was fetched, a later cache hit preserving that original time, a legacy cache entry without one read as obtained when read), and the well-known answer is obtained when read with `cached` false; (6) the consumer contract is a case-scoped reader (`readReputationResults`) the report calls per case and run, its integration into the report assigned to D07 T09 §5 through the coordinator, proven from storage through that reader with historical runs kept and another case's rows never answered; (7) replacement is one atomic batch per run (delete the run's rows, insert the new set), a storage failure propagates so the step retries, and the previous complete set survives a failed replacement; (8) the table belongs to its case (`ON DELETE CASCADE`, like `check_outcomes`) and is retained with the case, proven by a migrated-database deletion test that leaves another case's rows standing.

**Phase:** 7
**Needs:** none
**Surface:** no
**Freeze check:** `pnpm exec vitest run test/checks/reputation.test.ts` passes unchanged.

**Build order:**

1. Keep each provider's answer as its own stored result. Done when: a checked subject reads back one result per provider with its state, time and cache flag.

- [x] Store the per-provider results from the reputation answers the checks step holds (`Reputation` in `src/checks/reputation.ts`: each provider, its subject, listed, clear or unavailable, the time obtained and the cached flag) in the `reputation_results` table under the coordinator's migration number, written with the run's evidence and replaced on a re-run, never a provider's raw response. Done when: `test/checks/reputation.test.ts` reads back one stored result per provider for a listed, a clear and an unavailable subject, and a re-run holds one set.
- [x] Give each answer its obtained time at the provider contracts (`src/checks/webrisk.ts`, `src/checks/cf-block.ts`): results and cache entries carry when the answer was fetched, a cache hit preserving the original time and a legacy entry read as obtained when read; the well-known answer is obtained when read. Done when: the providers' suites read a later hit's original time back. (**Corrected 2026-11-02**, plan review, `docs/reviews/02-checks/D02-T06-s9.md`.)
- [x] Replace atomically and read through the consumer contract: one batch per run replaces the run's rows (a failed replacement leaving the previous set and failing the step), the table cascades with its case, and `readReputationResults` answers one case and run only. Done when: the checks step's own suite exercises the wiring (an unwired helper cannot pass), a removed subject disappears, an empty set clears, another run and case stand, and deleting the case removes its rows. (**Corrected 2026-11-02**, plan review, `docs/reviews/02-checks/D02-T06-s9.md`.)
- [ ] Commit: `checks: one reputation result stored per provider`

**Test checkpoint:** `pnpm exec vitest run test/checks/reputation.test.ts test/pipeline/analysis-workflow.test.ts` passes, and fails if a provider's answer is missing, merged into another's, or read as clear on an outage.

## Verification

- Listings appear with source, date and delisting page; no listing decides a verdict alone; outages say "not checked".
- `pnpm test` passes; `python3 scripts/todo-graph.py validate` and `plan --check` pass.
