# 02 IsItLegit: how it works

The product's technical specification in full, for learning and for the channel: about 11 minutes, 1920 × 1080, on-screen text, narrated in the operator's ElevenLabs voice when `data/narration/02.json` has been voiced (silent otherwise). Long form on the operator's request (2026-10-30), replacing the 60-second tech stack video; it is not part of the demo video.

The script is the storyboard [data/storyboards/02-technical-deep-dive.json](../data/storyboards/02-technical-deep-dive.json). Its figures come from [data/tech-facts.json](../data/tech-facts.json): 92 facts, each pinned to a commit and an exact quote from the design spec, the tech stack spec, `wrangler.jsonc`, `package.json` or `src/`, proven by `tools/check-facts.py` before a render.

## Honest build state

Every chapter card says shipped, partly built, started or planned. Shipped means the code is in `src/` at the pinned commit; planned means designed in the spec, not built. Diagrams are diagrams, not product screens, so this video never stands in for the live demo.

## Chapters

| Chapter | Status | What it covers |
| ------- | ------ | -------------- |
| 1 What it does | n/a | The problem, the answer, the whole system as one Worker |
| 2 Email intake | shipped | Email Routing, membership, size limits, dedupe, idempotent cases, daily caps |
| 3 Uploads, parsing and voice | partly | Accepted files, byte sniffing, MIME, body limits; voice decoding built, not yet wired in; transcription planned |
| 4 The investigation pipeline | shipped (verdict a stub) | The Workflow's seven steps, retries, timeouts, partial cases, the reconcile cron |
| 5 Evidence and deterministic checks | shipped | The evidence model and every check: authentication, headers, lookalikes, domain age, attachments, hidden text, links |
| 6 Reputation and the hard floor | planned | Web Risk, 1.1.1.2, weighting, counter-signals, the floor |
| 7 Following the link | started | Canary credentials built; Browser Run, the Muse Wonder walk and driver limits planned |
| 8 Vision | partly | Spark, SAM 3.1, Loupe (1.0 trained), the page-screen contract |
| 9 The Meta model client | built | Gateway, store false, budget guard, KV cache; called by the pipeline once the verdict agent lands |
| 10 The verdict agent | planned | Tools, output JSON, the citation validator, prompt injection defence |
| 11 Invoices and payments | started | PDF forensics and fixed payment actions built; extraction, the supplier ledger and bank change rules planned |
| 12 The trust network | started | Protected-identity data model built; registration, bank privacy, badge and seal, the impersonation monitor planned |
| 13 Storage, retention and privacy | partly | D1, R2, KV, POPIA retention, logs, Meta terms |
| 14 The app | partly | Better Auth, tenancy, invite codes, domain proof, sign-in limits, report links, the cases list; the report page (new scene); admin console and site planned |
| 15 Proof and the stack | partly and shipped | Evaluation corpora built, runner next, targets and ablation; the pinned stack; stamped sections per domain |

## Operator decisions and open questions

- Narration in the operator's ElevenLabs voice, one segment per scene in [data/narration/02.json](../data/narration/02.json); each scene stays up until its clip ends (operator, 2026-10-30, superseding text only).
- Re-render once the verdict agent and full pipeline ship: yes, re-render with shipped chapter marks, the Meta infinity SVG mark in `MetaBadge`, the two-row Runtime Meta AI and `Built with Meta Muse Code (Wonder 1.0)` attribution strip, and the 5 Meta Model X-Ray overlays (approved 2026-11-03).

Script approved: 02, 2026-11-03
