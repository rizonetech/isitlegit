---
schema_version: 1
id: day0-accounts
domain: 99-manual
status: active
title: "TODO-01 -- Operator Accounts, Keys and Domain for the Build"
track: day-0
---

# TODO-01 -- Operator Accounts, Keys and Domain for the Build

> **Goal:** Every account, key, plan and domain step that only Derick can take is done, each key is in the Conclave 1Password vault, and the build sections that depend on them can run.

> **Current state:** Measured 2026-10-26 16:45 SAST. Cerebral Valley account (the operator's Rizonetech address) approved 2026-10-20. Meta Model API credit claim form submitted 15:51; credit not yet visible under Billing; no payment method, spend limit or API key recorded. `isitlegit.co.za` registered at Domains.co.za 12:06 (expires 2027-10-26), status `serverHold` with the registrant unverified; nameserver change to `carmelo.ns.cloudflare.com` and `paris.ns.cloudflare.com` queued; Cloudflare zone pending. Workers Paid plan not confirmed (the API cannot read billing). Vault holds "Rizonetech SMTP2GO"; no WhatsApp app, Google Web Risk key or partner credits yet.

## Inputs

- `docs/plans/2026-10-26-phishing-invoice-analyser.md` Day 0, "Derick (accounts, cannot be delegated)".
- `sources/cerebralvalley/2026-10-26-credit-claim.md`: the credit rule and deadline.
- `docs/specs/2026-10-26-tech-stack-design.md` "Secrets and configuration" and "Open items".
- -> XREF: D00 T01 §7 -- the smoke test that waits for the Meta key and visible credit from §1
- -> XREF: D00 T01 §5 -- the deploy that relies on the Workers Paid plan from §3
- -> XREF: D01 T01 §15 -- the second inbound route a move off Cloudflare waits on (§9's runbook)

## Outcome

- The Meta Model API shows the US$150 under Billing, "free credits", with a card on file and a US$150 Spend Limit notification, and the key is in the vault.
- `isitlegit.co.za` is out of `serverHold` and the Cloudflare zone is `active`.
- The Rizonetech Cloudflare account is on Workers Paid.
- SMTP2GO and Google Web Risk credentials are in the vault, each named in the stack doc's secrets list (**Corrected 2026-10-27:** the Fireworks, then Baseten, credential for Glimmer is no longer needed: the operator removed the outside providers, and Muse Spark on the Meta Model API screens pages).
- The operator's Rizonetech mailbox is a verified Email Routing destination, so the test-mailbox, demo-alert and `conduct@` aliases can forward to it.

**Adjacency:** all=not-applicable (operator account tasks with no product records)

**Adjacency rationale:** These are one-off account actions outside the repository; their results are recorded here and in the vault, not in the product.

## Implementation Order

| Order | Section | Deliverable | Depends On | Status |
| ----- | ------- | ----------- | ---------- | ------ |
| 1 | §1 | Meta API billing and API key | -- | [x] |
| 2 | §2 | Domain verification and nameservers | -- | [x] |
| 3 | §3 | Workers Paid plan | -- | [x] |
| 4 | §4 | SMTP2GO sender domain | §2 | [x] |
| 5 | §5 | WhatsApp test number | -- | [ ] |
| 6 | §6 | Google Web Risk API key | -- | [x] |
| 7 | §7 | Partner credits for Glimmer | -- | [x] |
| 8 | §8 | AI Gateway tokens | -- | [x] |
| 9 | §9 | Domain and mail recovery runbook | §2, §4 | [x] |
| 10 | §10 | Web Risk key restriction read from Google | §6 | [ ] |
| 11 | §11 | SMTP2GO key permissions and senders read back | §4 | [ ] |

## 1. Meta API billing and API key

> **Started:** 2026-10-28T21:11:26Z

**Corrected 2026-10-28:** the Started line first read 2026-10-28T20:32:02Z, written before the plan review; the section's build (the checkpoint fixes and `scripts/check-meta-key.py`) began after that review, at this commit's time, so the line records that.

Credits apply in batches after the claim form; until they show, every call is charged to the card (`sources/cerebralvalley/2026-10-26-credit-claim.md`).

**Phase:** 99
**Needs:** none
**Surface:** no

**Corrected 2026-10-28** (at start): every operator step below is done and carries its evidence, so `operator` leaves Needs; the checkpoint was re-run today and passes.

**Build order:**

1. Add the payment method and Spend Limit notification on the Billing page. Done when: Billing shows the card and a US$150 notification.
2. Create the API key and store it in the vault. Done when: the vault item exists; the key is never pasted into chat.
3. Wait for the credit. Done when: Billing, "free credits" shows US$150.

- [x] Add a payment method on the Meta Model API Billing page. Done when: Billing lists the card. Evidence 2026-10-27 01:37 SAST: the operator confirmed it on the Meta Model API Billing page.
- [x] Set a Spend Limit notification at US$150. Done when: Billing shows it. Evidence 2026-10-27 01:37 SAST: the operator confirmed it on the Meta Model API Billing page.
- [x] Create an API key named `isitlegit-hackathon` and store it in the Conclave vault as "IsItLegit Meta Model API" (Claude created the empty item on 2026-10-27; the operator pastes the key into its credential field). Done when: the vault item exists. Cheaper substitute: pasting the key into chat or a file. Evidence 2026-10-27 00:50 SAST: the operator filled the vault item; a free model listing with it returned 200 and lists muse-spark-1.3, muse-wonder-1.0, sam-3.1 and muse-voice-transcribe-1.0.
- [x] Confirm US$150 under Billing, "free credits", and record it here as a line `Meta credit visible: YYYY-MM-DD`. Done when: the line is written; every `meta-api` section checks for it before its first call. Evidence: the operator reported the credit showing on Billing at 00:40 SAST on 2026-10-27.
The key and the credit are on one Meta Model API team: the operator created the key in the same Model API dashboard whose Billing shows the hackathon credit (2026-10-27, items above), and the key's live calls are billed there (`docs/meta-smoke-test.md`, `docs/live-checks.md`). The `Meta credit visible` line proves the credit was visible on that date, not what remains; remaining spend is the budget guard's (D03 T01 §2).

- [x] Commit: `todo: record the Meta Model API account as ready`

Meta credit visible: 2026-10-27

**Test checkpoint:** `python3 scripts/check-meta-key.py` exits 0 and prints `HTTP 200, <n> models listed, muse-spark-1.3 among them; key shape ok`: the vault's key has Meta's shape, is the recorded key (the SHA-256 of its public numeric id matches `EXPECTED_KEY_ID`, so another team's working key fails before any call; round 2 found a working foreign key passed), and Meta accepts it on its free model list, so a placeholder, a revoked or a replaced key fails, and a stalled vault (60 s) or network (30 s) fails with a reason; the key is never printed (`tests/scripts/test_check_meta_key.py`). **Corrected 2026-10-28** (the final review): it counted the credential's bytes, which proved only that something was stored; earlier still it called bare `op item get`. Evidence 2026-10-28 23:12 SAST: `check-meta-key: HTTP 200, 9 models listed, muse-spark-1.3 among them; the recorded key`, exit 0.

> **Verified:** 2026-10-28 | §1 | fa9e5be213fadf9c075c398b2a2cf6a93a7c5552
> **Review:** `docs/reviews/d99-t01-s1.json`

## 2. Domain verification and nameservers

> **Started:** 2026-10-28T21:11:56Z

**Corrected 2026-10-28:** the Started line first read 2026-10-28T20:32:02Z; it is recorded again at this commit, which the plan review reads, so the review comes before the build as the process requires.

`isitlegit.co.za` was on `serverHold` until the registrar released it; the nameserver change to Cloudflare was queued behind it. **Corrected 2026-10-28** (plan review): it read "until the registrant contact is verified", but Domains.co.za needs no contact verification (struck item below, operator 2026-10-27); what mattered was the hold lifting.

**Phase:** 99
**Needs:** none
**Surface:** no

**Corrected 2026-10-28** (at start): every operator step below is done and carries its evidence, so `operator` leaves Needs; the checkpoint was re-run today and passes.

**Build order:**

1. Get the domain released from `serverHold` and delegated to Cloudflare. Done when: the registrar reads status `ok` and public DNS names Cloudflare's nameservers (**Corrected 2026-10-28:** it required a verified registrant contact, which the operator's 2026-10-27 decision below made unnecessary).
2. Confirm the nameservers. Done when: the Cloudflare zone reads `active`.

- [x] Find the Domains.co.za verification email in Rizonetech's registrant contact mailbox and complete it. Done when: the Domains.co.za domain page no longer shows `serverHold`. Evidence 2026-10-27 00:30 SAST: the registrar reports status `ok` (EPP `ok`); its registrant contact still reads `Unverified`, covered by the next item.
- [x] Confirm the nameservers are `carmelo.ns.cloudflare.com` and `paris.ns.cloudflare.com`. Done when: `dig +short NS isitlegit.co.za @1.1.1.1` prints both.
- [x] Confirm zone `88aeec6df134bc59bfa16a25751241ef` is active in Cloudflare. Done when: the zone status reads `active`. Evidence 2026-10-27 00:30 SAST: the registrar and 1.1.1.1 (DNS over HTTPS) list both nameservers and the zone reads `active`.
- [x] ~~Complete the Domains.co.za registrant contact verification email sent to `hostmaster@rizonetech.com`. Done when: the registrar's registrant contact reads verified.~~ **Struck 2026-10-27 (operator):** Domains.co.za does not require contact verification; the registrant contact's `Unverified` flag needs no action, and no verification email exists in either mailbox.
- [x] Enable Email Routing on the zone and add `hostmaster@rizonetech.com` (the operator's mailbox, operator 2026-10-27) as its destination address. Done when: Email Routing reads `ready` with Cloudflare's MX, SPF and DKIM records and the destination exists. Evidence 2026-10-27 00:30 SAST: routing `ready`; MX route1 to route3, SPF `include:_spf.mx.cloudflare.net`, DKIM `cf2024-1`; destination created, unverified.
- [x] Publish DMARC `p=reject` (operator 2026-10-27) with reports to `dmarc@isitlegit.co.za`, and CAA records allowing only the certificate authorities Universal SSL uses (`letsencrypt.org`, `pki.goog`, `ssl.com`). Done when: both read back from the zone (**Corrected 2026-10-28** (final review): Cloudflare's Universal SSL adds its own CAA rows for Sectigo's `comodoca.com` and DigiCert beside the three published here; all five read back from the zone on 2026-10-28, and the checkpoint allows exactly those five). Evidence 2026-10-27 00:30 SAST: `_dmarc` TXT and three CAA `issue` records present.
- [x] Turn on auto-renew (operator 2026-10-27). Done when: the registrar reads `autorenew: true`. Evidence 2026-10-27 00:30 SAST: it does; the domain expires 2027-10-26 and the reseller balance is R9.45, flagged low.
- [x] Turn on DNSSEC in Cloudflare. Done when: Cloudflare returns the DS record. Evidence 2026-10-27 00:30 SAST: pending, DS `isitlegit.co.za. 3600 IN DS 2371 13 2 360CD8AC177997F22F9239EF3EB686AAAEDF101C211B330C684B723928504665`.
- [x] Add that DS record at Domains.co.za (key tag 2371, algorithm 13, digest type 2, the digest above); the connector has no DS tool, so the operator pastes it in the portal. Progress: Evidence 2026-10-27 00:40 SAST: the registrar reads `bDNSSec: true` with exactly that record; the `.co.za` zone does not publish it yet, so Cloudflare still reads `pending`. Done when: the registrar reads `bDNSSec: true`, Cloudflare's DNSSEC reads `active`, and 1.1.1.1 answers with the AD flag set. Evidence 2026-10-27 00:55 SAST: the registrar reads `bDNSSec: true`, the co.za servers publish DS 2371 13 2, Cloudflare's DNSSEC reads `active`, and `dig +dnssec isitlegit.co.za SOA @1.1.1.1` returns the `ad` flag.
- [x] Turn on the registrar transfer lock once DNSSEC is active (operator 2026-10-27). Done when: the registrar reads `locked`. Evidence 2026-10-27 00:55 SAST: the registrar reads `locked`.
- [x] Click the Cloudflare Email Routing verification link sent to the operator's Rizonetech mailbox once Claude has added it as a destination address (design spec section 11, Mailbox). Done when: the zone's Email Routing destination addresses list it as verified. Evidence 2026-10-27 00:40 SAST: the destination reads verified; the `hello@`, `conduct@` and `dmarc@` rules are enabled.
- [x] Add an Email Routing custom address `hello@isitlegit.co.za` forwarding to the operator's mailbox (named on the about page, D07 T06 §8). Done when: a test mail to it arrives. Evidence 2026-10-27 00:59 SAST: the test "IsItLegit routing test (hello@)" from rizonetech@gmail.com, sent 22:58:56 UTC on 2026-10-26, arrived in derick@rizonetech.com seconds later (internetMessageId `<CA+OCnvm2p3BUGO6k=ErfsauOqTjLiufUef5E99C-Lmp9WoiKXg@mail.gmail.com>`).
- [x] Add an Email Routing custom address `dmarc@isitlegit.co.za` forwarding to the operator's mailbox (DMARC aggregate reports). Done when: the rule reads enabled and a test mail to it arrives in the operator's mailbox (**Corrected 2026-10-28** (plan review): "rule reads enabled" did not prove delivery). Evidence 2026-10-27 00:40 SAST: enabled. Evidence 2026-10-28 23:13 SAST: the test "IsItLegit routing test (dmarc@) 2026-10-28" from rizonetech@gmail.com, sent 21:13:39 UTC, arrived in derick@rizonetech.com at 21:13:48 UTC (internetMessageId `<CA+OCnvkunt34fuzUosHJvddeCsQWO7x3SS0PM-jO0ZkMN-5BKw@mail.gmail.com>`).
- [x] Add an Email Routing custom address `conduct@isitlegit.co.za` forwarding to the operator's mailbox (named in `CODE_OF_CONDUCT.md` as the private conduct contact). Done when: a test mail to it arrives in the operator's mailbox. Evidence 2026-10-27 00:59 SAST: the test "IsItLegit routing test (conduct@)" from rizonetech@gmail.com, sent 22:58:56 UTC on 2026-10-26, arrived in derick@rizonetech.com seconds later (internetMessageId `<CA+OCnvmAHgudPYBzy2DtAo=cNyWodPTPE-XkgWTMZq4VS82uww@mail.gmail.com>`).
- [x] Commit: `todo: record isitlegit.co.za as live on Cloudflare`

**Test checkpoint:** `python3 scripts/check-domain.py` exits 0 and prints `7 of 7 checks passed`: from public DNS (1.1.1.1), Cloudflare's two nameservers, Email Routing's three MX hosts, exactly one SPF record and exactly one DMARC record, each byte for byte the record published here (`v=spf1 include:_spf.mx.cloudflare.net ~all`; `v=DMARC1; p=reject; sp=reject; adkim=r; aspf=r; fo=1; rua=mailto:dmarc@isitlegit.co.za`, DMARC's trailing semicolon allowed), so any edit fails, a reordered, repeated, empty or added tag or term included (after four review rounds found what a parser let through, round 4, 2026-10-28), CAA `issue` tags (not `issuewild`) including Let's Encrypt, Google and SSL.com, and `issue` and `issuewild` alike only from Universal SSL's authorities (RFC 8659; Cloudflare adds Sectigo and DigiCert rows itself), exactly the recorded DS at the registry and no other (key tag 2371, algorithm 13, digest type 2, the recorded digest) and the zone validated (`ad`); any missing, duplicated or weakened record fails it (exit 1), and a lookup that could not be made is reported as that (exit 2), never as a wrong record (`tests/scripts/test_check_domain.py`; completion review, 2026-10-28). The registrar's `ok`, auto-renew and lock, and Email Routing's `ready` with its verified destination, are the dated read-backs in the items above. **Corrected 2026-10-28** (plan review): it checked only the nameservers; the earlier text, kept: `dig +short NS isitlegit.co.za @1.1.1.1` prints `carmelo.ns.cloudflare.com.` and `paris.ns.cloudflare.com.`. Evidence 2026-10-28 23:36 SAST (after the final review): `check-domain: 7 of 7 checks passed`, exit 0.

> **Verified:** 2026-10-28 | §2 | f6eb9f4b5e434f266b10259e947a9585c07de6bc
> **Review:** `docs/reviews/d99-t01-s2.json`

## 3. Workers Paid plan

> **Started:** 2026-10-28T21:11:56Z

**Corrected 2026-10-28:** the Started line first read 2026-10-28T20:32:02Z; it is recorded again at this commit, which the plan review reads, so the review comes before the build as the process requires.

Browser Run hours and Workflows limits need Workers Paid (stack doc "Principles"). The Cloudflare API token cannot read billing, so the operator confirms it in the dashboard.

**Phase:** 99
**Needs:** none
**Surface:** no

**Corrected 2026-10-28** (at start): every operator step below is done and carries its evidence, so `operator` leaves Needs; the checkpoint was re-run today and passes.

**Build order:**

1. Check the plan in the Cloudflare dashboard under Workers and Pages, Plans. Done when: the plan reads Workers Paid, or it is upgraded.

- [x] Open the Cloudflare dashboard for account `f5a529987f8dc7d52ce7aba3da25e226` and read the Workers plan. Done when: it reads Workers Paid. Evidence 2026-10-27 01:27 SAST: the operator confirmed the account is on Workers Paid (the API token cannot read billing).
- [x] Record the plan and date in this section as a line `Plan read: Workers Paid, YYYY-MM-DD`. Done when: the line is written here. Evidence 2026-10-27 01:27 SAST: written below.
The plan line proves the account was on Workers Paid when the operator read it, not that it still is: no token this repository holds can read billing (Wrangler's login has `workers (write)` and no billing scope, HTTP 403 on `/accounts/<id>/subscriptions`, 2026-10-28), so a later downgrade or a lapsed card is the operator's to see, through Cloudflare's billing notices to the account, and shows in the product as Worker limits or refused Browser Run sessions. D00 T01 §5 (stamped) relies on this section through an XREF rather than a dependency; that reliance holds once this section stamps, and the stamped section is not edited.

- [x] Commit: `todo: record the Workers Paid plan`

Plan read: Workers Paid, 2026-10-27

**Test checkpoint:** `python3 -c 'import datetime,re,sys; d=re.findall(r"^Plan read: Workers Paid, (\d{4}-\d{2}-\d{2})$", open("todo/99-manual/TODO-01-day0-accounts.md").read(), re.M); [datetime.date.fromisoformat(x) for x in d]; print(len(d)); sys.exit(len(d) != 1)'` prints `1` and exits 0: exactly one plan line whose date is a real calendar date, any year (an impossible date raises and exits 1). **Corrected 2026-10-28** (the final review): the pattern accepted `2026-99-99` and refused a later year; the earlier text, kept: `grep -cE '^Plan read: Workers Paid, 2026-[0-9]{2}-[0-9]{2}$' todo/99-manual/TODO-01-day0-accounts.md` prints `1`.

> **Verified:** 2026-10-28 | §3 | b96582215777d7616c021e9339b88339be8713e1
> **Review:** `docs/reviews/d99-t01-s3.json`

## 4. SMTP2GO sender domain

> **Started:** 2026-10-28T22:07:52Z

**Corrected 2026-10-29:** the Started line first read 2026-10-28T20:32:02Z; it is recorded again at this commit, which the plan review reads, once §2 (its prerequisite) stamped.

Replies, verification mails and alerts go out through SMTP2GO from `check@`, `verify@`, `alerts@` and `signin@isitlegit.co.za` (stack doc "Outbound mail"; **Corrected 2026-10-26:** `signin@` added for sign-in and invitation mail, D07 T08 §6). One verified sender domain covers every address. The DNS records SMTP2GO gives are added to the Cloudflare zone by Claude once the operator starts the sender-domain setup. (**Corrected 2026-10-29:** sign-in and invitation mail sends as `signin@` (`src/auth/auth.ts`), not `no-reply@`.) (**Corrected 2026-10-29:** sign-in and invitation mail sends as `signin@` (`src/auth/auth.ts`), not `no-reply@`.)

**Phase:** 99
**Needs:** none
**Surface:** no

**Corrected 2026-10-28** (at start): every operator step below is done and carries its evidence, so `operator` leaves Needs; the checkpoint was re-run today and passes.

**Build order:**

1. Add `isitlegit.co.za` as a sender domain in SMTP2GO. Done when: SMTP2GO lists the DKIM and return-path CNAME records to add.
2. Have the records added to the zone and verified. Done when: SMTP2GO shows the domain verified.

- [x] Add `isitlegit.co.za` under SMTP2GO Sending, Verified Senders, Sender Domains. Done when: SMTP2GO shows the records to add. Evidence 2026-10-27 00:50 SAST: SMTP2GO lists the domain.
- [x] Give Claude the record names and targets (they are not secret) to add in Cloudflare DNS. Done when: the records exist in zone `88aeec6df134bc59bfa16a25751241ef`. Evidence 2026-10-27 00:50 SAST: SMTP2GO's setup added them through Cloudflare Domain Connect: `s1027207._domainkey` and `em1027207` CNAMEs (and an unused `link` tracking CNAME; tracking stays off, the emails promise none).
- [x] Click verify in SMTP2GO. Done when: the sender domain reads verified. Evidence 2026-10-27 00:50 SAST: DKIM and return path read verified.
- [x] Create an SMTP2GO API key restricted to sending and store it in the vault as "IsItLegit SMTP2GO" (Claude created the empty item on 2026-10-27; the operator pastes the key into its credential field). Done when: the vault item holds a live key that may send and search activity, SMTP2GO refuses it the probed account endpoints, the product sends only as isitlegit.co.za (`sendMail`), and an authenticated send has arrived (**Corrected 2026-10-29** (plan review, then the final review): "the vault item exists" passed an empty or over-privileged key; the key's complete permission set, its permitted senders and the domain's verified status are settings this key cannot read, deferred to §11). Progress: Evidence 2026-10-27 00:50 SAST: the key is stored and works (read-only stats call 200, 20,000 a month, none used), but it carries every permission except subaccounts; the item stays open until it is narrowed to sending, since a leaked Worker secret could otherwise change the account. Done: Evidence 2026-10-27 01:27 SAST: the operator narrowed the key; a send from `no-reply@isitlegit.co.za` to `hello@isitlegit.co.za` ("IsItLegit SMTP2GO send test", SMTP2GO email id `1xLU5R-FnQW0hPtclR-gWDp`, sent 23:26:41 UTC on 2026-10-26) reached the derick@rizonetech.com Inbox nine seconds later (internetMessageId `<E1xLU5R-FnQW0hPtclR-gWDp@message-id.smtpcorp.com>`), passing DMARC `p=reject`. The narrowed key can still read account stats (read-only), which is harmless. Evidence 2026-10-29 00:36 SAST: the sender domain still reads verified to SMTP2GO, shown by a send: "IsItLegit SMTP2GO sender domain check 2026-10-29" from check@isitlegit.co.za to hello@isitlegit.co.za, SMTP2GO email id `1xMCFV-FnQW0hPrEo4-B2FR`, sent 22:36:01 UTC, reached derick@rizonetech.com at 22:36:11 UTC (internetMessageId `<E1xMCFV-FnQW0hPrEo4-B2FR@message-id.smtpcorp.com>`). Evidence 2026-10-29 00:10 SAST: `scripts/check-smtp2go.py` reads the narrowing back from the key itself (stats HTTP 200; `domain/view` and `users/smtp/view` answer `ENDPOINT_PERMISSION_DENIED`). The sender limit: SMTP2GO refused a send as `probe@example.com` to hello@isitlegit.co.za with "From header sender domain not verified (example.com)" (0 sent, 2026-10-29 00:10 SAST), and `sendMail` (`src/mail/smtp2go.ts`) now refuses any sender outside isitlegit.co.za and its subdomains before calling SMTP2GO (`test/mail/smtp2go.test.ts`), since the key cannot list which domains the account has verified. What is and is not proven (**Corrected 2026-10-29**, completion review): SMTP2GO's own boundary is account-wide (it refuses unverified sender domains, not every domain but isitlegit.co.za), and the key's complete permission set is a saved setting only a key allowed `api_keys/view` can read (SMTP2GO refuses this one that endpoint, `ENDPOINT_PERMISSION_DENIED`); the product's boundary is `sendMail`. Reading back the key's full permissions and permitted senders is the operator's, filed as D99 T01 §11.
> **Deferred:** the SMTP2GO key's complete permission set, its permitted sender domains, the sender domain's current verified status and click tracking being off, all settings only an account-level key or the dashboard shows -> XREF: D99 T01 §11

- [x] Commit: `todo: record the SMTP2GO sender domain as verified`

**Test checkpoint:** `python3 scripts/check-smtp2go.py` exits 0: the vault's key has SMTP2GO's shape and reads its stats, it may send (an empty `email/send` answers `NON_VALIDATING_IN_PAYLOAD`, a payload error SMTP2GO gives only past its permission check, so no mail is sent), it searches activity as the reconciler does (a dated window, an events list), SMTP2GO refuses it `domain/view`, `users/smtp/view` and `api_keys/view` (narrowed, read back from the key), redirects are refused so the key never follows one, and the DKIM and return-path CNAMEs resolve to SMTP2GO; no mail is sent and the key is never printed; a placeholder, a revoked or unnarrowed key, or a wrong record exits 1, an unreachable vault, SMTP2GO or DNS exits 2 (`tests/scripts/test_check_smtp2go.py`). **Corrected 2026-10-29** (plan review): it checked only DNS; the earlier text, kept: `dig +short CNAME em1027207.isitlegit.co.za @1.1.1.1` prints `return.smtp2go.net.` and `dig +short CNAME s1027207._domainkey.isitlegit.co.za @1.1.1.1` prints `dkim.smtp2go.net.` (**Corrected 2026-10-28:** it named `em`, a placeholder; SMTP2GO gave `em1027207` and `s1027207._domainkey`, item 2's evidence). Evidence 2026-10-29 00:11 SAST: `check-smtp2go: the key is live and narrowed to sending, and SMTP2GO's DKIM and return-path records resolve`, exit 0.

> **Verified:** 2026-10-29 | §4 | 29f6881cd227e5e65c77abb97b460187cd52ac82
> **Review:** `docs/reviews/d99-t01-s4.json`

## 5. WhatsApp test number

The WhatsApp intake (design spec 4.1a) needs a Meta for Developers app with the WhatsApp product; the free test number serves the demo and dogfooding.

**Corrected 2026-10-26:** the operator removed WhatsApp from the hackathon scope at 19:30 (design spec 4.1a and section 11). This section moves to phase 7, after the event; it was phase 99, due tonight.

**Phase:** 7
**Needs:** operator
**Surface:** no

**Build order:**

1. Create the app under a Rizonetech business portfolio with the WhatsApp product. Done when: the app's WhatsApp page shows a test number.
2. Add recipient numbers and store the credentials. Done when: the vault holds the access token and app secret.

- [ ] Create a Meta for Developers app (type Business) named IsItLegit under a Rizonetech business portfolio, and add the WhatsApp product. Done when: WhatsApp, API Setup shows a test phone number and its id.
- [ ] Add Derick's and staff numbers as test recipients. Done when: each number is verified in API Setup.
- [ ] Create a permanent access token through a system user and store it with the app secret in the vault as "IsItLegit WhatsApp". Done when: the vault item exists. Cheaper substitute: the 24-hour temporary token, which expires mid-build.
- [ ] Record the test number id and WhatsApp Business Account id (not secret) in this section as lines `WhatsApp phone number id: <id>` and `WhatsApp Business Account id: <id>`. Done when: both lines are written here.
- [ ] Commit: `todo: record the WhatsApp test number`

**Test checkpoint:** `grep -cE '^WhatsApp (phone number|Business Account) id: [0-9]+$' todo/99-manual/TODO-01-day0-accounts.md` prints `2`, and `op item get "IsItLegit WhatsApp" --vault Conclave --format json | jq -r '.id' | wc -c` prints a non-zero count.

## 6. Google Web Risk API key

> **Started:** 2026-10-28T21:11:56Z

**Corrected 2026-10-28:** the Started line first read 2026-10-28T20:32:02Z; it is recorded again at this commit, which the plan review reads, so the review comes before the build as the process requires.

URL and domain reputation uses the Web Risk Lookup API, free up to 100,000 calls a month (design spec 4.3a).

**Phase:** 99
**Needs:** none
**Surface:** no

**Corrected 2026-10-28** (at start): every operator step below is done and carries its evidence, so `operator` leaves Needs; the checkpoint was re-run today and passes.

**Build order:**

1. Enable the Web Risk API in a Rizonetech Google Cloud project and create a restricted key. Done when: the key is in the vault.

- [x] Enable the Web Risk API in a Rizonetech Google Cloud project with billing. Done when: the API shows enabled. Evidence 2026-10-27 01:24 SAST: enabled in the existing Rizonetech project (the operator's choice); a lookup of Google's test phishing URL returns 200 with `SOCIAL_ENGINEERING`, and `https://www.google.com/` returns no threat.
- [x] Create an API key restricted to the Web Risk API only and store it in the vault as "IsItLegit Web Risk". Done when: the vault item exists. Cheaper substitute: an unrestricted key. Evidence 2026-10-27 01:24 SAST: the operator restricted the key to the Web Risk API in the console and filled the vault item (39 characters, value never shown).
- [x] Confirm the project's Web Risk metrics show no `threatLists.computeDiff` or `hashes.search` calls (the key is in the shared Rizonetech project, operator 2026-10-27; one `computeDiff` there would bill every lookup at US$50 per 1,000). Done when: the operator confirms none, or the key moves to a project of its own. Evidence 2026-10-27 01:36 SAST: the operator confirmed the metrics show only `uris.search` (Claude's two test lookups), nothing for `threatLists.computeDiff` or `hashes.search`.
- [x] ~~Cap `uris.search` at 3,000 requests a day in the project's Web Risk quotas, so a looping bug stays inside the 100,000-a-month free tier. Done when: the quota page shows the cap.~~ **Struck 2026-10-27:** the project's quotas offer only `SearchUris per minute` (6,000, not adjustable here), no daily limit; the daily bound is the code cap in D02 T06 §1 (3,000 a day globally, 500 per organisation, tested).
- [x] ~~Add a Google Cloud budget alert on the Rizonetech project for the Web Risk API at US$1 (alerts at 50, 90 and 100%), so any charge at all is seen the same day. Done when: Billing, Budgets and alerts lists it.~~ **Struck 2026-10-27:** the budget's Services filter lists only services with billable usage, and Web Risk has none (its free tier is not billed); a project-wide alert would fire on the project's other services. Charges are already bounded: the code caps lookups at 3,000 a day (D02 T06 §1) and a test refuses any Update API call; the metrics check below covers the other path.
- [x] Commit: `todo: record the Web Risk key`

**Test checkpoint:** `python3 scripts/check-webrisk-key.py` exits 0: the vault's key has a Google API key's shape, Web Risk `uris.search` flags Google's test phishing page `SOCIAL_ENGINEERING` and finds https://www.google.com/ clean, and seven other Google APIs each refuse the key (`API_KEY_SERVICE_BLOCKED` or `SERVICE_DISABLED`), at least one by its API restriction, proving the key is restricted and refused by every common Google API probed (the exact allowed-service list needs a Google Cloud credential this repository lacks: D99 T01 §10); a quota (429) or server (5xx) answer at any step exits 2 as inconclusive, never as a bad key or a threat (completion review C2); the key travels only in the `x-goog-api-key` header and is never printed; a placeholder, an invalid or revoked key, an unrestricted key and a lookup that misses the lure exit 1, an unreachable vault or Google exits 2 (`tests/scripts/test_check_webrisk_key.py`); the only Web Risk method called is `uris.search`, never the billed `computeDiff` or `hashes.search`, and the seven other APIs are read-only GETs; an answer that is not a whole JSON object of the expected shape is unreadable (exit 2), redirects are refused so the key's header stays with Google, and each call has a 30 second deadline for its whole answer (final review, 2026-10-28). **Corrected 2026-10-28** (plan review): it counted the credential's bytes, which an empty placeholder or a revoked key could pass, and could not show the restriction; the earlier text, kept: `bash -o pipefail -c '~/.local/bin/conclave-op read "op://Conclave/IsItLegit Web Risk/credential" | tr -d "\r\n" | wc -c'` exits 0 and prints a number greater than 1 (the lookup succeeded and the key is filled in; only the count is shown, never the value). **Corrected 2026-10-28** (D99 T01 §1's plan review): it called bare `op item get`, outside WSL's Conclave path (`conclave-op` with the service account), and a failed lookup could still print a count; the earlier text, kept: `op item get "IsItLegit Web Risk" --vault Conclave --fields credential --reveal | wc -c` prints more than 1 (the key is filled in; only the count is shown, never the value; **Corrected 2026-10-27:** this read the item id, which an empty placeholder also has). Evidence 2026-10-28 23:52 SAST: `check-webrisk-key: the test lure flagged SOCIAL_ENGINEERING, the clean page clean, and all 7 other Google APIs refused the key (4 by its API restriction): working and restricted`, exit 0.

> **Verified:** 2026-10-29 | §6 | 3a299512c9f89d54f1be342e6b8101fa9de6f016
> **Review:** `docs/reviews/d99-t01-s6.json`

## 7. Partner credits for Glimmer

> **Started:** 2026-10-28T20:27:46Z

The event offered partner credits for hosting Muse Glimmer. **Corrected 2026-10-27 (operator decision, 10:47 SAST):** the outside providers are removed from the plan, and Standard Muse Spark on the Meta Model API screens the monitor's pages (D03 T04; the operator first chose Muse Spark 1.3 Contributor and withdrew it at 11:05 SAST, as lure pages carry personal data), so no partner credit is used. This section now only records what each offer came to. Its earlier items (apply for the Fireworks, Baseten and Modal credits; store the provider key; lift `third-party` from D03 T04's Needs) are superseded: D03 T04 no longer names a provider or that Need.

**Phase:** 99
**Needs:** none
**Surface:** no

**Corrected 2026-10-28** (operator, 20:22 SAST): the product calls Meta's Model API and Fireworks AI only; Baseten and Modal are closed. Fireworks is used (Loupe, D03 T04), so its line reads `used`; Modal was first reported never applied for, so the record takes `not applied` beside `applied`, `granted` and `not offered`; at 22:28 SAST the operator reported US$30 of free Modal credit a month, granted and not used (nothing in the product needs it, and a third provider costs an integration, a key and a processor). With Modal's outcome given, the operator has answered all three, so `operator` leaves Needs.

**Build order:**

1. Record each partner credit and whether it is used. Done when: one line per provider below.

- [x] Record each partner offer as a line `Partner credit <name>: <applied|granted|not applied|not offered>, YYYY-MM-DD (<what it covered>; <used|not used>: <the operator decision>)`, for Fireworks, Baseten and Modal. Done when: the three lines exist.
- [x] Commit: `todo: record partner credits`

Partner credit Baseten: granted, 2026-10-27 (US$100 and up to 2M tokens per minute for `meta-models/muse-spark-open-1026` only, Meta's open-weights Muse Spark; verified 10:30 SAST with a text and an image call; not used: operator decisions 2026-10-27 and 2026-10-28 20:22 SAST, the product calls Meta's Model API and Fireworks AI only, and Baseten is closed; the key stays in Conclave as "Baseten x Meta Hackathon Key" until the operator deletes it)
Partner credit Fireworks: granted, 2026-10-28 (US$100 loaded, reported by the operator at 09:02 SAST; used: operator decision 2026-10-28 09:05 SAST reversed the 2026-10-27 one, and Loupe, a Glimmer LoRA trained and served on Fireworks, screens the monitor's pages, D03 T04; keys in the vault items "IsItLegit Fireworks" (inference), "IsItLegit Fireworks Admin" (local scripts) and "IsItLegit Fireworks Owner" (the operator's own, for serverless training), each filled and answering HTTP 200 on 2026-10-28)
Partner credit Modal: granted, 2026-10-28 (US$30 of free Modal credit a month, reported by the operator at 22:28 SAST; not used: operator decisions 2026-10-28 20:22 and 22:28 SAST, the product calls Meta's Model API and Fireworks AI only and Modal adds no value worth a third provider, so Modal stays closed)

**Test checkpoint:** `python3 scripts/check-partner-credits.py` prints `3` and exits 0: exactly three records, one per provider, each with an outcome from the list, a real calendar date, coverage and a decision in words and exactly one usage decision however it is spelled, Fireworks used and Baseten and Modal not used; `python3 -m unittest tests.scripts.test_check_partner_credits` proves each malformed record refused (**Corrected 2026-10-28** (plan review, round 1 and the final review): a prefix count, then two shell patterns, passed empty, duplicate, contradictory, misspelled, placeholder and impossibly dated records, so the proof moved to a parser).

> **Verified:** 2026-10-28 | §7 | 4da4eb41345f30b4748f70ad063e4ef9abe08909
> **Review:** `docs/reviews/d99-t01-s7.json`

## 8. AI Gateway tokens

> **Started:** 2026-10-27T13:44Z

Two Cloudflare API tokens only the operator can create: Wrangler's login offers no AI Gateway scope, and the Cloudflare connector cannot create tokens. D00 T01 §7 (the Meta smoke test through the authenticated gateway) and D00 T01 §11 (the gateway configuration snapshot and restore) wait on them.

**Phase:** 0
**Needs:** none
**Surface:** no

**Recorded 2026-10-27** (operator, 15:41 SAST): both tokens created in the Cloudflare dashboard and stored in Conclave; the `operator` Need is removed. Placeholders were created by Claude first (13:27 UTC) with the steps in their notes, and the operator pasted each value. The Worker may not need the Run token at all: requests through its `AI` binding are authenticated by the binding (the Settings page says so, and `env.AI.gateway(id).run` is documented for any provider); D00 T01 §7 decides that, while scripts outside the Worker still need the token.

**Build order:**

1. Create both tokens and store them in Conclave. Done when: both vault items exist with a filled credential.

- [x] Create the gateway's authentication token in the Cloudflare dashboard (AI, AI Gateway, `isitlegit`, Settings, Create authentication token; AI Gateway Run only, no expiry) and store it in Conclave as "IsItLegit AI Gateway token" (API Credential, value in `credential`). Done when: `conclave-op item get "IsItLegit AI Gateway token" --vault Conclave --fields credential --reveal | wc -c` prints more than 1.
- [x] Create an account API token (My Profile, API Tokens, Create Token, Custom: Account, AI Gateway, Read and Edit, this account only, no expiry) and store it in Conclave as "IsItLegit AI Gateway admin token". Done when: the same count for that item prints more than 1.
- [x] Write `scripts/check-gateway-tokens.ts`, the capability check behind the checkpoint (**plan review 2026-10-27, P2**: two filled fields would pass with the tokens swapped or with the wrong permissions): it reads both tokens through `conclave-op` and never prints them, then requires that the gateway refuses a request with no token and with a made-up one (its own `AiGatewayError`), passes one with the Run token (the answer comes from Meta, no model runs), refuses the Run token on the gateway's settings, and that the admin token reads gateway `isitlegit` and its `meta` provider and holds Edit (**corrected 2026-10-27**, round 1 and the final review: was "writes the gateway's own settings back unchanged", which could overwrite a newer change; Edit is now shown by creating a throwaway gateway and deleting it); any other answer fails it with the check named. Done when: `test/node/check-gateway-tokens.test.ts` drives it against a local stand-in for the API and the gateway, passing on the right answers and failing on swapped tokens, a Run token that can read settings, an admin token that cannot write, and a gateway that lets a missing token through, with no token in its output; and a live run passes.
- [x] Close the completion review's gaps: a token that is not well formed (a line break, a space) is refused before any request and never printed, and every message is scrubbed of both tokens; only Meta's own refusal of the missing provider key (`invalid_api_key`, logged by the gateway) proves the Run token crossed, so a gateway error carrying a log id fails; every failure names the endpoint or vault item, the permission it needs and one next step; and each check is announced before it waits and printed as it ends. Done when: `test/node/check-gateway-tokens.test.ts` covers a malformed token, a 502 and a non-Meta 401 carrying log ids, an unreachable endpoint, a stalled one (earlier results already shown), and an unreadable vault from the real entry point; removing the Meta-answer test, the format check or the streaming fails it (checked by mutation); and a live run passes all seven checks.
- [x] Close round 1's findings: the admin token's Edit is shown by an update with no fields, which Cloudflare refuses as invalid (400, code 7001) only after accepting Edit and as forbidden (403) without it, so the check can never overwrite a setting changed meanwhile (P2; the earlier write-back could); the entry point installs the signal cleanup before reading the vault, so an interrupt stops a stalled read (P2); and a malformed answer is a named failed check, not a crash (P3). Done when: `test/node/check-gateway-tokens.test.ts` covers an accepted empty update, malformed answers and an interrupted stalled vault read from the real entry point; removing the cleanup or the 400 test fails it (checked by mutation); and live, both tokens' empty updates were refused (admin 400 code 7001, Run 403) with the gateway's settings unchanged, and all seven checks passed.
- [x] Close round 2's P3: the Edit probe's error list is checked to be a list before it is read, so a malformed answer is a named failure. Done when: `test/node/check-gateway-tokens.test.ts` covers a 503 whose errors are not a list.
- [x] Close the final review's findings: requests never follow a redirect (the token would go with it), go only to Cloudflare's two hosts over HTTPS unless a test allows a stand-in, and read at most 1 MiB; the Run token is refused creating a gateway, so a Run token holding Edit fails; Edit is shown by the documented create and delete of a throwaway gateway, read back as gone, instead of an undocumented validation error, and a gateway that cannot be deleted is named; the `meta` provider must be enabled at `https://api.meta.ai`, found on whichever page it is listed; the interrupt names this command; and the stand-in servers are all closed. The planned check that the gateway refuses the admin token is dropped: live, Cloudflare's gateway accepts the Read-and-Edit admin token as Run, and no token setting prevents it, so the admin token must stay out of the Worker (recorded here), while swapped tokens are still caught by the Run token's Read. Done when: `test/node/check-gateway-tokens.test.ts` covers each and five mutations (following redirects, the Run token's Edit, the provider's address, the size limit, the host allowlist) each fail it; and a live run passes all eight checks with no throwaway gateway left.
- [x] Close round 3's P2: a create whose answer is lost (a timeout, a reset) may still have happened, so after anything but a clear refusal the throwaway gateway is deleted and read back as gone, a gateway whose removal cannot be confirmed is named for the operator, and an interrupted run names any throwaway gateway that may remain. Done when: `test/node/check-gateway-tokens.test.ts` covers a create committed with its answer lost (removed, nothing left) and the same with a failed removal (named), and fails when cleanup runs only after a 200 (checked by mutation); and a live run passes all eight checks.
- [x] Commit: `todo: AI Gateway tokens in the vault`

Evidence 2026-10-27 15:50 SAST, values never printed: the two credentials are filled (53 and more characters) and differ; `user/tokens/verify` reads both `active`. The admin token reads gateway `isitlegit` (`authentication: true`, `collect_logs: false`, `cache_ttl: 0`) and its custom provider `meta`, and a no-op `PUT` of the gateway's own settings returned 200 with every value unchanged. The Run token is refused reading the gateway's settings (403, `Authentication error`), so it holds no Read; at `gateway.ai.cloudflare.com/.../isitlegit/custom-meta/v1/models` a request with no token or a made-up one gets the gateway's own `AiGatewayError 2009 Unauthorized`, while one with the Run token passes the gateway (it is logged with a `cf-aig-log-id`) and is answered by Meta (`invalid_api_key`, as no Meta key was sent), so no model ran and nothing was charged. (A first attempt from Python's default user agent met Cloudflare's bot rule, error 1010; the check sets its own user agent.)

Evidence 2026-10-27 16:00 SAST: `node scripts/check-gateway-tokens.ts` printed seven `passed:` lines (no token refused, a made-up token refused, the Run token let through, the Run token refused on the settings, the admin token reading the gateway and the `meta` provider, and writing the settings back unchanged) and exited 0. `pnpm exec vitest run --project node test/node/check-gateway-tokens.test.ts`: 6 passed, including swapped tokens, an over-privileged Run token, an admin token that cannot write and an open gateway, each failing with the check named.

Evidence 2026-10-27 16:15 SAST, after the completion review: `node scripts/check-gateway-tokens.ts` announced each check and printed seven `passed:` lines as they ended, exit 0. `pnpm exec vitest run --project node test/node/check-gateway-tokens.test.ts`: 10 passed.

Evidence 2026-10-27 16:35 SAST, after the final review: `node scripts/check-gateway-tokens.ts` printed eight `passed:` lines (no token and a made-up token refused; the Run token through to Meta, refused reading the settings and refused creating a gateway; the admin token reading the gateway, the `meta` provider enabled at `https://api.meta.ai`, and creating then deleting a throwaway gateway) and exited 0; the account then listed only `isitlegit`. `pnpm exec vitest run --project node test/node/check-gateway-tokens.test.ts`: 16 passed. If provider keys are ever stored on the gateway, the Run probe would reach a model; none are, and D00 T01 §7 keeps it so.

**Test checkpoint:** `node scripts/check-gateway-tokens.ts` prints each capability as passed and exits 0, and `pnpm exec vitest run --project node test/node/check-gateway-tokens.test.ts` passes and fails if a swapped pair or an over-privileged Run token passes (**corrected 2026-10-27**, plan review: was two character counts above 1).

> **Verified:** 2026-10-27 | §8 | 32b3b8b8c77a6639c2e5f014d862f3d328aa94c3
> **Review:** `docs/reviews/d99-t01-s8.json`


## 9. Domain and mail recovery runbook

> **Started:** 2026-10-29T12:50Z

D99 T01 §2 set up isitlegit.co.za with DNSSEC (the DS at the registry), Cloudflare's nameservers, Email Routing and DMARC `p=reject`. A nameserver or signing change made with the DS still in place stops the domain resolving, and with it the site, mail intake and every report link (Cloudflare's DNSSEC documentation, https://developers.cloudflare.com/dns/dnssec/). The operator needs one ordered procedure for the changes that can break it, each step with its read-back, rather than researching during an incident. Filed from §2's completion review (out-of-scope gap C5 and E2, 2026-10-28).

**Phase:** 99
**Needs:** none
**Surface:** no

**Build order:**

1. Write the runbook. Done when: `docs/operations.md` has a "Domain recovery" section with ordered steps and a read-back after each.
2. Walk it through once. Done when: the walkthrough is recorded with each step's expected read-back.

- [x] Write `docs/operations.md` "Domain recovery" covering, in order, (a) a planned nameserver move (prepared first: the zone exported, rebuilt and read back from the new provider's own nameservers, Email Routing's dependence on Cloudflare named; the DS TTL measured at the parent and the wait started once its removal is observed there; the old zone kept serving through propagation; an abort and a rollback step), (b) an emergency (diagnosed first, a DNSSEC failure told apart from an outage so an outage never pulls the DS; the DS pulled; signing repaired and the right DS republished until responses validate again), (c) restoring Email Routing (enabled status, the MX, SPF and its own DKIM key, the verified destination, each rule with its exact action, `check@` to the Worker, and the catch-all) and (d) restoring DMARC and CAA, citing Cloudflare's DNSSEC and Email Routing pages. Done when: each step names the command or dashboard action and the read-back that shows it worked. Cheaper substitute: a link to Cloudflare's documentation alone. (**Corrected 2026-10-29**, plan review.) Done 2026-10-29: `docs/operations.md` "Domain recovery" (a) to (d).
- [x] Add (e) recovering SMTP2GO sending: a compromised key revoked first and read back gone, apart from one SMTP2GO already revoked; a new sending-only key into the vault first ("IsItLegit SMTP2GO"), a failed vault read stopping there; then `wrangler secret put SMTP2GO_API_KEY` from the vault without printing it, only while no rollback is in effect, repeated if its outcome is unclear; then verified through the serving Worker (a sign-in link to the operator's mailbox arrives, the reconciler logs `ok`), never by the vault check alone; and removed sender-domain records restored from SMTP2GO's Sender Domains page, ending in `python3 scripts/check-smtp2go.py`. Done when: the procedure names each action, its read-back and the order the vault and the Worker change in (filed from D99 T01 §4's completion review, gap C4). (**Corrected 2026-10-29**, plan review.) Done 2026-10-29: (e), seven steps.
- [x] Give `scripts/check-domain.py` what the runbook leans on: Email Routing's DKIM key as an eighth check (a valid record, **Corrected 2026-10-29**, round 1) and the demo subdomain's own MX and SPF as a ninth; `--diagnose` (an ordinary query against one with checking disabled: authenticated, unsigned, no SOA, a confirmed DNSSEC failure, or inconclusive, a local fault or a timeout never read as an outage or as healthy; **Corrected 2026-10-29**, completion review); and `--expect-ns`/`--expect-ds`, a planned move's new values reviewed on the command line before they are committed as its constants. A move in progress is a named refusal ("unsigned at the registry"), never a pass. Done when: `tests/scripts/test_check_domain.py` covers the DKIM check, each mid-move state, the reviewed values passing and stale ones refused, malformed values refused, and each diagnosis, on synthetic answers; the live domain reads 9 of 9. Done 2026-10-29: `ROUTING_DKIM` (the whole record pinned byte for byte by `ROUTING_DKIM_SHA256`, round 2), `--diagnose` (`probe`, five states), `--expect-ns`/`--expect-ds` (duplicates, key tag, algorithm and digest length refused), each lookup announced; `tests/scripts/test_check_domain.py` 19 passed (classes `Recovery`, `Progress`); the live domain reads 9 of 9.
- [x] End every domain procedure with `python3 scripts/check-domain.py` as the final read-back (9 of 9, or the named refusal of a state still in progress), and say what exit 2 (a lookup failed) means during an incident. Done when: each procedure's last step names it. Done 2026-10-29: each of (a) to (e) ends with it, and the opening paragraph says what exit 2 means during an incident.
- [x] Walk the runbook against the live domain without changing it (each read-back command run and its current output recorded, kept apart from the synthetic-state evidence above), and record the walkthrough under the section with its date. Done when: the record lists every step with its observed read-back. Done 2026-10-29: recorded below.
- [x] Commit: `todo: domain recovery runbook` Done 2026-10-29: f6f065e, then the review fixes to 08d5a27.

Walkthrough 2026-10-29, against the live domain, nothing changed, every step listed (rewritten after the final review, which found steps missing). A step that changes production or sends mail was not run; for it, the read-back command it names was run against today's state, which shows what the step would start from. The changed-state evidence is the synthetic answers in `tests/scripts/test_check_domain.py`, kept apart from this.

(a) 1, export and rebuild at a new provider: not run (a move); its read-back, the records list, is what `check-domain.py` reads, 9 of 9. Its gate holds: D01 T01 §15 is open. 2: the parent's DS TTL is 7200 s (`dig +noall +answer DS isitlegit.co.za @ns.coza.net.za`: `2371 13 2`). 3, remove the DS: not run; its read-back, `dig +short DS ... @ns.coza.net.za`, shows the DS. 4, wait: not run; `dig +short DS ... @1.1.1.1` shows `2371 13 2` (present, as today). 5, move the nameservers: not run; `dig +noall +authority NS isitlegit.co.za @ns.coza.net.za` names `paris` and `carmelo.ns.cloudflare.com`, TTL 7200 s (the first draft's `+short` form printed nothing at the registry, and the walkthrough corrected the runbook). 6, sign at the new provider: not run; `--diagnose` exits 0 today. 7: `check-domain.py --expect-ns paris.ns.cloudflare.com,carmelo.ns.cloudflare.com --expect-ds "2371 13 2 <the recorded digest>"`: 9 of 9, exit 0 (the reviewed-values path, with today's values).

(b) 1: `check-domain.py --diagnose`: "the domain resolves and validates (an authenticated answer); no DNSSEC failure", exit 0, so the procedure ends here today. 2, pull the DS: not run; the parent shows the DS. 3, repair signing: not run; the DNSKEY TTL at `carmelo.ns.cloudflare.com` is 3600 s. 4, publish the DS: not run; the parent shows `2371 13 2`. 5: the DS matches the recorded one, so no commit; `check-domain.py` 9 of 9.

(c) 1: MX `route1`, `route2`, `route3.mx.cloudflare.net`; SPF exactly the published record; `cf2024-1._domainkey` one record, matching `ROUTING_DKIM_SHA256`. 2 and 3, read through the Cloudflare API (`/zones/<zone>/email/routing`, its rules, catch-all and the account's destination addresses; the first draft deferred them because Wrangler's login token had expired, and `wrangler whoami` refreshed it): routing `enabled`, status `ready`; destination `hostmaster@rizonetech.com` verified; seven rules enabled, `check@` to the Worker `isitlegit` and `hello@`, `dmarc@`, `conduct@`, `finance@demo`, `alerts@demo` and `owner@demo` forwarding to `hostmaster@rizonetech.com`; the catch-all (drop) disabled: exactly the inventory (c) restores. 3's delivery sends: not run (they send mail); each alias's last delivery is in `docs/live-checks.md` "Aliases on `isitlegit.co.za`" (2026-10-26 to 2026-10-28), and `check@`'s reply in D01 T01 §9's record. 4: `demo.isitlegit.co.za` MX `route1` to `route3`, SPF the published record. 5: 9 of 9.

(d) 1: DMARC exactly the published record, once. 2: CAA 10 rows, only `comodoca.com`, `digicert.com`, `letsencrypt.org`, `pki.goog`, `ssl.com`, each as `issue` and `issuewild`; nothing to add. 3: 9 of 9.

(e) Finding the fault: `check-smtp2go.py` exit 0, and both CNAMEs resolve (`return.smtp2go.net.`, `dkim.smtp2go.net.`): no fault today. 1, revoke: not run (it deletes the live key). 2, records: intact, nothing to do. 3, create a key: not run (it creates a credential). 4: `check-smtp2go.py`: "the key is live, may send and search activity", exit 0. 5, put the secret: not run (it publishes a Worker version); its read-back, `wrangler secret list`, names `SMTP2GO_API_KEY`. 6, a sign-in link: not run (it sends mail); `check-smtp2go.py` exit 0. 7: 9 of 9.

**Test checkpoint:** `python3 -m pytest tests/scripts/test_check_domain.py` passes (the runbook's states on synthetic answers), and `python3 scripts/check-domain.py` exits 0 with 9 of 9.

> **Verified:** 2026-10-29 | §9 | f7ecf02c969a3eec14e8bbffffb822e25a2d49cc
> **Review:** `docs/reviews/d99-t01-s9.json`


## 10. Web Risk key restriction read from Google

**Operator disposition (2026-11-04T16:31:21.247559+00:00): WITHDRAWN.** The operator explicitly accepts the existing checks as is; additional readback automation is unnecessary. No further implementation, review or provider call is scheduled for this section. The original scope and historical prerequisite evidence below are retained unchanged as an archive, not an active work instruction. This is an operator withdrawal, not verified delivery: no review approval or stamp is claimed, and the unchecked items remain unchecked because the graph has no withdrawal receipt route. The only new work was plan preparation committed at `39936ac8ee1dc50affaa6e88f304da8ddd1393cf`; no plan review or checker/test implementation began. The existing Web Risk checker is unchanged.

> **Started:** 2026-11-04T16:28:36.613489+00:00 (plan preparation only; implementation after genuine plan self-review)

D99 T01 §6's check proves the Web Risk key works and that seven other Google APIs refuse it, at least one by the key's API restriction; it cannot read the key's exact allowed-service list, so a key allowed Web Risk and an eighth, unprobed API would pass. Google's API Keys API reads that list (`keys.lookupKey` with the key string, then `keys.get` for its `restrictions.apiTargets`; https://docs.cloud.google.com/api-keys/docs/add-restrictions-api-keys), but needs a Google Cloud credential with `apikeys.keys.lookup` and `apikeys.keys.get` on the Rizonetech project, which the operator supplied on 2026-10-30. Filed from §6's completion review (gap C1 and E1, 2026-10-28).

**Phase:** 99
**Needs:** none
**Surface:** no

**Operator prerequisite (completed 2026-10-30):** create a Google Cloud service account in the Rizonetech project with the API Keys Viewer role only, and store its JSON key in the Conclave vault as "IsItLegit Google API keys viewer". Recording `Operator ready: API keys viewer (YYYY-MM-DD)` here and removing `operator` from Needs releases the section.

Operator ready: API keys viewer (2026-10-30)

**Corrected 2026-10-30** (Needs was `operator`): the operator created the service account `isitlegit-apikeys-viewer@rizonetech-511822.iam.gserviceaccount.com` (API Keys Viewer only) and stored its JSON key in "IsItLegit Google API keys viewer" (operator batch 1, `docs/coordinator.md`), and enabled the API Keys API in project 131143319364, which holds the Web Risk key. A first read by the coordinator (2026-10-30 15:31 SAST) found `keys.lookupKey` and `keys.get` answering 200 and `restrictions.apiTargets` naming exactly `webrisk.googleapis.com`, with no other restriction. Read the resolved immutable item and credential field through `~/.local/bin/conclave-op read`, captured in memory and never printed; do not use bare op or CSV-formatted fields.

**Implementation contract (2026-11-04):** Preserve §6's live key, test-lure/clean-page and seven-API refusal checks. Add exact server-owned restriction proof without provider mutation. Resolve the already-supplied Conclave viewer and Web Risk item IDs, keep credentials, signed assertions and access tokens in process memory only, and never emit provider bodies, request headers or private values. Sign a short-lived RS256 assertion using OpenSSL with an anonymous in-memory key descriptor on this WSL host; a missing signer/platform capability refuses explicitly, with no temporary key file or command-line key. Pin the expected service-account identity and OAuth endpoint; use read-only OAuth scope and no credential-supplied destination. No new package dependency or credential rotation.

Google documents lookupKey as GET with keyString, and supports form POST with `X-HTTP-Method-Override: GET` for query fields (https://docs.cloud.google.com/api-keys/docs/reference/rest/v2/keys/lookupKey and https://docs.cloud.google.com/apis/docs/http). Use that documented transport to keep keyString out of URLs; never fall back to a credential-bearing URL. Validate the returned resource name belongs to project 131143319364 and matches the strict API Keys resource shape before keys.get. Require one apiTargets entry whose service is exactly webrisk.googleapis.com, no duplicate/additional targets or method restriction; malformed/missing restriction evidence cannot pass. Additional legitimate application restrictions are reported by category only and do not broaden API targets. No user/provider diagnostic content is interpolated into logs.

Transport preserves existing redirect refusal, bounded JSON response and whole-call deadline protections. Authentication/permission refusals, missing resource or wrong restrictions fail with sanitized actionable messages; unavailable vault/signer, quota/server/transport and malformed responses are inconclusive (exit2), never valid restriction proof. All calls are read-only semantics, no mail, model request or settings write.

**Build order:**

1. Read the Web Risk key's allowed services from Google. Done when: `scripts/check-webrisk-key.py` asserts the allowed-service set is exactly `webrisk.googleapis.com`.

- [ ] Add to `scripts/check-webrisk-key.py` a step that signs a token from the vault's service account (read through `conclave-op`, never printed), calls `apikeys.googleapis.com/v2/keys:lookupKey` with the stored key in the request (not the URL or the output), then `keys.get` on the returned key name, and refuses unless `restrictions.apiTargets` names exactly `webrisk.googleapis.com`. Done when: `tests/scripts/test_check_webrisk_key.py` refuses a key whose targets add any other service, and the live check passes. Cheaper substitute: the seven-API probe alone.
- [ ] Add failing-first synthetic tests for exact target success; unrestricted, duplicate, extra service, method-limited and malformed targets; wrong/missing resource identity; missing credential/signer; OAuth/lookup/get denial, timeout, quota, server error, redirect and truncated JSON. Done when: no invalid response passes, the actual request sends keyString only in the encoded POST body with documented override, bearer tokens stay in headers, and captured output/argv/files do not expose synthetic secrets. Preserve existing tests and add a real signature verification check using runtime-generated synthetic keys. Cheaper substitute: only a mocked happy-path response, rejected because it misses credential routing and refusal defects.
- [ ] Run the strengthened checker with the existing vault credentials and retain only sanitized status, method counts and exact allowed service names in the section evidence. Done when: live readback passes or its real inconclusive/failure blocks stamping, and no provider state changed. Cheaper substitute: accepting the dated 30 October readback as current implementation proof, rejected.
- [ ] Commit: `todo: read the Web Risk key's restriction from Google`

**Test checkpoint:** `python3 scripts/check-webrisk-key.py` exits 0 and names the exact allowed-service set it read.


## 11. SMTP2GO key permissions and senders read back

**Operator disposition (2026-11-04T16:31:21.247559+00:00): WITHDRAWN.** The operator explicitly accepts the existing checks as is; additional readback automation is unnecessary. No further implementation, review or provider call is scheduled for this section. The original scope and historical prerequisite evidence below are retained unchanged as an archive, not an active work instruction. This is an operator withdrawal, not verified delivery: no review approval or stamp is claimed, and the unchecked items remain unchecked because the graph has no withdrawal receipt route. No new plan, code, tests or review began. The existing SMTP2GO checker, approved permission groups and tracking settings are unchanged.

D99 T01 §4's check proves the SMTP2GO key is live and refused two account endpoints, and `sendMail` refuses any sender outside isitlegit.co.za, but the key's complete saved permission set and its permitted sender domains are settings only an account-level key can read (SMTP2GO refuses the sending key `api_keys/view` with `ENDPOINT_PERMISSION_DENIED`, 2026-10-29). A key granted one extra permission, or allowed another verified domain in the account, would still pass. Filed from §4's completion review (gaps C1, C2 and E1, 2026-10-29).

**Phase:** 99
**Needs:** none
**Surface:** no

**Operator action (open):** in SMTP2GO, either confirm on the API keys page that the "IsItLegit SMTP2GO" key holds only the sending permission, the read-only stats, and activity search (which `src/mail/reconcile.ts` needs to settle an uncertain send) that isitlegit.co.za is the only verified sender domain and still reads verified, and that click and open tracking are off for it (the `link` tracking CNAME Domain Connect added stays unused, since the product's mail promises no tracking), recording what the page shows with its date, or create an account-level read-only key with the API keys view permission and store it in the vault as "IsItLegit SMTP2GO admin". Recording `Operator ready: <which> (YYYY-MM-DD)` here and removing `operator` from Needs releases the section.

Operator ready: admin key (2026-10-30)

**Corrected 2026-10-30** (Needs was `operator`), from operator batch 1 (`docs/coordinator.md`), read by the coordinator through the admin key's `api_keys/view` and `domain/view` at 15:40 to 15:50 SAST:

- The admin key, "IsItLegit SMTP2GO admin", holds every account endpoint SMTP2GO offers (key, domain, subaccount, webhook and SMTP-user management included), not a view-only set. Asked to narrow it to the view endpoints, the operator chose to keep it as it is (2026-10-30); it is the operator's accepted risk, stored only in the vault.
- The sending key ("IsItLegit SMTP2GO", no description in SMTP2GO) was narrowed by the operator: it held template create, edit and delete beyond the product's needs; it now holds SMTP2GO's Emails group (`/email/send`, `/email/batch`, `/email/mime`, `/email/search`, `/email/scheduled/search`, `/email/scheduled/remove`, `/archive/email`, `/archive/search`), `/activity/search` and the Statistics group (`/stats/email_summary` and five other reports). The product calls `/email/send`, `/activity/search` and `/stats/email_summary` only; the form grants the Emails and Statistics groups whole. `python3 scripts/check-smtp2go.py` passed afterwards.
- Verified sender domains: `isitlegit.co.za` only, DKIM and return path verified; no single-sender addresses.
- Tracking: the domain's `link` tracking subdomain reads enabled. The operator chose to leave tracking as it is (2026-10-30), so whether SMTP2GO rewrites links in the product's mail is not yet measured; the check below reads it.

The item below therefore compares the sending key with that set (refusing a template, account or subaccount endpoint, and a missing send, activity or summary endpoint), not with the three endpoints alone (**Corrected 2026-10-30:** was "any permission beyond sending, stats and activity search", which SMTP2GO's grouped form cannot grant).

**Build order:**

1. Read the key's saved permissions and senders back. Done when: `scripts/check-smtp2go.py` compares them with the intended minimum, or §4 records the operator's dated read of the API keys page.

- [ ] With the admin key, read the sending key's saved permission set and the account's verified sender domains in `scripts/check-smtp2go.py`, refusing any permission beyond sending, stats and activity search, and any sender domain but isitlegit.co.za. Done when: `tests/scripts/test_check_smtp2go.py` refuses an extra permission, a missing send permission and a second domain, and the live check passes. Cheaper substitute: the operator's dated read of the dashboard, recorded in §4.
- [ ] Commit: `todo: read back the SMTP2GO key's permissions and senders`

**Test checkpoint:** `python3 scripts/check-smtp2go.py` exits 0 and names the permission set and sender domains it read.

## Verification

- Every vault item named above exists; no secret value appears in the repository, chat or logs.
- D00 T01 §5 and §7 can run: the zone is active, the plan is Workers Paid and the Meta credit is visible.
- `python3 scripts/todo-graph.py validate` and `python3 scripts/todo-graph.py plan --check` pass.
