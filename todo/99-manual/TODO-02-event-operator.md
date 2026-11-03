---
schema_version: 1
id: event-operator
domain: 99-manual
status: active
title: "TODO-02 -- Operator Tasks During the Event"
track: day-2
---

# TODO-02 -- Operator Tasks During the Event

> **Goal:** The steps only Derick can take during the build are done on time: Rizonetech dogfoods from day 2, any pilot client consents in writing, competitor posts are pasted in for review, the demo is recorded and edited, and the entry is submitted on Cerebral Valley by Wed 4 Nov 18:00 SAST and confirmed received.

> **Current state:** Measured 2026-10-26 20:00 SAST. Accounts and keys are in D99 T01. The design session is D07 T01 §1.

## Inputs

- `docs/hackathon-criteria.md` (submission requirements), design spec 4.10 (real usage), 5 (demo), plan Days 2, 6, 8 and 9.
- -> XREF: D09 T02 §3 -- the demo script and assets the recording follows

## Outcome

- Real Rizonetech usage counts exist from 27 Oct; the video is on YouTube; the submission shows as received.

**Adjacency:** all=not-applicable (operator actions outside the product)

**Adjacency rationale:** These are human steps; their results are recorded here.

## Implementation Order

| Order | Section | Deliverable | Depends On | Status |
| ----- | ------- | ----------- | ---------- | ------ |
| 1 | §1 | Rizonetech dogfooding from day 2 | -- | [ ] |
| 2 | §2 | Pilot client written consent | §1 | [ ] |
| 3 | §3 | Record the demo footage | §1 | [ ] |
| 4 | §4 | Assemble, caption and upload the video | §3 | [ ] |
| 5 | §5 | Submit on Cerebral Valley and confirm receipt | §4 | [ ] |
| 6 | §6 | Paste competitor updates for review | -- | [ ] |
| 7 | §7 | Publish Loupe LoRA weights and model card on Hugging Face | -- | [ ] |
| 8 | §8 | Post the demo on X for the Most Viral Project award | §4 | [ ] |
| 9 | §9 | Judge Getting-Started guide and access verification | §5 | [ ] |

## 1. Rizonetech dogfooding from day 2

Rizonetech is tenant one (spec 4.10): Derick and staff forward every suspicious email they receive from Tue 27 Oct, once intake is live.

**Phase:** 99
**Needs:** operator
**Surface:** no

**Build order:**

1. Register Rizonetech's domain and invite staff. Done when: staff are members and the domain is verified.

- [ ] Sign up with an invite code, verify `rizonetech.com`, and invite staff. Done when: the members list shows them.
- [ ] Tell staff to forward suspicious mail as an attachment to `check@isitlegit.co.za`, and record the start date here as a line `Dogfooding since: YYYY-MM-DD`. Done when: the line is written.
- [ ] Commit: `todo: record Rizonetech dogfooding`

**Test checkpoint:** `grep -cE '^Dogfooding since: 2026-' todo/99-manual/TODO-02-event-operator.md` prints `1`.

## 2. Pilot client written consent

Optional: one to three clients opt in in writing from day 6, covering processing by the Meta Model API in Standard mode (spec 4.10). Their content never leaves the product; only counts are shown.

**Phase:** 99
**Needs:** operator
**Surface:** no

**Build order:**

1. Ask and record. Done when: each pilot's consent is on file or the decision not to run pilots is recorded.

- [ ] Ask up to three clients and keep each signed consent outside the repository, recording here only `Pilot consent: <count>, YYYY-MM-DD` (no names). Done when: the line is written, with count 0 if none.
- [ ] Commit: `todo: record pilot consents`

Pilot consent: 1, 2026-10-27

