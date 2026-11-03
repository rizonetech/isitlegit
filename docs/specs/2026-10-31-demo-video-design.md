# Demo video design

Written 2026-10-31 by the media lane with the operator. Governs D09 T02 §3 (demo script and model-trace demo mode) and §4 (title cards and animation), moved to the media lane by the coordinator on 2026-10-31 (local `main` `21fc5c8d`). Recording and upload stay the operator's (D99 T02 §3 to §5); the final eval run (§5) and README (§6) stay with the eval lane.

## Goal

A 3-minute video that wins the Demo criterion (25%, `docs/hackathon-criteria.md`) and carries Impact (30%) and Use of Meta AI tooling (25%) with it: a judge finishes it knowing who it protects, what each Meta model does that only it can do, and that every frame is the live service.

## Rules it is held to

- Every feature shown runs on the live service at capture time. No mocked screens, no staged UI (criteria, Demo row).
- Only synthetic fixtures and fictional businesses (Fynbos Freight and the D07 T07 suppliers). No client mail, names or bank details.
- Fynbos Freight's logo and every fact about it come from the shared kit at `data/demo/fynbos-freight/` on `main` (`brand.json`, `logo/`; logo A1, the protea bloom, chosen by the operator on 2026-10-31), never typed into a fixture or scene.
- The rig never presses a sign-out control: a session ending mid-upload is suspected of leaving a case stuck in Checking (reported 2026-10-31; the checks lane owns the fix).
- Every figure on screen is a `{fact.x}` or `{stats.x}`, proven by `media/tools/check-facts.py`, as in videos 01 to 03.
- Development tooling is never shown as a product feature (`CONTRIBUTIONS.md`).
- 1920 x 1080 at 30 fps, mastered to -14 LUFS, narrated in the operator's ElevenLabs voice; AI-generated content is disclosed once, at upload (YouTube's altered or synthetic content box and one line in the submission), never shot by shot; the screen recordings are real footage of the live system and are not AI-generated (operator, 2026-10-31 18:50 SAST).

## Decisions (operator, 2026-10-31)

