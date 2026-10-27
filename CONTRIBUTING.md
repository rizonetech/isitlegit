# Contributing to IsItLegit

IsItLegit is built section by section from a validated TODO graph in [`todo/`](todo/TODO-00-INDEX.md), governed by the [design spec](docs/specs/2026-10-26-phishing-invoice-analyser-design.md) and the [tech stack spec](docs/specs/2026-10-26-tech-stack-design.md).

## During the hackathon

The hackathon rules require the entry to be the team's own work, so **outside pull requests are not merged until judging ends**. Issues are welcome now: bug reports, missed phishing, false alarms and feature ideas all help. Security problems go to private reporting, never a public issue: see [`SECURITY.md`](SECURITY.md).

Never attach real mail that contains other people's personal data or a client's details to an issue. Build a synthetic look-alike with fictional names, domains and bank details.

## Before you start

1. Read [`AGENTS.md`](AGENTS.md): the safety contract (the deterministic floor, evidence or nothing, untrusted content stays data, the contained walkthrough) and the rules every change follows.
2. Run `python3 scripts/todo-graph.py query ready` to see what work is dependency-safe now. Every change belongs to a section (`DNN TNN §N`), or captures a new one first under [`todo/README.md`](todo/README.md).

## Commit hook

Once per clone, turn on the repository's hooks:

```bash
git config core.hooksPath scripts/hooks
```

`scripts/hooks/pre-commit` refuses a commit that stages `todo/` changes while `todo/implementation-plan.md` is stale or the TODO graph is invalid, and a commit whose staged lines or paths contain a client name from the git-ignored `samples/client-names.txt`.

## Validation gates

```bash
python3 scripts/todo-graph.py validate
python3 scripts/todo-graph.py plan --check
python3 -m unittest discover -s tests/scripts
python3 -m unittest discover -s scripts/tests
LIVE_CHECKS=1 python3 -m unittest tests.scripts.test_readme_brand   # maintainers: reads the live social preview; needs gh and pip install -r design/tools/requirements.txt
python3 scripts/check-publication.py   # maintainers, before every push; needs the git-ignored client list
```

The Worker gates (Node 24, pnpm 11; the full local run is under "Run the Worker locally" in the [README](README.md#run-the-worker-locally)):

```bash
pnpm install --frozen-lockfile
pnpm typecheck   # refuses a worker-configuration.d.ts that no longer matches wrangler.jsonc: run pnpm types and commit it
pnpm lint
pnpm test
pnpm build
```

Never edit `todo/implementation-plan.md` by hand; regenerate it with `python3 scripts/todo-graph.py plan --sync`. `pnpm test` runs the Worker's tests inside workerd (the Workers runtime) through `@cloudflare/vitest-plugin`; `pnpm lint` is Biome over the Worker's own files.

## Pull requests and commits

- Branch from `main`, keep one logical section per commit, and cite the section reference (`DNN TNN §N`) in the commit body.
- No credentials, client data or private paths in commits, logs or pull request descriptions.
- By submitting a pull request you agree that Rizonetech (Pty) Ltd may distribute your contribution under the project's licence ([`LICENSE`](LICENSE)).
