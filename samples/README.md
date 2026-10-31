# Samples

Real emails for testing the analyser. **Everything here except this README and `.gitignore` is git-ignored**: these files contain client names, personal data and banking-related mail, and the project repo must be public. Never copy them into fixtures, the eval set, the demo or Discord; build synthetic look-alikes instead.

`manifest.csv` lists every file with its label (`attack` or `genuine`), what it is, its permanent `Message-ID` and its fidelity.

## The client list

`client-names.txt` (here, git-ignored, one client name, domain or address per line) is what keeps client names out of the public repository: `scripts/hooks/pre-commit` refuses a commit, and `scripts/check-publication.py` a push, while the tracked tree holds a listed name. Both find the list the same way: this checkout's own `samples/client-names.txt`, else the main checkout's, which serves every linked worktree of the clone (`git worktree add` copies no ignored file). A dangling link, no list, an unreadable list or a list naming no one stops both, each with its fix; an unusable own list never falls back. A new clone needs the operator's list at the main checkout's `samples/client-names.txt`.

## Fidelity

- `gmail/*.eml`: the original message source from the Gmail API (RAW), byte-exact, with full transport and `Authentication-Results` headers. Best quality.
- `outlook/*.eml`: rebuilt from the Microsoft Graph JSON the connector returns. Sender, recipients, date, subject, Message-ID and HTML body are real; transport and authentication headers and inline images are missing (marked with an `X-Sample-Source` header). The `.json` beside each is the untouched connector capture.
- For true `.msg` or full-header `.eml` from Outlook, drag the message from Outlook desktop into this folder (makes a `.msg`) or use "Download" in Outlook on the web (makes an `.eml`).

## Client sets

Subfolders per client hold quarantined or reported mail with full headers. Which client each set comes from, its consent status and its profile are in the git-ignored `NOTES.md`. Client mail is internal testing only: never shown in the app, demo or repository, and never sent to the Meta Model API without that client's written consent.

## How these were collected

`export_samples.py` (here, git-ignored, because it names the messages) reads the connector results from the Claude Code session log and writes the files. Collected 2026-10-26.

## Still wanted

- An original attack message with headers from the client case in the design spec (section 2a): ask the recipient to forward it **as an attachment**.
- Phishing from Defender quarantine in the Rizonetech tenant and other client tenants.
- Written consent from any client whose set is to go through the Meta models.
- Synthetic attacks for the public repo: display-name BEC, changed-bank-details invoice, credential-harvest page.