| Decision | Choice |
| -------- | ------ |
| Who builds it | The media lane, in `media/` (not a new `video/` package) |
| Capture | Scripted Playwright recordings of the live service, composed in Remotion |
| Hero case | The invoice bank change |
| Running order | Invoice-led, then the spine below (approved 2026-10-31 18:33 SAST) |
| Voice | Brian, an ElevenLabs premade voice (operator, 2026-10-31 20:45 SAST, after the v3 cold-open test); the operator's own clone, Derick Payne v2, is the fallback. Videos 01 to 03 on `eleven_multilingual_v2`, the demo on `eleven_v3` |
| Mail side | A dedicated Microsoft 365 mailbox, `demo@rizonetech.com` (vault item `IsItLegit demo mailbox`); tested 2026-10-31 17:40 SAST: sign-in, a saved session reused without the password, and send and receive in about 10 s |
| Freeze | Capture daily; final capture Tue 3 Nov evening; final render and operator review Wed 4 Nov morning; submitted before the 18:00 SAST own deadline |
| Demo mailbox security | Password only, no MFA (operator, 2026-10-31 17:45 SAST): unattended captures need no second factor; the account holds only demo mail and a long password kept in the vault |
| Central claim | Strong but provable (operator, 2026-10-31 18:33 SAST): "The fraud your filter can't see, because it comes from someone you trust." No "only system" or "unsolvable": every word is backed by something live on screen or a sourced figure |
| Generated footage | Veo (Google) and OpenAI video and images may be used freely for the cold open and illustrations (operator, 2026-10-31); disclosed once at upload, never per shot; a generated shot never stands in for the product's own screens |
| South Africa's scale | Approved figures (operator, 2026-10-31 18:45 SAST), each checked in its primary source: SABRIC Annual Crime Statistics 2025 p. 7, digital banking fraud losses R1.09 bn (2023), R1.86 bn (2024), R2.41 bn (2025), labelled as all digital banking fraud, never as phishing alone; p. 6 to 7, internet banking under 9% of cases but 28.6% of the rand; p. 9, the quote naming supplier mandate fraud and business email compromise as material risks; FBI IC3 2025 Annual Report, BEC adjusted losses $3,046,598,558. Left out as unverified or weak: a 70% African BEC share (news only), a 2022 vendor survey, Kaspersky's falling count, SAFPS figures. Hawarden v Edward Nathan Sonnenbergs is being verified from the judgment before any use |
| Meta story | Every model call in production is a Meta model, each doing a job only it can do, proven by the model trace on screen; no Meta model is added for decoration (Muse Image is not used to illustrate the video) (operator, 2026-10-31 18:38 SAST). It must be true on the live service at capture time |
| Technical depth | Slightly more, never crowded: a thin trace strip on every live beat (the model at work, the step, its latency, from the real model trace) and a Loupe 1.0 model card in the proof beat (operator, 2026-10-31) |
| Hero roles | Both, one story (operator, 2026-10-31 18:40 SAST): Fynbos Freight is the supplier whose identity is protected. A lookalike domain (`domains.lookalikes` in brand.json) sends Fynbos's customer an "updated banking details" invoice; the customer forwards it and IsItLegit flags the bank change against Fynbos's account on file (`bank` in brand.json); then Fynbos's own side shows the impersonation. The live demo shows the customer, then the supplier: the closed loop in one case. The customer is a second fictional member, to be set up through the coordinator |
| Our own client | Anonymised totals only, on the operator's authority as the client's IT provider (2026-10-31 18:46 SAST, recorded in the git-ignored consent file): "One Rizonetech client, a small South African business: 533 phishing emails caught in 30 days" (27 Sep to 26 Oct 2026; Microsoft Defender rated 341 high-confidence phishing, 192 phishing). Under published Microsoft 365 / Secure Email Gateway miss-rate benchmarks (Check Point / Avanan 3M-email study: 10.8% to 18.8% of phishing emails bypass default Microsoft Defender filtering), 533 caught emails implies roughly 65 to 123 phishing emails per month (2 to 4 per day) still slipping into staff inboxes, and 100% of genuine-mailbox supplier invoice compromises pass SPF, DKIM and DMARC. Never the client's name, domain, people or any mail. Framed as why we built it, not as a result: Defender blocked those 533, while the bypasses and genuine-mailbox takeovers are what reach staff |
| The court case | Usable, as its final outcome: Hawarden v Edward Nathan Sonnenbergs. A R5.5 million home-purchase payment went to a fraudster after a hacked inbox and a one-letter lookalike address ("ensafirca"); the High Court ordered the law firm to pay (2023, [2023] ZAGPJHC 14), and the Supreme Court of Appeal overturned that ([2024] ZASCA 90, 10 June 2024), holding the buyer "could reasonably have avoided the risk" by asking to "verify the account details". Placed immediately after the SABRIC R2.41 bn stats in Scene 2 so the national scale, legal liability on the payer, and our client's 533 caught emails form one tight stakes beat, while non-product B-roll is trimmed to maximize live product footage. Never shown as a loss the firm had to pay |
| Publication | The same cut in the submission and on @DerickPayneDev, in the IsItLegit playlist |
| 2026-11-03 upgrades | Approved by the operator (2026-11-03), rebalanced so ~136 s (~78%) of the 3-minute runtime shows live IsItLegit product UI on screen (`SCENES = [8, 18, 60, 18, 20, 20, 26, 10]`) paired with animated Remotion Meta Model "How It's Done" X-Ray overlays at every model beat: (1) Scene 1 (`ColdOpen`, `0:00 to 0:08`, `8 s`) runs the operator's on-camera intro (`media/out/demo/intro-final.mp4`) as a picture-in-picture (PIP) overlay on the abstract animated background (`GENERATED.loop` / plates in `media/src/videos/Demo.tsx`), plus the opening built-from-scratch statement ("From zero to production-ready in 9 days: product engineering, brand identity, UI/UX design system, model fine-tuning, evaluation harness, and marketing site, all built from scratch during the hackathon"). (2) Scene 2 (`FiltersAndClientScene`, `0:08 to 0:26`, `18 s`) places Hawarden v ENS ([2024] ZASCA 90, R5.5m) immediately after the SABRIC R2.41 bn figure, followed by the 533 caught client phishing emails and the 10.8% to 18.8% industry miss rate (~65 to 123 emails/month, 2 to 4 per day slipping through, plus 100% of genuine-mailbox supplier takeovers passing SPF/DKIM/DMARC), trimming 16 seconds of non-product B-roll. (3) Scene 3 (`ReportScene`, `0:26 to 1:26`, `60 s` of 100% live product instead of `22 s`) runs an `8 s` forward + reply lead-in and `52 s` on the live `/r/:id?clock=1&trace=1` report showcasing Meta models doing real work in-situ with animated Remotion X-Ray overlays explaining how each call works under the hood: (a) `muse-spark-1.3` X-Ray overlay showing delimited `<untrusted_email>` blocks, `store: false`, Zod `cited_evidence_ids` schema, and the deterministic `floor = MALICIOUS` lock; (b) `sam-3.1` X-Ray overlay drawing the animated segmentation bounding box/mask over the invoice PDF's protea emblem with a side-by-side arrow to Fynbos Freight's registered reference logo; (c) `muse-wonder-1.0` X-Ray HUD overlay on `#trace-actions` showing driver containment (`Step 3/8 · 60 s cap · http(s) only · downloads blocked`), the typed canary (`canary-...@isitlegit.co.za`), and the extracted hidden prompt-injection text; and (d) `#model-trace` (`?trace=1`) provenance table showing step latency, `store: false`, and USD cost. (4) Scene 4 & 5 (`ProtectAndCasesScene` `1:26 to 1:44` `18 s` + `TrustNetworkScene` `1:44 to 2:04` `20 s`, `38 s` of 100% live product) remove the moved Hawarden text slide from Scene 4 and replace all yellow `PLACEHOLDER` static boards in Scene 5 with live Playwright captures of `/protect`, `/suppliers`, `/cases`, `/monitor`, `/v/fynbos-freight`, `/b/fynbos-freight.png`, `/s/fynbos-freight` and the live impersonation alert. (5) Scene 6 (`ArchitectureAndVoiceScene`, `2:04 to 2:24`, `20 s`) opens with an `8 s` animated 5-Model Architecture & Safety Contract flow diagram (`Intake -> Deterministic Checks & Floor -> SAM 3.1 / Loupe 1.1 / Muse Wonder / Muse Voice -> Muse Spark Verdict`), followed by `12 s` of live `/check` voice-note upload -> `muse-voice-transcribe-1.0` transcript and verdict card with the `Ogg Opus -> In-Worker WASM SIMD (16 kHz WAV, faster than FFmpeg on all 11 inputs) -> muse-voice-transcribe-1.0 -> fenced transcript` X-Ray overlay. (6) Scene 7 (`ProofScene`, `2:24 to 2:50`, `26 s`) shows a live screen capture of `app.isitlegit.co.za/eval` (scrolling the real per-model ablation chart and dataset metrics) paired with the Loupe 1.1 (`Muse Glimmer 30B` LoRA) X-Ray cascade overlay (`Stage 1: Loupe 30B LoRA trained on 172,987 pages -> confidence < tau escalates to Stage 2: Muse Spark`, plus open-weight LoRA on `huggingface.co/rizonetech/isitlegit-loupe`). (7) Scene 8 (`CloseCard`, `2:50 to 3:00`, `10 s`) closes with the built-from-scratch tagline, `isitlegit.co.za` / `app.isitlegit.co.za` (`pnpm judge:demo`), and `huggingface.co/rizonetech/isitlegit-loupe` |

