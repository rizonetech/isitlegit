# Security policy

IsItLegit's job is to open mail that may come from attackers: messages, attachments, links and landing pages. It treats all of it as hostile. If you find a way that content can make IsItLegit run code, reach another member's cases, reveal a registered business's details, change a verdict it should not, or send mail it should not, please tell us privately.

## Supported versions

| Version | Security fixes |
| ------- | -------------- |
| `main` | Yes; there is no release line |
| The service at `isitlegit.co.za` | Not running yet. Once it is live it is covered, and fixes are deployed to it from `main` |

The code on `main` is in scope today; the service joins the scope when it goes live during the hackathon build.

## How to report a vulnerability

Use GitHub private vulnerability reporting: open the repository's **Security** tab and choose **Report a vulnerability**, or go straight to <https://github.com/rizonetech/isitlegit/security/advisories/new>. Only the maintainers see the report.

Do not open a public issue, pull request or discussion for a vulnerability, and do not post a working exploit anywhere public. Do not test against the live service with real people's mail or accounts; use your own test mailbox.

A useful report includes what you sent (a synthetic `.eml` is ideal), the steps, what happened, and what an attacker gains.

## In scope

- The Worker and its intake channels: email and upload.
- Prompt injection that changes a verdict, a recipient or a stored record.
- Escape from the contained browser walkthrough, or a walkthrough that types anything other than canary values.
- Access to another member's cases, reports or a registered business's identity data.

## What happens next

- **First response within 3 working days**, confirming we received the report and who is handling it.
- We reproduce the problem, agree on its severity with you, and keep you updated in the private advisory thread until it is fixed.
- Fixed vulnerabilities are published as GitHub security advisories with the credit you choose (or none).
- We ask you to keep the details private until the fix is deployed and the advisory is published.
