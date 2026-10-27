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

## Outcome

- The Meta Model API shows the US$150 under Billing, "free credits", with a card on file and a US$150 Spend Limit notification, and the key is in the vault.
- `isitlegit.co.za` is out of `serverHold` and the Cloudflare zone is `active`.
- The Rizonetech Cloudflare account is on Workers Paid.
- SMTP2GO and Google Web Risk credentials are in the vault, each named in the stack doc's secrets list (**Corrected 2026-10-27:** the Fireworks, then Baseten, credential for Glimmer is no longer needed: the operator replaced the outside providers with Muse Spark 1.3 Contributor on the Meta Model API).
- The operator's Rizonetech mailbox is a verified Email Routing destination, so the test-mailbox, demo-alert and `conduct@` aliases can forward to it.

**Adjacency:** all=not-applicable (operator account tasks with no product records)

**Adjacency rationale:** These are one-off account actions outside the repository; their results are recorded here and in the vault, not in the product.

## Implementation Order

| Order | Section | Deliverable | Depends On | Status |
| ----- | ------- | ----------- | ---------- | ------ |
| 1 | §1 | Meta API billing and API key | -- | [ ] |
| 2 | §2 | Domain verification and nameservers | -- | [ ] |
| 3 | §3 | Workers Paid plan | -- | [ ] |
| 4 | §4 | SMTP2GO sender domain | §2 | [ ] |
| 5 | §5 | WhatsApp test number | -- | [ ] |
| 6 | §6 | Google Web Risk API key | -- | [ ] |
| 7 | §7 | Partner credits for Glimmer | -- | [ ] |

## 1. Meta API billing and API key

Credits apply in batches after the claim form; until they show, every call is charged to the card (`sources/cerebralvalley/2026-10-26-credit-claim.md`).

**Phase:** 99
**Needs:** operator
**Surface:** no

**Build order:**

1. Add the payment method and Spend Limit notification on the Billing page. Done when: Billing shows the card and a US$150 notification.
2. Create the API key and store it in the vault. Done when: the vault item exists; the key is never pasted into chat.
3. Wait for the credit. Done when: Billing, "free credits" shows US$150.

- [x] Add a payment method on the Meta Model API Billing page. Done when: Billing lists the card. Evidence 2026-10-27 01:37 SAST: the operator confirmed it on the Meta Model API Billing page.
- [x] Set a Spend Limit notification at US$150. Done when: Billing shows it. Evidence 2026-10-27 01:37 SAST: the operator confirmed it on the Meta Model API Billing page.
- [x] Create an API key named `isitlegit-hackathon` and store it in the Conclave vault as "IsItLegit Meta Model API" (Claude created the empty item on 2026-10-27; the operator pastes the key into its credential field). Done when: the vault item exists. Cheaper substitute: pasting the key into chat or a file. Evidence 2026-10-27 00:50 SAST: the operator filled the vault item; a free model listing with it returned 200 and lists muse-spark-1.3, muse-wonder-1.0, sam-3.1 and muse-voice-transcribe-1.0.
- [x] Confirm US$150 under Billing, "free credits", and record it here as a line `Meta credit visible: YYYY-MM-DD`. Done when: the line is written; every `meta-api` section checks for it before its first call. Evidence: the operator reported the credit showing on Billing at 00:40 SAST on 2026-10-27.
- [ ] Commit: `todo: record the Meta Model API account as ready`

Meta credit visible: 2026-10-27

**Test checkpoint:** `op item get "IsItLegit Meta Model API" --vault Conclave --fields credential --reveal | wc -c` prints more than 1 (the key is filled in; only the count is shown, never the value; **Corrected 2026-10-27:** this read the item id, which an empty placeholder also has) (the item exists; the value is never printed).

## 2. Domain verification and nameservers

`isitlegit.co.za` is on `serverHold` until the registrant contact is verified; the nameserver change to Cloudflare is queued behind it.

**Phase:** 99
**Needs:** operator
**Surface:** no

**Build order:**

1. Verify the registrant contact from the Domains.co.za email to Rizonetech's registrant contact mailbox. Done when: Domains.co.za shows the registrant verified and the hold lifted.
2. Confirm the nameservers. Done when: the Cloudflare zone reads `active`.

