# Live checks

How Claude Code proves the live mail paths without the operator, as authorised on 2026-10-27.

## Mailboxes

- **Sender for tests:** `rizonetech@gmail.com`, through the Gmail connector. It is an outside sender, so its mail takes the real path through Cloudflare's MX.
- **Where mail lands:** `derick@rizonetech.com` (Microsoft 365), read through the Microsoft 365 connector. `hostmaster@rizonetech.com`, the Email Routing destination, delivers there.
- **Allowed recipients for tests:** `isitlegit.co.za` addresses only. Never a client, a member outside Rizonetech, or any other domain.

## Aliases on `isitlegit.co.za`

| Address | Forwards to | Purpose | Proven |
| --- | --- | --- | --- |
| `hello@` | `hostmaster@rizonetech.com` | Contact on the about page | 2026-10-26 22:58 UTC |
| `conduct@` | `hostmaster@rizonetech.com` | Private conduct contact (`CODE_OF_CONDUCT.md`) | 2026-10-26 22:58 UTC |
| `dmarc@` | `hostmaster@rizonetech.com` | DMARC aggregate reports | 2026-10-28 21:13 UTC |
| `finance@demo.` | `hostmaster@rizonetech.com` | Demo organisation finance contact (D07 T07) | 2026-10-27 19:20 UTC |
| `alerts@demo.` | `hostmaster@rizonetech.com` | Demo organisation alerts contact (D07 T07) | 2026-10-27 19:20 UTC |
| `owner@demo.` | `hostmaster@rizonetech.com` | Demo organisation owner contact (D07 T07) | 2026-10-27 19:20 UTC |

## Outbound through SMTP2GO

| Test | From | To | Result |
| --- | --- | --- | --- |
| Send through the narrowed key, 2026-10-26 23:26 UTC | `no-reply@isitlegit.co.za` | `hello@isitlegit.co.za` | Inbox of derick@rizonetech.com in 9 s; DKIM `s1027207` for isitlegit.co.za, DMARC `p=reject` passed; internetMessageId `<E1xLU5R-FnQW0hPtclR-gWDp@message-id.smtpcorp.com>` |
| Sender domain still verified, 2026-10-28 22:36 UTC | `check@isitlegit.co.za` | `hello@isitlegit.co.za` | Inbox of derick@rizonetech.com in 10 s; SMTP2GO email id `1xMCFV-FnQW0hPrEo4-B2FR`; internetMessageId `<E1xMCFV-FnQW0hPrEo4-B2FR@message-id.smtpcorp.com>` |

`demo.isitlegit.co.za` has Email Routing of its own (enabled 2026-10-27 19:19 UTC, D01 T02 §4: its own MX records to `route1` to `route3.mx.cloudflare.net` and SPF `include:_spf.mx.cloudflare.net`); an address there needs a rule like any other. A rule or subdomain is not usable the moment it is created: mail sent 15 s after these were made was refused `550 5.1.1 Address does not exist`, and mail sent about a minute later arrived, so wait a minute or two before testing a new one. `check@` (the intake Worker) joins this table when the intake sections add it.

`check@isitlegit.co.za` routes to the Worker `isitlegit` from 2026-10-28 23:12 UTC (rule `ba3c41f1cb86483d806607ec00f4958e`, D01 T01 §9). A send through SMTP2GO reaches the Worker with an envelope sender on SMTP2GO's return-path domain, not its From address: the probe "IsItLegit envelope probe 2026-10-29" (SMTP2GO email id `1xMCqi-AIkwcC8njzQ-O92i`, From `probe@isitlegit.co.za`) arrived with `mailFrom` `bounce.<token>@em1027207.isitlegit.co.za` and `rawSize` 4971 (`wrangler tail`), and was dropped as from no member. Intake identifies the forwarder by the envelope (D01 T01 §3), so a member's forward must come from a real mailbox, where envelope and From agree.


Read back through the Cloudflare API on 2026-10-27 at 19:23:11 UTC (D01 T02 §4): Email Routing `ready`; destination `hostmaster@rizonetech.com` verified 2026-10-26 23:02:41 UTC; six rules enabled, each forwarding to it: `finance@`, `alerts@` and `owner@demo.isitlegit.co.za`, and `dmarc@`, `conduct@` and `hello@isitlegit.co.za`; the catch-all (drop) is disabled, so any other address is refused.

