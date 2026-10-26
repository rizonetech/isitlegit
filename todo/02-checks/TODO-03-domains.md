---
schema_version: 1
id: domains
domain: 02-checks
status: active
title: "TODO-03 -- Lookalike Domains, Brand Table and Domain Age"
track: day-2
---

# TODO-03 -- Lookalike Domains, Brand Table and Domain Age

> **Goal:** Every domain in a case (From, Reply-To, links, landing pages) is compared with the organisation's own domains, its suppliers and a curated brand table using a confusables skeleton, edit distance and added-word patterns; brand-to-real-domain facts come from a curated table; domain age comes from RDAP with caching; each finding is cited evidence.

> **Current state:** Measured 2026-10-26 20:00 SAST. No domain code exists. Suppliers arrive with the ledger (D06 T01 §2); until then the comparison uses the organisation's domains and the brand table.

## Inputs

- Design spec 4.3 (Domains), 4.4 (brand real domains: curated table first), 4.11 (the monitor reuses the confusables module).
- Unicode Technical Standard #39 (confusables, `confusables.txt`, Unicode License v3) and RFC 9083 (RDAP JSON responses).
- Stack doc: own confusables module over the Unicode table; `tldts` 7.4.19.
- -> XREF: D05 T04 §1 -- the impersonation monitor's candidate generator reuses this module

## Outcome

- `fynbosfreight.example` vs `fynb0sfreight.example`, `fynbosfreight-payments.example` and `fynbosfreíght.example` are each flagged as lookalikes with the technique named; unrelated domains are not.
- A domain registered within 30 days is flagged from RDAP; RDAP outages leave a "not checked" item.

**Adjacency:** list=not-applicable (no list of its own; brand entries are reference data maintained in code); document=not-applicable (no carried document); settings=not-applicable (thresholds are fixed in code with tests); reporting=not-applicable (domain findings are reported per case); notifications=not-applicable (no notices); permissions=not-applicable (no user action); audit=not-applicable (reference data changes are commits); exchange=applicable @ D02 T03 §3; reverse=not-applicable (pure checks)

**Adjacency rationale:** The brand table is reference data loaded into KV from a committed file (§3), which is its exchange path; everything else is evidence on a case.

## Implementation Order

| Order | Section | Deliverable | Depends On | Status |
| ----- | ------- | ----------- | ---------- | ------ |
| 1 | §1 | Confusables skeleton and edit distance module | D02 T01 §1 | [ ] |
| 2 | §2 | Lookalike check against own, supplier and brand domains | §1, §3 | [ ] |
| 3 | §3 | Curated brand domain table in KV | D02 T01 §1 | [ ] |
| 4 | §4 | Domain age from RDAP with caching | D02 T01 §2 | [ ] |

## 1. Confusables skeleton and edit distance module

UTS #39 defines a "skeleton" that maps visually confusable characters to one prototype; two domains with equal skeletons look alike. Combined with Damerau-Levenshtein distance and an added-word list, this catches the common lookalikes (spec 4.3). The Unicode table is vendored with its licence recorded in `NOTICE.md`.

**Phase:** 2
**Needs:** none
**Surface:** no

**Build order:**

1. Vendor `confusables.txt` and generate a compact map. Done when: `src/checks/confusables-map.json` exists with its source version and licence noted.
2. Write `skeleton`, `distance` and `addedWords`. Done when: tests pass the UTS #39 examples and the synthetic lookalikes.

