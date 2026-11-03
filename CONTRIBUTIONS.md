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

GPT-6 Astra, OpenAI's model through the Codex CLI, is development tooling in the same sense: it reviews every section, and for the Loupe page screener (D03 T04) it also does dataset collection, downloading licence-checked public page datasets into a local data store outside the repository, and label judging, deciding disputed training labels beside Claude. It writes no product code, and its collections and judgements are verified by Claude before any of them trains Loupe.

Muse Wonder through Muse Code (the operator's own subscription) is development tooling in the same sense when it reviews: the pin names it as the final reviewer after the Astra rounds (`.conclave/reviewers.toml`, `[schedule.final]`), a step that is switched off (`mode = "off"`), so sections are stamped on the plan review, the completion review and Astra's rounds. The videos the media lane makes (D10, `media/`) show this review tooling as part of how IsItLegit is built: it is pre-existing development tooling, not a product feature. The product's own use of Muse Wonder, the walkthrough agent driving a contained browser through the Meta Model API (D04 T02), is product work and is listed with the rest of the product, not here.

Changes made to this tooling during the event (the IsItLegit environment needs, the client-name guard in the pre-commit hook) are new work and show in the history.

## Third-party code and data

None vendored yet. Each dependency enters through the section that adds it and is listed in [`NOTICE.md`](NOTICE.md); public phishing corpora used for evaluation are listed with their licences in `eval/DATASETS.md` when the eval harness lands.