Recorded 2026-10-27 11:26 SAST from the operator: the pilot is a client whose email security, Microsoft 365, websites and IT Rizonetech manages with permission to do what is needed to secure it, and who asked for this problem to be solved. The consent basis, the client's name and its account controller (a Rizonetech-controlled mailbox in the client's domain) are kept outside the repository in `samples/pilot-consent.md`; no mail is sent to the client's people (`AGENTS.md` Safety).

**Test checkpoint:** `grep -cE '^Pilot consent: [0-3], 2026-' todo/99-manual/TODO-02-event-operator.md` prints `1`.

## 3. Record the demo footage

OBS Studio at 1080p with Derick's voice on a separate track, following `docs/demo-script.md`; one uncut take of forward-to-reply with the demo clock (plan Day 8).

**Phase:** 99
**Needs:** operator
**Surface:** no

**Build order:**

1. Record each beat. Done when: the raw files exist and are listed here.

- [ ] Record the beats from `docs/demo-script.md` rebalanced to ~78% (~136 s of ~175 s) live product UI (`SCENES = [8, 18, 60, 18, 20, 20, 26, 10]`, no webcam PIP intro): (1) `8 s` cold open on the abstract animated background and the opening built-from-scratch claim ("From zero to production-ready in 9 days: product engineering, brand identity, UI/UX design system, model fine-tuning, evaluation harness, and marketing site, all built from scratch during the hackathon"), (2) `18 s` cohesive stakes sequence (SABRIC R2.41 bn -> Hawarden v ENS [2024] ZASCA 90 R5.5m ruling -> 533 caught client phishing emails + 10.8% to 18.8% industry miss rate = ~65 to 123 emails/month or 2 to 4 per day slipping through), (3) `60 s` uncut forward-to-verdict take (`8 s` forward/reply + `52 s` on `/r/:id?clock=1&trace=1`) showing `muse-spark-1.3`, `sam-3.1` side-by-side logo comparison, `muse-wonder-1.0` walkthrough actions (`#trace-actions`), and `#model-trace` (`?trace=1`), (4) `38 s` live Playwright captures of `/protect`, `/suppliers`, `/cases`, `/monitor`, `/v/fynbos-freight`, `/b/fynbos-freight.png`, and `/s/fynbos-freight` replacing all yellow `PLACEHOLDER` boards, (5) `20 s` `8 s` animated 5-Model Architecture diagram + `12 s` live `/check` voice-note upload -> `muse-voice-transcribe-1.0` transcript card with the WASM Opus benchmark overlaid on the live app, and (6) `26 s` live `/eval` dashboard and per-model ablation chart capture with the Loupe model card (`huggingface.co/rizonetech/isitlegit-loupe`) overlaid. Done when: a line `Footage recorded: YYYY-MM-DD` is written here.
- [ ] Commit: `todo: record demo footage done`

**Test checkpoint:** `grep -cE '^Footage recorded: 2026-' todo/99-manual/TODO-02-event-operator.md` prints `1`.

## 4. Assemble, caption and upload the video

DaVinci Resolve assembly with the Remotion assets (D09 T02 §4), captions from Muse Voice Transcribe exported as SRT and corrected by hand, at most 3 minutes, uploaded to YouTube (unlisted or public) and checked logged out (plan Day 8).

**Phase:** 99
**Needs:** operator
**Surface:** no

**Build order:**

1. Edit, caption and upload. Done when: the YouTube link plays logged out and is in the README.

