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

The demo aliases (`finance@`, `alerts@` and `owner@demo.isitlegit.co.za`) and `check@` (the intake Worker) join this table when D01 T02 §4 and the intake sections add them.

## How a test runs

1. Send from `rizonetech@gmail.com` to the alias with a subject that names it, for example `IsItLegit routing test (hello@)`.
2. Search `derick@rizonetech.com` for that subject; it normally arrives within seconds. Cloudflare's Email Routing analytics lag, so the inbox is the proof.
3. Record the subject, sender, send time and the arriving message's `internetMessageId` in the TODO item the test closes.