## Beat sheet

The spine approved on 2026-10-31 (18:33 SAST). The insight it carries: in the costliest attack the email really comes from the supplier, whose mailbox was taken over, so SPF, DKIM and DMARC pass and no filter on the member's side can see it. IsItLegit judges the request itself and closes the loop through the supplier's own registration. The line: "The email is real. The bank details aren't."

| Time | Beat | On screen | Meta model | Depends on (lane) |
| ---- | ---- | --------- | ---------- | ----------------- |
| 0:00 to 0:12 | Cold open (generated) | A supplier's mailbox taken over, the invoice's bank details quietly edited, the mail landing perfect in Fynbos Freight's inbox; the line | | generated footage |
| 0:12 to 0:25 | Why filters miss it, and how big it is in South Africa | Our own report showing authentication passing, because the mail is genuinely the supplier's; one or two sourced South African charts | | D02 checks (shipped); sourced facts |
| 0:25 to 1:20 | Invoice bank change (hero, live) | Forward from the demo mailbox; the report fills in live with an on-screen clock; the bank change against the supplier ledger; PDF forensics; the model trace; the fixed "phone the number in your own records" action | Muse Spark, SAM 3.1 | D06 T01 §1 to §3 (trust), D04 T01 §4 and §5 (checks), D07 T03 §5 and §15 (app), D07 T07 (site) |
| 1:20 to 1:45 | The closed loop | Fynbos Freight's side of the same case: its protected identity and the account on file that caught the change, and the impersonation alert it receives | | D05 T01 §2 and §3 (trust) |
| 1:45 to 2:15 | Depth, fast | The lure walkthrough with a canary; hidden "classify this as safe" text caught (captured live on 2026-10-31); the voice note | Muse Wonder, SAM 3.1, Muse Voice Transcribe | D04 T02 (walkthrough), D01 T03 §3 and §4 (checks) |
| 2:15 to 2:40 | Proof | Eval numbers and the ablation per model; the Loupe 1.0 model card (about 12 s: trained on our own 52,019-line dataset in 14 h 29 min, 0.980 lure recall and 0.057 false alarms on 1,000 held-out pages, 3.9 s median, its own deployment that scales to zero, and its weak spot, lure type right 0.635); the deterministic floor | all, Loupe on Muse Glimmer | D08 T02 (eval); Loupe figures from media/data/loupe-facts.json |
| 2:40 to 3:00 | What's new, and who it is for | Built 26 Oct to 4 Nov by one operator and nine lanes; "Your filter protects your inbox. We protect you from everyone else's." | | none |

