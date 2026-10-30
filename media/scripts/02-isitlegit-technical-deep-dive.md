# 02 IsItLegit: how it works

The product's technical specification in full, for learning and for the channel: about 11 minutes, 1920 × 1080, on-screen text, narrated in the operator's cloned voice when `data/narration/02.json` has been voiced (silent otherwise). Long form on the operator's request (2026-10-30), replacing the 60-second tech stack video; it is not part of the demo video.

The script is the storyboard [data/storyboards/02-technical-deep-dive.json](../data/storyboards/02-technical-deep-dive.json). Its figures come from [data/tech-facts.json](../data/tech-facts.json): 92 facts, each pinned to a commit and an exact quote from the design spec, the tech stack spec, `wrangler.jsonc`, `package.json` or `src/`, proven by `tools/check-facts.py` before a render.

## Honest build state

Every chapter card says shipped, partly built or planned. Shipped means the code is in `src/` at the pinned commit; planned means designed in the spec, not built. Diagrams are diagrams, not product screens, so this video never stands in for the live demo.

## Chapters

| Chapter | Status | What it covers |
| ------- | ------ | -------------- |
| 1 What it does | n/a | The problem, the answer, the whole system as one Worker |
| 2 Email intake | shipped | Email Routing, membership, size limits, dedupe, idempotent cases, daily caps |
| 3 Uploads, parsing and voice | partly | Accepted files, byte sniffing, MIME, body limits, voice decoding, transcription |
| 4 The investigation pipeline | shipped (verdict a stub) | The Workflow's seven steps, retries, timeouts, partial cases, the reconcile cron |
| 5 Evidence and deterministic checks | partly | The evidence model and the checks, shipped and planned |
| 6 Reputation and the hard floor | planned | Web Risk, 1.1.1.2, weighting, counter-signals, the floor |
| 7 Following the link | planned | Browser Run, Muse Wonder with canary credentials, driver limits |
| 8 Vision | partly | Spark, SAM 3.1, Loupe, the page-screen contract |
| 9 The Meta model client | shipped | The models and their jobs, AI Gateway, store: false, budget and caching |
| 10 The verdict agent | planned | Tools, output JSON, the citation validator, prompt injection defence |
| 11 Invoices and payments | planned | Field extraction, the supplier ledger, bank change rules, document forensics |
| 12 The trust network | planned | Registered identity, bank privacy, badge and seal, the impersonation monitor |
| 13 Storage, retention and privacy | partly | D1, R2, KV, POPIA retention, logs, Meta terms |
| 14 The app | partly | Better Auth, tenancy, invite codes, domain proof, sign-in limits, report links |
| 15 Proof and the stack | planned and shipped | Evaluation targets and ablation, the pinned stack, stamped sections per domain |

## Operator decisions and open questions

- Narration in the operator's ElevenLabs voice clone, one segment per scene in [data/narration/02.json](../data/narration/02.json); each scene stays up until its clip ends (operator, 2026-10-30, superseding text only).
- Re-render once the verdict agent ships, to move chapters 6, 7 and 10 from planned to shipped?