Cloudflare does not pass a delivery failure that happens after it accepted a message back to the sender: a mail that reaches the alias but then fails to reach the destination is lost silently. D01 T02 §6 owns detecting that and telling the operator.

## How a test runs

1. Send from `rizonetech@gmail.com` to the alias with a subject that names it, for example `IsItLegit routing test (hello@)`.
2. Search `derick@rizonetech.com` for that subject; it normally arrives within seconds. Cloudflare's Email Routing analytics lag, so the inbox is the proof.
3. Record the subject, sender, send time and the arriving message's `internetMessageId` in the TODO item the test closes.

## Meta model client

One call through `src/meta/client.ts` by `node scripts/meta-client-live.ts --confirm-credit` (D03 T01 §1), its gateway log read back.

| Run (UTC) | Model | Result | Meta tokens in / out | Cost | Gateway log |
| --- | --- | --- | --- | --- | --- |
| 2026-10-28T16:43:00.242Z | `muse-spark-1.3` | passed | 15 / 64 | US$0.000291 | `01a18364-d800-7003-ab06-51024533cbdf`: metadata and a matching cost kept, no body |

## The app host

`https://app.isitlegit.co.za` serves the `isitlegit` Worker as a Workers custom domain from 2026-10-28 23:30 UTC (D07 T06 §9), the host `APP_URL` (sign-in and invitation links) and `PUBLIC_ORIGIN` (report links) name, so those links resolve. Tested deployment: `24e43d6` (version `261facf8-7495-4d27-b731-ab869cd66a24`); `/health` answers 200 with that SHA on it and on `isitlegit.derick-f5a.workers.dev`, which stays for `scripts/smoke.ts`. The apex and `www` stay with D07 T06 §6.

## Sign-in links and link scanners

Scanner-safe sign-in, 2026-10-29 (D07 T02 §10, deployed `1f09b70`): the test user had 0 sessions; a sign-in link was requested at 00:06:32 UTC and SMTP2GO confirmed it at 00:06:33; Microsoft 365's link scanner fetched `/signin/confirm` twice at 00:06:49 UTC (`wrangler tail`: two `{"event":"signin-confirm","step":"shown"}` lines, from AS Microsoft Corporation, token not logged), 37 s before the mail reached the inbox at 00:07:26 ("Your IsItLegit sign-in link", internetMessageId `<E1xMDf9-AIkwcC8ht6s-V7Ab@message-id.smtpcorp.com>`); the user still had 0 sessions; the page's form, submitted from this session, answered 303 to `/cases` with a session for the test user, and the count read 1. Before the fix (23:39 UTC) the same scanner's fetch signed itself in and the member's click was refused `INVALID_TOKEN`.

## Intake: check@ end to end

2026-10-29 (D01 T01 §9, deployed `18f2cdc`): the Rizonetech test organisation verified the single address `derick@rizonetech.com` through the address-claim flow. A synthetic suspicious message ("Updated banking details for invoice INV-2291 (live smoke run-0129a)") forwarded from that mailbox to check@ at 01:57:14 UTC (forward `<ZR6PR08MB999924BA11F51F7848ECEED811B86E2@ZR6PR08MB999924.eurprd08.prod.outlook.com>`) was admitted as case `01M62P0FCKTGQ4A6YY7XNXE933` (`{"event":"intake","outcome":"admitted"}`), and its reply (`<E1xMFOS-FnQW0hPzh2n-rLN5@message-id.smtpcorp.com>`) was sent at 01:57:28, 14 s later, threaded under the forward, with a signed report link for that case; `scripts/live-intake.ts` exited 0.

The topmost Authentication-Results header Email Routing added to that case's stored message (`raw/01M62P0FCKTGQ4A6YY7XNXE933/message.eml`, two such headers in all): `mx.cloudflare.net; dkim=pass header.d=rizonetech.com header.s=selector2 header.b=M3ym6aCz; dmarc=pass header.from=rizonetech.com policy.dmarc=none; spf=pass (...) smtp.helo=AS8PR04CU009.outbound.protection.outlook.com; spf=pass (...) smtp.mailfrom=derick@rizonetech.com; arc=pass smtp.remote-ip="2a01:111:f403:c201::3"` (in full in `test/intake/sender.test.ts`).

