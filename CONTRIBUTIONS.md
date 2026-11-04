# Contributions

[![Meta Muse Code](https://img.shields.io/badge/Meta%20Muse%20Code-Wonder%201.0-0467DF?logo=meta&logoColor=white)](#existing-before-the-hackathon-development-tooling-only)
[![OpenAI GPT-6 Astra](https://img.shields.io/badge/OpenAI-GPT--6%20Astra-412991?logo=openai&logoColor=white)](#existing-before-the-hackathon-development-tooling-only)
[![Anthropic Claude Opus 5.5](https://img.shields.io/badge/Anthropic-Claude%20Opus%205.5-D97757?logo=anthropic&logoColor=white)](#built-during-the-hackathon)
[![Google Gemini 4 Argon](https://img.shields.io/badge/Google-Gemini%204%20Argon-4285F4?logo=googlegemini&logoColor=white)](#built-during-the-hackathon)

The Meta Global AI Developer Hackathon requires every entry to show which features, code and functionality the team built during the event (26 Oct to 4 Nov 2026). This file is that record.

## Built during the hackathon

Everything in this repository from the first commit on, which landed after the 19:00 SAST kickoff on 26 Oct 2026, except the paths listed below. That covers the product design and plans in `docs/`, the execution plan in `todo/`, and all product code as it lands: the Worker in `src/`, the site in `site/`, the tests in `test/` and the eval harness in `eval/`. The 09-launch domain of the plan extends this section with the commit ranges for each day before submission.

## Existing before the hackathon: development tooling only

These files came from Rizonetech's own Conclave-SDK `base`, `todo` and `reviewer` kits, installed on 26 Oct 2026 and adapted to this project. They run the build process (planning, review and commit checks). They are not part of IsItLegit, take no part in a verdict, and are never shown as product features in the demo.

| Path | What it is |
| ---- | ---------- |
| `.claude/` | Agent skills, rules and read-only helper agents for the build |
| `.conclave/reviewers.toml` | The pinned independent reviewer and its review schedule |
| `scripts/` | The TODO graph (`todo-graph.py`, `lib/todo_graph.py`), review dispatch, the run guard, the pre-commit hook and CI helpers |
| `tests/scripts/`, `scripts/tests/` | Tests for that tooling |
| `docs/todo-workflow.md`, `docs/*-prompt.md`, `docs/agent-skills-and-rules-structure.md` | How the TODO system and the reviews work |
| `todo/README.md`, `todo/templates/` | The TODO format and its templates |
| `design/brand/rizonetech/` | Rizonetech's own logo files from its brand kit, used only for the "by Rizonetech" credit |
| `design/fonts/` | The Exo and Exo 2 fonts (SIL OFL 1.1) from Rizonetech's brand kit; third-party, listed in `NOTICE.md` |

The IsItLegit brand itself (`design/brand/` outside `rizonetech/`, and `design/tools/build-brand.py`) was designed and built during the event, on 26 Oct 2026.

Development attribution (updated 4 November 2026): IsItLegit uses Meta models in its product workflow. Meta Muse Wonder 1.0 and Muse Spark 1.3 also assisted development during the hackathon, alongside other models used only as development tools. The additional development use is separate from the product's runtime model calls; evidence of each model's contribution to an investigation comes from that investigation's actual execution. Codex subsequently took over coordinator and lane implementation under the recorded operator decision in `AGENTS.md`.

Historical review and data tooling also included GPT-6 Astra through the Codex CLI for reviews, public-dataset collection and disputed-label judging, and a configured optional Muse Wonder final-review route. These roles changed during development; the candidate-bound review receipts and their recorded pins retain the applicable policy. A configured route is not proof that a review ran. The product's own Muse Wonder walkthrough agent, driving a contained browser through the Meta Model API (D04 T02), is separate product work and requires its own runtime evidence.

Changes made to this tooling during the event (the IsItLegit environment needs, the client-name guard in the pre-commit hook) are new work and show in the history.

## Third-party code and data

None vendored yet. Each dependency enters through the section that adds it and is listed in [`NOTICE.md`](NOTICE.md); public phishing corpora used for evaluation are listed with their licences in `eval/DATASETS.md` when the eval harness lands.

Loupe is a project-specific LoRA fine-tune of the pre-existing Muse Glimmer 30B base model, trained and historically hosted through Fireworks AI. Loupe 1.1 completed 72,375 training examples in 4,524 optimizer steps; these are training workload counts, not independent evaluation results or separately authored instructions. The unsuccessful experiment is archived, its hosting is shut down, and this release disables Loupe production calls. Its historical Worker inference was separate from training, which did not run inside Cloudflare Workers. No Hugging Face model release is claimed. Version and measurement evidence is separated in [Loupe release status](docs/glimmer/release-status.md).
