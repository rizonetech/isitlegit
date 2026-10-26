# Phishing and invoice-fraud analyser: build plan

Spec: `docs/specs/2026-10-26-phishing-invoice-analyser-design.md`. Deadline: submit by Wed 4 Nov 18:00 SAST (hard limit Thu 5 Nov 04:00 SAST). Solo build, Claude implements, Derick reviews and owns accounts.

Execution: from 2026-10-26 17:00 this plan is executed through the TODO system in `todo/` (format `todo/README.md`, workflow `docs/todo-workflow.md`), ported from Recto through the Conclave-SDK kits. Each day below becomes TODO sections; a section closes only through a reviewed stamp. Day 0 lives in `todo/00-workspace/TODO-01-repo-and-scaffold.md` and `todo/99-manual/TODO-01-day0-accounts.md`.

Conventions for every task: TypeScript strict, one Cloudflare Worker (fetch, email and queue handlers), Hono for routes and server-rendered pages, zod for every external input and every model output, Vitest with `@cloudflare/vitest-pool-workers`, tests first for every check. Secrets only through `wrangler secret`. Commit after each task with a message that says what was built.

Every build day from Tue 27 Oct: one frontier experiment at the edge of the Meta models, logged in `docs/frontier-log.md` (spec 4.9, `docs/manifesto.md`).

## Day 0: Mon 26 Oct (after 19:00 SAST kickoff)

Derick (accounts, cannot be delegated):
- [ ] Watch kickoff; note any rule or model changes into `sources/`.
- [x] Claim form for the $150 credit submitted (2026-10-26 15:51).
- [ ] Meta Model API account: payment method on file, Spend Limit notification at $150, API key created and stored in the Conclave vault; confirm the credit shows under Billing, "free credits".
- [x] Product name IsItLegit, domain `isitlegit.co.za` (decided 12:05).
- [ ] Register `isitlegit.co.za` on Domains.co.za (R80); Claude then adds the Cloudflare zone and nameservers.
- [ ] Google Cloud: enable the Web Risk API in a Rizonetech project, create an API key restricted to it, store in the Conclave vault.
- [ ] Apply for partner credits if offered (Baseten, Modal, Fireworks). Fireworks matters most: it hosts Muse Glimmer.
- [ ] ~~Meta for Developers: create an app with the WhatsApp product (Business portfolio under Rizonetech), note the test number, add your own and staff numbers as test recipients. Store the access token and app secret in the Conclave vault.~~ Out of the event scope (operator, 2026-10-26 19:30; spec 4.1a).

Claude:
- [ ] `git init`, first commit after 19:00 SAST: README (what it is, "built during the Meta Global AI Developer Hackathon, 26 Oct to 4 Nov 2026"), `.gitignore`, licence file per decision, `docs/` and `sources/`.
- [ ] Create the public GitHub repo under `rizonetech` and push.
- [ ] Scaffold per `docs/specs/2026-10-26-tech-stack-design.md`: `wrangler.jsonc` with D1, R2, KV, Workflow, Browser Run bindings; `SMTP2GO_API_KEY` secret; Hono app with `/health`; Vitest 4 workers pool; CI running typecheck and tests.
- [ ] AI Gateway custom provider for `api.meta.ai` (payload logging off); confirm Workers Paid plan.
- [ ] Gate before any Meta API call: the $150 shows under Billing, "free credits", and a Spend Limit notification is set at $150. Until then every call is charged to the card.
- [ ] `scripts/meta-smoke.ts`: one call each to `muse-spark-1.3` (text, then an image), `sam-3.1` with prompt "logo" on a synthetic branded image, and `muse-wonder-1.0` with the computer tool for one step. All with `store: false`. Record results in `sources/meta-api/2026-10-26-smoke-test.md`.

Done when: repo public, CI green, smoke test shows each of the four capabilities working or a named fallback.

## Day 1: Tue 27 Oct, intake and pipeline skeleton