Raw-store fault, 2026-10-29 (D01 T01 §9): with `INTAKE_FAULT_SENDER` naming the test sender, a forward at 02:19:47 UTC was taken by Email Routing, the Worker undid its admission and threw `RetryDelivery` (outcome `exception`), and Email Routing answered a temporary failure: Microsoft 365 retried the delivery 32 minutes later (02:52:14 UTC), which made exactly one case (`01M62S51XXVFCWAEJ541S0XPW8`) and its reply. A refusal (`setReject`), tried in between, reaches the sender as `555 5.7.1 <reason>` within seconds (02:50:56). The thrown retry is kept (`c949a42`). The variable is empty again (deploy of `c949a42`, read back), and the switch was removed from the handler after the final review. The intake logs `{"event":"intake","outcome":"retry","error":"RetryDelivery"}` for such a delivery, and Workers Logs marks that invocation's outcome `exception`, since the handler throws so Email Routing answers a temporary failure.

## Forwarding failures (D01 T02 §6)

The Worker reads Cloudflare's Email Routing events every 15 minutes (`src/mail/forwarding.ts`) and alerts the operator, at `OPERATOR_EMAIL` and the fallback `OPERATOR_FALLBACK_EMAIL`, in two cases.

- **"Mail to <alias> was refused after forwarding":** Cloudflare handed the message to the alias's destination, which then refused it; Cloudflare drops the refusal notice, so the sender was not told. Check the destination mailbox's health first: its quota, its mail flow rules, its spam filtering. Then ask the sender to send again; the alert names the sender's domain, never the address.
- **"The Worker could not take mail to <alias>":** the Worker failed a delivery to `check@` and the sender's server has not retried successfully within an hour. Check the Worker's logs in Workers Logs (`event: intake` lines around the time given) and the intake sweep's line (`event: intake-sweep`); a deploy or an exception at that time is the usual cause. The sender's server may still retry; if the member asks, they can forward again.

A run logs one line, `event: forwarding`, with `disabled` when `CF_ANALYTICS_TOKEN` (the vault item "IsItLegit Cloudflare analytics token") or `EMAIL_ZONE_ID` is not set, `degraded` when Cloudflare's API failed (the next run catches up) or an alert was not handed over (tried again next run).

### Probe 4 proven durable, and probe 3 repaired (D01 T02 §9)

Read-only reads of production D1 by the coordinator, 2026-10-31 about 10:31 UTC, on the deployed `e26b53c6` (migration 0040 applied 09:27 UTC). Keys are shown as 8-character prefixes; no domain or address was read out.

```sql
SELECT key, kind, state, alert, alert_tries, occurred_at, detected_at FROM forward_incidents ORDER BY occurred_at;
SELECT incident_key, COUNT(*) FROM forward_notices GROUP BY incident_key;
SELECT send_key, status, attempts, created_at FROM mail_sends WHERE send_key LIKE 'forward-failure:%' ORDER BY created_at;
```

- **Probe 4 after many later scans:** incident `be3d4494` is refused and open, its alert `sent` after 1 try, occurred 2026-10-30T18:28:07Z and detected 18:45:34.646Z, with 2 notices. Its alert sends `forward-failure:be3d4494:0` and `:1` are both `sent` with 1 attempt, created 19:15:35.140Z and 19:15:37.319Z. No `forward-failure` send was created after 2026-10-30T19:15:37Z, though both schedules have run many times since.
- **Probe 3 after migration 0040:** `forward_incidents` holds exactly 2 rows, `130199c1` (probe 3) and `be3d4494` (probe 4). Probe 3's false second incident `43a48a16` is gone and its notices are relinked, so `130199c1` has 2 notices. Its two historical sends (`forward-failure:43a48a16:0` and `:1`, `sent` 2026-10-30T17:15:37Z, before the repair) stay in `mail_sends` as history. No bracket remains in either incident's sender or destination domain, nor in any of `forward_seen`'s 3 rows. No new alert was sent.

## Sign-in rate limits and the audit trail (D07 T02 §6)

- Run: 2026-10-29, after the deploy of `f946261` with migration `0027_audit_trail.sql` applied and read back.
- A POST to `https://app.isitlegit.co.za/signin/confirm` with a token that is not one answered 400 (the new-link page).
- The live `auth_events` table then held one `sign-in-failed` row, outcome `invalid_token`, its IP hashed, no detail; the live `rate_limits` table held one bucket (the verification counted per IP in D1).

