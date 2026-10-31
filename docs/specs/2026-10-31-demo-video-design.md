# Demo video design

Written 2026-10-31 by the media lane with the operator. Governs D09 T02 §3 (demo script and model-trace demo mode) and §4 (title cards and animation), moved to the media lane by the coordinator on 2026-10-31 (local `main` `21fc5c8d`). Recording and upload stay the operator's (D99 T02 §3 to §5); the final eval run (§5) and README (§6) stay with the eval lane.

## Goal

A 3-minute video that wins the Demo criterion (25%, `docs/hackathon-criteria.md`) and carries Impact (30%) and Use of Meta AI tooling (25%) with it: a judge finishes it knowing who it protects, what each Meta model does that only it can do, and that every frame is the live service.

## Rules it is held to

- Every feature shown runs on the live service at capture time. No mocked screens, no staged UI (criteria, Demo row).
- Only synthetic fixtures and fictional businesses (Fynbos Freight and the D07 T07 suppliers). No client mail, names or bank details.
- Every figure on screen is a `{fact.x}` or `{stats.x}`, proven by `media/tools/check-facts.py`, as in videos 01 to 03.
- Development tooling is never shown as a product feature (`CONTRIBUTIONS.md`).
- 1920 x 1080 at 30 fps, mastered to -14 LUFS, narrated in the operator's ElevenLabs voice; YouTube's altered or synthetic content box is ticked on upload.

## Decisions (operator, 2026-10-31)

| Decision | Choice |
| -------- | ------ |
| Who builds it | The media lane, in `media/` (not a new `video/` package) |
| Capture | Scripted Playwright recordings of the live service, composed in Remotion |
| Hero case | The invoice bank change |
| Running order | Invoice-led (below) |
| Voice | The operator's ElevenLabs voice |
| Mail side | A dedicated Microsoft 365 mailbox, `demo@rizonetech.com` (vault item `IsItLegit demo mailbox`); tested 2026-10-31 17:40 SAST: sign-in, a saved session reused without the password, and send and receive in about 10 s |
| Freeze | Capture daily; final capture Tue 3 Nov evening; final render and operator review Wed 4 Nov morning; submitted before the 18:00 SAST own deadline |
| Publication | The same cut in the submission and on @DerickPayneDev, in the IsItLegit playlist |

## Beat sheet

| Time | Beat | On screen | Meta model | Depends on (lane) |
| ---- | ---- | --------- | ---------- | ----------------- |
| 0:00 to 0:15 | Cold open | A supplier invoice email whose bank details were quietly changed; what that fraud costs | | fixture only |
| 0:15 to 1:15 | Invoice bank change (hero) | Forward from the demo mailbox; the report fills in live with an on-screen clock; the bank change against the supplier ledger; PDF forensics; the Do this first block; the model trace open | Muse Spark, SAM 3.1 | D06 T01 §1 to §3 (trust), D04 T01 §4 and §5 (checks), D07 T03 §5 trace panel and §15 invoice cards (app), D07 T07 §1 and §2 demo organisation (site) |
| 1:15 to 1:55 | Phishing lure | The reply landing in the inbox; Muse Wonder walking the fake login and typing a canary; the SAM logo crop; hidden text aimed at an AI shown as evidence | Muse Wonder, SAM 3.1, Muse Spark | D04 T02 §1, §3 to §6 (walkthrough), D03 T03 §1 and §3 (walkthrough), D07 T03 §13 and §14 (app) |
| 1:55 to 2:15 | Voice note and safe mail | A voice note uploaded, transcribed and judged; a genuine mail marked safe | Muse Voice Transcribe | D01 T03 §3 and §4 (checks), D07 T03 §16 (app) |
| 2:15 to 2:40 | Proof | The eval dashboard, the ablation per model, Loupe 1.0's held-out lure recall, the deterministic floor | all | D08 T02 §1 to §4 (eval) |
| 2:40 to 3:00 | What's new | Built 26 Oct to 4 Nov by one operator and nine lanes; each Meta model's job | | none |

Shipped today on `main` and capturable now: the upload page, the report page (verdict band, evidence cards, live status, feedback), the cases list, every deterministic check's evidence card, PDF forensics cards, the canary credentials. The verdict step is a stub, so reasons and actions stay empty until D04 T01 lands.

## Capture system

- `media/capture/`: one Playwright script per beat. Each signs in to the judge demo organisation, submits its fixture (upload, or a forward from the demo mailbox in Outlook on the web), waits for the case to finish, and records 1920 x 1080 video and stills.
- The demo mailbox signs in once, by the operator, into a persistent Playwright profile kept outside the repository (`~/isitlegit-data/media/demo-profile/`); every capture reuses that session, and no password passes through a script.
- Each run writes a manifest: the case IDs, the live Worker version, the capture time, and the on-screen box of every element a scene highlights, so Remotion's zooms and callouts land on the real pixels.
- `pnpm capture:demo` then `pnpm render:demo`. A beat whose feature is not live is skipped and listed, so each day shows exactly what is missing.
- Captures and renders stay in `media/out/` (git-ignored); the scripts, fixtures index and manifest schema are committed.

## Composition

A Remotion composition `Demo` in `media/src/videos/`, reusing the brand kit, cold open, voice and sound pipeline of videos 01 to 03: recorded clips framed in a browser chrome, timed zooms to manifest boxes, short captions naming the model at work, and title cards plus the animated architecture diagram (§4's scope).

## Model-trace demo mode (§3)

The report page's model trace (`?trace=1`) and an on-screen clock (`?clock=1`) are product code in `src/` owned by the app lane's report page. They take the full section process and reviews, and every change to an app-lane file is asked of the coordinator first.

## Risks

- Most of the hero beat depends on four other lanes shipping by about 3 Nov. Mitigation: build the rig and the live beats first; each day's capture shows what is missing; if a dependency misses the freeze, its beat shrinks to what is live, never to a mock.
- Live latency: a slow case is cut with a visible clock jump, never sped up silently.
- Mail delivery: the forward-to-reply take is captured uncut at least once with the clock visible.

## Open items

- The demo mailbox signs in with its password alone (no MFA challenge, tested 2026-10-31); whether to enforce MFA is the operator's decision.
- The demo mailbox becomes a member of the judge demo organisation (D07 T07 §2).
- The coordinator's `21fc5c8d` reaches `origin/main`; then the media lane merges it and records `Started:` on §3 and §4, correcting §4's paths to `media/`.