- [x] Find the Domains.co.za verification email in Rizonetech's registrant contact mailbox and complete it. Done when: the Domains.co.za domain page no longer shows `serverHold`. Evidence 2026-10-27 00:30 SAST: the registrar reports status `ok` (EPP `ok`); its registrant contact still reads `Unverified`, covered by the next item.
- [x] Confirm the nameservers are `carmelo.ns.cloudflare.com` and `paris.ns.cloudflare.com`. Done when: `dig +short NS isitlegit.co.za @1.1.1.1` prints both.
- [x] Confirm zone `88aeec6df134bc59bfa16a25751241ef` is active in Cloudflare. Done when: the zone status reads `active`. Evidence 2026-10-27 00:30 SAST: the registrar and 1.1.1.1 (DNS over HTTPS) list both nameservers and the zone reads `active`.
- [x] ~~Complete the Domains.co.za registrant contact verification email sent to `hostmaster@rizonetech.com`. Done when: the registrar's registrant contact reads verified.~~ **Struck 2026-10-27 (operator):** Domains.co.za does not require contact verification; the registrant contact's `Unverified` flag needs no action, and no verification email exists in either mailbox.
- [x] Enable Email Routing on the zone and add `hostmaster@rizonetech.com` (the operator's mailbox, operator 2026-10-27) as its destination address. Done when: Email Routing reads `ready` with Cloudflare's MX, SPF and DKIM records and the destination exists. Evidence 2026-10-27 00:30 SAST: routing `ready`; MX route1 to route3, SPF `include:_spf.mx.cloudflare.net`, DKIM `cf2024-1`; destination created, unverified.
- [x] Publish DMARC `p=reject` (operator 2026-10-27) with reports to `dmarc@isitlegit.co.za`, and CAA records allowing only the certificate authorities Universal SSL uses (`letsencrypt.org`, `pki.goog`, `ssl.com`). Done when: both read back from the zone. Evidence 2026-10-27 00:30 SAST: `_dmarc` TXT and three CAA `issue` records present.
- [x] Turn on auto-renew (operator 2026-10-27). Done when: the registrar reads `autorenew: true`. Evidence 2026-10-27 00:30 SAST: it does; the domain expires 2027-10-26 and the reseller balance is R9.45, flagged low.
- [x] Turn on DNSSEC in Cloudflare. Done when: Cloudflare returns the DS record. Evidence 2026-10-27 00:30 SAST: pending, DS `isitlegit.co.za. 3600 IN DS 2371 13 2 360CD8AC177997F22F9239EF3EB686AAAEDF101C211B330C684B723928504665`.
- [x] Add that DS record at Domains.co.za (key tag 2371, algorithm 13, digest type 2, the digest above); the connector has no DS tool, so the operator pastes it in the portal. Progress: Evidence 2026-10-27 00:40 SAST: the registrar reads `bDNSSec: true` with exactly that record; the `.co.za` zone does not publish it yet, so Cloudflare still reads `pending`. Done when: the registrar reads `bDNSSec: true`, Cloudflare's DNSSEC reads `active`, and 1.1.1.1 answers with the AD flag set. Evidence 2026-10-27 00:55 SAST: the registrar reads `bDNSSec: true`, the co.za servers publish DS 2371 13 2, Cloudflare's DNSSEC reads `active`, and `dig +dnssec isitlegit.co.za SOA @1.1.1.1` returns the `ad` flag.
- [x] Turn on the registrar transfer lock once DNSSEC is active (operator 2026-10-27). Done when: the registrar reads `locked`. Evidence 2026-10-27 00:55 SAST: the registrar reads `locked`.
- [x] Click the Cloudflare Email Routing verification link sent to the operator's Rizonetech mailbox once Claude has added it as a destination address (design spec section 11, Mailbox). Done when: the zone's Email Routing destination addresses list it as verified. Evidence 2026-10-27 00:40 SAST: the destination reads verified; the `hello@`, `conduct@` and `dmarc@` rules are enabled.
- [x] Add an Email Routing custom address `hello@isitlegit.co.za` forwarding to the operator's mailbox (named on the about page, D07 T06 §8). Done when: a test mail to it arrives. Evidence 2026-10-27 00:59 SAST: the test "IsItLegit routing test (hello@)" from rizonetech@gmail.com, sent 22:58:56 UTC on 2026-10-26, arrived in derick@rizonetech.com seconds later (internetMessageId `<CA+OCnvm2p3BUGO6k=ErfsauOqTjLiufUef5E99C-Lmp9WoiKXg@mail.gmail.com>`).
- [x] Add an Email Routing custom address `dmarc@isitlegit.co.za` forwarding to the operator's mailbox (DMARC aggregate reports). Done when: the rule reads enabled. Evidence 2026-10-27 00:40 SAST: enabled.
- [x] Add an Email Routing custom address `conduct@isitlegit.co.za` forwarding to the operator's mailbox (named in `CODE_OF_CONDUCT.md` as the private conduct contact). Done when: a test mail to it arrives in the operator's mailbox. Evidence 2026-10-27 00:59 SAST: the test "IsItLegit routing test (conduct@)" from rizonetech@gmail.com, sent 22:58:56 UTC on 2026-10-26, arrived in derick@rizonetech.com seconds later (internetMessageId `<CA+OCnvmAHgudPYBzy2DtAo=cNyWodPTPE-XkgWTMZq4VS82uww@mail.gmail.com>`).
- [ ] Commit: `todo: record isitlegit.co.za as live on Cloudflare`

**Test checkpoint:** `dig +short NS isitlegit.co.za @1.1.1.1` prints `carmelo.ns.cloudflare.com.` and `paris.ns.cloudflare.com.`.

## 3. Workers Paid plan

Browser Run hours and Workflows limits need Workers Paid (stack doc "Principles"). The Cloudflare API token cannot read billing, so the operator confirms it in the dashboard.

**Phase:** 99
**Needs:** operator
**Surface:** no

**Build order:**

1. Check the plan in the Cloudflare dashboard under Workers and Pages, Plans. Done when: the plan reads Workers Paid, or it is upgraded.

- [x] Open the Cloudflare dashboard for account `f5a529987f8dc7d52ce7aba3da25e226` and read the Workers plan. Done when: it reads Workers Paid. Evidence 2026-10-27 01:27 SAST: the operator confirmed the account is on Workers Paid (the API token cannot read billing).
- [x] Record the plan and date in this section as a line `Plan read: Workers Paid, YYYY-MM-DD`. Done when: the line is written here. Evidence 2026-10-27 01:27 SAST: written below.
- [ ] Commit: `todo: record the Workers Paid plan`

Plan read: Workers Paid, 2026-10-27

**Test checkpoint:** `grep -cE '^Plan read: Workers Paid, 2026-[0-9]{2}-[0-9]{2}$' todo/99-manual/TODO-01-day0-accounts.md` prints `1`.

## 4. SMTP2GO sender domain

Replies, verification mails and alerts go out through SMTP2GO from `check@`, `verify@`, `alerts@` and `no-reply@isitlegit.co.za` (stack doc "Outbound mail"; **Corrected 2026-10-26:** `no-reply@` added for sign-in and invitation mail, D07 T08 §6). One verified sender domain covers every address. The DNS records SMTP2GO gives are added to the Cloudflare zone by Claude once the operator starts the sender-domain setup.

**Phase:** 99
**Needs:** operator
**Surface:** no

**Build order:**

1. Add `isitlegit.co.za` as a sender domain in SMTP2GO. Done when: SMTP2GO lists the DKIM and return-path CNAME records to add.
2. Have the records added to the zone and verified. Done when: SMTP2GO shows the domain verified.

- [x] Add `isitlegit.co.za` under SMTP2GO Sending, Verified Senders, Sender Domains. Done when: SMTP2GO shows the records to add. Evidence 2026-10-27 00:50 SAST: SMTP2GO lists the domain.
- [x] Give Claude the record names and targets (they are not secret) to add in Cloudflare DNS. Done when: the records exist in zone `88aeec6df134bc59bfa16a25751241ef`. Evidence 2026-10-27 00:50 SAST: SMTP2GO's setup added them through Cloudflare Domain Connect: `s1027207._domainkey` and `em1027207` CNAMEs (and an unused `link` tracking CNAME; tracking stays off, the emails promise none).
- [x] Click verify in SMTP2GO. Done when: the sender domain reads verified. Evidence 2026-10-27 00:50 SAST: DKIM and return path read verified.
- [x] Create an SMTP2GO API key restricted to sending and store it in the vault as "IsItLegit SMTP2GO" (Claude created the empty item on 2026-10-27; the operator pastes the key into its credential field). Done when: the vault item exists. Progress: Evidence 2026-10-27 00:50 SAST: the key is stored and works (read-only stats call 200, 20,000 a month, none used), but it carries every permission except subaccounts; the item stays open until it is narrowed to sending, since a leaked Worker secret could otherwise change the account. Done: Evidence 2026-10-27 01:27 SAST: the operator narrowed the key; a send from `no-reply@isitlegit.co.za` to `hello@isitlegit.co.za` ("IsItLegit SMTP2GO send test", SMTP2GO email id `1xLU5R-FnQW0hPtclR-gWDp`, sent 23:26:41 UTC on 2026-10-26) reached the derick@rizonetech.com Inbox nine seconds later (internetMessageId `<E1xLU5R-FnQW0hPtclR-gWDp@message-id.smtpcorp.com>`), passing DMARC `p=reject`. The narrowed key can still read account stats (read-only), which is harmless.
- [ ] Commit: `todo: record the SMTP2GO sender domain as verified`

**Test checkpoint:** `dig +short CNAME em.isitlegit.co.za @1.1.1.1` (or the record names SMTP2GO gives) resolves to SMTP2GO targets.

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

URL and domain reputation uses the Web Risk Lookup API, free up to 100,000 calls a month (design spec 4.3a).

**Phase:** 99
**Needs:** operator
**Surface:** no

**Build order:**

1. Enable the Web Risk API in a Rizonetech Google Cloud project and create a restricted key. Done when: the key is in the vault.

- [x] Enable the Web Risk API in a Rizonetech Google Cloud project with billing. Done when: the API shows enabled. Evidence 2026-10-27 01:24 SAST: enabled in the existing Rizonetech project (the operator's choice); a lookup of Google's test phishing URL returns 200 with `SOCIAL_ENGINEERING`, and `https://www.google.com/` returns no threat.
- [x] Create an API key restricted to the Web Risk API only and store it in the vault as "IsItLegit Web Risk". Done when: the vault item exists. Cheaper substitute: an unrestricted key. Evidence 2026-10-27 01:24 SAST: the operator restricted the key to the Web Risk API in the console and filled the vault item (39 characters, value never shown).
- [x] Confirm the project's Web Risk metrics show no `threatLists.computeDiff` or `hashes.search` calls (the key is in the shared Rizonetech project, operator 2026-10-27; one `computeDiff` there would bill every lookup at US$50 per 1,000). Done when: the operator confirms none, or the key moves to a project of its own. Evidence 2026-10-27 01:36 SAST: the operator confirmed the metrics show only `uris.search` (Claude's two test lookups), nothing for `threatLists.computeDiff` or `hashes.search`.
- [x] ~~Cap `uris.search` at 3,000 requests a day in the project's Web Risk quotas, so a looping bug stays inside the 100,000-a-month free tier. Done when: the quota page shows the cap.~~ **Struck 2026-10-27:** the project's quotas offer only `SearchUris per minute` (6,000, not adjustable here), no daily limit; the daily bound is the code cap in D02 T06 §1 (3,000 a day globally, 500 per organisation, tested).
- [x] ~~Add a Google Cloud budget alert on the Rizonetech project for the Web Risk API at US$1 (alerts at 50, 90 and 100%), so any charge at all is seen the same day. Done when: Billing, Budgets and alerts lists it.~~ **Struck 2026-10-27:** the budget's Services filter lists only services with billable usage, and Web Risk has none (its free tier is not billed); a project-wide alert would fire on the project's other services. Charges are already bounded: the code caps lookups at 3,000 a day (D02 T06 §1) and a test refuses any Update API call; the metrics check below covers the other path.
- [ ] Commit: `todo: record the Web Risk key`

**Test checkpoint:** `op item get "IsItLegit Web Risk" --vault Conclave --fields credential --reveal | wc -c` prints more than 1 (the key is filled in; only the count is shown, never the value; **Corrected 2026-10-27:** this read the item id, which an empty placeholder also has).

## 7. Partner credits for Glimmer

The event offered partner credits for hosting Muse Glimmer. **Corrected 2026-10-27 (operator decision, 10:47 SAST):** the outside providers are removed from the plan; Muse Spark 1.3 Contributor on the Meta Model API screens public pages instead (D03 T04), so no partner credit is used. This section now only records what each offer came to. Its earlier items (apply for the Fireworks, Baseten and Modal credits; store the provider key; lift `third-party` from D03 T04's Needs) are superseded: D03 T04 no longer names a provider or that Need.

**Phase:** 99
**Needs:** operator
**Surface:** no

**Build order:**

1. Record each partner credit and that it is not used. Done when: one line per provider below.

- [ ] Record each partner offer as a line `Partner credit <name>: <applied|granted|not offered>, YYYY-MM-DD (<what it covered>; not used: operator decision 2026-10-27)`, for Fireworks, Baseten and Modal. Done when: the three lines exist.
- [ ] Commit: `todo: record partner credits`

Partner credit Baseten: granted, 2026-10-27 (US$100 and up to 2M tokens per minute for `meta-models/muse-spark-open-1026` only, Meta's open-weights Muse Spark; verified 10:30 SAST with a text and an image call; not used: operator decision 2026-10-27; the key stays in Conclave as "Baseten x Meta Hackathon Key" until the operator deletes it)

**Test checkpoint:** `grep -cE '^Partner credit (Fireworks|Baseten|Modal): ' todo/99-manual/TODO-01-day0-accounts.md` prints `3`.

## Verification

- Every vault item named above exists; no secret value appears in the repository, chat or logs.
- D00 T01 §5 and §7 can run: the zone is active, the plan is Workers Paid and the Meta credit is visible.
- `python3 scripts/todo-graph.py validate` and `python3 scripts/todo-graph.py plan --check` pass.