- [ ] Assemble and export at 1080p, 3:00 or shorter (~78% / ~136 s live product UI across `SCENES = [8, 18, 60, 18, 20, 20, 26, 10]`, no webcam PIP intro), verifying: (1) the cold open on the abstract animated background and the opening built-from-scratch claim ("From zero to production-ready in 9 days: product engineering, brand identity, UI/UX design system, model fine-tuning, evaluation harness, and marketing site, all built from scratch during the hackathon"), (2) the `18 s` SABRIC -> Hawarden v ENS -> 533 caught / ~65 to 123 missed stakes flow, (3) the `60 s` live `/r/:id?clock=1&trace=1` investigation with the Remotion "How It's Done" X-Ray overlays (`muse-spark-1.3` untrusted fence & floor, `sam-3.1` mask crop vs. reference logo, `muse-wonder-1.0` containment HUD & canary, and `#model-trace`), (4) zero `PLACEHOLDER` boards in Scene 5, (5) the `8 s` animated 5-Model Architecture diagram + `12 s` live `/check` voice-note upload with the WASM Opus -> `muse-voice-transcribe-1.0` X-Ray overlay in Scene 6, and (6) the live `/eval` ablation chart + Loupe 1.1 (`Muse Glimmer 30B` LoRA -> `muse-spark-1.3` escalation, `huggingface.co/rizonetech/isitlegit-loupe`) X-Ray overlay in Scene 7 and Scene 8; plus, if time permits after the 3-minute submission cut is locked and uploaded, export and publish an Extended Cut (including the trimmed B-roll, full charts, and extra product footage, also without the PIP intro) to Facebook and YouTube. Done when: the submission cut's duration is 180 seconds or less.
- [ ] Upload to YouTube and record `Video: https://www.youtube.com/watch?v=<id>` here; Claude adds it to the README. Done when: the line is written and the link plays logged out.
- [ ] Commit: `todo: record the demo video link`

**Test checkpoint:** `grep -cE '^Video: https://www.youtube.com/watch\?v=' todo/99-manual/TODO-02-event-operator.md` prints `1`.

## 5. Submit on Cerebral Valley and confirm receipt

Submit by Wed 4 Nov 18:00 SAST (official deadline Thu 5 Nov 04:00 SAST): public repository, video link, Startup track, Rizonetech as the startup, the judge demo code (`docs/hackathon-criteria.md`).

**Phase:** 99
**Needs:** operator
**Surface:** no

**Build order:**

1. Submit and confirm. Done when: the submission shows as received.

- [ ] Make `rizonetech/isitlegit` public again on Tue 3 Nov 2026, before submitting (operator decision 2026-10-30 20:05 SAST: private from then until submission, since the Official Rules need the repository public at submission, `docs/hackathon-criteria.md`): `gh repo edit rizonetech/isitlegit --visibility public --accept-visibility-change-consequences`. Done when: `gh api repos/rizonetech/isitlegit --jq .visibility` prints `public` and a logged-out `curl -s -o /dev/null -w '%{http_code}' https://github.com/rizonetech/isitlegit` prints `200`.
- [ ] Submit at `https://cerebralvalley.ai/e/meta-ai-developer-hackathon/hackathon/submit` with the repository URL, video link, track and judge code. Done when: the form confirms.
- [ ] Record `Submitted: YYYY-MM-DD HH:MM SAST` here after seeing the submission as received. Done when: the line is written.
- [ ] Commit: `todo: record the submission`

**Test checkpoint:** `grep -cE '^Submitted: 2026-11-0[1-4] ' todo/99-manual/TODO-02-event-operator.md` prints `1`.

## 6. Paste competitor updates for review

Claude cannot read Discord; on Sun 1 Nov and Tue 3 Nov Derick pastes new project posts so the competitor profiles stay current (plan Day 8).

**Phase:** 99
**Needs:** operator
**Surface:** no

**Build order:**

1. Paste updates twice. Done when: both dates are recorded here.

- [x] Paste new Discord project posts on Sun 1 Nov and Tue 3 Nov and record `Competitor update: YYYY-MM-DD` here each time. Done when: two lines exist.
- [ ] Commit: `todo: record competitor updates`

Competitor update: 2026-11-01
Competitor update: 2026-11-03

**Test checkpoint:** `grep -cE '^Competitor update: 2026-11-0[1-3]$' todo/99-manual/TODO-02-event-operator.md` prints `2`.

## 7. Publish Loupe LoRA weights and model card on Hugging Face

