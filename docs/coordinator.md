# Coordinator record

The coordinator lane's standing record (`docs/specs/2026-10-30-four-lanes-design.md`): the operator's manual steps, prepared to the step only the operator can take, and the D1 migration numbers handed out to lanes. Updated by the coordinator session on `main`; the TODO sections stay the contract, this file only tracks what is asked and when.

## Operator steps

Batches are asked at a time the operator chooses. Each step names the section it releases; the coordinator verifies the result (a vault item by title only, never its value) and records the `Operator ready:` or decision line in that section.

### Batch 1 (asked 2026-10-30, 14:55 SAST)

| Step | Releases | Status |
| ---- | -------- | ------ |
| Cloudflare API token, Zone Analytics Read on `isitlegit.co.za`, vault "IsItLegit Cloudflare analytics token" | D01 T02 §6 (checks) | asked |
| Google service account with API Keys Viewer only, JSON key in vault "IsItLegit Google API keys viewer" | D99 T01 §10 (main) | asked |
| SMTP2GO account-level read-only key with API keys view, vault "IsItLegit SMTP2GO admin" | D99 T01 §11 (main) | asked |
| Decision: a sign-in code beside the link, `Code sign-in: yes or no` | D07 T02 §11 (app) | asked |

### Waiting on a lane first

| Step | Releases | Waits on |
| ---- | -------- | -------- |
| Forward the near-limit message to check@ as an attachment, from Outlook | D01 T01 §14 (checks) | the checks lane sending it to the operator's mailbox |
| Approve board `Report-EvidenceViewer` | D07 T03 §8 (app) | the app lane drawing it, after D07 T03 §3 |
| Approve the `Error-410` renewal button | D07 T08 §7 (app) | the app lane drawing it, after D07 T08 §1 |
| Sign up with an invite code, verify `rizonetech.com`, invite staff, `Dogfooding since:` | D99 T02 §1 (main) | D07 T02 §7 (sign-in and signup pages) live on the deployment |
| Exchange Online mail flow rule rejecting the test subject, removed after | D01 T02 §6 live check (checks) | the checks lane reaching that item |
| Microsoft 365 admin deploys the Outlook add-in | D01 T01 §10 (checks, Phase 6) | the add-in built |
| Paste new Discord project posts, Sun 1 Nov and Tue 3 Nov | D99 T02 §6 (main) | the dates |
| Record the demo footage, then assemble, caption and upload the video, then submit by Wed 4 Nov 18:00 SAST | D99 T02 §3 to §5 (main) | the core path stamped and the demo script |

### After the event (Phase 7)

D99 T01 §5 (WhatsApp test number), D01 T03 §10 (AAC decoding, legal advice first), D01 T01 §15 (second inbound route), D07 T01 §11 and §12 (shortcut and switcher boards).

## Migration numbers

| Number | Lane | For | Handed out |
| ------ | ---- | --- | ---------- |
| 0034 | checks | `org_receivers`, `receiver_lookups` (D02 T02 §1; first version on main in c4bc74c, final with the §1 stamp) | 2026-10-30, reserved |

The next free number is 0035.