- [ ] Download `confusables.txt` from `https://www.unicode.org/Public/security/latest/confusables.txt`, store it in `vendor/unicode/` with its version header, and add a `NOTICE.md` row (Unicode License v3). Done when: the file and row exist.
- [ ] Write `scripts/build-confusables.ts` generating `src/checks/confusables-map.json`. Done when: the generated map has the expected entry for Cyrillic `а` mapping to Latin `a`.
- [ ] Write `skeleton(label)` (NFD, map, NFD again, per UTS #39 section 4) in `src/checks/lookalike.ts`. Done when: `test/checks/lookalike.test.ts` gives equal skeletons for `paypal` and `pаypal` (Cyrillic а).
- [ ] Write `distance(a, b)` (Damerau-Levenshtein) and `addedWords(candidate, base)` for prefixes and suffixes such as `-payments`, `-invoice`, `-secure`, `-za`, `online`. Done when: the tests cover each.
- [ ] Commit: `checks: confusables skeleton and edit distance`

**Test checkpoint:** `pnpm exec vitest run test/checks/lookalike.test.ts` passes and fails if NFD normalisation is removed.

## 2. Lookalike check against own, supplier and brand domains

For every domain in the case, compare its registrable label with the organisation's verified domains, its suppliers' domains (when the ledger exists) and the brand table. A lookalike of a domain the organisation trusts is high; of a brand, medium; an exact match is never a lookalike.

**Phase:** 2
**Needs:** none
**Surface:** no

**Build order:**

1. Register check `domain.lookalike`. Done when: the synthetic lookalike fixtures yield items naming the technique and the target.

- [ ] Collect case domains (From, Reply-To, Return-Path, link hosts, landing hosts) as registrable domains with `tldts`. Done when: `test/checks/domain-lookalike.test.ts` lists them for a fixture.
- [ ] Compare each with targets: skeleton equal, distance 1 or 2 on labels of 6 or more characters, or added words; skip exact matches and the organisation's own domains. Done when: the four synthetic lookalikes are found and `example.com` vs `example.org` is reported as a different TLD, not a lookalike, unless the brand table lists it.
- [ ] Set severity high for the organisation's own and supplier domains, medium for brands, with `detail.technique` and `detail.target`. Done when: the test checks severities.
- [ ] Read suppliers through `listSupplierDomains(orgId)` returning an empty list until D06 T01 §2 provides the ledger. Done when: the check runs with and without suppliers. Cheaper substitute: none.
- [ ] Commit: `checks: lookalike domains against own, supplier and brand domains`

**Test checkpoint:** `pnpm exec vitest run test/checks/domain-lookalike.test.ts` passes and fails if an exact match is flagged.

## 3. Curated brand domain table in KV

The brands most impersonated in South African small-business mail (banks, Microsoft, Google, DocuSign, SARS, couriers, accounting platforms) and their real sending and web domains, curated from each brand's own website (spec 4.4). Facts only; no logos here (logos live in R2, D03 T04 §2).

**Phase:** 2
**Needs:** none
**Surface:** no

**Build order:**

1. Write `data/brands.json` with sources. Done when: each brand lists domains and the URL the fact came from.
2. Load it into KV. Done when: `getBrand(name)` reads from KV and falls back to the bundled file.

- [ ] Write `data/brands.json` with at least 25 brands (the big five SA banks, Capitec, Discovery Bank, TymeBank, Microsoft, Google, Apple, DocuSign, Adobe, SARS, Xero, Sage, DHL, FedEx, Aramex, The Courier Guy, PostNet, Takealot, Netflix, PayPal, Payfast, Yoco), each with `domains`, `display_names` and `source_url`. Done when: a schema test validates every entry has a source URL. Cheaper substitute: domains from memory without a source.
- [ ] Write `scripts/load-brands.ts` putting the table into `CACHE` under `brands:v<n>`. Done when: running it locally writes the key.
- [ ] Write `getBrand(name)` and `brandForDomain(domain)` in `src/checks/brands.ts`. Done when: `test/checks/brands.test.ts` finds a brand by display name and by domain.
- [ ] Commit: `checks: curated brand domain table`

**Test checkpoint:** `pnpm exec vitest run test/checks/brands.test.ts` passes and fails if an entry lacks `source_url`.

## 4. Domain age from RDAP with caching

A domain registered in the last 30 days is a strong phishing signal (spec 4.3). RDAP (RFC 9083) is queried through the IANA bootstrap; results are cached in KV for 7 days; an outage gives a "not checked" item, never a guess.

**Phase:** 2
**Needs:** none
**Surface:** no

**Build order:**

1. Write the RDAP client with bootstrap and cache. Done when: a stubbed test reads the registration date from a recorded RDAP response.
2. Register `domain.age`. Done when: 10 days old is high, 200 days is info, and an outage is not checked.

- [ ] Write `rdapLookup(domain)` in `src/checks/rdap.ts` resolving the server from `https://data.iana.org/rdap/dns.json` (cached 1 day) and reading the `registration` event date. Done when: `test/checks/rdap.test.ts` parses a recorded `.co.za` and a `.com` response.
- [ ] Cache results in `CACHE` for 7 days keyed by registrable domain. Done when: a second lookup makes no network call.
- [ ] Register `domain.age`: high under 30 days, medium under 90, info otherwise, with the date and RDAP server as detail. Done when: the test covers each band.
- [ ] Map timeouts and non-200 responses to `not_checked` for this check only. Done when: a 503 stub yields it. Cheaper substitute: treating unknown age as new.
- [ ] Commit: `checks: domain age from RDAP with caching`

**Test checkpoint:** `pnpm exec vitest run test/checks/rdap.test.ts` passes and fails if an outage is reported as a new domain.

## Verification

- Lookalike, brand and age fixtures produce the expected evidence; outages leave "not checked".
- `pnpm test` passes; `python3 scripts/todo-graph.py validate` and `plan --check` pass.
