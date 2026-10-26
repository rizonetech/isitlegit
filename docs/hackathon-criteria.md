# Hackathon criteria

The rules and judging criteria of the Meta Global AI Developer Hackathon, written as checks an agent or reviewer applies to every section, commit and demo decision. `AGENTS.md` is the engineering contract; this file is the competition contract. Where they meet, both apply.

Sources: the event page and Official Rules (<https://cerebralvalley.ai/e/meta-ai-developer-hackathon>, captured 2026-10-26 10:30 SAST), the rules post in the event Discord (pasted 2026-10-26 10:34 SAST), and the organisers' answer in the Discord "Development tools" thread (2026-10-26 09:46 SAST). The raw captures are kept locally, not in this repository. Reviewed 2026-10-26.

## The event

- Entry: Rizonetech (Pty) Ltd, **Startup track**, solo, theme **Build for Your World** (Rizonetech's own clients' problem).
- Build window: Mon 26 Oct 2026, 19:00 SAST kickoff, to the submission deadline, **Wed 4 Nov 21:00 ET (Thu 5 Nov 04:00 SAST)**. Our own deadline is **Wed 4 Nov 18:00 SAST**; the platform's grace period is never planned on.
- Submission: the public repository, a working demo video link (3 minutes), every team member added.

## Hard rules (breaking one disqualifies)

| Rule | What it means for every change |
| ---- | ------------------------------ |
| New work only | Everything presented is built from the first commit on (after 19:00 SAST, 26 Oct). No product code is copied from an earlier project. |
| Identify contributions | The demo shows only what was built during the event, and a judge can tell what is new. Pre-existing development tooling is declared in `CONTRIBUTIONS.md` and never shown as a product feature. |
| Public repository | Nothing secret, no client data, no private paths, nothing we lack the rights to republish. |
| Rights to everything used | Every library, dataset, font, image and sample has a licence that allows our use, recorded in `NOTICE.md` or `eval/DATASETS.md`. Open source is allowed when its licence is followed. |
| Meta's models are genuinely part of the build | Organisers' answer: other tools and services (Claude Code, Codex, Cloudflare, reputation APIs) are fine "as long as Meta's models are genuinely part of the build". A feature where a Meta model is decorative does not count towards this. |
| Not a banned category | Not AI medical or health advice, a basic RAG app, a simple image analyser, an education chatbot, a job application screener, a nutrition coach, a personality analyser, or a sports analyser or coach. IsItLegit must never be describable as "a simple image analyser" or "basic RAG": the evidence pipeline and the agent walkthrough are the answer. |
| Legal, ethical and platform policies | No real person's mail or data without consent; the walkthrough types canary values only; Meta's usage policies apply to every model call. |
| Waiver | 18 or older; no Meta or Cerebral Valley staff. Everything shared during the event (repository, video, Discord) is licensed to the organisers and is not confidential. |

## How the entry is scored

| Criterion | Weight | What judges look for | What it asks of our build |
| --------- | -----: | -------------------- | ------------------------- |
| Impact | 30% | Real-world potential, who benefits, could people actually use it, fits a theme | Real small businesses can use it on day one: forward an email, get an answer. Show the cost of a missed invoice fraud. |
| Use of Meta AI tooling | 25% | Creative use beyond a basic integration, unexpected capabilities | Our first priority (`docs/manifesto.md`): each Meta model does a job only it can do, the models are chained into one investigation, each one's contribution is measured by ablation in the eval, and the judge sees it in the model trace and the demo. |
| Demo | 25% | Works, holds up live, quality of the 3 minute video | Every feature in the video runs on the live service. No mocked screens. |
| Technical depth and execution | 20% | Sound, refined engineering, real craft | The safety contract, the eval numbers, tests, CI, and a reviewed history. |

Startup track lens on top: technical execution and **whether it holds up in production**. A live service with real intake, measured accuracy and cost, and failure handling beats a polished prototype.

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

## Open questions

- The event page names Muse Spark, Muse Wonder, Muse Image and SAM 3.1; the Official Rules name Muse Spark, Glimmer and SAM 3. The build uses the models the Meta Model API actually serves (design spec section 9).
- The submission form's fields are visible only after signing in; check them before Wed 4 Nov.