- [ ] D1 schema and migrations: Better Auth tables (users, sessions, organisations, members, invitations), `tenant_domains` (with verification state), `cases`, `evidence`, `suppliers`, `feedback`, `eval_runs`, `eval_results`.
- [ ] Better Auth: magic link and passkeys, organisations, invites; signup creates an organisation with a 14-day trial.
- [ ] Domain verification (DNS TXT or emailed code); intake accepts mail only from verified domains.
- [ ] Email handler: accept only senders whose domain is in `tenant_domains`; store raw message in R2; create case; enqueue. Tests: unknown sender dropped, known sender creates case.
- [ ] Forward detection: find attached `message/rfc822` or `.msg`; otherwise mark `headers_available = false`. Tests with fixtures for both.
- [ ] MIME parsing with `postal-mime`; pick and test an MSG reader that runs in Workers; attachments to R2.
- [ ] Web upload route (`.eml`, `.msg`) feeding the same queue.
- [ ] `AnalysisWorkflow` runs a stub pipeline and stores a stub verdict; report page shows it.
- [ ] Email Routing rule for `check@isitlegit.co.za` to the Worker; outbound replies through the SMTP2GO HTTP API, threaded with `In-Reply-To`; sender domain verified in SMTP2GO.

Done when: forwarding a fixture email to the live address produces a reply with a link to a (stub) report.

## Day 2 start: dogfood

- [ ] Register Rizonetech as tenant 1; Derick and staff forward every suspicious email from here on (spec 4.10).

## Day 2: Wed 28 Oct, deterministic checks

- [ ] `Evidence` type and registry; every check is a pure function `(case) => Evidence[]` with its own tests.
- [ ] Authentication results (SPF, DKIM, DMARC, alignment, ARC), trusting only the tenant's receiving headers.
- [ ] Sender checks: display name vs address, Reply-To and Return-Path mismatch, first-time sender.
- [ ] Lookalike domains: confusables, edit distance, added words; against tenant domain, suppliers, brand table.
- [ ] Domain age via RDAP with caching.
- [ ] Attachment checks: real type vs extension, HTML attachments, macros, encrypted archives, executables.
- [ ] Hidden-text check (spec 4.3): invisible text and text addressed to AI filters become evidence.
- [ ] Choose eval datasets, record licences in `eval/DATASETS.md`; write the first 20 synthetic South African samples (fake banks, fake suppliers).

Done when: fixture suite yields the expected evidence for each check, and the report page lists evidence cards.

## Day 3: Thu 29 Oct, links and first vision

- [ ] Reputation signals (spec 4.3a): Web Risk `uris.search` client, 1.1.1.2 DoH check, top-sites list loaded into KV; weighting rules with tests (IP listing alone never raises severity; listing alone never makes a verdict malicious; verified or well-known domain shown as counter-evidence).

- [ ] URL extraction from HTML, text and PDF annotations.
- [ ] Redirect expansion and landing-page screenshot in Browser Run with downloads blocked; detect password and card forms.
- [ ] QR decoding from images and PDF pages into the link checks.
- [ ] Render email HTML to a screenshot; Muse Spark structured extraction (claimed brand, requested action, urgency, visible sender) with zod-validated output.
- [ ] Model client wrapper: `store: false`, Standard IDs only (a test fails if a `-contributor` ID appears anywhere), retries, cache by artefact hash in D1 or KV, cost logging per case.

Done when: a phishing fixture shows the claimed brand, the requested action and the landing-page screenshot on its report.

## Day 4: Fri 30 Oct, logos and the walkthrough agent

- [ ] SAM 3.1 "logo" segmentation on email and landing screenshots, parsed with `@meta-sam/parser`; crops to R2.
- [ ] Logo comparison: crop plus reference logo to Muse Spark for same/different; brand domain table; search grounding for unknown brands.
- [ ] Day-1 quality check of SAM on 20 branded samples; switch to perception grounding if recall is poor and record why.
- [ ] Computer-use driver: Puppeteer on Browser Run executing Muse Wonder `computer_call` actions, with hard limits (8 steps, 60 s, no downloads, http(s) only, canary values only) enforced and tested in the driver.
- [ ] Canary credential generator and form-target capture; walkthrough evidence with screenshot chain.

