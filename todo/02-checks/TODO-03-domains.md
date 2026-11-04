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
- -> XREF: D07 T03 §44 -- the report's clean-check words, whose completion review filed §12 here

## Outcome

- `fynbosfreight.example` vs `fynb0sfreight.example`, `fynbosfreight-payments.example` and `fynbosfreíght.example` are each flagged as lookalikes with the technique named; unrelated domains are not.
- A domain registered within 30 days is flagged from RDAP; RDAP outages leave a "not checked" item.

**Adjacency:** list=not-applicable (no list of its own; brand entries are reference data maintained in code); document=not-applicable (no carried document); settings=not-applicable (thresholds are fixed in code with tests); reporting=not-applicable (domain findings are reported per case); notifications=not-applicable (no notices); permissions=not-applicable (no user action); audit=not-applicable (reference data changes are commits); exchange=applicable @ D02 T03 §3; reverse=not-applicable (pure checks)

**Adjacency rationale:** The brand table is reference data loaded into KV from a committed file (§3), which is its exchange path; everything else is evidence on a case.

## Implementation Order

| Order | Section | Deliverable | Depends On | Status |
| ----- | ------- | ----------- | ---------- | ------ |
| 1 | §1 | Confusables skeleton and edit distance module | D02 T01 §1 | [x] |
| 2 | §2 | Lookalike check against own, supplier and brand names | §1, §3 | [x] |
| 3 | §3 | Curated brand domain table in KV | D02 T01 §1 | [x] |
| 4 | §4 | Domain age from RDAP with caching | D02 T01 §2 | [x] |
| 5 | §5 | Accent-insensitive lookalikes, measured | §2 | [ ] |
| 6 | §6 | Right-to-left lookalike labels | §2 | [ ] |
| 7 | §7 | Lookalike check on link and landing hosts | §2, D02 T07 §1, D02 T07 §3 | [x] |
| 8 | §8 | Repeated-name lookalikes | §2, §5 | [ ] |
| 9 | §9 | Domain age for .za by WHOIS | §4 | [x] |
| 10 | §10 | Domain age for link and landing hosts | §4, §9, D02 T07 §1, D02 T07 §3 | [x] |
| 11 | §11 | Demo domains kept apart in the checks | §2 | [x] |
| 12 | §12 | Lookalike clean summary names the domains compared | §7, D02 T01 §7 | [x] |

## 1. Confusables skeleton and edit distance module

UTS #39 defines a "skeleton" that maps visually confusable characters to one prototype; two domains with equal skeletons look alike. Combined with an edit distance (the optimal string alignment distance, correction 3 below) and an added-word list, this catches the common lookalikes (spec 4.3). The Unicode table is vendored with its licence recorded in `NOTICE.md`.

> **Started:** 2026-10-29T14:57Z

**Corrected 2026-10-29** (at start, checked against the sources): (1) the current table is Unicode 18.0.0 (`# Version: 18.0.0`, dated 2026-08-06), served only at `latest`: `https://www.unicode.org/Public/security/` has numbered directories up to 16.0.0, so the vendored file is pinned by its own version line, which `scripts/build-confusables.ts` checks, refusing any other; (2) UTS #39 revision 34 defines `skeleton(X)` as `bidiSkeleton(LTR, X)`, and its `internalSkeleton` has four steps, not three: NFD, remove every Default_Ignorable_Code_Point (a zero-width joiner hides in a label otherwise), map each character to its prototype, NFD again; for a label with no right-to-left character the bidi reordering changes nothing, so `skeleton` is `internalSkeleton` there, and a label holding a right-to-left character (Hebrew, Arabic) gets no skeleton (`null`), which §2 reports as not compared rather than guessing; (3) `distance` is the optimal string alignment distance (Damerau-Levenshtein restricted to adjacent transpositions), counted in code points, which catches the swapped-letter lookalike the full form also does; (4) the map ships in the Worker as `src/checks/confusables-map.json`, generated, with the build script's check that it matches the vendored file in CI.

**Corrected 2026-10-29** (plan review): (5) the primitives take a Unicode label, lowercased; a link's host arrives as an A-label (`new URL` and `tldts` give `xn--pypal-4ve` for `pаypal`), so `unicodeLabel(label)` here decodes a validated A-label (RFC 3492) and lowercases, answering `null` for an invalid one, and §2 passes every candidate and every target through it, so a Unicode form and its Punycode compare alike; (6) a right-to-left label is one holding a character of Bidi_Class R or AL, as UTS #39 names them: JavaScript regular expressions cannot match Bidi_Class, so `vendor/unicode/DerivedBidiClass.txt` (18.0.0) is vendored beside the confusables and its R and AL ranges built into the map; Default_Ignorable_Code_Point is matched by the runtime's own Unicode property (`\p{Default_Ignorable_Code_Point}`), and both NFD passes use the runtime's normalisation: a runtime Unicode upgrade can move them without a map change, which the labels compared here (letters, marks, digits, hyphens) do not feel, since IDNA disallows the code points whose properties change (final review).

**Phase:** 2
**Needs:** none
**Surface:** no

**Build order:**

1. Vendor `confusables.txt` and generate a compact map. Done when: `src/checks/confusables-map.json` exists with its source version and licence noted.
2. Write `skeleton`, `distance` and `addedWords`. Done when: tests pass the UTS #39 examples and the synthetic lookalikes.

