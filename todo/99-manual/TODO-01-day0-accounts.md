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
- SMTP2GO, WhatsApp, Google Web Risk and Fireworks credentials are in the vault, each named in the stack doc's secrets list.

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

- [ ] Add a payment method on the Meta Model API Billing page. Done when: Billing lists the card.
- [ ] Set a Spend Limit notification at US$150. Done when: Billing shows it.
- [ ] Create an API key named `isitlegit-hackathon` and store it in the Conclave vault as "IsItLegit Meta Model API". Done when: the vault item exists. Cheaper substitute: pasting the key into chat or a file.
- [ ] Confirm US$150 under Billing, "free credits", and tell Claude. Done when: the credit is visible; then remove `operator` from D00 T01 §7's wait by recording the date here.
- [ ] Commit: `todo: record the Meta Model API account as ready`

**Test checkpoint:** `op item get "IsItLegit Meta Model API" --vault Conclave --format json | jq -r '.id' | wc -c` prints a non-zero count (the item exists; the value is never printed).

## 2. Domain verification and nameservers

`isitlegit.co.za` is on `serverHold` until the registrant contact is verified; the nameserver change to Cloudflare is queued behind it.

**Phase:** 99
**Needs:** operator
**Surface:** no

**Build order:**

1. Verify the registrant contact from the Domains.co.za email to Rizonetech's registrant contact mailbox. Done when: Domains.co.za shows the registrant verified and the hold lifted.
2. Confirm the nameservers. Done when: the Cloudflare zone reads `active`.

- [ ] Find the Domains.co.za verification email in Rizonetech's registrant contact mailbox and complete it. Done when: the Domains.co.za domain page no longer shows `serverHold`.
- [ ] Confirm the nameservers are `carmelo.ns.cloudflare.com` and `paris.ns.cloudflare.com`. Done when: `dig +short NS isitlegit.co.za @1.1.1.1` prints both.
- [ ] Confirm zone `88aeec6df134bc59bfa16a25751241ef` is active in Cloudflare. Done when: the zone status reads `active`.
- [ ] Commit: `todo: record isitlegit.co.za as live on Cloudflare`

**Test checkpoint:** `dig +short NS isitlegit.co.za @1.1.1.1` prints `carmelo.ns.cloudflare.com.` and `paris.ns.cloudflare.com.`.

## 3. Workers Paid plan

Browser Run hours and Workflows limits need Workers Paid (stack doc "Principles"). The Cloudflare API token cannot read billing, so the operator confirms it in the dashboard.

**Phase:** 99
**Needs:** operator
**Surface:** no

**Build order:**

1. Check the plan in the Cloudflare dashboard under Workers and Pages, Plans. Done when: the plan reads Workers Paid, or it is upgraded.

- [ ] Open the Cloudflare dashboard for account `f5a529987f8dc7d52ce7aba3da25e226` and read the Workers plan. Done when: it reads Workers Paid.
- [ ] Record the plan and date in this section as a line `Plan read: Workers Paid, YYYY-MM-DD`. Done when: the line is written here.
- [ ] Commit: `todo: record the Workers Paid plan`

**Test checkpoint:** `grep -cE '^Plan read: Workers Paid, 2026-[0-9]{2}-[0-9]{2}$' todo/99-manual/TODO-01-day0-accounts.md` prints `1`.

## 4. SMTP2GO sender domain

Replies, verification mails and alerts go out through SMTP2GO from `check@`, `verify@` and `alerts@isitlegit.co.za` (stack doc "Outbound mail"). The DNS records SMTP2GO gives are added to the Cloudflare zone by Claude once the operator starts the sender-domain setup.

**Phase:** 99
**Needs:** operator
**Surface:** no

**Build order:**

1. Add `isitlegit.co.za` as a sender domain in SMTP2GO. Done when: SMTP2GO lists the DKIM and return-path CNAME records to add.
2. Have the records added to the zone and verified. Done when: SMTP2GO shows the domain verified.

- [ ] Add `isitlegit.co.za` under SMTP2GO Sending, Verified Senders, Sender Domains. Done when: SMTP2GO shows the records to add.
- [ ] Give Claude the record names and targets (they are not secret) to add in Cloudflare DNS. Done when: the records exist in zone `88aeec6df134bc59bfa16a25751241ef`.
- [ ] Click verify in SMTP2GO. Done when: the sender domain reads verified.
- [ ] Create an SMTP2GO API key restricted to sending and store it in the vault as "IsItLegit SMTP2GO". Done when: the vault item exists.
- [ ] Commit: `todo: record the SMTP2GO sender domain as verified`

**Test checkpoint:** `dig +short CNAME em.isitlegit.co.za @1.1.1.1` (or the record names SMTP2GO gives) resolves to SMTP2GO targets.

## 5. WhatsApp test number

The WhatsApp intake (design spec 4.1a) needs a Meta for Developers app with the WhatsApp product; the free test number serves the demo and dogfooding.

**Phase:** 99
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

- [ ] Enable the Web Risk API in a Rizonetech Google Cloud project with billing. Done when: the API shows enabled.
- [ ] Create an API key restricted to the Web Risk API only and store it in the vault as "IsItLegit Web Risk". Done when: the vault item exists. Cheaper substitute: an unrestricted key.
- [ ] Commit: `todo: record the Web Risk key`

**Test checkpoint:** `op item get "IsItLegit Web Risk" --vault Conclave --format json | jq -r '.id' | wc -c` prints a non-zero count.

## 7. Partner credits for Glimmer

Muse Glimmer is not on the Meta Model API; it runs through a hosted provider, Fireworks AI first (design spec 4.11). The event offers partner credits to selected participants.

**Phase:** 99
**Needs:** operator
**Surface:** no

**Build order:**

1. Apply for the Fireworks, Baseten and Modal credits when the event opens them. Done when: each application is submitted or recorded as not offered.

- [ ] Apply for Fireworks AI credits (US$25) through the event's partner offer. Done when: it is recorded here as a line `Partner credit Fireworks: <applied|granted|not offered>, YYYY-MM-DD`.
- [ ] Apply for Baseten and Modal credits if offered. Done when: each is recorded here as a line `Partner credit <name>: <applied|granted|not offered>, YYYY-MM-DD`.
- [ ] Store the Fireworks API key in the vault as "IsItLegit Fireworks" once granted. Done when: the vault item exists.
- [ ] Commit: `todo: record partner credits`

**Test checkpoint:** `grep -cE '^Partner credit (Fireworks|Baseten|Modal): ' todo/99-manual/TODO-01-day0-accounts.md` prints `3`.

## Verification

- Every vault item named above exists; no secret value appears in the repository, chat or logs.
- D00 T01 §5 and §7 can run: the zone is active, the plan is Workers Paid and the Meta credit is visible.
- `python3 scripts/todo-graph.py validate` and `python3 scripts/todo-graph.py plan --check` pass.
