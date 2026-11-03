# Hackathon criteria

The rules and judging criteria of the Meta Global AI Developer Hackathon, written as checks an agent or reviewer applies to every section, commit and demo decision. `AGENTS.md` is the engineering contract; this file is the competition contract. Where they meet, both apply.

Sources: the event page and Official Rules (<https://cerebralvalley.ai/e/meta-ai-developer-hackathon>, captured 2026-10-26 10:30 SAST), the rules post in the event Discord (pasted 2026-10-26 10:34 SAST), and the organisers' answer in the Discord "Development tools" thread (2026-10-26 09:46 SAST). The raw captures are kept locally, not in this repository. Reviewed 2026-10-26.

## The event

- Entry: Rizonetech (Pty) Ltd, **Startup track**, solo, theme **Build for Your World** (Rizonetech's own clients' problem).
- Build window: Mon 26 Oct 2026, 19:00 SAST kickoff, to the submission deadline, **Wed 4 Nov 21:00 ET (Thu 5 Nov 04:00 SAST)**. Our own deadline is **Wed 4 Nov 18:00 SAST**; the platform's grace period is never planned on.
- Submission URL: <https://cerebralvalley.ai/e/meta-ai-developer-hackathon/hackathon/submit> (one representative submits and may keep pushing repo commits and editing the form, including swapping in an updated YouTube video URL, until the hard deadline at Wed 4 Nov 21:00 ET / Thu 5 Nov 04:00 SAST, after which no edits or repo pushes are allowed): the public repository, a working demo video link (3:00 or less, e.g. YouTube), written description fields, and every accepted team member added.

## Hard rules (breaking one disqualifies)

| Rule | What it means for every change |
| ---- | ------------------------------ |
| New work only (judges inspect commit history) | Everything presented is built from the first commit on (`f6d4088f`, `2026-10-26 19:00:36 +0200`, after the 19:00 SAST kickoff). No product code or pre-existing Git history is copied from an earlier project. Per Q&A rulings (`2026-11-03 04:41, 07:08, 16:59, 17:13 & 17:17` in `sources/discord/`, including judge `Connor (Meta)` at `17:13`): *"Yes, judges look at commit history, so commit incrementally as you go rather than pushing everything at the end"*, *"The submission repo must hold only work done during the event, so the pre-existing open-source code and its Git history can't be included"*, and `Connor (Meta)`: *"That way it'll be crystal clear what's been built for the hackathon vs what was pre-existing."* |
| Identify contributions | The demo shows only what was built during the event, and a judge can tell what is new. Pre-existing development tooling and license-permissive coding-agent skills are declared in `CONTRIBUTIONS.md` and never shown as a product feature (per `2026-11-03 07:08`: *"code with any tools or license-permissive agent skills, no disclosure needed, as long as every runtime model is a Meta model"*). Per Kai \| CV (`#faq`, 2026-10-26 14:42) and Q&A rulings (`2026-11-03 08:57 to 08:58`): if extending pre-existing work, open the 3-minute video with one line stating what existed before kickoff (`Oct 26, 12:24 PM ET` / `18:24 SAST`) and what was built this week; if nothing in the product existed before the event, no pre-existing disclosure line is required. |
| Public and source-available repository + published LoRA weights | Nothing secret, no client data, no private paths, nothing we lack the rights to republish. Per `#announcements` (`2026-11-03 04:00`) and the license Q&A rulings (`2026-11-03 07:08 & 07:55`): *"Any license is fine, no specific one required. Third-party assets can be listed with how to get them rather than redistributed"* (confirming `FSL-1.1-ALv2` and our external `docs/glimmer/sources.md` dataset manifest are compliant). Per Q&A ruling on fine-tuned Muse Glimmer (`2026-10-30 21:34`): *"Serve the model on your own hardware or through partner inference, and publish the fine-tuned weights or LoRA adapter, since everything the demo depends on must be open source. Keep a live Meta model call in the demo as well."* |
| Rights to everything used | Every library, dataset, font, image and sample has a licence that allows our use, recorded in `NOTICE.md` or `eval/DATASETS.md`. Outputs generated with `Muse Image` (including for fictional brands) and Meta/Muse logos are explicitly permitted (`2026-11-03 07:08`). |
| Meta's models are genuinely part of the build (no non-Meta models and no Llama at runtime) | Organisers' answer: other tools and services (Claude Code, Codex, Cloudflare, reputation APIs) are fine "as long as Meta's models are genuinely part of the build". Per Q&A rulings (`2026-10-28 22:25 to 22:40`, `2026-11-03 06:21` and `07:08` in `sources/discord/2026-11-03-qa-threads-raw.txt`): (1) *"Every model your project calls at runtime has to be a Meta model, so a custom VAE [or DINOv3] can't be one of the models the project runs... doing the same step in deterministic code rather than a trained model is fine"*; (2) **"Llama is not part of this hackathon and does not count as a Meta model, however you run it, so don't build on Llama"**; and (3) *"Since Muse has no text-to-speech model, any TTS service is fine, so ElevenLabs works for the voice step. Follow ElevenLabs' own terms and say in your README which service handles the voice."* A feature where a Meta model is decorative does not count towards this. |
| Not a banned category | Not AI medical or health advice, a basic RAG app, a simple image analyser, an education chatbot, a job application screener, a nutrition coach, a personality analyser, or a sports analyser or coach. IsItLegit must never be describable as "a simple image analyser" or "basic RAG": the evidence pipeline and the agent walkthrough are the answer. |
| Legal, ethical and platform policies | No real person's mail or data without consent; the walkthrough types canary values only; Meta's usage policies apply to every model call. |
| Waiver | 18 or older; no Meta or Cerebral Valley staff. Everything shared during the event (repository, video, Discord) is licensed to the organisers and is not confidential. |

## How the entry is scored

Per `#faq` (captured 2026-11-03 in `sources/discord/2026-11-03-faq-and-announcements-raw.txt`), projects must first fit the theme and meaningfully use Meta Model API and/or Meta open-weight models; eligible entries are then **scored equally (25% each)** across the four criteria below, and the **top 5 projects per track advance to the live finals** on Mon 9 Nov at 12:00 ET (19:00 SAST).

| Criterion | Weight | What judges look for | What it asks of our build |
| --------- | -----: | -------------------- | ------------------------- |
| Impact | 25% (30% in early brief) | Real-world potential, who benefits, could people actually use it, fits a theme | Real small businesses can use it on day one: forward an email, get an answer. Show the cost of a missed invoice fraud. |
| Use of Meta AI tooling | 25% | Creative use beyond a basic integration, unexpected capabilities | Our first priority (`docs/manifesto.md`): each Meta model does a job only it can do, the models are chained into one investigation, each one's contribution is measured by ablation in the eval, and the judge sees it in the model trace and the demo. |
| Demo | 25% | Works, holds up live, quality of the 3 minute video | Every feature in the video runs on the live service. No mocked screens. Strict `<= 3:00` duration. |
| Technical depth and execution | 25% (20% in early brief) | Sound, refined engineering, real craft | The safety contract, the eval numbers, tests, CI, and a reviewed history. |

Startup track lens on top: technical execution and **whether it holds up in production**. A live service with real intake, measured accuracy and cost, and failure handling beats a polished prototype.

### Prize structure and bonus awards (`#faq`, captured 2026-11-03)

- **Startups track (1st to 5th):** $250k / $150k / $75k / $50k / $25k (top 5 advance to the live finals on Mon 9 Nov 12:00 ET / 19:00 SAST).
- **Indie Developer track (1st to 5th):** $150k / $100k / $75k / $50k / $25k.
- **Cross-track bonus awards ($50k total):**
  - **Most Viral Project ($20k):** post the demo on X and submit the X post link through the submission platform; engagement counts through Sun 8 Nov EOD.
  - **Best Build on Meta Open Weight Models ($10k):** directly targeted by our `Loupe` page-screener LoRA fine-tuned on open-weight **Muse Glimmer**.
  - **Community Vote ($10k):** opens Mon 9 Nov (one vote per verified account), winner announced Mon 16 Nov.
  - **Best Agentic Use-Case ($5k):** directly targeted by our chained investigation and contained **Muse Wonder** computer-use browser walkthrough.
  - **Best Creative Build ($5k).**

## Checks an agent applies

Before building a section:

- Does it move one of the four criteria, or protect a hard rule? Work that does neither waits until after 4 Nov.
- If it uses a Meta model, is the model doing something visible and essential, or would a regex do?
- Will it be finished, tested and live before Wed 4 Nov 18:00 SAST? If not, cut it or file it for after the event (phase 7), never half-ship it.

Before committing:

- Nothing in the change came from an earlier project except the declared tooling, and nothing in it is secret, a client's, or unlicensed.
- A new dependency, dataset or asset has its licence row in `NOTICE.md` or `eval/DATASETS.md`.

Before anything appears in the demo or README:

- It runs on the live service and was built during the event.
- It shows evidence, not a claim: real verdicts on synthetic mail, measured numbers from the eval.
- It uses no real client mail, names or bank details.

## Judging access (operator information, 2026-11-02)

Judges run the project from the public repository's setup instructions, and every judging stage needs a working demo: the 3 minute video alone is not enough, and a hosted version is optional. A judge must never need their own outside account to try it: a setup that requires a judge to create their own Meta app and connect a Page and ad account (here: their own Meta Model API keys or Cloudflare account) goes against this. A sandbox or mock-data demo is fine, and so is a replay mode when the README explains how to use it. Recorded examples (request and response pairs, outputs and traces) are a valid no-account path, with as much provenance as can be given (deployed commit, run id, date, model IDs, `store: false`), and any simulated part is labelled as simulated wherever a judge meets it.

Checks:

- The README's setup path runs from a clean clone with no judge-owned account or secret, or says plainly at the top which parts need the hosted service instead, and includes `.env.example` / instructions for judges who wish to test with their own Meta Model API key (never committing our own keys).
- At least one working no-account demo exists at every judging stage: the hosted live service with judge access, a sandbox or mock-data mode, or a replay of recorded examples (`pnpm judge:demo`), each explained in the README (confirmed by `Maya (Meta)`, 2026-11-02, and `Yash Khare (Meta)`, 2026-11-03 17:12: *"great call on making it reproducible without accounts or keys... show off which models you used and where, and highlight anything beyond a basic API call; if the local demo uses cached or stubbed responses, label them clearly, and show the live model in the video"*).
- Recorded examples carry provenance and label every simulated part; nothing simulated is presented as a live model call.
- **3-minute video rules (`sources/discord/2026-11-03-qa-threads-raw.txt`):**
  - **Judges stop watching at `3:00`**: keep total runtime strictly at or under `3:00` (`<= 180.0s`).
  - **Open with one line** stating what existed before the event vs. what was built this week: *"From zero to production-ready in 9 days: product engineering, brand identity, UI/UX design system, model fine-tuning, evaluation harness, and marketing site, all built from scratch during the hackathon (only our internal TODO and code-review runner scripts existed beforehand)."*
  - **No slide decks or unbuilt future ideas**: show the working product with **live Meta model calls visible on screen** (`?trace=1` model-trace drawer open showing `Muse Spark`, `Muse Wonder`, `SAM 3.1`, `Muse Image`, `Muse Voice Transcribe`, and `Loupe` on `Muse Glimmer`).
  - **Show the calls and their live effect in the app UI (`17:21`, `17:47` & `17:54` Q&A rulings, `sources/discord/2026-11-03-showing-meta-models-qa.txt`):** `Yash Khare (Meta)` (`17:47`): *"show Meta models in action, mostly means judges should see the models doing real work in your demo... so judges can actually see it adapting rather than taking your word for it."* `Connor (Meta)` (`17:54`): *"I'd recommend making it clear in your video where the model is used, either by showing a few live API requests that demonstrate the model in-situ, or by showing examples of the prompts and responses. Architectural diagrams wouldn't hurt either, but the best case is that the app itself makes it clear where the model is being used."* Keep `#model-trace` (`?trace=1`, `src/web/components/model-trace.tsx`) visible in the demo recording alongside the Remotion architecture card (`D09 T02 §4`), the SAM 3.1 logo crop vs. registered logo comparison, the Muse Wonder browser walkthrough screenshots (`#trace-actions`), and the `/eval` ablation chart (`D09 T02 §12`).
  - **Speeding up footage (e.g. `2x`) is explicitly allowed** so the full flow fits inside `3:00`, as long as it remains understandable in English and backed by recorded outputs or traces.
  - **Human presenter preferred (`02:59` ruling):** AI voice-over in English is allowed, **"though organizers prefer one made and presented by a person."** Recording your own voiceover (or appearing on camera/mic for the intro & outro while narrating the screen recording) directly aligns with the organizers' stated preference.

## Open questions

- The event page names Muse Spark, Muse Wonder, Muse Image and SAM 3.1; the Official Rules name Muse Spark, Glimmer and SAM 3. The build uses the models the Meta Model API actually serves (design spec section 9).
- The submission form's fields are visible only after signing in; check them before Wed 4 Nov.