Done when: the fake Microsoft login fixture site (hosted by us) is walked end to end and the report shows where the password would have gone.

## Trust network additions (decided 12:30; spread over days 1, 5 and 6)

- [ ] Day 1: organisations double as **protected identities**: verified domains, sending addresses, logo upload (R2), bank accounts (stored encrypted at rest with a Worker secret key).
- [ ] Day 5: closed-loop verification: on a bank-detail mismatch, email the supplier's registered finance contact from `verify@isitlegit.co.za`, record the reply on the case.
- [ ] Day 6: counterparty path: mail from non-members is accepted and checked against the registry when it claims a protected identity (display name, domain, logo, signature); rate limits per sender and per identity; never reveal registered details.
- [ ] Day 6: impersonation alerts to the protected business with the evidence.
- [ ] Demo: the courier forwards the fake "Fynbos Freight" statement request (synthetic, fictional company) and gets "impersonation" back; the protected business receives the alert.

## Broader Meta layer (decided 15:30)

- [ ] ~~Day 1: WhatsApp webhook route (signature check, media to R2, same Workflow); reply in chat. Tests: bad signature rejected, unknown number ignored, image and PDF create cases.~~ Out of the event scope (operator, 2026-10-26 19:30; spec 4.1a).
- [ ] Day 1 spike: `ogg-opus-decoder` in Workers to 16 kHz WAV; one call to `muse-voice-transcribe-1.0`.
- [ ] Day 3: voice notes and voicemail lures (spec 4.2a): transcript, request and claimed-identity extraction, trust-network check of the claimed caller.
- [ ] Day 5: Muse Image doctored-document pairs for the eval (spec 4.9), fictional companies only, stamped SYNTHETIC.
- [ ] Day 6 or 7: Muse Glimmer screening in the impersonation monitor through a hosted provider; record cost per page against Muse Spark.
- [ ] Demo: a voice note from a "director" asking for an urgent payment, uploaded on the web and checked (WhatsApp intake is after the event, spec 4.1a).

## Paid layers (decided 15:10; after the core and trust network)

- [ ] Day 5: payment document check (spec 4.5a): standalone upload of invoices, POPs and bank confirmation letters; PDF forensics (producer, incremental updates, fonts, dates) with fixture tests; Muse Spark field and layout extraction; synthetic genuine and doctored POP pairs.
- [ ] Day 6 or 7: impersonation monitor (spec 4.11): lookalike candidate generator (tests), DNS-over-HTTPS check, daily Cron Trigger, new hosts into the screenshot, SAM and walkthrough pipeline, alert email with takedown pack; certificate-transparency search if time allows.
- [ ] Plan flag per feature; the trial unlocks all.
- [ ] Demo fixture: a lookalike site of the fictional demo company, hosted by us, found by the monitor before the fake mail arrives.

## Day 5: Sat 31 Oct, invoice fraud

- [ ] Invoice detection and field extraction from PDFs with Muse Spark (native PDF input), zod schema for bank fields.
- [ ] Supplier ledger: admin pages to add suppliers and bank details, CSV import, "mark invoice verified" from a report.
- [ ] Rules: bank details changed, supplier domain changed, change-of-bank language; critical evidence with the fixed "phone the supplier on the number in your records" action.
- [ ] Synthetic invoice set: genuine and tampered pairs for three fake suppliers.

Done when: the tampered invoice fixture is flagged critical and the genuine one is not.

## Day 6: Sun 1 Nov, verdict agent and reply

