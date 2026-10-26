---
schema_version: 1
id: repo-and-scaffold
domain: 00-workspace
status: active
title: "TODO-01 -- Repository, Worker Scaffold, CI and Meta Smoke Test"
track: day-0
---

# TODO-01 -- Repository, Worker Scaffold, CI and Meta Smoke Test

> **Goal:** A public GitHub repository under `rizonetech` holds a TypeScript Cloudflare Worker that builds, type-checks, lints and tests in CI, is deployed with its D1, R2, KV, Workflow and Browser Run bindings, sends Meta Model API traffic through an AI Gateway custom provider, and has a recorded smoke test proving each Meta capability the product needs.

> **Current state:** Measured 2026-10-26 16:45 SAST. The repository folder `isitlegit` (renamed from `meta-hackethon` at 17:53) is not yet a git repository. It holds `docs/` (design spec, tech stack, build plan), `sources/`, `competitors/`, git-ignored `samples/`, and the agent kit (`AGENTS.md`, `CLAUDE.md`, `.claude/`, `.conclave/reviewers.toml`, `scripts/`, `tests/scripts/`, `todo/`) installed from the Conclave-SDK `base`, `todo` and `reviewer` kits. There is no `package.json`, no `src/`, no `wrangler.jsonc`, no CI workflow and no Cloudflare resource for the Worker. Cloudflare zone `isitlegit.co.za` exists (id `88aeec6df134bc59bfa16a25751241ef`, status pending, nameserver change queued at Domains.co.za). The Meta Model API credit claim was submitted at 15:51; the credit is not yet visible under Billing.

## Inputs

- `docs/specs/2026-10-26-tech-stack-design.md`: services, library versions, secrets, repository layout and rejected options; every pin below comes from its tables.
- `docs/plans/2026-10-26-phishing-invoice-analyser.md` Day 0: the scaffold, gateway and smoke-test tasks this file executes.
- `docs/specs/2026-10-26-phishing-invoice-analyser-design.md` section 6 (rules compliance: first commit after the 19:00 SAST kickoff, public repo, no secrets) and section 9 (Meta model map).
- `sources/meta-api/2026-10-26-meta-model-api.md`: endpoints, model IDs, `store: false`, SAM request shape, pricing.
- `sources/cerebralvalley/2026-10-26-credit-claim.md`: no Meta API call before the credit shows under Billing.
- -> XREF: D99 T01 §1 -- the Meta account, payment method, spend limit and API key that §7 needs before it runs
- -> XREF: D99 T01 §3 -- the Workers Paid plan that Browser Run hours and Workflows limits in §5 rely on
- -> XREF: D07 T01 §1 -- the design session whose wordmark §8 puts in the README

## Outcome

- `git log` shows a first commit after 2026-10-26 19:00 SAST, and `https://github.com/rizonetech/isitlegit` is public with that history.
- `pnpm typecheck`, `pnpm lint` and `pnpm test` pass locally and in GitHub Actions on every push, together with `python3 scripts/todo-graph.py validate` and `plan --check`.
- `GET https://isitlegit.<account>.workers.dev/health` returns `200` with the deployed commit, and the Worker's D1, R2, KV, Workflow and Browser bindings resolve.
- `sources/meta-api/2026-10-26-smoke-test.md` records one passing call each to `muse-spark-1.3` (text and image), `sam-3.1` and `muse-wonder-1.0`, all with `store: false`, through the AI Gateway.

**Adjacency:** all=not-applicable (repository and build plumbing with no user-facing records; product surfaces start in 01-intake and 07-app)

**Adjacency rationale:** This file builds the empty, deployable shell and proves the model access the product depends on. It owns no record a user lists, exports, reverses or is notified about; the first such record (a case) is created in 01-intake.

## Implementation Order

| Order | Section | Deliverable | Depends On | Status |
| ----- | ------- | ----------- | ---------- | ------ |
| 1 | §1 | Git repository and public GitHub repo | -- | [x] |
| 2 | §2 | Worker package and health route | §1 | [ ] |
| 3 | §3 | Vitest workers pool and Biome | §2 | [ ] |
| 4 | §4 | GitHub Actions CI | §3 | [ ] |
| 5 | §5 | Cloudflare bindings and first deploy | §4 | [ ] |
| 6 | §6 | AI Gateway for the Meta Model API | §5 | [ ] |
| 7 | §7 | Meta smoke test | §6 | [ ] |
| 8 | §8 | README banner and social preview | §1, D07 T01 §1 | [ ] |