## Registration dates from ZACR's WHOIS

D02 T03 §9 reads `.za` registration dates over a Workers TCP socket. `VITE_LIVE_WHOIS=1 pnpm exec vitest run test/checks/whois-live.test.ts` runs the reader under workerd with its own `connect()` against ZACR.

| Check | Result |
| --- | --- |
| Workers runtime (workerd, this machine), 2026-10-31 02:04 UTC | google.co.za `2001-06-25T20:37:59Z` and standardbank.co.za `1996-11-23T22:00:00Z` from `coza-whois.registry.net.za:43`; a name not registered read as `not-registered`; test passed |
| Deployed Worker | The coordinator's, at the next deploy (asked 2026-10-31) |

## Retried runs' findings kept apart: migration 0051 (D01 T01 §19)

| Check | Result |
| --- | --- |
| Row counts before the migration, production, 2026-10-31 16:24 UTC | `evidence` 12, `check_outcomes` 69 |
| Row counts after the migration, same query | `evidence` 12, `check_outcomes` 69: equal |
| Rows without a run after the migration | `evidence` 0, `check_outcomes` 0 |
| Deploy | `2a430fba`, version `ec3e8231-0faf-49e3-b729-1af0f40f70a6`, smoke passed in 12 s |

## Fictional demo businesses (D07 T07 §1)

The seed writes the records only (`scripts/seed-demo.ts`, `src/demo/seed.ts`); the site lane has rehearsed it on a local database and never runs `--remote`. The coordinator runs the production seed from gated `main` after D07 T07 §1 merges. Protected, never touched: demo@rizonetech.com, derick@rizonetech.com and organisation `ZF5SufztotybeXIWVncExFAVu9GYZ8Fu` (Fynbos Freight): the seed finds Fynbos Freight by that id, never creates it, and adds only what is absent.

| Step | Command | Expect |
| --- | --- | --- |
| 1. Read the production state first (read only) | `BANK_KEY=... BANK_MATCH_KEY=... node scripts/seed-demo.ts --remote --check` | exit 1, naming the parts not yet seeded for each business; nothing written |
| 2. Keys | The vault item "IsItLegit bank key" (`BANK_KEY`, `BANK_MATCH_KEY`), piped into the environment, never an argument or a printed value | the same keys the Worker holds, or the seed refuses accounts under other keys |
| 3. Seed | `node scripts/seed-demo.ts --remote` | five lines, `created` for what was absent, `present` for what Fynbos Freight already holds |
| 4. Rerun | the same command | every step `present`, no row changed |
| 5. Read back | `node scripts/seed-demo.ts --remote --check` | each business `protected: true`, exit 0 |
| 6. Fynbos Freight's identity | on app.isitlegit.co.za as demo@rizonetech.com | an identity already set by the operator is left as found; `--check` names it if protection is off |