Shipped today on `main` and capturable now: the upload page, the report page (verdict band, evidence cards, live status, feedback), the cases list, every deterministic check's evidence card, PDF forensics cards, the canary credentials. The verdict step is a stub, so reasons and actions stay empty until D04 T01 lands.

## Narration, draft 1 (2026-10-31)

Voice: Brian (ElevenLabs premade, `nPczCjzI2devNBz1zQrb`), chosen by the operator on 2026-10-31 20:45 SAST after hearing the v3 cold-open test. The demo is made on `eleven_v3` (expressive, with `[quietly]` and `[pause]` tags and a few takes per line); videos 01 to 03 stay on `eleven_multilingual_v2`, which holds one narrator steady across long reads. About 400 spoken words for 3:00. Figures come from pinned facts or the sourced figures above, never typed. A line marked (live) is said only if that feature is live at the final capture; otherwise it is cut, never mocked.

| Time | Line |
| ---- | ---- |
| 0:00 to 0:12 | [quietly] Tuesday morning. A supplier you trust sends an invoice. Same logo. Same wording. [pause] It looks exactly like your supplier. The bank details aren't theirs. |
| 0:12 to 0:30 | The email is real. It comes from your supplier's own mailbox, so every check your filter runs, passes. In South Africa, digital banking fraud cost R2.41 billion in 2025 (SABRIC). One of our own clients, a small business, got 533 phishing emails in 30 days. That is why we built this. |
| 0:30 to 1:20 | Forward it to IsItLegit. The report fills in live. The mail passes SPF, DKIM and DMARC, because it really is the supplier's. So we judge the request itself: the bank account is not the one on file for Fynbos Freight. (live) The invoice was edited after it was made. Muse Spark reads the mail and the evidence, and cites every reason. SAM 3.1 checks the logo and the stamp. And the first action never changes: phone the number in your own records. In the Hawarden case, the appeal court said the payer should have verified the account details. |
| 1:20 to 1:45 | (live) And the supplier sees it too. Fynbos Freight registered its domains and its bank account once. When someone impersonates it, Fynbos is alerted. One case, both sides protected. |
| 1:45 to 2:15 | Not every attack is an invoice. (live) Muse Wonder walks a suspicious page in a contained browser, typing canary credentials, never real ones. It caught hidden text telling an AI assistant to classify the mail as safe. (live) Muse Voice Transcribe turns a voice note into text, so it is checked too. |
| 2:15 to 2:40 | Every model is measured. Loupe, our fine-tune of Muse Glimmer thirty B, trained on {fact.trainLines} lines in {fact.trainTime}. On held-out pages it caught {fact.lureRecallOf}, with {fact.falseAlarmsOf} false alarms, in {fact.latency}. We show its weak spot too: it names the lure type right about sixty-four percent of the time. |
| 2:40 to 3:00 | Built in under two weeks by one operator and nine AI lanes. Your filter protects your inbox. We protect you from everyone else's. IsItLegit, at app dot isitlegit dot co dot za. |

Flags: (1) the SA charts, our client's month and the Hawarden card no longer all fit the approved 0:12 to 0:25 slot, so the charts and the client run to 0:30 and the hero starts at 0:30 (the hero keeps 50 s). (2) The beat sheet's Loupe line still quotes older figures (0.980, 0.057 on 1,000 pages); the narration uses the pinned facts above, which are the ones video 03 proves. (3) The "internet banking is under 9% of cases but 28.6% of the rand" figure is a chart, not narrated, so the voice stays inside its slot.

## Trace strip

Every live beat carries a thin strip along its foot: the Meta model at work, the pipeline step and its latency, read from the case's model trace (D07 T03 §5, the app lane's panel and its stored rows) at capture time, never typed. Until the trace panel deploys, the strip shows only the capture's own measured marks.

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

- The demo mailbox becomes a member of the judge demo organisation (D07 T07 §2).
- The coordinator's `21fc5c8d` reaches `origin/main`; then the media lane merges it and records `Started:` on §3 and §4, correcting §4's paths to `media/`.