## 1. Git repository and public GitHub repo

> **Started:** 2026-10-26T16:45:00Z

The hackathon accepts only work built from 26 Oct; the first commit must land after the 19:00 SAST kickoff so the history proves it. The repository is public from the start, so nothing secret or client-related may be staged: `samples/` is git-ignored and stays so.

**Corrected 2026-10-26:** the operator asked for the same repository treatment as Rizonetech's public repositories (`rizonesoft/Recto`, `rizonesoft/Isotone`, `rizonesoft/Office`): community files, issue and pull request templates, labels, Dependabot, security policy and GitHub settings. The operator also decided three things in session at 18:33 SAST: the licence is `FSL-1.1-ALv2` (Functional Source License 1.1, Apache 2.0 future licence); `sources/` and `competitors/` stay local and are git-ignored (they profile named entrants and mirror pages that are not ours to republish); client names are anonymised in every tracked file before the first commit. Before, the section asked only for `README.md`, `.gitignore` and `LICENSE` with the licence open. The README banner and social preview image are design work and move to §8.

**Phase:** 0
**Needs:** attended
**Surface:** no

**Build order:**

1. Make the tree safe to publish: ignore rules, anonymised documents, and a pre-commit guard against client names. Done when: no tracked-to-be file names a client and the guard refuses a staged client name.
2. Write the licence and the community files, modelled on Recto and Isotone. Done when: each file below exists with IsItLegit's content.
3. Initialise the repository, enable the hooks and make the first commit after 19:00 SAST. Done when: `git log --reverse --format=%cI | head -1` prints a time after `2026-10-26T19:00:00+02:00`.
4. Create the public repository, push, and apply the GitHub settings. Done when: `gh repo view rizonetech/isitlegit --json visibility -q .visibility` prints `PUBLIC`.