- [x] Download `confusables.txt` from `https://www.unicode.org/Public/security/latest/confusables.txt` and `DerivedBidiClass.txt` from `https://www.unicode.org/Public/UCD/latest/ucd/extracted/DerivedBidiClass.txt` (both 18.0.0 on 2026-10-29), store them unchanged in `vendor/unicode/` with their SHA-256 digests recorded beside them, and add a `NOTICE.md` row (Unicode License v3, the version and URLs). Done when: the files, their digests and the row exist. (**Corrected 2026-10-29**, at start and plan review.) Done 2026-10-29: `vendor/unicode/` (both files, `SHA256SUMS`), the `NOTICE.md` row.
- [x] Write `scripts/build-confusables.ts` generating `src/checks/confusables-map.json` (the prototypes, the R and AL ranges, the version and both sources' digests), refusing a source whose version is not 18.0.0 or whose digest differs, with `--check` that exits non-zero when the committed map is missing or differs from a fresh build and never writes. Done when: the generated map has the expected entry for Cyrillic `а` mapping to Latin `a`, and `test/node/confusables-map.test.ts` proves, on fixtures in a temporary directory, the committed map current, and a non-zero exit with no file changed for a stale map, a missing map, a wrong version and a digest mismatch. (**Corrected 2026-10-29**, at start and plan review.) Done 2026-10-29: 6,712 prototypes, 60 R and AL ranges with the `@missing` defaults (completion review); `test/node/confusables-map.test.ts` (5 tests); the map is excluded from Biome as generated.
- [x] Write `unicodeLabel(label)` and `skeleton(label)` (NFD, Default_Ignorable_Code_Point removed, map, NFD again, per UTS #39 section 4, revision 34; `null` for a label with an R or AL character) in `src/checks/lookalike.ts`. Done when: `test/checks/lookalike.test.ts` gives exact skeletons (`pаypal` with a Cyrillic а is `paypal`; `modern` is `rnodern`, a one-to-many mapping), unequal skeletons for unrelated labels, equal ones for a label and the same label with a zero-width joiner, for precomposed and decomposed forms (each normalisation stage tested on its own), and for `xn--pypal-4ve` and `pаypal` through `unicodeLabel`; an invalid A-label gives `null`; a Hebrew, an Arabic and a Thaana label each give `null`. (**Corrected 2026-10-29**, at start and plan review.) Done 2026-10-29: `src/checks/lookalike.ts`; `test/checks/lookalike.test.ts` "skeleton" and "unicodeLabel" (cross-checked against the runtime's IDNA encoder; every form normalised by the URL host parser and a round trip, completion review), each NFD stage proven by removing it.
- [x] Write `distance(a, b)` (optimal string alignment, in code points) and `addedWords(candidate, base)`: a fixed vocabulary (`ADDED_WORDS`: `pay`, `payment`, `payments`, `invoice`, `invoices`, `billing`, `account`, `accounts`, `secure`, `security`, `verify`, `login`, `online`, `portal`, `support`, `za`), each as a whole word before or after the whole base, joined by `-` or nothing, matching only when the rest of the label is exactly that word, answering the word and its side or `null`. Done when: the tests give exact distances for an insertion, a deletion, a substitution, an adjacent transposition, a supplementary character, and `ca` to `abc` (3, where unrestricted Damerau-Levenshtein gives 2); `fynbosfreight-payments`, `fynbosfreightpayments` and `secure-fynbosfreight` match with their word and side, while `fynbosfreight`, `otherfreight-payments` and `fynbosfreightpayable` do not. (**Corrected 2026-10-29**, at start and plan review.) Done 2026-10-29: `distance`, `ADDED_WORDS`, `addedWords`; tests "distance" and "addedWords".
- [x] Commit: `checks: confusables skeleton and edit distance` Done 2026-10-29: 8ef36b7, then the review fixes. Test checkpoint 2026-10-29: `pnpm exec vitest run test/checks/lookalike.test.ts test/node/confusables-map.test.ts` 25 passed; removing either NFD stage fails one test each.

**Test checkpoint:** `pnpm exec vitest run test/checks/lookalike.test.ts test/node/confusables-map.test.ts` passes, and the lookalike test fails if either NFD stage is removed.

> **Verified:** 2026-10-29 | §1 | e4db21e724318f7bd33fdf88c2792bafc2371df9
> **Review:** `docs/reviews/d02-t03-s1.json`

## 2. Lookalike check against own, supplier and brand names

For every domain in the case, compare its registrable label with the organisation's verified domains, its suppliers' domains (when the ledger exists) and the brand table. A lookalike of a domain the organisation trusts is high; of a brand, medium; an exact match is never a lookalike.

> **Started:** 2026-10-30T18:11Z

**Corrected 2026-10-30** (at start, checked against the repository): (1) the case's domains here are the header domains, read only with the original's own headers (`headersAvailable`): the From's single mailbox (`fromDomain` in `src/checks/auth.ts`), every Reply-To mailbox and the topmost Return-Path; link and landing hosts have no extractor yet (URL extraction is D02 T07 §1 and landing pages §3, both Phase 3), so they are filed as §7, which runs this check over them; (2) checks are pure (`src/checks/registry.ts`), so the targets reach the view: `Tenant.trusted` carries the organisation's verified domains (`org_domains`, state `verified`) and its suppliers' domains, both read by the Workflow's `checks` step; suppliers come through `listSupplierDomains(db, orgId)` in `src/checks/suppliers.ts`, an empty list until the ledger (D06 T01 §2, the app lane's, Phase 5) fills it, asked of the app lane through the coordinator; (3) domains are compared as registrable domains (`tldts`, ICANN suffixes), their label the registrable domain without its suffix; a domain whose registrable domain is a target's, the organisation's own, or a brand's own is never a lookalike; (4) techniques, strongest first: `skeleton` (the labels differ but share a UTS #39 skeleton, `labelSkeleton`), `different-tld` (the same label under another suffix), `added-word` (`addedWords`), `edit` (distance 1 or 2, both labels at least 6 characters); a label with a right-to-left character has no skeleton and is not compared (§6 owns it); (5) one item per lookalike domain, its strongest match (the organisation's own or a supplier before a brand), citing the header fields it was read from and the raw message, its summary and detail bounded as §2 of D02 T02 does (`item` in `src/checks/sender.ts`'s manner): `detail.domain`, `detail.target`, `detail.targetKind` (`own`, `supplier` or `brand`), `detail.technique`, `detail.fields`.

**Corrected 2026-10-30** (plan review): (6) registrable domains are the repository's own `registrable` (`src/checks/brand-schema.ts`, private suffixes included), as the brand table's are, rather than ICANN suffixes only; (7) the items are bounded below the runner's limit: at most `MAX_LOOKALIKES` (20) lookalike items, the strongest first (high before medium), and past that one item counting the rest, so detected risk is never replaced by `not_checked`; (8) a domain whose label has no skeleton (right-to-left, or refused) is not compared, and says so: an info item naming it, as is a trusted domain (own or supplier) that cannot be compared, while every other comparison still runs; (9) the checks step's read-back fixture holds another organisation's verified domain and this organisation's pending one, neither a target nor an exemption; (10) the tests add unrelated and distance-3 negatives, an A-label and its Unicode form as one domain, a domain that imitates both the organisation's own and a brand (own wins), and one domain in From, Reply-To and Return-Path read back from storage as one item citing all three.

**Phase:** 2
**Needs:** none
**Surface:** no

**Build order:**

1. Register check `domain.lookalike`. Done when: the synthetic lookalike fixtures yield items naming the technique and the target.

- [x] Collect the case's header domains (From, Reply-To, Return-Path) as registrable domains with `tldts`, each with the fields it came from (correction 1). Done when: `test/checks/domain-lookalike.test.ts` lists them for a fixture, and none for an inline forward or a headerless upload. (**Corrected 2026-10-30**, at start.) Done 2026-10-30: `headerDomains` in `src/checks/domain-lookalike.ts`.
- [x] Compare each with the targets by the techniques of correction 4, skipping exact matches, the organisation's own domains and a brand's own. Done when: the four synthetic lookalikes (skeleton, different suffix, added word, edit) are found with their technique, `example.com` against `example.org` is `different-tld` unless the brand table lists both, and an exact match is never flagged. (**Corrected 2026-10-30**, at start.) Done 2026-10-30: `techniqueOf`, `lookalikeEvidence`; the plan review's bounds (20 and a count of the rest) and "not compared" items.
- [x] Set severity high for the organisation's own and supplier domains, medium for brands, with `detail.technique` and `detail.target`. Done when: the test checks severities. Done 2026-10-30: `test/checks/domain-lookalike.test.ts` (16 tests); seven mutations (inline headers read, exact matches flagged, brand before own, no cap, short labels by distance, another organisation's domains, pending domains) each fail a test.
- [x] Fill `Tenant.trusted` in the Workflow's `checks` step: the verified `org_domains` and `listSupplierDomains(db, orgId)` from `src/checks/suppliers.ts`, an empty list until D06 T01 §2 provides the ledger (correction 2). Done when: the check runs with and without suppliers, and a Workflow read-back test stores a lookalike of the organisation's verified domain as high. Cheaper substitute: none. (**Corrected 2026-10-30**, at start.) Done 2026-10-30: `listOwnDomains` and `listSupplierDomains` in `src/checks/suppliers.ts`, read in `checks`; the read-back test stores one high item citing From, Reply-To and Return-Path; 421 tests across checks, pipeline and intake pass.
- [x] Commit: `checks: lookalike domains against own, supplier and brand domains` Done 2026-10-30: 019aee4, with 7c39e5e (completion review) and 93436d8 (round 1).

**Test checkpoint:** `pnpm exec vitest run test/checks/domain-lookalike.test.ts` passes and fails if an exact match is flagged.

> **Verified:** 2026-10-30 | §2 | 7e2c3f1fcec5505304d7b3d72858db77f78dcd88
> **Review:** `docs/reviews/d02-t03-s2.json`

## 3. Curated brand domain table in KV

The brands most impersonated in South African small-business mail (banks, Microsoft, Google, DocuSign, SARS, couriers, accounting platforms) and their real sending and web domains, curated from each brand's own website (spec 4.4). Facts only; no logos here (logos live in R2, D03 T03 §2: **corrected 2026-10-29**, plan review).

> **Started:** 2026-10-29T15:42Z

**Corrected 2026-10-29** (at start, checked against the repository and the spec): (1) "the big five SA banks" are Standard Bank, FNB, Absa, Nedbank and Investec, with Capitec named separately, 26 brands in all; (2) the table is bundled with the Worker (`data/brands.json`, imported by `src/checks/brands.ts`) and KV holds a copy under `brands:v<n>`, `n` the table's own `version`, so it can be refreshed without a deploy: a KV copy that is missing, of another version or that fails the schema is not used, the bundled table is, and the fall back is logged; (3) `scripts/load-brands.ts` writes the key to local KV and, with `--remote`, to the production `CACHE` namespace, reading it back either way; (4) `brandForDomain` matches a host on the brand's registrable domains and their subdomains (`tldts`, the public suffix list: `secure.fnb.co.za` is FNB's, `fnb.co.za.example` is not), and `getBrand` matches display names without regard to case, spacing or punctuation; (5) every domain is sourced from the brand's own website or its official documentation (a page naming the domain, with the date it was read), never from memory, and a brand whose page names none is left out rather than guessed.

**Corrected 2026-10-29** (plan review): (6) a brand's registrable domains are official except where the brand hosts other people's content: each entry lists those hosts (`user_content`, such as `sites.google.com` and `script.google.com`), and `brandForDomain` answers a host there as the brand's platform but not the brand (`official: false`), so a lure on Google Sites never gains Google's standing (D03 T02 §4's mismatch signal keeps working); customer-tenant domains (`sharepoint.com`, `googleusercontent.com`, `azurewebsites.net`) are never listed as a brand's domains; (7) `n` in `brands:v<n>` is the schema version, fixed in code (1); the table's own `revision` (a date) moves with each refresh, so a new revision loaded under `brands:v1` is read without a deploy, and the loader keeps the one it replaced under `brands:v1:previous`, which `--restore` writes back; (8) a KV read is bounded (one second) and a rejected, slow, missing, wrong-version or schema-invalid read falls back to the bundled table, logging which; the reader keeps what it read for 60 seconds an isolate; (9) the loader validates the table before writing, names its target explicitly (`--local` or `--remote`), reads the key back and compares it whole with what it wrote, retrying for KV's eventual consistency (up to 60 seconds), and exits non-zero on a refused write or an unverified read-back; (10) the schema is the whole table's: a `version` of 1, a `revision`, every brand with a name, non-empty display names, non-empty registrable domains (each one `tldts` reads as its own registrable domain), and sources each with an `https` URL on one of the brand's domains, the date it was read and the domains it names, every domain named by some source; the 26 brands named here are each present or listed in the table's `excluded` with the reason.

**Corrected 2026-10-29** (final review): (11) the lookups take the table in force: `getBrand(table, name)`, `brandForDomain(table, host)` and `brandForUrl(table, url)`, the table from `brandTable(env)`, held per namespace; (12) a brand whose own pages could not be read is excluded however well its domain is known (Capitec, Investec and The Courier Guy, each with the reason), and a home page's address alone is not a source; (13) a host that carries other people's content on some paths is not official answered alone, so PayPal, whose invoices any account holder sends from any PayPal host, is official only on a web address whose path is not an invoice or a transfer; DocuSign's `docusign.net`, iCloud, Gmail and `live.com` are their brands' platforms, never the brand speaking; (14) the labels that mark a community or forum host on any brand (`community_labels`) are part of the table, reviewed with it; (15) a KV copy or a loaded table must name every brand the committed table names, as a brand or as excluded, so a wrong file cannot shrink the table in production.

**Phase:** 2
**Needs:** none
**Surface:** no

**Build order:**

1. Write `data/brands.json` with sources. Done when: each brand lists domains and the URL the fact came from.
2. Load it into KV. Done when: `getBrand(name)` reads from KV and falls back to the bundled file.

- [x] Write `data/brands.json` (`version` 1, a `revision`, the brands, `excluded`) covering the 26 brands named in correction (1): the big five SA banks, Capitec, Discovery Bank, TymeBank, Microsoft, Google, Apple, DocuSign, Adobe, SARS, Xero, Sage, DHL, FedEx, Aramex, The Courier Guy, PostNet, Takealot, Netflix, PayPal, Payfast, Yoco, each with `display_names`, `domains`, `user_content` and dated `sources` on the brand's own site, or in `excluded` with why. Done when: `test/checks/brands.test.ts` validates the whole table against the schema of correction (10), refuses an empty table, an empty name or domain list, a malformed or non-registrable domain, a source off the brand's domains, an undated source and a domain no source names, and finds each of the 26 present or excluded. Cheaper substitute: domains from memory without a source. (**Corrected 2026-10-29**, at start and plan review.) Done 2026-10-29: 23 brands, with Capitec, Investec and The Courier Guy excluded (their pages answered HTTP 403 on 2026-10-29; final review); sourced by a research pass and spot-checked against the pages (FNB, Discovery, Yoco, DocuSign); `user_content` for Google, Apple, Microsoft, DocuSign, Adobe and Xero; the source field is `evidence` (a verbatim quote, or what a page read only by its address is).
- [x] Write `scripts/load-brands.ts` (`--local` or `--remote`, `--restore`): validate, keep the current value as `brands:v1:previous`, write `brands:v1`, read it back and compare it whole, retrying up to 60 seconds, through `wrangler kv key` commands it is given (so tests drive it with a fake). Done when: `test/node/load-brands.test.ts` shows each target's commands, an invalid table refused before any write, a refused write and a read-back that never matches each exiting non-zero, and a restore writing the previous value back; and a `--remote` run against production reads its revision back. (**Corrected 2026-10-29**, at start and plan review.) Done 2026-10-29: `test/node/load-brands.test.ts` (6 tests); production `brands:v1` reads back revision 2026-10-29 (`node scripts/load-brands.ts --remote`), after reading the remote API's 404 for a missing key as absent.
- [x] Write `brandTable(env)`, `getBrand(name)` and `brandForDomain(host)` in `src/checks/brands.ts`, reading `brands:v1` from `CACHE` within one second with the bundled table as the fall back (logged), held 60 seconds an isolate. Done when: `test/checks/brands.test.ts`, with KV and bundled tables that differ, proves KV used when valid; the bundled table used, and the reason logged, for a missing, wrong-version, schema-invalid, rejected and stalled read; a new revision read and a restored one read back without a rebuild; names matched without regard to case, spacing or punctuation; `secure.fnb.co.za` FNB's and official, `fnb.co.za.example` and `fnb-co-za.example` no brand's, `sites.google.com` Google's platform but not official; an unknown name or host `null`; each test failing when its behaviour is removed. (**Corrected 2026-10-29**, at start and plan review.) Done 2026-10-29: `src/checks/brands.ts` and `src/checks/brand-schema.ts`; `test/checks/brands.test.ts` (11 tests), proven to fail with the customer-content rule or the KV validation removed.
- [x] Commit: `checks: curated brand domain table` Done 2026-10-29: 6066091, then the review fixes to eef55c5. Test checkpoint 2026-10-29: `pnpm exec vitest run test/checks/brands.test.ts test/node/load-brands.test.ts` 32 passed.

**Test checkpoint:** `pnpm exec vitest run test/checks/brands.test.ts test/node/load-brands.test.ts` passes and fails if an entry lacks a dated source for any of its domains.

> **Verified:** 2026-10-29 | §3 | c36b2300b0e8447b1761a8100a9b791384085618
> **Review:** `docs/reviews/d02-t03-s3.json`

## 4. Domain age from RDAP with caching

A domain registered in the last 30 days is a strong phishing signal (spec 4.3). RDAP (RFC 9083) is queried through the IANA bootstrap; results are cached in KV for 7 days; an outage gives a "not checked" item, never a guess.

> **Started:** 2026-10-30T18:54Z

**Corrected 2026-10-30** (at start, checked against the repository and the live registries): (1) checks are pure (`src/checks/registry.ts`; the brand table's KV read moved to the step, D02 T02 §4), so the lookups run in the Workflow's `checks` step and their results reach the view as `domainAges`; the check maps them to items; (2) the domains are §2's header domains (`headerDomains`), the organisation's own, its suppliers' and the brand table's left out (their age says nothing), From first, at most `MAX_AGE_LOOKUPS` (5) a case, each lookup within `RDAP_TIMEOUT_MS` (4 s), the rest counted as not checked; (3) the IANA bootstrap (publication 2026-10-28T22:00:04Z) has no `za` service, and ZACR's RDAP server (`rdap.registry.net.za/rdap/`) answers 404 for `.co.za` names, so a `.za` domain reads "not checked: no RDAP service for this ending" until §9 reads `.za` ages by WHOIS; the recorded fixtures are a real `.com` response (`test/fixtures/rdap/example-com.json`, from Verisign) and a trimmed bootstrap (`test/fixtures/rdap/dns.json`); (4) an outage is never a guess: when every lookup fails the check throws and the runner writes `not_checked` naming `domain.age`; when some fail, the ages found are items and one info item names the domains not checked and why; (5) KV `CACHE` holds the bootstrap a day (`rdap:bootstrap`) and each registration date seven days (`rdap:domain:<registrable>`), failures uncached; each item's detail carries the domain, the registration date, the RDAP server and the fields it came from.

**Corrected 2026-10-30** (plan review): (6) a 200 answer that is not JSON or is too large is `malformed`, one without a registration event or with an unreadable date is `no-date`, and no other event's date stands in; (7) each lookup ends within `LOOKUP_BUDGET_MS` (5 s), its network work cancelled, whatever the registry, a stalled body or KV does, and never throws, so the step's other checks always run; a KV read or write that fails leaves the lookup working; (8) the cache is proven in KV itself: exact keys (`rdap:bootstrap`, `rdap:domain:<registrable>`), their TTLs, a fresh client reading them, failures never cached, and the band recomputed from a cached date as days pass (29, 30, 89, 90 days); (9) when no age could be read, the reasons are kept: a `.za` ending or an unreadable answer is an info item naming the domain and its reason, and only when no registry answered at all is the check `not_checked` (its error class `RdapUnavailable`); (10) no lookup happens without the original's headers, without a usable domain, when every domain is trusted, or for a reserved name (`.example`, `.test`, `.invalid`, `.localhost`, RFC 2606 and 6761, which cannot be registered); trusted domains are left out before the cap, the From first; (11) the info item names at most ten domains of each kind, with exact counts.

**Phase:** 2
**Needs:** none
**Surface:** no

**Build order:**

1. Write the RDAP client with bootstrap and cache. Done when: a stubbed test reads the registration date from a recorded RDAP response.
2. Register `domain.age`. Done when: 10 days old is high, 200 days is info, and an outage is not checked.

- [x] Write `rdapLookup(domain, deps)` in `src/checks/rdap.ts` resolving the server from `https://data.iana.org/rdap/dns.json` (cached 1 day) and reading the `registration` event date (correction 3). Done when: `test/checks/rdap.test.ts` parses the recorded `.com` response, and a `.co.za` domain reads as having no RDAP service. (**Corrected 2026-10-30**, at start.) Done 2026-10-30: `src/checks/rdap.ts` (`rdapLookup`, `serviceFor`, `domainAgesOf`).
- [x] Cache results in `CACHE` for 7 days keyed by registrable domain. Done when: a second lookup makes no network call. Done 2026-10-30: KV keys and TTLs read back in `test/checks/rdap.test.ts`.
- [x] Register `domain.age` over the view's `domainAges`, filled by the `checks` step (corrections 1 and 2): high under 30 days, medium under 90, info otherwise, with the date and RDAP server as detail. Done when: the test covers each band, and a Workflow read-back test stores a stubbed new domain as high. (**Corrected 2026-10-30**, at start.) Done 2026-10-30: `src/checks/domain-age.ts`; the checks step reads the ages (`domainAges`); `test/checks/rdap.test.ts` (20 tests) with the stored read-backs.
- [x] Map timeouts and non-200 responses to `not_checked` for this check only when every lookup failed, and to an info item naming the domains not checked when some did (correction 4). Done when: a 503 stub yields `not_checked` naming `domain.age`, and a mixed case keeps its found ages. Cheaper substitute: treating unknown age as new. (**Corrected 2026-10-30**, at start.) Done 2026-10-30: six mutations (no lookup deadline, a day's cache, trusted domains looked up, no lookup cap, another event's date, an outage never `not_checked`) each fail a test; 452 tests across checks, pipeline, intake and bindings pass.
- [x] Commit: `checks: domain age from RDAP with caching` Done 2026-10-30: c94105c, with 043b675 (completion review) and dd007c8 (round 1).

**Test checkpoint:** `pnpm exec vitest run test/checks/rdap.test.ts` passes and fails if an outage is reported as a new domain.

> **Verified:** 2026-10-31 | §4 | 2253fa4ba7dc552fd7ff732c175a84a63c81307b
> **Review:** `docs/reviews/d02-t03-s4.json`

## 5. Accent-insensitive lookalikes, measured

The UTS #39 skeleton keeps accents (`fýnbósfreíght` and `fynbosfreight` have different skeletons, distance 3, no added word), as it should, so a name with several accented letters escapes §1's primitives. Browsers compare protected names with the accents set aside; this adds that as a separate technique beside the skeleton, never a change to it, and measures what it catches against what it wrongly flags. Filed 2026-10-29 from D02 T03 §1's completion review (Part 2, items 3 and 4): no measured comparison of detection, false positives or timing exists for the lookalike primitives yet, and this section makes one.

**Phase:** 7
**Needs:** none
**Surface:** no

**Build order:**

1. Build a synthetic lookalike corpus and a benign one. Done when: both are committed with their generation script.
2. Add the accent-insensitive comparison and measure it with §1's primitives. Done when: the record names detections, false positives and timings for each technique and the chosen thresholds.

- [ ] Write `scripts/fixtures/make-lookalikes.ts` generating `test/fixtures/lookalikes/` (each brand and organisation name in the fixtures with one, two and three accented letters, swapped, doubled and confusable letters, and added words) and a benign set of real accented business names that are not lookalikes of any fixture name. Done when: both files are committed, deterministic from a seed, and the script's `--check` passes.
- [ ] Write `foldAccents(label)` in `src/checks/lookalike.ts`: NFD, every combining mark (`\p{M}`) removed, NFC, kept apart from `skeleton`. Done when: `test/checks/lookalike.test.ts` gives `fynbosfreight` for `fýnbósfreíght` and `skeleton` still gives three differences.
- [ ] Measure each technique (skeleton equality, distance at most 1 and 2, added words, accent folding, and folding then skeleton) on both sets, with timings, in `scripts/measure-lookalikes.ts`, against a pinned alternative implementation of UTS #39 run on the same inputs. Done when: `docs/evals/lookalikes.md` records detections, false positives and microseconds a label for each, and names at least one measured advantage, or none if there is none.
- [ ] Add accent folding to §2's comparison only at the threshold the measurement chose, citing it. Done when: §2's check flags `fýnbósfreíght` against `fynbosfreight` and none of the benign set.
- [ ] Commit: `checks: accent-insensitive lookalikes, measured`

**Test checkpoint:** `pnpm exec vitest run test/checks/lookalike.test.ts` passes and `docs/evals/lookalikes.md` holds the measured table.

## 6. Right-to-left lookalike labels

§1 gives no skeleton for a label with a right-to-left character (Bidi_Class R or AL), so §2 reports such a label as not compared rather than comparing it wrongly. UTS #39's `bidiSkeleton` compares labels as they are displayed, after the Unicode Bidirectional Algorithm reorders them; this builds that, so Hebrew and Arabic labels can be compared with each other and with mixed-direction lookalikes. Filed 2026-10-29 from D02 T03 §1's completion review (Part 2, item 2).

**Phase:** 7
**Needs:** none
**Surface:** no

**Build order:**

1. Implement the reordering UTS #39 names for a single label. Done when: the reordered output matches the Unicode BidiCharacterTest.txt cases for single-paragraph, isolated input.
2. Compare right-to-left labels by their display-order skeleton. Done when: confusable and unrelated Hebrew and Arabic pairs give the expected results.

- [ ] Vendor `BidiCharacterTest.txt` and `BidiBrackets.txt`/`BidiMirroring.txt` (18.0.0) beside §1's tables with their digests, and extend `scripts/build-confusables.ts` with the mirroring data. Done when: `test/node/confusables-map.test.ts` passes with the new sources.
- [ ] Write `bidiSkeleton(direction, label)` in `src/checks/lookalike.ts` (UAX #9 up to L2 for an isolated label, L3, L4 mirroring, then `internalSkeleton`), with `skeleton` returning it for a right-to-left label instead of `null`. Done when: `test/checks/lookalike.test.ts` matches BidiCharacterTest.txt's single-label cases and gives equal skeletons for a confusable Hebrew pair and an Arabic pair, unequal for unrelated pairs.
- [ ] Have §2's check compare right-to-left labels and drop its "not compared" item for them. Done when: §2's tests flag a right-to-left lookalike of a right-to-left fixture name.
- [ ] Commit: `checks: right-to-left labels compared by display order`

**Test checkpoint:** `pnpm exec vitest run test/checks/lookalike.test.ts` passes, including the BidiCharacterTest.txt cases.

## 7. Lookalike check on link and landing hosts

> **Started:** 2026-11-01T17:05Z

Filed 2026-10-30 from §2's start (its correction 1): §2 compares the header domains, since nothing extracts a message's links yet. Once URL extraction (D02 T07 §1) and landing pages (D02 T07 §3) exist, every link host and landing host goes through the same comparison, so a lookalike in a link is found as one in a From is.

**Corrected 2026-11-01** (at start, checked against `src/checks/domain-lookalike.ts`, `src/checks/case-view.ts` and `src/checks/links.ts`): (1) the candidates are one merged list: the header domains first (their fields and cited headers as today), then each link host (`in a link`), each landing host a followed link settled on (`on the page it lands on`) and each host it passed through (`behind a redirect`), deduplicated by registrable domain with their fields merged, all under the same `MAX_COMPARED` bound, the rest named in the same unread item; an organisation's own or a trusted domain is exempt wherever it was found, as today; (2) the comparison, technique severities, detail shape and bounds do not change; only where a candidate was found is new.

**Phase:** 3
**Needs:** none
**Surface:** no

**Build order:**

1. Run the lookalike comparison over link and landing hosts. Done when: a lookalike in a link or behind a redirect is an item naming the host, the target and the technique.

- [x] Feed the hosts D02 T07 §1 extracts and D02 T07 §3 lands on into `domain.lookalike` (`src/checks/domain-lookalike.ts`), each with where it was found. Done when: `test/checks/domain-lookalike.test.ts` finds a lookalike link host and a lookalike landing host, and a link to the organisation's own domain is never flagged. (**Corrected 2026-11-01**, plan review, `docs/reviews/02-checks/D02-T03-s7.md`: (3) the check runs whenever the case has hosts to compare: with the original's headers unavailable but links or followed pages present (an inline forward, an uploaded document), it compares those, and skips only when there is nothing at all; (4) every extracted link host is compared whether or not it was followed; a settled page's host is `on the page it lands on` only for a `done` outcome, and a host from an interrupted chain is `behind a redirect`, never a settled landing; the check's outcome is `partial` while link or expansion parts went unread; (5) each item's detail carries its provenance (`found`: where, the address it was found in and its part, at most 5, the rest counted) beside the header citations, merged when one domain is found in several places; the tests also cover a redirect-only lookalike, header and link deduplication, candidates past `MAX_COMPARED` with the exact unread count, and the stored evidence read back through the checks runner.)
- [x] Commit: `checks: lookalike link and landing hosts`

**Test checkpoint:** `pnpm exec vitest run test/checks/domain-lookalike.test.ts` passes.

> **Unstamped:** 2026-11-01: stamp check quoted 35 tests, the checkpoint run shows 34; restamp with the quoted result corrected (revoked receipt `docs/reviews/d02-t03-s7.revoked-2026-11-01.json`)

> **Verified:** 2026-11-01 | §7 | b194cfedc41d6507e641b50be1e54016612cf74a
> **Review:** `docs/reviews/d02-t03-s7.json`

## 8. Repeated-name lookalikes

Filed 2026-10-30 from §2's completion review (out of scope): §2's techniques miss names that repeat or extend the real one beyond two edits and outside the added-word list, such as Microsoft's own example `contosososo.com` for `contoso.com`. Broader matching risks false positives, so it is added only against a labelled corpus.

**Phase:** 7
**Needs:** none
**Surface:** no

**Build order:**

1. Add the families and measure them. Done when: recall on the repetition and extension families improves on §5's corpus without the false-positive rate passing 2%.

- [ ] Add repetition and extension families (a repeated syllable, a doubled label part, the real name inside a longer label) with benign neighbours to the labelled corpus §5 builds (`test/fixtures/lookalike/`). Done when: the corpus holds at least 20 of each family and 20 benign neighbours.
- [ ] Add the technique to `techniqueOf` in `src/checks/domain-lookalike.ts` behind the corpus's measurement, recording recall and false positives per technique in `docs/frontier-log.md`. Done when: the measured false-positive rate is at most 2% and the log entry exists.
- [ ] Commit: `checks: repetition and extension lookalikes`

**Test checkpoint:** `pnpm exec vitest run test/checks/domain-lookalike.test.ts` passes with the corpus cases.

## 9. Domain age for .za by WHOIS

Filed 2026-10-30 from §4's start (its correction 3): the IANA RDAP bootstrap has no `za` service and ZACR's RDAP server does not answer for `.co.za` names, so §4 reads every `.za` domain as not checked. ZACR's port-43 WHOIS does (`coza-whois.registry.net.za` gave google.co.za's `Creation Date: 2001-06-25T20:37:59Z` on 2026-10-30), and most of the mail IsItLegit checks names `.co.za` domains, so their age is read there.

> **Started:** 2026-10-31T01:55Z

**Corrected 2026-10-31** (at start, checked against the repository and ZACR's servers): (1) the four zones' servers answered on port 43 on 2026-10-31: `coza-whois.registry.net.za` (google.co.za `Creation Date: 2001-06-25T20:37:59Z`, standardbank.co.za `1996-11-23T22:00:00Z`), `net-whois.registry.net.za` (absa.net.za `2016-10-28T11:59:35Z`; mweb.net.za's `2026-03-04` is a re-registration, not a migration stamp, since absa.net.za's is older), `org-whois.registry.net.za` and `web-whois.registry.net.za` (each answered a registered name with no dates, read as `no-date`); a name not registered answers `Available` and "No information was found matching that query", read as a new reason, `not-registered`, which `src/checks/domain-age.ts` words; (2) the answer is attributed only when its `Domain Name` line names the domain asked for, else `malformed`; (3) the socket is `RdapDeps.connect` (optional, so a caller without it reads `.za` as before), given `connect` from `cloudflare:sockets` by the Workflow; the lookup stays within `LOOKUP_BUDGET_MS`, the socket closed on the budget's abort; (4) the live check runs in the Workers runtime itself (`test/checks/whois-live.test.ts`, workerd's `connect()` against ZACR, run only with `LIVE_WHOIS=1`) and is recorded in `docs/live-checks.md`; the same check from the deployed Worker is the coordinator's, at the next deploy (deploys are the coordinator's; asked 2026-10-31).

**Corrected 2026-10-31** (from the plan review, `docs/reviews/02-checks/D02-T03-s9.md`): (5) the Workflow's lookup dependencies come from `rdapDeps(env)` in `src/pipeline/analysis-workflow.ts`, tested to carry `cloudflare:sockets`' `connect`, and a checks-step test reads a new `.co.za` domain's high `domain.age` item back from D1 with its domain, age and WHOIS server; (6) the tests cover all four zones' servers, an answer naming another domain or none, the recorded availability answer, a registered answer without a date, and each reason's wording through `domain.age` beside an age that was read; (7) a WHOIS date is cached under `rdap:domain:<domain>` for seven days, read back from KV, and a fresh caller makes no connection; a failed or not-registered lookup is not cached, so a recovered server is asked again; (8) a failed connection, `opened`, write or read returns `unavailable` with the socket closed, `closed`'s rejection is handled, and closing is asserted on the oversized and timed-out answers; (9) the first item's `whoisLookup` is built as two parts, `whoisAnswer` (the socket, bounded) and `readWhois` (the answer read), composed in `rdapLookup`'s WHOIS branch in `src/checks/rdap.ts`.

**Phase:** 2
**Needs:** none
**Surface:** no

**Build order:**

1. Read `.za` registration dates by WHOIS from the Worker. Done when: a stubbed WHOIS answer for a `.co.za` domain gives its age through `domain.age`, and an unreachable WHOIS is not checked.

- [x] Write `whoisLookup(domain, deps)` in `src/checks/whois.ts` over a Workers TCP socket (`connect` from `cloudflare:sockets`) to the zone's WHOIS server (`co.za`, `org.za`, `net.za`, `web.za`, as ZACR lists them), bounded in bytes and time, reading `Creation Date`. Done when: `test/checks/whois.test.ts` parses a recorded answer, refuses an oversized or slow one, and reads a missing date as not checked.
- [x] Use it in `rdapLookup`'s place for `.za` domains, cached as RDAP results are. Done when: `test/checks/rdap.test.ts` reads a `.co.za` age through the stub, and a live check of one `.co.za` domain from the Workers runtime is recorded in `docs/live-checks.md` (correction 4).
- [x] Commit: `checks: .za domain age by WHOIS` Done 2026-10-31: 18964e2b, with the completion review's fix after it.

**Test checkpoint:** `pnpm exec vitest run test/checks/whois.test.ts test/checks/rdap.test.ts` passes.

> **Verified:** 2026-10-31 | §9 | b24292256251a4587b84519c9e358012afe909a8
> **Review:** `docs/reviews/d02-t03-s9.json`


## 10. Domain age for link and landing hosts

Filed 2026-10-31 from §9's completion review (gap 3): `domain.age` reads the header domains only (`domainAgesOf` in `src/checks/rdap.ts`), so a message from an established sender carrying a link to a `.co.za` domain registered last week gets no age for that domain. §7 covers lookalikes on link and landing hosts, not their age.

> **Started:** 2026-11-01T17:31Z

**Corrected 2026-11-01** (at start, checked against `src/checks/rdap.ts`, `src/checks/domain-lookalike.ts` and `src/pipeline/analysis-workflow.ts`): (4) `domain.age` reads partial while link or expansion parts went unread (unread or overflow link parts, skipped expansions, unfinished chains, links never followed), with the ages found kept, and its skip wording no longer speaks of headers only; (5) the tests prove the handoff through the checks step with stored evidence read back: a link-only case without the original's headers, a settled landing host, an interrupted redirect host, one lookup per registrable domain, header domains first and the exact unread count past the cap. (1) the candidates are §7's merged list (`candidatesOf`: header domains first, then link hosts, redirect hop hosts and settled landing hosts, deduplicated by registrable domain with where each was found in its fields), so a domain in both a header and a link is looked up once with both fields; trusted and reserved names are left out before the `MAX_AGE_LOOKUPS` cap, as today, and the rest stay in the same unread count; (2) the checks step passes the built view (links and expansions included) to `domainAgesOf`, not the raw read, which has neither; (3) each age item's summary and detail name the fields it was seen in, so a link or landing age names the link or the page it lands on, and the stored item keeps §7's provenance beside it.

**Phase:** 3
**Needs:** none
**Surface:** no

**Build order:**

1. Look up the registrable domains of the message's links and their landing pages beside the header domains. Done when: a link to a domain registered five days ago is a high `domain.age` item naming the link, and the header domains keep their lookups first within `MAX_AGE_LOOKUPS`.

- [x] Add the link hosts (D02 T07 §1's extracted URLs) and landing hosts (D02 T07 §3's final pages) to `domainAgesOf` in `src/checks/rdap.ts`, after the header domains, each named with where it was seen, within the lookup limit and the unread count. Done when: `test/checks/rdap.test.ts` reads a young link domain's age through the stub and counts the rest as unread.
- [x] Name the link or landing page in `domain.age`'s summary and detail in `src/checks/domain-age.ts`. Done when: the stored item names the link.
- [x] Commit: `checks: domain age for link and landing hosts`

**Test checkpoint:** `pnpm exec vitest run test/checks/rdap.test.ts` passes.

> **Verified:** 2026-11-01 | §10 | a281839fc0c4dd1c5cf86810167ddb059cb4f02c
> **Review:** `docs/reviews/d02-t03-s10.json`

## 11. Demo domains kept apart in the checks

> **Started:** 2026-11-01T04:05Z

**Corrected 2026-11-01 (plan review):** a third item for `split()`, which re-parses the registrable domain and would still see every demo domain as `isitlegit` under `co.za`; the lookalike check is tested through `lookalikeEvidence()` and added to the checkpoint.

**Corrected 2026-11-01:** the first item named the senders' `registrable()` as the one to use; it ignores the public suffix list's private section, so using it would reduce `x.github.io` to `github.io` and the second item's `claimable()` is a column predicate, not a filter over a JSON list. Both items now say what is built.

Filed 2026-10-31 from D07 T02 §20's completion review (the app lane's, through the coordinator): D07 T02 §20 makes `registrable()` in `src/auth/senders.ts` treat `demo.isitlegit.co.za` as a private suffix, so each `<name>.demo.isitlegit.co.za` is its own registrable domain, and adds `claimable()` for the organisation domains that may count as verified. The checks keep two copies of the old rule: (1) `registrable` in `src/checks/brand-schema.ts:12` (the public suffix list with its private section, no demo suffix), so two demo organisations' domains both reduce to `isitlegit.co.za` and a link showing one demo organisation's domain while going to another's gets no mismatch evidence (`src/checks/links.ts`); (2) `src/checks/suppliers.ts` reads verified `org_domains` rows directly, so a claim on `isitlegit.co.za` left from before §20's fix would still count as a verified supplier or own domain.

It builds on D07 T02 §20's `registrable()` and `claimable()`, which reach `main` with §20's stamp (the app lane's branch `app-demo-suffix`); §20 is added to this row's Depends On at the merge that brings it here, since the graph refuses a reference it cannot yet resolve.

**Phase:** 3
**Needs:** none
**Surface:** no

**Build order:**

1. One registrable rule. Done when: the checks reduce a host to its registrable domain through §20's `registrable()` (or its `DEMO_SUFFIX`), every other private suffix of the public suffix list kept.
2. Only claimable domains trusted. Done when: an organisation's own and supplier domains are read through §20's `claimable()`.

- [x] Add the demo boundary to the checks' own `registrable` in `src/checks/brand-schema.ts`, importing `DEMO_SUFFIX` from `src/auth/senders.ts` (the app lane's constant; that file is not edited here): a host under `demo.isitlegit.co.za` reduces to the label directly under the suffix plus the suffix, the suffix itself to null, every other host to what the public suffix list's private section gives it as before. Not the senders' `registrable()` itself: it ignores private suffixes (`allowPrivateDomains: false`) and the checks need them kept (`x.github.io`, `x.blob.core.windows.net`). Done when: `test/checks/brands.test.ts` reduces `mail.fynbos.demo.isitlegit.co.za` to `fynbos.demo.isitlegit.co.za`, `demo.isitlegit.co.za` to null, `a.github.io` to `a.github.io`, and `test/checks/links.test.ts` reads a mismatch for link text naming `fynbos.demo.isitlegit.co.za` whose destination is `karoo.demo.isitlegit.co.za`, none for a same-organisation subdomain (`mail.fynbos.demo.isitlegit.co.za`), and the brand table still validates (`test/checks/brands.test.ts`).
- [x] Make `split()` in `src/checks/domain-lookalike.ts` demo-aware: for a registrable domain under `demo.isitlegit.co.za` the label is the one label before the suffix and the suffix is `demo.isitlegit.co.za` (it re-parses the domain with `tldts`, which gives every demo domain the label `isitlegit` and suffix `co.za`, so no technique would match). Exported for the impersonation monitor (D05 T04 §1), which splits its candidates the same way. Done when: `test/checks/domain-lookalike.test.ts` runs `lookalikeEvidence()` over a case whose organisation verified `fynbos.demo.isitlegit.co.za` and whose From is `fynb0s.demo.isitlegit.co.za` and reads evidence for the lookalike (a skeleton match, label against label); reads none for an unrelated demo organisation (`karoo.demo.isitlegit.co.za`) and none for the organisation's own subdomain (`mail.fynbos.demo.isitlegit.co.za`); and `split()` of both returns the labels `fynb0s` and `fynbos` with the suffix `demo.isitlegit.co.za`.
- [x] Have `listOwnDomains` and `listSupplierDomains` in `src/checks/suppliers.ts` keep only claimable domains: `listOwnDomains` adds `AND ${claimable()}` to its `org_domains` query, and `listSupplierDomains` filters `d.value` with `claimable("d.value")` (a supplier's domain list is not an `org_domains` row, and a supplier domain of IsItLegit's own must not count as a supplier either). Done when: `test/checks/suppliers.test.ts` stores an old-style verified `isitlegit.co.za` row and a supplier listing it and reads neither as an own or a supplier domain, while a verified demo organisation domain (`fynbos.demo.isitlegit.co.za`) still is both.
- [x] Commit: `checks: demo domains kept apart in the checks`

**Test checkpoint:** `pnpm exec vitest run test/checks/links.test.ts test/checks/suppliers.test.ts test/checks/brands.test.ts test/checks/domain-lookalike.test.ts` passes.

> **Verified:** 2026-11-01 | §11 | ee31ac2631390e819d3b65af1f03b4823256642f
> **Review:** `docs/reviews/d02-t03-s11.json`

## 12. Lookalike clean summary names the domains compared

> **Started:** 2026-11-04T00:40Z

**Corrected 2026-11-04 (plan review):** (1) `lookalikeSummary` takes the registrable domains actually compared inside the candidate loop (`comparedDomains`, after exempt domains, unsupported labels, and the `MAX_COMPARED` cap), never `examined`'s full candidate list, and reports `"trusted or reserved domains only, none compared"` when all candidate domains were exempt (`exemptSkipped > 0` and none compared); tests cover an exempt domain before a compared domain, candidates beyond `MAX_COMPARED`, and an all-exempt run; (2) truncation reserves space for `, some not compared` before clipping the first domain so both ordinary and partial summaries stay within the 120-character outcome bound, proven with a valid multi-label registrable domain exceeding the available room and read back from stored `case_check_outcomes` rows.

Filed 2026-11-03 from D07 T03 §44's completion review (`docs/reviews/07-app/D07-T03-s44.md`, gaps 1 and 4, and round 1's P3 on `design/SPEC.md` M3): when `domain.lookalike` runs clean, `lookalikeSummary` in `src/checks/domain-lookalike.ts` stores "no lookalike of a known name", so the report's Checks that found nothing cannot say what the check looked at, where the board (`Report-Safe`) shows the domains seen. This section makes the clean summary name how many domains were compared and the first of them, inside D02 T01 §7's 120-character bound; the report already draws the stored summary (D07 T03 §44).

**Phase:** 7
**Needs:** none
**Surface:** no

**Build order:**

1. Say what a clean lookalike check compared. Done when: a clean lookalike outcome's stored summary names the count of domains compared and the first registrable domain, and a check that compared none says so.

- [x] Give `lookalikeSummary` in `src/checks/domain-lookalike.ts` the domains the check compared (the header and link registrable domains its `examined` hook already lists, D02 T01 §8), and write a clean summary of the form "no lookalike among 3 domains, from fynbosfreight.example", the first domain cut so the whole stays inside D02 T01 §7's 120-character bound. Done when: `test/checks/domain-lookalike.test.ts` reads back that summary for a clean three-domain case, a one-domain case in the singular, and a 63-character hostname cut inside the bound.
- [x] Keep the uncompared wording: a clean run with some domains not compared still says so, after the count. Done when: a test with one compared and one uncompared domain reads "no lookalike among 1 domain compared, from <domain>, some not compared".
- [x] Record the board's lookalike words as met in `design/SPEC.md` M3 (round 1's P3 at `design/SPEC.md:740`). Done when: M3 names the lookalike summary's form and `python3 design/tools/check-design.py` passes.
- [x] Commit: `checks: lookalike clean summary names the domains compared`

**Test checkpoint:** `pnpm exec vitest run test/checks/domain-lookalike.test.ts` passes, and fails if a clean summary names no domain when one was compared.

> **Verified:** 2026-11-04 | §12 | 55ae27be71fd4a021f0f32d9c29391c3465ffc27
> **Review:** `docs/reviews/d02-t03-s12.json`

## Verification

- Lookalike, brand and age fixtures produce the expected evidence; outages leave "not checked".
- `pnpm test` passes; `python3 scripts/todo-graph.py validate` and `plan --check` pass.