- [ ] Muse Spark verdict agent on the Responses API with the tool set from the spec; zod validation of every tool call.
- [ ] Citation validator (every claim cites existing evidence IDs; one retry, then rule-based fallback).
- [ ] Deterministic floor: critical evidence caps the verdict; tests prove the model cannot lower it.
- [ ] Prompt-injection defence (spec 4.6a): untrusted content in delimited blocks, recipients and templates from code only; injection fixtures prove verdict, recipients and tool calls do not change.
- [ ] Reply email template (plain language, verdict, top three reasons, link) and the final report page design (Rizonetech brand: Exo / Exo 2, orange `#FF4A14`).
- [ ] "This was wrong" feedback button.
- [ ] Derick: onboard one to three pilot clients with written consent (spec 4.10).

Done when: every fixture produces a cited verdict and the floor tests pass.

## Day 7: Mon 2 Nov, evaluation

- [ ] Eval runner CLI that pushes each labelled sample through the real pipeline.
- [ ] Metrics: detection rate, false positive rate, per category, median time to verdict, cost per case.
- [ ] Model ablation (spec 4.9): rerun with each Meta model switched off in turn; record the cost of each removal in `eval/RESULTS.md` and on the dashboard.
- [ ] Dashboard page with the latest run and production counts (cases, verdict mix, median time, invoice flags; no content).
- [ ] Fix the worst misses found; rerun; record before and after in `eval/RESULTS.md`.

Done when: the dashboard shows a full run on at least 100 samples within budget.

## Day 8: Tue 3 Nov, production hardening and video

- [ ] Cloudflare Access in front of `/admin` (MSP console) with JWT verification in the Worker; signed expiring report links; sign-in rate limits.
- [ ] Client dashboard and MSP console pages finished.
- [ ] Astro marketing site at `isitlegit.co.za`: home, how it works, invoice fraud, pricing (no billing), privacy and POPIA, signup link. Copy written to the marketing-copy rules and checked with `article-check` if installed.
- [ ] R2 lifecycle rule (30 days), rate limit per tenant, size limits on uploads and attachments.
- [ ] Error paths: Meta API down, Browser Run timeout, oversized email; each produces a clear partial report.
- [ ] Code review of the full diff (Opus reviewer), fix findings.
- [ ] Re-check competitor repos and posts (also on Sun 1 Nov); update `competitors/`.
- [ ] `CONTRIBUTIONS.md`: what was built during the event, by day, with commit ranges; third-party code and data listed separately.
- [ ] Record the 3 minute demo video against the spec's script, with an on-screen label naming the Meta model at each moment it is called (Muse Spark, SAM 3.1, Muse Wonder) and the agent's containment limits shown; upload; check the link works logged out.
  - Labels come from the app itself: a demo-mode "model trace" panel on the report page fed by the real pipeline events (model, step, time, cost), so no labels are faked in editing.
  - Capture with OBS Studio (1080p, Derick's voice on a separate track); one uncut take of forward-to-reply with an on-screen clock to prove the speed.
  - Title cards, the animated architecture diagram and the model-trace highlights built in Remotion (`video/`, pinned to 4.x) and rendered to MP4; the screen recordings drop into the Remotion timeline.
  - Final assembly and audio in DaVinci Resolve (free); captions from `muse-voice-transcribe-1.0` exported as SRT and corrected by hand.
  - Upload to YouTube as unlisted or public; the link goes in the README and the submission.

## Day 9: Wed 4 Nov, submit

- [ ] README final: problem, demo link, architecture diagram, Meta models and how each is used, what was built during the event, third-party libraries and datasets with licences, how to run.
- [ ] Final eval run and dashboard screenshot.
- [ ] Submit on Cerebral Valley by 18:00 SAST: public repo, video link, Startup track, Rizonetech as the startup.
- [ ] Confirm the submission shows as received.

## Standing rules

- No real client email in the repo, fixtures, eval set, demo or Discord.
- Model IDs: Standard mode only, `store: false` everywhere.
- Every day ends with the live deployment working end to end, even if some checks are stubbed.
- If a day slips, take from the spec's cut list, not from tests or the eval.