Delivery of mail to `accounts@fynbosfreight.demo.isitlegit.co.za` (the allowlist's recipient policy and Email Routing for the subdomain) is the coordinator's and is not part of this seed: closed-loop verification mail to the seeded contacts waits on it.

**Run 2026-10-31 23:55 SAST (coordinator, gated main 46b47906, keys piped from "IsItLegit bank key").** Check first: exit 1, Fynbos Freight not flagged demo with no verified domain or address, the other four missing, nothing written. Seed: exit 0, Fynbos Freight's organisation, identity and logo present, its domain, address and account created; the other four created whole. Rerun: every step present. Read back: Hadeda Couriers, Kestrel Packaging, Marula Office Supplies and Quagga Tyres protected; Fynbos Freight's identity left as found, not yet protected and its finance contact not the accounts address (the operator switches it on). Rows: cases 19 before and after, users 2 to 6 and organisations 2 to 6 (the four owners), both protected accounts present.

## Site claims and the status of their owners (D07 T06 §6)

`node site/scripts/check-claims.ts` (the deploy's first gate) on `site-lane` at `0599820d` after merging `origin/main`, 2026-11-01. This is the owners' status in the plan, not proof that the live service backs a claim: §20 checks each claim against the deployed service. The deploy refuses while any owner below is unstamped; each such claim is either backed by a stamped section by the first deploy or reworded.

94 claims; 54 have every owner stamped, 40 wait on at least one unstamped section (51 unstamped owner references in all). Refreshed by the site lane for the coordinator's §20 deploy read-back; this refresh is not a stamp and does not change any claim's wording.

| Claim | Owners and their status | Deploy |
| --- | --- | --- |
| home.phishing | D04 T02 §4 stamped | clear |
| home.invoice | D06 T01 §3 open | blocked |
| home.impersonation | D05 T02 §4 open | blocked |
| home.model.spark | D04 T01 §4 open, D04 T01 §5 open | blocked |
| home.model.wonder | D04 T02 §4 stamped | clear |
| home.model.sam | D03 T03 §3 open | blocked |
| home.model.voice | D01 T03 §4 stamped | clear |
| home.protect | D05 T02 §9 open | blocked |
| how.check.sender | D02 T02 §5 stamped | clear |
| how.check.links | D02 T03 §2 stamped, D02 T03 §4 stamped, D02 T07 §1 stamped, D02 T07 §2 stamped, D02 T07 §4 open, D02 T06 §1 stamped | blocked |
| how.check.attachments | D02 T04 §2 stamped | clear |
| how.spark | D03 T02 §3 open | blocked |
| how.sam | D03 T03 §3 open | blocked |
| how.wonder | D04 T02 §4 stamped | clear |
| how.voice | D01 T03 §4 stamped | clear |
| how.verdict | D04 T01 §1 stamped, D04 T01 §4 open, D04 T01 §5 open | blocked |
| how.reply | D01 T01 §8 stamped | clear |
| how.retention | D01 T01 §2 stamped | clear |
| how.meta | D03 T01 §1 stamped | clear |
| how.inline | D01 T01 §4 stamped | clear |
| invoice.read | D06 T01 §1 open | blocked |
| invoice.ledger | D06 T01 §3 open | blocked |
| invoice.phone | D05 T03 §1 open | blocked |
| invoice.pop | D06 T02 §2 open | blocked |
| invoice.limit | D06 T02 §2 open | blocked |
| invoice.closing | D06 T01 §4 stamped | clear |
| how.cites | D04 T01 §5 open | blocked |
| home.step3 | D04 T01 §5 open, D07 T03 §1 stamped | blocked |
| how.intro | D04 T01 §4 open | blocked |
| how.strip | D02 T02 §2 stamped, D02 T07 §2 stamped, D02 T04 §2 stamped, D03 T02 §3 open | blocked |
| how.size | D01 T01 §3 stamped, D01 T03 §1 stamped | clear |
| invoice.catch | D06 T01 §1 open, D06 T01 §3 open | blocked |
| invoice.sign.edits | D06 T02 §1 stamped | clear |
| invoice.sign.fonts | D06 T02 §1 stamped | clear |
| invoice.sign.dates | D06 T02 §1 stamped | clear |
| invoice.sign.layout | D06 T02 §2 open | blocked |
| pricing.free.verdicts | D01 T01 §3 stamped | clear |
| pricing.free.cap | D07 T02 §4 stamped, D07 T08 §8 stamped | clear |
| pricing.protect.team | D07 T02 §3 stamped | clear |
| pricing.protect.identity | D05 T01 §1 stamped, D05 T02 §7 stamped, D05 T02 §9 open | blocked |
| pricing.protect.alerts | D05 T02 §4 open, D05 T04 §2 stamped, D05 T04 §5 open | blocked |
| pricing.protect.bank | D06 T01 §3 open, D06 T01 §4 stamped | blocked |
| pricing.protect.verify | D05 T03 §1 open | blocked |
| pricing.protect.pop | D06 T02 §1 stamped, D06 T02 §2 open | blocked |
| pricing.trial.after | D07 T02 §8 stamped | clear |
| pricing.trial.join | D07 T02 §8 stamped | clear |
| privacy.summary | D00 T01 §5 stamped, D01 T01 §2 stamped, D03 T01 §1 stamped | clear |
| privacy.what.mail | D01 T01 §3 stamped, D01 T03 §1 stamped | clear |
| privacy.what.account | D07 T02 §3 stamped | clear |
| privacy.what.ledger | D06 T01 §4 stamped | clear |
| privacy.what.feedback | D07 T03 §6 stamped | clear |
| privacy.what.security | D07 T02 §6 stamped | clear |
| privacy.what.members | D01 T01 §3 stamped | clear |
| privacy.training | D03 T04 §11 stamped, D03 T04 §7 stamped | clear |
| privacy.screening | D05 T04 §3 stamped | clear |
| privacy.keep.raw | D00 T01 §5 stamped, D01 T01 §2 stamped | clear |
| privacy.keep.derived | D01 T01 §2 stamped | clear |
| privacy.keep.case | D01 T01 §2 stamped, D07 T02 §9 open | blocked |
| privacy.keep.links | D01 T01 §8 stamped | clear |
| privacy.keep.security | D07 T02 §6 stamped | clear |
| privacy.keep.account | D07 T02 §9 open, D06 T01 §4 stamped | blocked |
| privacy.p.cloudflare | D01 T01 §2 stamped | clear |
| privacy.p.meta | D03 T01 §1 stamped | clear |
| privacy.p.smtp2go | D01 T02 §1 stamped | clear |
| privacy.p.webrisk | D02 T06 §1 stamped | clear |
| privacy.p.fireworks | D03 T04 §11 stamped, D03 T04 §7 stamped | clear |
| privacy.protected | D05 T01 §2 stamped, D05 T02 §1 stamped | clear |
| protect.answer | D05 T01 §1 stamped, D05 T02 §2 open, D05 T02 §3 open, D05 T02 §4 open, D05 T04 §2 stamped | blocked |
| protect.identity | D05 T01 §1 stamped, D05 T01 §2 stamped, D05 T01 §3 stamped, D05 T02 §2 open, D05 T02 §3 open, D05 T02 §4 open | blocked |
| protect.seal | D05 T02 §6 stamped, D05 T02 §9 open | blocked |
| protect.badge | D05 T02 §7 stamped, D05 T02 §8 open | blocked |
| protect.monitor | D05 T04 §1 stamped, D05 T04 §2 stamped, D05 T04 §3 stamped, D05 T04 §5 open | blocked |
| protect.bank | D05 T03 §1 open, D05 T01 §2 stamped, D05 T02 §1 stamped | blocked |
| terms.service | D01 T01 §3 stamped, D01 T03 §1 stamped, D01 T03 §4 stamped, D04 T01 §4 open, D05 T01 §1 stamped, D05 T01 §2 stamped, D05 T01 §3 stamped | blocked |
| terms.you.mail | D01 T01 §3 stamped, D01 T03 §1 stamped, D07 T02 §5 stamped | clear |
| terms.you.authority | D05 T01 §1 stamped, D05 T01 §2 stamped, D05 T01 §3 stamped | clear |
| terms.you.limits | D07 T02 §4 stamped, D07 T08 §8 stamped | clear |
| terms.protect.bank | D05 T01 §2 stamped, D05 T02 §1 stamped, D05 T03 §1 open | blocked |
| terms.limits.partial | D03 T01 §2 stamped, D04 T01 §5 open, D07 T02 §4 stamped, D07 T08 §8 stamped | blocked |
| security.safeguards.untrusted | D01 T02 §2 stamped, D02 T05 §1 stamped, D03 T01 §6 stamped | clear |
| security.safeguards.floor | D04 T01 §1 stamped | clear |
| security.safeguards.citations | D04 T01 §2 stamped, D04 T01 §5 open | blocked |
| security.safeguards.walkthrough | D04 T02 §2 stamped, D04 T02 §3 stamped, D04 T02 §4 stamped | clear |
| security.safeguards.zod | D03 T01 §5 stamped, D04 T01 §3 open, D04 T01 §4 open | blocked |
| security.safeguards.store | D03 T01 §1 stamped | clear |
| security.intro | D03 T01 §6 stamped, D04 T01 §1 stamped, D04 T02 §2 stamped | clear |
| security.data.bank | D05 T01 §2 stamped, D05 T02 §1 stamped | clear |
| security.data.reports | D01 T01 §8 stamped | clear |
| security.data.tenancy | D01 T01 §2 stamped, D05 T01 §1 stamped, D06 T01 §4 stamped, D07 T02 §3 stamped | clear |
| security.data.retention | D00 T01 §5 stamped, D01 T01 §2 stamped | clear |
| security.data.auth | D07 T02 §1 stamped, D07 T02 §2 stamped | clear |
| errors.mail | D01 T01 §3 stamped | clear |
| about.purpose | D05 T01 §2 stamped, D05 T02 §2 open, D01 T03 §1 stamped | blocked |
| about.built.models | D01 T03 §4 stamped, D03 T02 §3 open, D03 T03 §3 open, D03 T04 §11 stamped, D04 T01 §4 open, D04 T02 §4 stamped, D05 T04 §3 stamped | blocked |

## Public repository and advisory read-back (D07 T06 §18)

Unauthenticated `curl`, no credentials, nothing submitted, read 2026-10-31 22:19 UTC (2026-11-01 00:19 SAST) after the repository went public (D99 T02 §5, the coordinator). `/about` and `/security` link these three addresses (`site/src/lib/links.ts`: `repo`, `securityPolicy`, `securityAdvisory`; `site/test/about.test.ts`, `site/test/security.test.ts`).

| URL | Status | Result |
| --- | --- | --- |
| `https://github.com/rizonetech/isitlegit` | 200 | the public repository |
| `https://github.com/rizonetech/isitlegit/blob/main/SECURITY.md` | 200 | the disclosure policy |
| `https://github.com/rizonetech/isitlegit/security/advisories/new` | 302 | `Location: https://github.com/login?return_to=https%3A%2F%2Fgithub.com%2Frizonetech%2Fisitlegit%2Fsecurity%2Fadvisories%2Fnew`: the sign-in page, whose `return_to` decodes to the advisory address itself (checked), curl exit 0: private vulnerability reporting is reachable |

## Refusal-to-alert time, five live probes (D01 T02 §14)

Five probes sent 2026-11-01 01:55 to 02:00 UTC (03:55 to 04:00 SAST) from `alerts@isitlegit.co.za` through SMTP2GO to `hello@isitlegit.co.za`, each subject `ILPROBE-7Q4K9X refusal-to-alert probe <n> of 5 20261101T0155Z (D01 T02 section 14)`, a minute apart, which the operator's kept Exchange mail flow rule refuses after Email Routing forwards it. The Worker was on `b4f03b02` (D01 T02 §12's `FORWARD_CRON` live since the 6b08a4c3 deploy, 2026-10-31 22:47 UTC). Read at 02:50 UTC by `scripts/forward-probe.py read` (this lane, no secret printed): each probe's `forward_incidents` row by its subject's hash (production D1, one read-only SELECT through the local Wrangler login), the notices held on it, and the alert as the `mail_sends` row `forward-failure:<incident key>:1` with its SMTP2GO email id confirmed in SMTP2GO's activity, which gives the send time. Incident keys are shown as 8-character prefixes.

| Probe | SMTP2GO id (probe) | Sent (UTC) | Refused (UTC, the incident's `occurred_at`) | Incident | SMTP2GO id (alert) | Alert sent (UTC, SMTP2GO `processed`) | Alert delivered (UTC) | Refusal to alert |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `1xNKnV-FnQW0hPszX0-G7rC` | 01:55:51 | 01:55:58 | 91dedc60 | `1xNLBj-4o5NDgrhmJ6-lHgR` | 02:20:51 | 02:20:53 | 1493 s (24.9 min) |
| 2 | `1xNKob-FnQW0hQ15ln-aaZX` | 01:56:59 | 01:57:07 | 5c6605e4 | `1xNLBm-FnQW0hPtO65-m8s1` | 02:20:54 | 02:20:56 | 1427 s (23.8 min) |
| 3 | `1xNKpe-FnQW0hQ1DZU-M0Ka` | 01:58:03 | 01:58:10 | 0ec6839f | `1xNLBo-4o5NDgrhmLz-mphy` | 02:20:56 | 02:20:59 | 1366 s (22.8 min) |
| 4 | `1xNKqg-FnQW0hPs7HD-djpq` | 01:59:07 | 01:59:20 | 5d74ea0b | `1xNLBp-FnQW0hPy8yI-Qtxl` | 02:21:00 | 02:21:03 | 1300 s (21.7 min) |
| 5 | `1xNKrh-FnQW0hPqboF-qA9X` | 02:00:10 | 02:00:17 | e6413af5 | `1xNLBu-AIkwcC8sj3S-WhLJ` | 02:21:02 | 02:21:04 | 1245 s (20.8 min) |

Every probe has exactly one refused incident with its notice held and one sent alert; no probe has a second incident. The alert's send time is SMTP2GO's `processed` event for its email id, which is when SMTP2GO accepted it for sending; its `delivered` event, two to three seconds later, is shown apart and is not what is measured. The record was first read with the tool as first written (24.9 minutes) and then again, for the figures above, with the corrected tool (`scripts/forward-probe.py`, which decides on exact seconds, follows every page of SMTP2GO's activity search, keeps processed and delivered apart and refuses an incomplete run): the 95th percentile (nearest rank, which for five probes is the slowest) is **1,493 seconds (24 minutes 53 seconds)**, under the 1,500 the section asks for. The margin is 7 seconds and is not an accident of this run: a refusal is settled when the later of its occurrence plus `MATCH_GRACE_MS` (20 minutes) and its first reading plus `SEEN_MS` (4 minutes) has passed, at the next five-minute scan, so the design's worst case is the grace plus one scan, 25 minutes. All five alerts left in one scan, at 02:20:51 to 02:21:02 UTC. A refusal whose due time falls just after a scan waits the whole next interval and can pass 25 minutes. Whether to shorten the grace or accept 25 to 30 minutes is an owner decision; §15 (early refusal alert before attribution), deferred by the operator until after the competition, is the filed route to a shorter time.

## Well-known sites list in production KV (D02 T06 §6)

Loaded 2026-11-02 by the checks lane from this machine: `node scripts/load-top-sites.ts --remote` exited 0 with "generation 72528f8d0b8b (100000 domains in 1119 shards) reads back (remote)". Before the load, `wrangler kv key get top:meta --binding CACHE --remote` (namespace ea28d6e83ede4a83bfb06898d8791a16) returned 404, so this was the first production load and no `top:meta:previous` exists yet. After the load the same read returns generation 72528f8d0b8b, source majestic-million, date 2026-11-02, count 100000. Consumer proof through the real reader (`isWellKnown`, src/checks/top-sites.ts) fed the exact production meta and shards fetched with `wrangler kv key get --remote`: `microsoft.com` answers known (present in the mi shard, 785 names) and `qzxwv-unlikely-7392.com`, verified absent from its qz shard (11 names), answers unknown; the probe test passed (1 passed) and was removed after running. A case-level read through the deployed Worker's report was not run: the live upload answers 401 "sign in first" without a member session, and no authenticated live path was available in the loading session.
## First site deploy and apex read-backs (D07 T06 §20, coordinator, 2026-11-02)

The proven-only deploy ran from gated main (`node scripts/deploy.ts --proven-only`, site version `1ed650c9-f500-4ad8-8540-862371f6b04e`): 63 claims proven and rendered, 31 omitted and listed in the site lane's run record; no unstamped claim is on the live pages. The app Worker then deployed from main `a83da8dc` (version `5bca7e53-ff72-4eae-b4ef-6c09798ed1a2`, gate 41387614244 green) with the apex trust routes and the www custom domain.

| URL | Status | Result |
| --- | --- | --- |
| `https://isitlegit.co.za/` | 200 | the marketing home page |
| `https://www.isitlegit.co.za/some/path?x=1` | 301 | `Location: https://isitlegit.co.za/some/path?x=1`, path and query kept |
| `https://isitlegit.co.za/v/fynbos-freight` | 200 | the verify page, "Fynbos Freight" read in the body |
| `https://isitlegit.co.za/b/fynbos-freight.png` | 200 | `image/png`, the signature badge |
| `https://isitlegit.co.za/s/fynbos-freight` | 404 | the route reaches the app Worker; the seal frame's handler is D05 T02 §8 and §9, not yet stamped, so no seal is served yet |
| `https://isitlegit.co.za/privacy` | 200 after 307 to `/privacy/` | heading "What happens to the email you forward?" |
| `https://isitlegit.co.za/no-such-page-xyz` | 404 | the site's 404 page |
| `https://app.isitlegit.co.za/health` | 200 | `{"ok":true,"commit":"a83da8dc0dae68e8d3de215820be57c47bed496c"}` |

The production demo seed was read before these checks: `node scripts/seed-demo.ts --remote --check` (keys piped from the vault item "IsItLegit bank key", never printed) exits 0 with all five businesses `protected: true`.