- [x] Write the root `.gitignore` covering `node_modules/`, `.wrangler/`, `.dev.vars`, `.env*`, `build/`, `dist/`, `__pycache__/`, `site/dist/`, `.remember/`, `sources/` and `competitors/`. Done when: `git check-ignore .dev.vars build/x node_modules/x .remember/x sources/x competitors/x | wc -l` prints `6` (**Corrected 2026-10-26:** was `git check-ignore -q` with six paths, which git refuses: `--quiet` takes one path). Cheaper substitute: relying on `samples/.gitignore` alone, which protects nothing else.
- [x] Keep the client list outside the repository in git-ignored `samples/client-names.txt` (one name, domain or address per line), and add a block to `scripts/hooks/pre-commit` that refuses a commit whose added lines or staged paths contain one, case-insensitively, skipping blank lines. Done when: new tests in `tests/scripts/test_pre_commit_hook.py` show a staged name refused, a name inside a binary-marked `.eml` refused (the hook diffs with `--text`; completion review gap), a staged file name refused, a blank line in the list not blocking every commit, and no list meaning no check. Cheaper substitute: a one-off grep before the first commit, which protects no later commit.
- [x] Add `scripts/check-publication.py`, run before every push: exit 2 when `samples/client-names.txt` is missing, unreadable or names no one; exit 1 listing each client name in index content (binary-marked files read as text) or a path, each private checkout path outside the test folders, any `samples/` file but `.gitignore` and `README.md`, and anything under `sources/`, `competitors/` or `.remember/`. Done when: `tests/scripts/test_check_publication.py` covers each exit and finding (completion review 2026-10-26, which also found the reviewer's absolute paths in the findings file: `scripts/review-dispatch.py` now records repository paths relative, tested in `scripts/tests/test_review_dispatch.py`). Cheaper substitute: a one-line grep that reports `0` when it could not run.
- [x] Anonymise the client case in `docs/specs/2026-10-26-phishing-invoice-analyser-design.md`, `docs/plans/2026-10-26-phishing-invoice-analyser.md`, `AGENTS.md` and `samples/README.md`: a fictional supplier and fictional addresses in the story, "client mail" without names in the rules; the client-specific notes move to git-ignored `samples/NOTES.md`. Replace the personal account mailbox names in `docs/specs/2026-10-26-tech-stack-design.md` and `todo/99-manual/TODO-01-day0-accounts.md` with role names. Done when: `git grep -niIF -f samples/client-names.txt` over the staged tree prints nothing, and `git grep --cached -nE '/home/[a-z]|[A-Z]:\\(GitHub|Users)\\[A-Za-z]|/mnt/[a-z]/(GitHub|Users)/[A-Za-z]' -- . ':!tests/' ':!scripts/tests/'` finds no private checkout path (the test folders hold made-up Windows path fixtures) (**Corrected 2026-10-26**, plan review P1: the first commit still published a local checkout path in `todo/README.md:7`, now removed; the scratch-folder convention in `AGENTS.md` and the path fixtures in `tests/` are not private paths).
- [x] Add `LICENSE` with the FSL-1.1-ALv2 text from fsl.software, licensor Rizonetech (Pty) Ltd, software IsItLegit, year 2026, and record the decision with its date in `README.md`. Done when: `LICENSE` names `FSL-1.1-ALv2` and `README.md` names it with the date.
- [x] Write `README.md` in the Isotone layout: centred title and one-line pitch, badges (execution plan, licence, Meta Model API, Cloudflare Workers; the CI badge joins in §4 when the workflow exists, so no badge leads nowhere, completion review 2026-10-26), a status note, contents, what it does, how it uses Meta's models, how it is built, governing documents, contributing, security, licence; "built during the Meta Global AI Developer Hackathon, 26 Oct to 4 Nov 2026". Done when: the file names the event dates, both spec files and `todo/TODO-00-INDEX.md`, and every relative link resolves to a tracked file. Cheaper substitute: a short placeholder README.
- [x] Write `CONTRIBUTIONS.md` for the rule "Identify your contributions": what existed before the event (the agent tooling in `.claude/`, `.conclave/`, `scripts/` and `tests/scripts/` from Rizonetech's Conclave-SDK kits, development process only, never shown as product), and that everything else is built from the first commit on. Done when: the file names each pre-existing path and the 09-launch owner who extends it with commit ranges.
- [x] Write `SECURITY.md` (GitHub private vulnerability reporting, scope: the service, the Worker and the analyser's handling of hostile mail; first response within 3 working days; no public issues for vulnerabilities), `CONTRIBUTING.md` (issues welcome; outside pull requests are not merged before judging ends because the rules require the team's own work; the hooks path; the validation commands), `CODE_OF_CONDUCT.md` (Contributor Covenant 2.1, reports to `conduct@isitlegit.co.za`, routed by D99 T01 §2, and GitHub's report abuse form; **Corrected 2026-10-26**, plan review P2: it named no reachable private destination) and `NOTICE.md` (third-party notices: none vendored yet; each dependency section adds its row). Done when: each file exists and names IsItLegit.
- [x] Add `.gitattributes` (LF for text sources, binary for images and fixtures) and `.editorconfig` (UTF-8, LF, 2 spaces for TypeScript, JSON and YAML, 4 for Python). Done when: `git check-attr eol -- scripts/hooks/pre-commit` prints `eol: lf`.
- [x] Add `.github/ISSUE_TEMPLATE/bug_report.yml`, `feature_request.yml` and `config.yml` (blank issues off, a security contact link to the advisory form), `.github/pull_request_template.md`, `.github/dependabot.yml` (GitHub Actions now; npm joins in §2) and `.github/labels.yml`. Done when: `python3 -c "import sys,yaml; [yaml.safe_load(open(f)) for f in sys.argv[1:]]" .github/ISSUE_TEMPLATE/*.yml .github/dependabot.yml .github/labels.yml` exits 0, each issue form has `name`, `description` and `body`, and `gh api repos/rizonetech/isitlegit/community/profile -q .files` lists the code of conduct, contributing, issue template, pull request template, license and security files (**Corrected 2026-10-26**, plan review P2: was an import of the YAML library, which parses nothing).
- [x] Run `git init -b main` and `git config core.hooksPath scripts/hooks`. Done when: `git config core.hooksPath` prints `scripts/hooks`.
- [x] Stage everything and read the staged list before committing. Done when: `git diff --cached --name-only | grep -cE '^(samples/[^.R]|sources/|competitors/|\.remember/)'` prints `0`. Cheaper substitute: `git add -A` without reading the staged list.
- [x] Make the first commit, `repo: initial commit for the IsItLegit hackathon build`, after 19:00 SAST with the hook enabled. Done when: `git log --reverse --format=%cI | head -1` prints a time after `2026-10-26T19:00:00+02:00`.
- [x] Create `rizonetech/isitlegit` as public with `gh repo create` and push `main`. Done when: `gh repo view rizonetech/isitlegit --json visibility,defaultBranchRef` shows `PUBLIC` and `main`, and `git ls-remote origin refs/heads/main` prints the same SHA as `git rev-parse main` (**Corrected 2026-10-26**, plan review P2: visibility alone did not prove the reviewed commit was pushed).
- [x] Apply the GitHub settings: description, homepage `https://isitlegit.co.za`, topics, private vulnerability reporting on, the labels from `.github/labels.yml`. Done when: `gh api repos/rizonetech/isitlegit/private-vulnerability-reporting -q .enabled` prints `true`; `gh repo view rizonetech/isitlegit --json description,homepageUrl,repositoryTopics` reads back the description in `README.md`'s pitch, `https://isitlegit.co.za` and the eleven topics (`phishing`, `email-security`, `invoice-fraud`, `business-email-compromise`, `meta-ai`, `muse-spark`, `sam`, `cloudflare-workers`, `typescript`, `south-africa`, `hackathon`); and the sorted names from `gh label list -R rizonetech/isitlegit` equal the sorted names in `.github/labels.yml` (**Corrected 2026-10-26**, plan review P2: description, homepage and topics were not read back, and extra default labels could pass).
- [x] Commit: `todo: record the public repository and its settings`

**Test checkpoint:** `git log --reverse --format=%cI | head -1` prints a time after `2026-10-26T19:00:00+02:00`; `git ls-files samples/` prints exactly `samples/.gitignore` and `samples/README.md`; `git ls-files sources competitors .remember | wc -l` prints `0`; `python3 scripts/check-publication.py` exits 0 (it exits 2 when the client list is missing, unreadable or empty, and scans the index: content including binary-marked mail fixtures, file paths, private checkout paths, the `samples/` files by identity and the local-only folders; tests in `tests/scripts/test_check_publication.py`); and `python3 -m unittest tests.scripts.test_pre_commit_hook` passes, including the client-name tests. **Corrected 2026-10-26**, plan review P1: the old check scanned the working tree and counted lines, which prints `0` when the list is missing or grep fails. **Corrected again 2026-10-26**, completion review: the replacement `test -s ... && git grep ...; test $? -eq 1` still passed with no list, and `-I` skipped binary-marked mail; both are now `scripts/check-publication.py`.

> **Verified:** 2026-10-26 | §1 | 87bfdedd0649f2c9d2fd73671027556a65b3885d
> **Review:** `docs/reviews/d00-t01-s1.json`

## 2. Worker package and health route

The Worker is one deploy unit (stack doc "Platform services"). This section creates the package with exact pins and the smallest route that proves the app runs: `GET /health`. TypeScript 7.0.2 is used for type checking only; Wrangler bundles with esbuild. If TypeScript 7 fails on the Cloudflare or Better Auth types, fall back to 6.0.3 and record why in the stack doc.

**Phase:** 0
**Needs:** none
**Surface:** no

**Build order:**

1. Create `package.json`, `pnpm-workspace.yaml` and `tsconfig.json` with exact pins from the stack doc. Done when: `pnpm install --frozen-lockfile` succeeds from a clean clone.
2. Create `wrangler.jsonc` with name `isitlegit`, a current `compatibility_date`, `nodejs_compat`, and no bindings yet. Done when: `pnpm exec wrangler deploy --dry-run` succeeds.
3. Create `src/index.ts` with a Hono app serving `GET /health`. Done when: `pnpm exec wrangler dev` answers `/health` with `200` and JSON naming the commit.

- [ ] Create `package.json` with `"packageManager": "pnpm@11.16.0"`, `"type": "module"` and exact versions: `hono` 4.13.14, `zod` 4.6.7, `typescript` 7.0.2, `wrangler` 4.152.0, `@cloudflare/workers-types` 5.20261026.1 (stack doc "Libraries" and "Tooling"). Done when: `pnpm install` writes `pnpm-lock.yaml` with those versions. Cheaper substitute: caret ranges, which let CI and local drift.
- [ ] Create `pnpm-workspace.yaml` listing `.` and `site` so the Astro site can pin TypeScript 6.0.3 on its own later. Done when: `pnpm -r list --depth -1` lists the root package.
- [ ] Create `tsconfig.json`: `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `module` and `moduleResolution` set for bundlers, `types` from `wrangler types` output. Done when: `pnpm exec tsc --noEmit` exits 0.
- [ ] Add script `typecheck` = `wrangler types && tsc --noEmit` to `package.json`. Done when: `pnpm typecheck` exits 0 and fails when a type error is added to `src/index.ts`.
- [ ] Create `wrangler.jsonc` with `name: "isitlegit"`, `main: "src/index.ts"`, `compatibility_flags: ["nodejs_compat"]`. Done when: `pnpm exec wrangler deploy --dry-run --outdir build/dry` exits 0.
- [ ] Create `src/index.ts` exporting a Hono app with `GET /health` returning `{ ok: true, commit }`, the commit from a `COMMIT_SHA` var. Done when: `curl -s localhost:8787/health` under `wrangler dev` prints `"ok":true`. Cheaper substitute: a hard-coded string with no commit, which cannot prove which build is live.
- [ ] Record in `docs/specs/2026-10-26-tech-stack-design.md` whether TypeScript 7 passed on the scaffold (the Day 0 check in its Tooling row). Done when: the row states the result with the date.
- [ ] Add an `npm` entry (directory `/`, weekly, label `dependencies`) to `.github/dependabot.yml` beside the GitHub Actions entry, as D00 T01 §1 promised. Done when: `python3 -c "import yaml;print(sorted(u['package-ecosystem'] for u in yaml.safe_load(open('.github/dependabot.yml'))['updates']))"` prints `['github-actions', 'npm']`. Cheaper substitute: leaving npm updates to memory.
- [ ] Commit: `worker: scaffold the Worker package with a health route`

**Test checkpoint:** `pnpm typecheck` exits 0, and `pnpm exec wrangler deploy --dry-run --outdir build/dry` exits 0.

## 3. Vitest workers pool and Biome

Tests run inside the Workers runtime through `@cloudflare/vitest-pool-workers`, which requires Vitest `^4.1` (so not Vitest 5). Biome replaces `typescript-eslint`, which does not support TypeScript 7.

**Phase:** 0
**Needs:** none
**Surface:** no

**Build order:**

1. Add `vitest` 4.1.12 and `@cloudflare/vitest-pool-workers` 0.23.0 with `vitest.config.ts`. Done when: `pnpm test` runs inside workerd.
2. Write `test/health.test.ts` for `/health`. Done when: it passes, and fails when the route returns `500`.
3. Add `@biomejs/biome` at an exact 2.6.x version with `biome.json`. Done when: `pnpm lint` exits 0 and fails on an unused variable.

- [ ] Add exact dev dependencies `vitest` 4.1.12 and `@cloudflare/vitest-pool-workers` 0.23.0 to `package.json`. Done when: `pnpm install` resolves both with no peer warning about Vitest.
- [ ] Create `vitest.config.ts` using the workers pool with `wrangler.jsonc` as its config. Done when: `pnpm exec vitest run` reports the workers pool.
- [ ] Write `test/health.test.ts` calling `SELF.fetch("https://x/health")` and asserting `200` and `ok: true`. Done when: the test passes and fails if `src/index.ts` returns `500`. Cheaper substitute: unit-testing the handler function outside the runtime.
- [ ] Add script `test` = `vitest run` to `package.json`. Done when: `pnpm test` exits 0.
- [ ] Add exact dev dependency `@biomejs/biome` (latest 2.6.x on the day) and `biome.json` with the recommended rules, formatter on, `samples/`, `sources/` and `build/` ignored. Done when: `pnpm exec biome check .` exits 0.
- [ ] Add script `lint` = `biome check .` to `package.json`. Done when: `pnpm lint` fails on an unused variable in `src/index.ts` and passes once it is removed.
- [ ] Commit: `test: Vitest workers pool and Biome lint for the Worker`

**Test checkpoint:** `pnpm test` exits 0 with `test/health.test.ts` passing, and `pnpm lint` exits 0.

## 4. GitHub Actions CI

Every push runs the Worker gates and the TODO gates, so a stale plan or a failing test cannot reach `main` unnoticed. Actions are pinned to full commit SHAs.

**Phase:** 0
**Needs:** none
**Surface:** no

**Build order:**

1. Create `.github/workflows/ci.yml` running install, typecheck, lint, test and the TODO and tooling checks. Done when: the workflow passes on GitHub for the pushed commit.
2. Record the watched workflow for `scripts/ci_status.py` in `.conclave/ci.json`. Done when: `python3 scripts/ci_status.py` reports the workflow's latest verdict.

- [ ] Create `.github/workflows/ci.yml` on `push` and `pull_request` with `actions/checkout`, `pnpm/action-setup` and `actions/setup-node` (Node 24) pinned to full SHAs. Done when: `grep -E 'uses: .+@[0-9a-f]{40}' .github/workflows/ci.yml | wc -l` equals the number of `uses:` lines. Cheaper substitute: `@v4` tags, which can move under us.
- [ ] Add steps `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm lint`, `pnpm test` to `ci.yml`. Done when: each step appears and the run log shows each one green.
- [ ] Add steps `python3 scripts/todo-graph.py validate`, `python3 scripts/todo-graph.py plan --check`, `python3 -m unittest discover -s tests/scripts` and `python3 -m unittest discover -s scripts/tests` to `ci.yml`. Done when: a deliberately stale `todo/implementation-plan.md` fails the run.
- [ ] Create `.conclave/ci.json` with `{"workflows": ["ci.yml"]}`. Done when: `python3 scripts/ci_status.py` exits 0 on a green run.
- [ ] Add the CI badge for `.github/workflows/ci.yml` to the badge row in `README.md`, first in the row as in Isotone. Done when: the badge renders the workflow's status on GitHub. Cheaper substitute: a badge for a workflow that does not exist yet.
- [ ] Commit: `ci: run Worker and TODO gates on every push`

**Test checkpoint:** `gh run list --workflow ci.yml --limit 1 --json conclusion -q '.[0].conclusion'` prints `success`.

## 5. Cloudflare bindings and first deploy

The Worker needs D1 for cases and tenants, R2 for raw mail and artefacts (with a 30-day lifecycle on `raw/` for POPIA), KV for caches, a Workflow for the pipeline and Browser Run for rendering (stack doc "Platform services"). Resource creation and the first deploy are covered by the operator's standing authorisation for IsItLegit resources (design spec section 11, `AGENTS.md` Safety; **Corrected 2026-10-26:** this section needed `attended` before that authorisation).

**Phase:** 0
**Needs:** cloudflare
**Surface:** no

**Build order:**

1. Create the D1 database, R2 bucket and KV namespace. Done when: `wrangler d1 list`, `wrangler r2 bucket list` and `wrangler kv namespace list` show `isitlegit`, `isitlegit-artefacts` and `isitlegit-cache`.
2. Add the bindings and a stub `AnalysisWorkflow` to `wrangler.jsonc` and `src/`. Done when: `pnpm typecheck` passes with the generated binding types.
3. Deploy and read back `/health`. Done when: the deployed `/health` returns the commit just pushed.

- [ ] Create D1 database `isitlegit` with `wrangler d1 create`. Done when: `wrangler d1 list` shows it and its id is in `wrangler.jsonc` as binding `DB`.
- [ ] Create R2 bucket `isitlegit-artefacts` with `wrangler r2 bucket create`. Done when: it is bound as `ARTEFACTS` in `wrangler.jsonc`.
- [ ] Add an R2 lifecycle rule deleting objects under `raw/` after 30 days (design spec 4.8, POPIA). Done when: `wrangler r2 bucket lifecycle list isitlegit-artefacts` shows the rule. Cheaper substitute: a cleanup cron in the Worker, which fails silently when the Worker is broken.
- [ ] Create KV namespace `isitlegit-cache` and bind it as `CACHE`. Done when: `wrangler kv namespace list` shows it and `wrangler.jsonc` holds its id.
- [ ] Add a stub `AnalysisWorkflow` class in `src/pipeline/analysis-workflow.ts` with one no-op step, exported from `src/index.ts` and bound as `ANALYSIS`. Done when: `pnpm typecheck` passes with the binding type.
- [ ] Add the Browser Run binding `BROWSER` to `wrangler.jsonc`. Done when: `wrangler types` emits `BROWSER: Fetcher`.
- [ ] Deploy with `wrangler deploy --var COMMIT_SHA:$(git rev-parse HEAD)`. Done when: `curl -s https://isitlegit.<account>.workers.dev/health` returns the same SHA.
- [ ] Commit: `infra: Cloudflare bindings, R2 lifecycle and first deploy`

**Test checkpoint:** `curl -s https://isitlegit.<account>.workers.dev/health` returns `"ok":true` with the SHA of `git rev-parse HEAD`.

## 6. AI Gateway for the Meta Model API

All Meta traffic goes through an AI Gateway custom provider in front of `https://api.meta.ai/v1`, for per-request cost and latency logs without storing prompt content (stack doc "Model traffic"). This section configures the gateway only; no Meta call is made until §7.

**Phase:** 0
**Needs:** cloudflare
**Surface:** no

**Build order:**

1. Create gateway `isitlegit` with a custom provider for `https://api.meta.ai/v1`. Done when: the gateway shows in the Cloudflare dashboard API with the provider slug recorded in `wrangler.jsonc` vars.
2. Configure payload logging off. Done when: the gateway settings read back with prompt and response logging disabled.

- [ ] Create AI Gateway `isitlegit` on account `f5a529987f8dc7d52ce7aba3da25e226` through the Cloudflare API. Done when: a GET of the gateway returns it.
- [ ] Add a custom provider with base URL `https://api.meta.ai/v1` (Cloudflare docs, AI Gateway custom providers). Done when: the provider's slug is recorded in `wrangler.jsonc` as var `META_GATEWAY_URL`.
- [ ] Disable payload logging on the gateway and document the `cf-aig-collect-log-payload: false` header the client sends. Done when: the gateway settings read back with logging of bodies off. Cheaper substitute: relying on the header alone, which a client bug would drop.
- [ ] Commit: `infra: AI Gateway custom provider for the Meta Model API`

**Test checkpoint:** `curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" https://api.cloudflare.com/client/v4/accounts/f5a529987f8dc7d52ce7aba3da25e226/ai-gateway/gateways/isitlegit | jq .success` prints `true`.

## 7. Meta smoke test

One small script proves each Meta capability the product depends on before anything is built on it. It runs only once the hackathon credit shows under Billing, "free credits" (`sources/cerebralvalley/2026-10-26-credit-claim.md`); before then every call is charged to the card.

**Phase:** 0
**Needs:** meta-api, cloudflare
**Surface:** no

**Build order:**

1. Write `scripts/meta-smoke.ts` with one call per capability through the gateway, `store: false` on each. Done when: `pnpm exec tsx scripts/meta-smoke.ts --dry` prints the four planned requests without sending them.
2. Run it once and record the results. Done when: `docs/meta-smoke-test.md` holds each model's status, latency and token counts (**Corrected 2026-10-26:** was under `sources/`, which is now git-ignored and local only).

- [ ] Add exact dev dependencies `openai` 7.43.0 and `tsx` 4.23.15. Done when: `pnpm install` resolves both.
- [ ] Write `scripts/meta-smoke.ts` reading `META_API_KEY` from the environment only and refusing to run without `--confirm-credit`. Done when: running without the flag exits 2 with the reason. Cheaper substitute: a key pasted into the script.
- [ ] Add a `muse-spark-1.3` text call and an image call on a synthetic image in `test/fixtures/` to the script, both with `store: false`. Done when: `--dry` prints both request bodies with `store: false`.
- [ ] Add a `sam-3.1` call with the text prompt `logo` on a synthetic branded image, parsed with `@meta-sam/parser` 0.1.0 (Meta docs, SAM reading segmentation). Done when: `--dry` prints the request with one `input_text` and one `input_image` part.
- [ ] Add a `muse-wonder-1.0` call with the computer tool for one step against `about:blank`. Done when: `--dry` prints the request with the computer tool declared.
- [ ] Add a guard that refuses any model ID ending in `-contributor`. Done when: passing `--model muse-spark-1.3-contributor` exits 2.
- [ ] Confirm the credit gate before any call: `grep -E '^Meta credit visible: 2026-' todo/99-manual/TODO-01-day0-accounts.md` matches (the operator records it in D99 T01 §1); without it park the section. Done when: the grep matches.
- [ ] Run the script once with `--confirm-credit` and write `docs/meta-smoke-test.md` (model, status, latency, input and output tokens, cost; no keys, no response bodies beyond a short excerpt). Done when: the file lists all four calls with results or a named fallback.
- [ ] Commit: `meta: smoke test of Spark, SAM 3.1 and Wonder through the gateway`

**Test checkpoint:** `pnpm exec tsx scripts/meta-smoke.ts --dry` exits 0 printing four requests each with `"store": false`, and `docs/meta-smoke-test.md` exists with four result rows.

## 8. README banner and social preview

> **Started:** 2026-10-26T23:42:17Z

The reference repositories open with a brand image (Recto's `design/brand/github-banner.png`, Isotone's wordmark and cover). IsItLegit gets the same once its brand exists; until then the README opens with a text title. The wordmark comes out of the design session (D07 T01 §1; **Corrected 2026-10-26:** moved from phase 0 to phase 1 to follow it).

**Phase:** 1
**Needs:** attended
**Surface:** no

**Build order:**

1. Design the IsItLegit wordmark and banner in the Rizonetech brand (Exo and Exo 2, orange `#FF4A14`), light and dark. Done when: the operator approves the banner.
2. Put it in the README and set the GitHub social preview. Done when: the README shows the banner and the repository's social preview is set.

- [x] Design `design/brand/logo-svg/isitlegit-logo.svg`, `design/brand/logo-svg/isitlegit-logo-on-dark.svg` and `design/brand/web/github-banner.png` (1280 by 640). Done when: the operator approves them in session. Cheaper substitute: a stock template banner. **Corrected 2026-10-26:** the operator approved the brand in session at 20:58 SAST (direction A logo, direction C seal with PROTECTED, C's icons, the dot-becomes-the-answer motion, orange); the full kit is generated by `design/tools/build-brand.py` into `design/brand/` (guide in `design/brand/README.md`), so the paths are `logo-svg/` and `web/` rather than the flat names first planned.
- [x] Add the wordmark to the top of `README.md` with a `<picture>` element for light and dark, as Isotone does. Done when: GitHub renders the right variant in each theme.
- [x] Upload `design/brand/web/github-banner.png` as the social preview in the repository settings (the API cannot set it). Done when: sharing the repository link shows the banner. Evidence 2026-10-27 00:58 SAST: GitHub reports `usesCustomOpenGraphImage: true` and serves the current banner (centred tick, ink #181519).
- [ ] Write `tests/scripts/test_readme_brand.py`: the banner decodes in full at 1280 by 640; the README `<picture>` maps `prefers-color-scheme: dark` to `isitlegit-logo-on-dark.svg`, light to `isitlegit-logo.svg`, and its `<img>` falls back to the light logo with alt `IsItLegit`; every file it names exists and parses as SVG. Done when: it passes, and planted defects (a banner cut after its header, swapped theme sources, a missing logo) each fail it. **Corrected 2026-10-27 (plan review P2):** the checkpoint read only the PNG header and one filename, so it passed on a truncated banner or reversed themes.
- [ ] Read back the live social preview: `openGraphImageUrl` from the GitHub GraphQL API, downloaded and decoded, matches `design/brand/web/github-banner.png` in size and within a mean channel difference of 4 (GitHub re-encodes it). Done when: `LIVE_CHECKS=1` runs the live test in the same file and it passes; without the variable it is skipped.
- [ ] Render the repository page in headless Chromium in the light and the dark colour scheme and record which logo each shows. Done when: both screenshots are inspected and the result is written here as evidence.
- [ ] Commit: `brand: README wordmark and social preview banner`

**Test checkpoint:** `LIVE_CHECKS=1 python3 -m unittest tests.scripts.test_readme_brand` passes with no test skipped. **Corrected 2026-10-27 (plan review P2):** it was a PNG header read and a filename count.

## Verification

- A clean clone runs `pnpm install --frozen-lockfile && pnpm typecheck && pnpm lint && pnpm test` to green, and CI shows the same on `main`.
- The deployed `/health` returns the SHA of `main`.
- The smoke-test record shows Spark, SAM 3.1 and Wonder working through the gateway, or a named fallback for any that failed.
- `python3 scripts/todo-graph.py validate` and `python3 scripts/todo-graph.py plan --check` pass.