Upload the fine-tuned Loupe (Muse Glimmer 30B LoRA) adapter weights, evaluation summary, and generated model card (`docs/glimmer/model-card-1.0.md` and `1.1` when promoted) to Hugging Face under `rizonetech/isitlegit-loupe`, containing model weights and public evaluation summaries only (never client mail or training rows).

**Phase:** 99
**Needs:** operator
**Surface:** no

**Build order:**

1. Create the model repository, upload the adapter weights and model card, and link it in the README. Done when: the public Hugging Face page resolves logged out and is recorded here.

- [ ] Create `https://huggingface.co/rizonetech/isitlegit-loupe`, upload the Loupe LoRA adapter weights and the generated model card (`README.md`) with held-out recall, false-alarm rate, latency, and dataset provenance, and record `Hugging Face: https://huggingface.co/rizonetech/isitlegit-loupe` here. Done when: a logged-out `curl -s -o /dev/null -w '%{http_code}' https://huggingface.co/rizonetech/isitlegit-loupe` prints `200` and the line is written here.
- [ ] Commit: `todo: record Hugging Face model release`

**Test checkpoint:** `grep -cE '^Hugging Face: https://huggingface\.co/' todo/99-manual/TODO-02-event-operator.md` prints `1`.

## 8. Post the demo on X for the Most Viral Project award

Post the public demo thread and video on X (`@AIMetaDevs` tagged) for the US$20,000 Most Viral Project on X award (`docs/hackathon-criteria.md`): lead with the 15-second hook clip (`check@isitlegit.co.za` forward-to-verdict, live Muse Wonder containment walkthrough, and SAM 3.1 + Loupe trace), link the live demo (`https://isitlegit.co.za`), GitHub repository, and Hugging Face model card, and submit the X post URL on Cerebral Valley.

**Phase:** 99
**Needs:** operator
**Surface:** no

**Build order:**

1. Publish the X launch post and record its URL. Done when: the post is live, tags `@AIMetaDevs`, and is recorded here.

- [ ] Publish the demo video and launch thread on X tagging `@AIMetaDevs`, include the live `https://isitlegit.co.za` demo, GitHub repo, and Hugging Face links, and record `X post: https://x.com/<handle>/status/<id>` here. Done when: the line is written here and included in the Cerebral Valley submission.
- [ ] Commit: `todo: record X launch post`

**Test checkpoint:** `grep -cE '^X post: https://(x|twitter)\.com/' todo/99-manual/TODO-02-event-operator.md` prints `1`.

## 9. Judge Getting-Started guide and access verification

Verify in a clean incognito browser that a hackathon judge landing on the GitHub README or `https://isitlegit.co.za` can test every Meta model flow in under 60 seconds without installing anything (`docs/hackathon-criteria.md`).

**Phase:** 99
**Needs:** operator
**Surface:** no

**Build order:**

1. Verify the 60-second judge quickstart in a logged-out browser. Done when: every step works logged out and the check is recorded here.

- [ ] Verify the Judge Quickstart at the top of `README.md` in an incognito browser: (1) open the pre-populated demo org and sample cases (`https://isitlegit.co.za`), (2) sign in with the judge demo invite code or trigger a live upload check, (3) forward a test email to `check@isitlegit.co.za`, and (4) inspect the per-case model trace (Muse Spark, Muse Wonder browser walkthrough, SAM 3.1 logo segmentation, Loupe / Muse Glimmer screener, and Muse Voice Transcribe), then record `Judge quickstart verified: YYYY-MM-DD` here. Done when: the line is written here.
- [ ] Commit: `todo: record judge quickstart verification`

**Test checkpoint:** `grep -cE '^Judge quickstart verified: 2026-11-0[1-4]$' todo/99-manual/TODO-02-event-operator.md` prints `1`.

## Verification

- Each line above is recorded; the submission is received.
- `python3 scripts/todo-graph.py validate` and `plan --check` pass.
