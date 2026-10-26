# Contributions

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

Changes made to this tooling during the event (the IsItLegit environment needs, the client-name guard in the pre-commit hook) are new work and show in the history.

## Third-party code and data

None vendored yet. Each dependency enters through the section that adds it and is listed in [`NOTICE.md`](NOTICE.md); public phishing corpora used for evaluation are listed with their licences in `eval/DATASETS.md` when the eval harness lands.
