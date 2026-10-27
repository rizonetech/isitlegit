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
| `dmarc@` | `hostmaster@rizonetech.com` | DMARC aggregate reports | rule enabled |
| `finance@demo.` | `hostmaster@rizonetech.com` | Demo organisation finance contact (D07 T07) | 2026-10-27 19:20 UTC |
| `alerts@demo.` | `hostmaster@rizonetech.com` | Demo organisation alerts contact (D07 T07) | 2026-10-27 19:20 UTC |
| `owner@demo.` | `hostmaster@rizonetech.com` | Demo organisation owner contact (D07 T07) | 2026-10-27 19:20 UTC |

## Outbound through SMTP2GO

| Test | From | To | Result |
| --- | --- | --- | --- |
| Send through the narrowed key, 2026-10-26 23:26 UTC | `no-reply@isitlegit.co.za` | `hello@isitlegit.co.za` | Inbox of derick@rizonetech.com in 9 s; DKIM `s1027207` for isitlegit.co.za, DMARC `p=reject` passed; internetMessageId `<E1xLU5R-FnQW0hPtclR-gWDp@message-id.smtpcorp.com>` |

`demo.isitlegit.co.za` has Email Routing of its own (enabled 2026-10-27 19:19 UTC, D01 T02 §4: its own MX records to `route1` to `route3.mx.cloudflare.net` and SPF `include:_spf.mx.cloudflare.net`); an address there needs a rule like any other. A rule or subdomain is not usable the moment it is created: mail sent 15 s after these were made was refused `550 5.1.1 Address does not exist`, and mail sent about a minute later arrived, so wait a minute or two before testing a new one. `check@` (the intake Worker) joins this table when the intake sections add it.

Read back through the Cloudflare API on 2026-10-27 at 19:23:11 UTC (D01 T02 §4): Email Routing `ready`; destination `hostmaster@rizonetech.com` verified 2026-10-26 23:02:41 UTC; six rules enabled, each forwarding to it: `finance@`, `alerts@` and `owner@demo.isitlegit.co.za`, and `dmarc@`, `conduct@` and `hello@isitlegit.co.za`; the catch-all (drop) is disabled, so any other address is refused.

Cloudflare does not pass a delivery failure that happens after it accepted a message back to the sender: a mail that reaches the alias but then fails to reach the destination is lost silently. D01 T02 §6 owns detecting that and telling the operator.

## How a test runs

1. Send from `rizonetech@gmail.com` to the alias with a subject that names it, for example `IsItLegit routing test (hello@)`.
2. Search `derick@rizonetech.com` for that subject; it normally arrives within seconds. Cloudflare's Email Routing analytics lag, so the inbox is the proof.
3. Record the subject, sender, send time and the arriving message's `internetMessageId` in the TODO item the test closes.
