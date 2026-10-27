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
| 2 | §2 | Worker package and health route | §1 | [x] |
| 3 | §3 | Vitest workers pool and Biome | §2 | [x] |
| 4 | §4 | GitHub Actions CI | §3 | [x] |
| 5 | §5 | Cloudflare bindings and first deploy | §4 | [ ] |
| 6 | §6 | AI Gateway for the Meta Model API | §5 | [ ] |
| 7 | §7 | Meta smoke test | §6 | [ ] |
| 8 | §8 | README banner and social preview | §1, D07 T01 §1 | [x] |
| 9 | §9 | Red CI refused when a section starts | §4 | [ ] |

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

> **Started:** 2026-10-27T00:09:32Z

The Worker is one deploy unit (stack doc "Platform services"). This section creates the package with exact pins and the smallest route that proves the app runs: `GET /health`. TypeScript 7.0.2 is used for type checking only; Wrangler bundles with esbuild. If TypeScript 7 fails on the Cloudflare or Better Auth types, fall back to 6.0.3 and record why in the stack doc.

**Phase:** 0
**Needs:** none
**Surface:** no

**Build order:**

1. Create `package.json`, `pnpm-workspace.yaml` and `tsconfig.json` with exact pins from the stack doc. Done when: `pnpm install --frozen-lockfile` succeeds from a clean clone.
2. Create `src/index.ts` with a Hono app serving `GET /health`. Done when: `pnpm typecheck` passes on it.
3. Create `wrangler.jsonc` with name `isitlegit`, a current `compatibility_date`, `nodejs_compat`, and no bindings yet. Done when: `pnpm exec wrangler deploy --dry-run` succeeds and `pnpm exec wrangler dev` answers `/health` with `200` and JSON naming the commit. **Corrected 2026-10-27** (plan review P3): the dry run came before the entry point it bundles existed.

- [x] Create `package.json` with `"packageManager": "pnpm@11.16.0"`, `"type": "module"` and exact versions: `hono` 4.13.14, `zod` 4.6.7, `typescript` 7.0.2, `wrangler` 4.152.0 (stack doc "Libraries" and "Tooling"). Done when: `pnpm install` writes `pnpm-lock.yaml` with those versions. Cheaper substitute: caret ranges, which let CI and local drift. **Corrected 2026-10-27:** the list also pinned `@cloudflare/workers-types` 5.20261026.1 as a "required peer of Wrangler 4.152"; `npm view wrangler@4.152.0 peerDependenciesMeta` marks it optional, and `wrangler types` already writes the runtime types for the configured `compatibility_date` into `worker-configuration.d.ts`, so installing both declares the Workers globals twice. The runtime types come from `wrangler types` only, and the stack doc row is corrected with it.
- [x] Create `pnpm-workspace.yaml` listing `.` and `site` so the Astro site can pin TypeScript 6.0.3 on its own later, with `allowBuilds` naming `esbuild` and `workerd`, the two dependencies whose install scripts Wrangler needs. Done when: `pnpm -r list --depth -1` lists the root package and `pnpm install --frozen-lockfile` exits 0 from a clean clone. **Corrected 2026-10-27:** pnpm 11.16.0 fails `install` with `ERR_PNPM_IGNORED_BUILDS` for `esbuild` and `workerd` when no build is approved (measured on a scratch scaffold), so the approval belongs in the workspace file, not in a local `pnpm approve-builds` that CI never sees.
- [x] Create `tsconfig.json`: `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `module` and `moduleResolution` set for bundlers, `types` from `wrangler types` output. Done when: `pnpm exec tsc --noEmit` exits 0.
- [x] Add script `typecheck` = `wrangler types --strict-vars=false && tsc --noEmit` to `package.json`. Done when: `pnpm typecheck` exits 0 and fails when a type error is added to `src/index.ts`. **Corrected 2026-10-27:** without `--strict-vars=false`, `wrangler types` typed `COMMIT_SHA` as the literal `"dev"`, which every deploy contradicts.
- [x] Create `wrangler.jsonc` with `name: "isitlegit"`, `main: "src/index.ts"`, `compatibility_date: "2026-10-26"`, `compatibility_flags: ["nodejs_compat"]` and `vars.COMMIT_SHA: "dev"`, the local default that `wrangler dev --var` and the §5 deploy (`--var COMMIT_SHA:$(git rev-parse HEAD)`) override. Done when: `pnpm exec wrangler deploy --dry-run --outdir build/dry` exits 0. **Corrected 2026-10-27:** the item left out the `compatibility_date` its build order asks for, and gave `COMMIT_SHA` no declared source, so `Env` had no typed `COMMIT_SHA`.
- [x] Create `src/index.ts` exporting a Hono app with `GET /health` returning `{ ok: true, commit }`, the commit from a `COMMIT_SHA` var. Done when: `curl -s localhost:8787/health` under `wrangler dev --var COMMIT_SHA:$(git rev-parse HEAD)` prints `"ok":true` with that SHA. Cheaper substitute: a hard-coded string with no commit, which cannot prove which build is live.
- [x] Record in `docs/specs/2026-10-26-tech-stack-design.md` whether TypeScript 7 passed on the scaffold (the Day 0 check in its Tooling row), and correct its `@cloudflare/workers-types` row to the generated runtime types. Done when: the Language row states the result with the date, names D07 T02 §1 as the owner of the Better Auth half of the check, and no row calls `@cloudflare/workers-types` a required peer.
- [x] Add an `npm` entry (directory `/`, weekly, label `dependencies`) to `.github/dependabot.yml` beside the GitHub Actions entry, as D00 T01 §1 promised. Done when: `python3 -c "import yaml;u={x['package-ecosystem']:x for x in yaml.safe_load(open('.github/dependabot.yml'))['updates']};print(sorted(u), [(x['directory'],x['schedule']['interval'],x['labels']) for k,x in sorted(u.items())])"` prints `['github-actions', 'npm'] [('/', 'weekly', ['dependencies']), ('/', 'weekly', ['dependencies'])]`. Cheaper substitute: leaving npm updates to memory. **Corrected 2026-10-27** (plan review P2): the check read only the ecosystem names, so a wrong directory, schedule or label passed.
- [x] Add the four packages to the `Entering the build` table in `NOTICE.md`: `hono` 4.13.14 MIT (ships), `zod` 4.6.7 MIT (ships once imported), `typescript` 7.0.2 Apache-2.0 (no, type checking only), `wrangler` 4.152.0 MIT OR Apache-2.0 (no, build and deploy tool). Done when: each row's version and licence equal `node -p "require('./node_modules/<name>/package.json').version + ' ' + require('./node_modules/<name>/package.json').license"` for that package. Cheaper substitute: a licence column copied from memory. **Corrected 2026-10-27** (plan review P2): `NOTICE.md` asks each section that adds a dependency to add its row, and this section had no item for it.
- [x] Add scripts `dev` = `wrangler dev --var COMMIT_SHA:$(git rev-parse HEAD)` and `build` = `wrangler deploy --dry-run --outdir build/dry` to `package.json`, with `shellEmulator: true` in `pnpm-workspace.yaml` so the substitution runs in pnpm's own shell on Windows as on Linux. Done when: `pnpm build` exits 0 and, under `pnpm dev`, `curl -s localhost:8787/health` prints the commit `git rev-parse HEAD` prints. Cheaper substitute: a README line asking each developer to type the `--var` flag by hand. (Completion review 2026-10-27, in-scope excellence item: the Hono and Cloudflare starters expose `dev` and `build` as package scripts.)
- [x] Add a "Run the Worker locally" quickstart under "How it is built" in `README.md` (Node 24, pnpm 11 through `corepack enable`, frozen install, `pnpm typecheck`, `pnpm build`, `pnpm dev`, the expected `/health` JSON, how to stop, restart and free port 8787), and replace the stale promise in `CONTRIBUTING.md` "Validation gates" with the Worker gates and a link to it. Done when: following the quickstart in a clean clone prints `{"ok":true,"commit":"<HEAD>"}`, and `python3 -m unittest tests.scripts.test_readme_brand` still passes (it resolves every relative link in the README). Cheaper substitute: leaving the commands in the stack doc and this TODO. (Completion review 2026-10-27, missing in scope.)
- [x] Add the Worker gates (`pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm build`) to the `AGENTS.md` "Validation" block, as its own closing line asks of the scaffold section, and add `tests/scripts/test_worker_gates.py`, which fails while any `package.json` script but `dev` and `types` is missing from `AGENTS.md` "Validation" or `CONTRIBUTING.md` "Validation gates". Done when: the test fails on the candidate before the fix (`AGENTS.md` listed no pnpm command) and passes after it, and its planted defects (a dropped command, a new `lint` script, a command outside the section, a commented-out command) each fail. (Final review 2026-10-27, P2.)
- [x] Make `typecheck` refuse a stale `worker-configuration.d.ts`: `typecheck` = `wrangler types --strict-vars=false --check && tsc --noEmit`, and a `types` script regenerates the file. Done when: a var added to `wrangler.jsonc` without `pnpm types` makes `pnpm typecheck` exit 1 with "Types at worker-configuration.d.ts are out of date". Cheaper substitute: regenerating inside the gate, which can never refuse a stale committed copy. (Final review 2026-10-27, P3.)
- [x] Pin Node 24.18.0 from the stack doc in `.nvmrc` and `package.json` `engines.node` (`>=24.18.0`), with `engineStrict: true` in `pnpm-workspace.yaml`. Done when: `pnpm install --frozen-lockfile --config.node-version=22.12.0` exits 1 with `ERR_PNPM_UNSUPPORTED_ENGINE`, and `tests/scripts/test_worker_gates.py` checks `.nvmrc`, `engines` and `packageManager` against the stack doc row. (Final review 2026-10-27, P3.)
- [x] State in the README quickstart that `/health` names the `HEAD` at `pnpm dev` start, so after a new commit or with uncommitted edits the server is restarted after committing. Done when: the README says so; the deploy half of the finding is D00 T01 §5's (corrected there to refuse a dirty tree). (Final review 2026-10-27, P3.)
- [x] Commit: `worker: scaffold the Worker package with a health route`

**Test checkpoint:** `pnpm install --frozen-lockfile` exits 0 in a clean clone; `pnpm typecheck` exits 0 and exits non-zero with `const n: number = "x";` planted in `src/index.ts`; `pnpm exec wrangler deploy --dry-run --outdir build/dry` exits 0; and under `pnpm exec wrangler dev --var COMMIT_SHA:$(git rev-parse HEAD)`, `curl -s -w ' %{http_code}' localhost:8787/health` prints `{"ok":true,"commit":"<that SHA>"} 200`. **Corrected 2026-10-27:** the checkpoint was a type check and a dry run only, which pass on a Worker with no `/health` route; the route test in the runtime arrives with Vitest in §3.

Evidence 2026-10-27 02:35 SAST, at `92115c4`: a clean clone runs `pnpm install --frozen-lockfile` (exit 0), `pnpm typecheck` (exit 0, and the regenerated `worker-configuration.d.ts` equals the committed one) and `pnpm exec wrangler deploy --dry-run --outdir build/dry` (exit 0); `pnpm typecheck` exits 1 with `const n: number = "x";` planted (`TS2322`); under `wrangler dev --var COMMIT_SHA:46eaa434f04fb77d9157f4328c994f82b2b9912d`, `/health` printed `{"ok":true,"commit":"46eaa434f04fb77d9157f4328c994f82b2b9912d"} 200` and an unknown path `404`. `wrangler types` runs with `--strict-vars=false` so `COMMIT_SHA` is typed `string`, not the literal `"dev"` (a deploy sets a SHA).

Evidence 2026-10-27 02:27 SAST, at `db21252`, following the README quickstart in a clean clone: `pnpm install --frozen-lockfile` 0, `pnpm typecheck` 0 (tree unchanged), `pnpm build` 0, and under `pnpm dev`, `/health` printed `{"ok":true,"commit":"db2125216b6881211b4c1ed83b89f1da222b83ad"} 200`, the clone's HEAD; `python3 -m unittest tests.scripts.test_readme_brand` ran 17 tests, OK (1 live test skipped without `LIVE_CHECKS`).

> **Verified:** 2026-10-27 | §2 | 6e0c6d521c0318198e0e5d77c4794c95c9fa6cca
> **Review:** `docs/reviews/d00-t01-s2.json`

## 3. Vitest workers pool and Biome

> **Started:** 2026-10-27T00:40:05Z

Tests run inside the Workers runtime through Cloudflare's Vitest integration. Biome replaces `typescript-eslint`, which does not support TypeScript 7.

**Corrected 2026-10-27:** the integration was planned as `@cloudflare/vitest-pool-workers` 0.23.0, which requires Vitest `^4.1`. That package was renamed `@cloudflare/vitest-plugin` for version 1 (Cloudflare changelog 2026-08-19, "@cloudflare/vitest-pool-workers is now @cloudflare/vitest-plugin"), and installing 0.23.0 prints `deprecated ... will not receive future updates`. The plugin is configured with `cloudflareTest()` in the `plugins` array, and tests reach the Worker through `exports` from `cloudflare:workers` (the `SELF` binding is the old API; developers.cloudflare.com/workers/testing/vitest-integration/test-apis/). Version 1.4.7 is pinned: it is the newest release older than pnpm 11's minimum release age on the day (1.4.8 came out 2026-10-26, and pnpm answers a too-new pin by writing a `minimumReleaseAgeExclude` waiver into `pnpm-workspace.yaml`), and it depends on exactly the Wrangler 4.152.0 the Worker pins, so the lockfile holds one Wrangler and one Miniflare. It accepts Vitest `^4.1 || ^5`; the stack doc's Vitest 4.1.12 stays.

**Phase:** 0
**Needs:** none
**Surface:** no

**Build order:**

1. Add `vitest` 4.1.12 and `@cloudflare/vitest-plugin` 1.4.7 with `vitest.config.ts`. Done when: `pnpm test` runs inside workerd.
2. Write `test/health.test.ts` for `/health`. Done when: it passes, and fails when the route returns `500`.
3. Add `@biomejs/biome` at an exact 2.6.x version with `biome.json`. Done when: `pnpm lint` exits 0 and fails on an unused variable.
4. Document the two new gates. Done when: `tests/scripts/test_worker_gates.py` passes with `test` and `lint` in `package.json`.

- [x] Add exact dev dependencies `vitest` 4.1.12 and `@cloudflare/vitest-plugin` 1.4.7 to `package.json`. Done when: `pnpm install` resolves both with no peer warning, writes no `minimumReleaseAgeExclude` into `pnpm-workspace.yaml`, and `pnpm-lock.yaml` holds one `wrangler@` (4.152.0) and one `miniflare@` entry. Cheaper substitute: accepting pnpm's release-age waiver for a day-old release. **Corrected 2026-10-27:** was `@cloudflare/vitest-pool-workers` 0.23.0 (renamed and deprecated, see above).
- [x] Create `vitest.config.ts` with `cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" }, miniflare: { bindings: { COMMIT_SHA: <a fixed 40-character test SHA> } } })` in `plugins`. Done when: `pnpm exec vitest run` runs `test/health.test.ts` in workerd (the test imports `cloudflare:workers`, which exists only there). **Corrected 2026-10-27:** "the workers pool" is now the `cloudflareTest()` plugin.
- [x] Write `test/health.test.ts` calling `exports.default.fetch("https://example.com/health")` from `cloudflare:workers` (**Corrected 2026-10-27:** was `SELF.fetch`, the pre-plugin API) and asserting `200`, `ok: true` and `commit` equal to the `COMMIT_SHA` binding the pool supplies (set a test value in `vitest.config.ts`, not `"dev"`). Done when: the test passes, and fails if `src/index.ts` returns `500` or hard-codes the commit. **Corrected 2026-10-27** (D00 T01 §2 completion review): the assertion read only status and `ok`, so a route that dropped or hard-coded the commit, the one thing `/health` exists to prove, passed. Cheaper substitute: unit-testing the handler function outside the runtime.
- [x] Add script `test` = `vitest run` to `package.json`. Done when: `pnpm test` exits 0.
- [x] Add `test/tsconfig.json` extending the root config with `types: ["@cloudflare/vitest-plugin/types"]` and `worker-configuration.d.ts` included, and extend `typecheck` to `tsc --noEmit -p test` after the root check. Done when: `pnpm typecheck` exits 1 with a type error planted in `test/health.test.ts`. Cheaper substitute: leaving tests outside the type check, where Vitest's transform strips types without checking them. Vitest's bundled `tinybench` types clash with the Workers runtime `EventTarget` (TS2416), a third-party defect, so this file alone sets `skipLibCheck: true`, marked `WORKAROUND`; the root config keeps checking libraries.
- [x] Add exact dev dependency `@biomejs/biome` 2.6.3 (latest 2.6.x on the day, released 2026-10-24) and `biome.json` with the formatter on, `linter.rules.preset` `recommended`, `noUnusedVariables` and `noUnusedImports` at `error`, VCS ignore on, and `files.includes` limited to the Worker's own files (`src/**`, `test/**`, `vitest.config.ts`, `wrangler.jsonc`, `package.json`, `tsconfig.json`, `biome.json`). Done when: `pnpm exec biome check .` exits 0 and `git status` shows no file outside those paths reformatted. **Corrected 2026-10-27:** the whole tree with three folders ignored would lint and reformat JSON written by the Python tooling (review receipts in `docs/reviews/`, design exports); `recommended: true` is deprecated in 2.6 in favour of `preset`; and `noUnusedVariables` is only a warning in the recommended set, which `biome check` passes.
- [x] Add script `lint` = `biome check .` to `package.json`. Done when: `pnpm lint` fails on an unused variable in `src/index.ts` and passes once it is removed.
- [x] Add `pnpm test` and `pnpm lint` to the `AGENTS.md` "Validation" block, `CONTRIBUTING.md` "Validation gates" and the README quickstart, and the three packages to `NOTICE.md` (`vitest` 4.1.12 MIT, `@cloudflare/vitest-plugin` 1.4.7 MIT, `@biomejs/biome` 2.6.3 MIT OR Apache-2.0, none shipping in the Worker). Done when: `python3 -m unittest tests.scripts.test_worker_gates` passes and each `NOTICE.md` row matches the installed `package.json` version and licence. Cheaper substitute: gates nobody is told to run.
- [x] Correct the stack doc's Tests row (plugin name and version, Vitest 5 now accepted, 4.1.12 kept) and Lint row (Biome 2.6.3 pinned). Done when: neither row names `vitest-pool-workers` or "2.6.x".
- [x] Make `pnpm exec vitest --watch` rerun `test/health.test.ts` when `src/index.ts` changes (the test imports `../src/index`, as Cloudflare's migration guide requires for `exports`-based tests), and document the watch loop and its `q` stop in the README quickstart and `CONTRIBUTING.md`. Done when: an edit to `src/index.ts` under `pnpm exec vitest --watch` prints `RERUN src/index.ts`, and `pnpm test` still fails on a `500`. Cheaper substitute: documenting watch mode that never reruns on Worker edits. (Completion review 2026-10-27, in-scope excellence item; the missing rerun was found while proving it.) Evidence at `8fef04f`: an appended comment in `src/index.ts` under watch printed `RERUN src/index.ts x1` and `Tests  1 passed` twice; with `/health` returning `500`, `pnpm test` printed `expected 500 to be 200`, `Tests  1 failed`.
- [x] Type-check `vitest.config.ts` through `tsconfig.config.json` (extends the root config, includes only that file, `skipLibCheck` marked `WORKAROUND` because Miniflare's published declarations import modules the package does not ship, TS2307), run as the last step of `typecheck`, and add the file to Biome's `files.includes`. Done when: `const n: number = "x";` planted in `vitest.config.ts` makes `pnpm typecheck` print `vitest.config.ts(17,7): error TS2322` and exit 1. Cheaper substitute: relying on Vite, which strips the config's types unchecked. (Final review 2026-10-27, P3.)
- [x] Extend `tests/scripts/test_worker_gates.py` to the README quickstart (`### Run the Worker locally`), reading sections line by line so a `# comment` inside a bash block never ends one. Done when: deleting `pnpm lint` and `pnpm test` from the README quickstart fails the test (`path='README.md'`, `['pnpm lint', 'pnpm test']`), and the level-3 and commented-command unit tests pass. (Final review 2026-10-27, P3; the first regex version ended a section at `# pnpm build`, caught by its own unit test.)
- [x] Prove the unused-import half of the lint rule. Done when: `import { z } from "zod";` planted at the top of `src/index.ts` makes `pnpm lint` exit 1 with `lint/correctness/noUnusedImports`. (Final review 2026-10-27, P3.)
- [x] Remove the old pool name from the stack doc: the repository layout's `test/` line names `@cloudflare/vitest-plugin`, and the Tests row's note describes the rename without the deprecated package's name. Done when: `grep -cE "workers pool|vitest-pool-workers" docs/specs/2026-10-26-tech-stack-design.md` prints `0`. (Final review 2026-10-27, two P3s.)
- [x] Commit: `test: Vitest workers pool and Biome lint for the Worker`

**Test checkpoint:** in a clean clone, `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm lint` and `pnpm test` exit 0 with `test/health.test.ts` passing; `pnpm test` exits 1 when `/health` returns `500` or hard-codes `"dev"` as the commit; `pnpm lint` exits 1 on an unused variable in `src/index.ts`; `python3 -m unittest tests.scripts.test_worker_gates` passes. **Corrected 2026-10-27:** the checkpoint named only the passing runs, which a test asserting nothing also gives.

Evidence 2026-10-27 02:50 SAST, at `a7c04c0` in a clean clone: `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm lint` (8 files), `pnpm test` (1 file, 1 test, in workerd) and `pnpm build` exit 0, the tree stays clean, and `python3 -m unittest tests.scripts.test_worker_gates` passes. Planted in the working tree and reverted: `/health` returning `500` fails `pnpm test` (`expected 500 to be 200`); a hard-coded `commit: "dev"` fails it (`expected { ok: true, commit: 'dev' } to deeply equal ...`); `const unusedThing = 1;` in `src/index.ts` fails `pnpm lint` (`lint/correctness/noUnusedVariables`, 1 error); `const n: number = "x";` in `test/health.test.ts` fails `pnpm typecheck` (`TS2322`). `pnpm add` wrote no `minimumReleaseAgeExclude`, and `pnpm-lock.yaml` holds one `wrangler@4.152.0` and one `miniflare@5.20261019.2-beta`. `vitest.config.ts` limits `test.include` to `test/**/*.test.ts`: without it Vitest collected 28 files from the design tools and kit fixtures.

> **Verified:** 2026-10-27 | §3 | 654540ec56df05a03ea42ced1b95ad2baf0db89c
> **Review:** `docs/reviews/d00-t01-s3.json`

## 4. GitHub Actions CI

> **Started:** 2026-10-27T01:03:29Z

Every push runs the Worker gates and the TODO gates, so a stale plan or a failing test cannot reach `main` unnoticed. Actions are pinned to full commit SHAs.

**Phase:** 0
**Needs:** none
**Surface:** no

**Build order:**

1. Create `.github/workflows/ci.yml` running install, typecheck, lint, test, build and the TODO and tooling checks. Done when: the workflow passes on GitHub for the pushed commit.
2. Record the watched workflow for `scripts/ci_status.py` in `.conclave/ci.json`. Done when: `python3 scripts/ci_status.py` reports the workflow's latest verdict.

- [x] Create `.github/workflows/ci.yml` on `push` and `pull_request`, `runs-on: ubuntu-24.04` (Python 3.12 preinstalled, AGENTS.md needs 3.11 or newer), `permissions: contents: read`, with `actions/checkout` v7.0.1 (`persist-credentials: false`), `pnpm/action-setup` v6.1.0 (pnpm from `packageManager`) and `actions/setup-node` v7.1.0 (`node-version-file: .nvmrc`, pnpm cache) pinned to full SHAs, each with its tag in a comment. Done when: `grep -E 'uses: .+@[0-9a-f]{40}' .github/workflows/ci.yml | wc -l` equals the number of `uses:` lines. Cheaper substitute: `@v4` tags, which can move under us. **Corrected 2026-10-27:** "Node 24" would install the newest 24.x, but `engineStrict` with `engines.node` `>=24.18.0` (D00 T01 §2) makes `.nvmrc` the one source; the runner image and token scope were unpinned.
- [x] Add steps `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm lint`, `pnpm test` and `pnpm build` to `ci.yml`. Done when: each step appears and the run log shows each one green. **Corrected 2026-10-27:** `pnpm build` (the dry-run bundle, a documented gate since D00 T01 §2) was missing.
- [x] Add steps `python3 scripts/todo-graph.py validate`, `python3 scripts/todo-graph.py plan --check`, `python3 -m unittest discover -s tests/scripts` and `python3 -m unittest discover -s scripts/tests` to `ci.yml`. Done when: the run log shows each step green on `main`; `python3 scripts/todo-graph.py plan --check` exits non-zero on a stale plan in a scratch copy (it exits 2, the validator's refusal code; **Corrected 2026-10-27:** this said 1); and a throwaway branch `ci-probe-red` whose only change is a failing assertion in `test/health.test.ts` makes the run conclude `failure` at `pnpm test` with the later steps skipped, after which the branch is deleted. **Corrected 2026-10-27:** a stale plan cannot be committed without bypassing `scripts/hooks/pre-commit`, which `AGENTS.md` forbids; the probe proves a red step fails the run, and the scratch copy proves `plan --check` goes red on staleness.
- [x] Create `.conclave/ci.json` with `{"workflows": ["ci.yml"]}`. Done when: `python3 scripts/ci_status.py --json` names `ci.yml` with `verdict` `green` and `verdict_run.headSha` equal to the pushed section commit, and, before the probe branch is deleted, `python3 scripts/ci_status.py --json --branch ci-probe-red` exits 1 with `verdict` `red` and the failed test job in `failed_jobs`. **Corrected 2026-10-27** (plan review P2): exit 0 alone also means no completed run at all (`report()` in `scripts/ci_status.py` exits 0 unless a verdict is `red`).
- [x] Add the CI badge for `.github/workflows/ci.yml` to the badge row in `README.md`, first in the row as in Isotone. Done when: the badge renders the workflow's status on GitHub. Cheaper substitute: a badge for a workflow that does not exist yet.
- [x] Add `tests/scripts/test_ci_workflow.py` (standard library): `.github/workflows/ci.yml` triggers on `push` and `pull_request`, has a read-only token, pins every action to a full SHA with its tag, gives every job `timeout-minutes`, runs the frozen install, every `package.json` gate (as `test_worker_gates.py` defines them), validate, plan check and both suites, reads no secret, never deploys or serves, and `pnpm build` stays a dry run. Done when: it failed on the single-job workflow (`job gates has no timeout-minutes`) and passes now, and its planted defects (a tag pin, a dropped trigger, a write token, a missing timeout, a dropped or commented-out gate, a new `lint` script, a secret, a deploy, a real-deploy `build` script) each fail. (Completion review 2026-10-27, missing in scope.)
- [x] Split `ci.yml` into four jobs (`worker`, `todo`, `project-scripts`, `kit-scripts`) so `gh run rerun --failed` repeats only the group that failed, each with `timeout-minutes` well above its measured time on run 40431354712 (Worker gates 25 s: 10; TODO graph 1 s: 5; project tests 144 s: 15; kit tests 34 s: 10) and far below the six-hour default. **Corrected 2026-10-27** (final review P3): this said "about five times", which the numbers contradict. Done when: a push run on `main` shows four jobs, each `success`. Cheaper substitute: one job with the runner's six-hour default, which a hung Chromium holds for hours. (Completion review 2026-10-27, in-scope excellence item, and an out-of-scope one taken here because the section does not fix the job layout.)
- [x] Harden `tests/scripts/test_ci_workflow.py`: refuse any `if:` or `continue-on-error:`, any key under `push:` or `pull_request:` (branch or path filters), any `secrets` reference, a missing `typecheck`, `lint`, `test` or `build` script, and a `build` script that is more than `wrangler deploy --dry-run [--outdir <dir>]`. Done when: planted `if: false`, step and job `continue-on-error: true`, `branches: [main]`, `paths-ignore`, `secrets['T']`, a removed `build` script and `wrangler deploy --dry-run && wrangler deploy` each fail it, and the real workflow passes. (Final review 2026-10-27: P1 skipped or ignored gates, P2 narrowed triggers, P2 a removed required script, P3 secret and build spellings.)
- [x] Pin Python 3.12 with `actions/setup-python` v7.1.0 (`6d4fd22b20465ccc0f7354476588e8df7c9ca0e0`) in the three Python jobs. Done when: a push run on `main` shows all four jobs `success` with the pinned interpreter. (Final review 2026-10-27, P3.)
- [x] Prove the red path on the four-job layout. Done when: a throwaway `ci-probe-red` branch failing `test/health.test.ts` concludes `failure` with `Worker gates` failing at `pnpm test` and `pnpm build` skipped, `python3 scripts/ci_status.py --json --branch ci-probe-red` exits 1 naming `Worker gates`, and the branch is deleted. (Final review 2026-10-27, P2: the first probe ran on the superseded single job.)
- [x] Stop git auto maintenance in the git fixtures of `tests/scripts/test_todo_graph.py`, `tests/scripts/test_campaign_guard.py` and `tests/scripts/test_pre_commit_hook.py` (`maintenance.auto false` after `init`). Done when: `GIT_TRACE=1` on a fixture-style commit shows no `git maintenance run`, and the three suites pass. Found by the four-job red probe: `Project script tests` also failed there, in `test_todo_graph.Stamp.test_the_schedule_check_needs_no_temporary_directory` (`OSError: Directory not empty: .git/objects/pack` in `tearDown`), because the runner's newer git detaches auto maintenance after a commit and it can still be repacking when the temporary repository is removed; local git 2.43 runs it in the foreground, so the race never showed here.
- [x] Commit: `ci: run Worker and TODO gates on every push`

**Test checkpoint:** `gh run list --workflow ci.yml --branch main --event push --limit 5 --json headSha,status,conclusion,url` holds a run whose `headSha` is the section's pushed commit with `status` `completed` and `conclusion` `success` (its URL recorded here), and the `ci-probe-red` run concluded `failure`. **Corrected 2026-10-27** (plan review P2): the latest run on any branch, for any commit, could pass the check while the candidate stayed untested.

Evidence 2026-10-27 03:19 SAST. Green: push run https://github.com/rizonetech/isitlegit/actions/runs/40431354712 on `main` at `4838d28e594f9781e54693fbeed693d9e94585c2`, `completed` / `success`, every step `success` (install, typecheck, lint, test, build, validate, plan check, both Python suites); `python3 scripts/ci_status.py --json` exits 0 with `ci.yml` `green` at that SHA. Red probe: branch `ci-probe-red` (only change: `toBe(201)` in `test/health.test.ts`) ran https://github.com/rizonetech/isitlegit/actions/runs/40431749111, `failure` at `pnpm test` with build and every later step `skipped`; `python3 scripts/ci_status.py --json --branch ci-probe-red` exited 1, `verdict` `red`, `failed_jobs` naming `gates`; the branch was then deleted (`git ls-remote --heads origin` lists only `main`). Stale plan: in a scratch clone, `plan --check` printed `plan current` (exit 0), then with one row edited `TODO refused: stale projection: todo/implementation-plan.md; run plan --sync` (exit 2). Badge: `https://github.com/rizonetech/isitlegit/actions/workflows/ci.yml/badge.svg` serves `image/svg+xml` reading `passing`. Two reds on the way, fixed at their layers: a depth-1 checkout hid stamped commits from `validate` (`fetch-depth: 0`), and the image's `/usr/bin/chromium` has no usable sandbox (`MOCKUP_CHROMIUM=/usr/bin/google-chrome` for the mockup tests, which the test helper now honours).

Evidence 2026-10-27 03:27 SAST, after the completion review: push run https://github.com/rizonetech/isitlegit/actions/runs/40432358282 on `main` at `80329ce6010407c91303e0078736129d6cdd4b7c` concluded `success` with four jobs, each `success` (Worker gates 29 s, TODO graph 4 s, Kit script tests 38 s, Project script tests 2 min 14 s, run in parallel); `python3 scripts/ci_status.py --json` exits 0 with `ci.yml` `green` at that SHA; `tests/scripts/test_ci_workflow.py` failed on the single untimed job and passes on the four timed ones.

Evidence 2026-10-27 03:40 SAST, after the final review: push run https://github.com/rizonetech/isitlegit/actions/runs/40433218172 at `637bfa2e82d3b3a41fe754505c7e5a0218dd4325`, four jobs `success` with Python pinned. Red probe on the four-job layout: https://github.com/rizonetech/isitlegit/actions/runs/40433479224, `failure`, `Worker gates` failed at `pnpm test` with `pnpm build` skipped, `Kit script tests` and `TODO graph` green, `Project script tests` red from the maintenance race fixed above; `ci_status.py --json --branch ci-probe-red` exited 1, `verdict` `red`, `failed_jobs` naming `Project script tests` and `Worker gates`; branch deleted.

> **Verified:** 2026-10-27 | §4 | 7e61fa40c8f8ba2e7ba15488f4b2ff079fed07cc
> **Review:** `docs/reviews/d00-t01-s4.json`

## 5. Cloudflare bindings and first deploy

> **Started:** 2026-10-27T06:30:22Z

The Worker needs D1 for cases and tenants, R2 for raw mail and artefacts (with a 30-day lifecycle on `raw/` for POPIA), KV for caches, a Workflow for the pipeline and Browser Run for rendering (stack doc "Platform services"). Resource creation and the first deploy are covered by the operator's standing authorisation for IsItLegit resources (design spec section 11, `AGENTS.md` Safety; **Corrected 2026-10-26:** this section needed `attended` before that authorisation).

**Corrected 2026-10-27** (plan review: 2 P1, 1 P2): the lifecycle rule covered `raw/` while D01 T01 §2 stored attachments under `art/`, though the design spec (POPIA) deletes raw messages and attachments after 30 days; attachments now live under `raw/` too (D01 T01 §2 corrected), so the one rule covers both and is read back. The deployed checkpoint read only `/health`, which passes with no working binding; a token-guarded smoke route now exercises every binding on the deployed Worker. And the deploy needs a clean, pushed `HEAD`, so the order is gates, commit, push, deploy, verify.

**Phase:** 0
**Needs:** cloudflare
**Surface:** no

**Build order:**

1. Create the D1 database, R2 bucket and KV namespace. Done when: `wrangler d1 list`, `wrangler r2 bucket list` and `wrangler kv namespace list` show `isitlegit`, `isitlegit-artefacts` and `isitlegit-cache`.
2. Add the bindings and a stub `AnalysisWorkflow` to `wrangler.jsonc` and `src/`. Done when: `pnpm typecheck` passes with the generated binding types.
3. Deploy and read back `/health`. Done when: the deployed `/health` returns the commit just pushed.

- [x] Create D1 database `isitlegit` with `wrangler d1 create`. Done when: `wrangler d1 list` shows it and its id is in `wrangler.jsonc` as binding `DB`.
- [x] Create R2 bucket `isitlegit-artefacts` with `wrangler r2 bucket create`. Done when: it is bound as `ARTEFACTS` in `wrangler.jsonc`.
- [x] Add an R2 lifecycle rule deleting objects under `raw/` after 30 days, which holds the raw message and its attachments (design spec 4.8, POPIA; D01 T01 §2 writes attachments to `raw/<caseId>/attachments/`). Done when: `wrangler r2 bucket lifecycle list isitlegit-artefacts` reads back one enabled rule with prefix `raw/` and expiry 30 days. Cheaper substitute: a cleanup cron in the Worker, which fails silently when the Worker is broken.
- [x] Create KV namespace `isitlegit-cache` and bind it as `CACHE`. Done when: `wrangler kv namespace list` shows it and `wrangler.jsonc` holds its id.
- [x] Add a stub `AnalysisWorkflow` class in `src/pipeline/analysis-workflow.ts` with one no-op step, exported from `src/index.ts` and bound as `ANALYSIS` (`workflows`: name `isitlegit-analysis`, `class_name` `AnalysisWorkflow`). Done when: `pnpm typecheck` passes with the binding type.
- [x] Add the Browser Run binding `BROWSER` to `wrangler.jsonc`. Done when: `wrangler types` emits `BROWSER: BrowserRun`. (**Corrected 2026-10-27:** said `Fetcher`; Wrangler 4.152 types the binding `BrowserRun`.)
- [x] Prove each binding from inside the Worker: `test/bindings.test.ts` (the `worker` project, in workerd) runs `select 1` on `DB`, puts, reads and deletes an object under `test/` in `ARTEFACTS`, puts and reads a key in `CACHE`, and creates an `ANALYSIS` instance that completes its no-op step; `BROWSER` is bound, and `test/smoke.test.ts` launches and closes a session through Miniflare's local Browser Run. Done when: the test passes and fails when a binding is removed from `wrangler.jsonc`. (**Corrected 2026-10-27:** the section proved the bindings only by listing commands, which pass for a binding the Worker cannot use.)
- [x] Add `@cloudflare/puppeteer` 1.4.0 (the stack doc's Browser Run driver) and a smoke route `GET /internal/smoke` in `src/smoke.ts`, answering 404 unless the request's bearer token equals the `SMOKE_TOKEN` secret (compared in constant time; 404 too when the secret is unset), that runs each binding once with synthetic data and cleans up: `select 1` on `DB`; put, read and delete `smoke/<uuid>` in `ARTEFACTS`; put, read and delete a key in `CACHE`; create an `ANALYSIS` instance and wait up to 30 s for it to complete; launch and close a `BROWSER` session; it answers JSON naming each check `ok` or its error, with the commit, and `503` if any failed. Done when: `test/smoke.test.ts` (workerd) finds 404 without a token, with a wrong one and with a malformed header, and every check `ok` with the local bindings, Browser Run included (**Corrected 2026-10-27:** said every check but the browser; Miniflare simulates Browser Run with a local Chrome).
- [x] Write `scripts/smoke.ts`: it mints a random token, sets it with `wrangler secret put SMOKE_TOKEN` (from standard input, never printed or stored), calls the deployed `/internal/smoke`, prints each check's result, and exits non-zero on a refused call or any failed check. Done when: `test/node/smoke-script.test.ts` proves it against a local stand-in (a fresh 64-hex token that never appears in its output, a failed check named, a Worker that never accepts the token, any other answer, and retrying a 404 while the secret propagates), and run against the deployment it reports every check `ok`.
- [x] Deploy in this order: the gates green (`pnpm typecheck`, `pnpm test`, `wrangler types --check`), the work committed and pushed, the tree clean (`git status --porcelain` prints nothing), then `wrangler deploy --var COMMIT_SHA:$(git rev-parse HEAD)`. Done when: `curl -s https://isitlegit.derick-f5a.workers.dev/health` answers 200 with that SHA, and `node scripts/smoke.ts` reports every binding `ok` on the deployed Worker. **Corrected 2026-10-27** (D00 T01 §2 final review P3): a deploy from a tree with uncommitted edits would report a commit that is not the code it serves.
- [ ] Commit: `infra: Cloudflare bindings, R2 lifecycle and first deploy`

**Test checkpoint:** `curl -s https://isitlegit.derick-f5a.workers.dev/health` returns `"ok":true` with the SHA of `git rev-parse HEAD`, and `node scripts/smoke.ts` reports `DB`, `ARTEFACTS`, `CACHE`, `ANALYSIS` and `BROWSER` all `ok` on the deployed Worker (**Corrected 2026-10-27:** `/health` alone passes with no working binding).

Evidence 2026-10-27 08:55 SAST. Account "Derick@rizonetech.com's Account": D1 `isitlegit` (WEUR), R2 `isitlegit-artefacts` with `raw-30-days` (enabled, prefix `raw/`, expire after 30 days) beside the default multipart-abort rule, KV `isitlegit-cache`. `wrangler deploy --var COMMIT_SHA:6cd7ab7...` from a clean tree whose `HEAD` was pushed and green in CI (run 40462504039): `https://isitlegit.derick-f5a.workers.dev/health` answered `200 {"ok":true,"commit":"6cd7ab749adf3472c6f5c654d1eecc93b5d6b633"}`; `/internal/smoke` without a token answered 404; `node scripts/smoke.ts https://isitlegit.derick-f5a.workers.dev` printed `DB: ok`, `ARTEFACTS: ok`, `CACHE: ok`, `ANALYSIS: ok`, `BROWSER: ok` and exited 0. `pnpm test`: 18 files, 151 tests; removing the R2 binding from `wrangler.jsonc` fails 2 of the bindings and smoke tests.

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
- [x] Write `tests/scripts/test_readme_brand.py`: the banner decodes in full at 1280 by 640; the README `<picture>` maps `prefers-color-scheme: dark` to `isitlegit-logo-on-dark.svg`, light to `isitlegit-logo.svg`, and its `<img>` falls back to the light logo with alt `IsItLegit`; every file it names exists and parses as SVG. Done when: it passes, and planted defects (a banner cut after its header, swapped theme sources, a missing logo) each fail it. **Corrected 2026-10-27 (plan review P2):** the checkpoint read only the PNG header and one filename, so it passed on a truncated banner or reversed themes. **Corrected 2026-10-27 (final review P2s):** "decodes in full" overstated a header-and-inflate check; the banner is now checked as a structurally sound PNG (legal IHDR first, every CRC, PLTE where needed, nothing after IEND, image data inflating to exactly its rows, interlaced included, with bounded reads and inflate); the `<picture>` is read as a browser picks (first matching `<source>` before the `<img>`); each logo must be an SVG-namespace `<svg>` painting only the colours `design/tools/build-brand.py` gives it (ink and orange, white and orange); a README path outside the repository is refused unread. Evidence 2026-10-27 02:15 SAST: 16 local tests pass with no site packages (`python3 -S`), including planted defects for a truncated banner, a flipped IDAT byte, a zlib bomb, a short IHDR, swapped theme sources, an `<img>` before its sources, an earlier wrong dark source, swapped logo files, a dropped SVG namespace, paths outside the repository, and an undecodable or missing README.
- [x] Read back the live social preview: `openGraphImageUrl` from the GitHub GraphQL API, downloaded and decoded, matches `design/brand/web/github-banner.png` in size and with no pixel off by more than 8 levels in any channel. Done when: `LIVE_CHECKS=1` runs the live test in the same file and it passes; without the variable it is skipped. **Corrected 2026-10-27 (final review P2s):** a mean under 4 passed a stale banner differing in a small area; the repository is now read from `gh repo view`, not hard-coded, and the download is capped. Evidence 2026-10-27 02:15 SAST: `LIVE_CHECKS=1` passes (GitHub serves the banner pixel for pixel, worst difference 0); a 41 by 41 pixel patch on the local banner fails it at 222 levels.
- [x] Render the repository page in headless Chromium in the light and the dark colour scheme and record which logo each shows. Done when: both screenshots are inspected and the result is written here as evidence. Evidence 2026-10-27 01:55 SAST: at github.com/rizonetech/isitlegit, the light scheme shows `isitlegit-logo.svg` (ink IsIt and question mark) and the dark scheme shows `isitlegit-logo-on-dark.svg` (white IsIt and question mark), orange Legit and tick in both; the page chrome switched theme with them.
- [x] Commit: `brand: README wordmark and social preview banner`

**Test checkpoint:** `LIVE_CHECKS=1 python3 -m unittest tests.scripts.test_readme_brand` passes with no test skipped. **Corrected 2026-10-27 (plan review P2):** it was a PNG header read and a filename count.

> **Verified:** 2026-10-27 | §8 | 716e9ef5301c3aa1d1ad22f54cda4fc269a060a9
> **Review:** `docs/reviews/d00-t01-s8.json`

## 9. Red CI refused when a section starts

Filed 2026-10-27 from the D00 T01 §4 completion review (gap 3, missing out of scope). The rule that a red `main` comes before any new row lives in the `process-phase` skill and the heartbeat prompt: an agent that skips reading `scripts/ci_status.py` can still claim a row while CI is red. This section makes the refusal mechanical at the point a section starts.

**Phase:** 7
**Needs:** none
**Surface:** no

**Build order:**

1. Make `python3 scripts/todo-graph.py resolve` report a red `main` for an open section. Done when: `resolve` on a ready section exits non-zero with the red workflow and run URL while `scripts/ci_status.py` reports red.
2. Prove the refusal and its escape. Done when: tests cover red, green, unknown and the documented override.

- [ ] Add a CI gate to `resolve` in `scripts/todo-graph.py` that calls `scripts/ci_status.py --json` for an open, otherwise-ready section and exits 5 (a new code, documented in the `--help` text and `todo/README.md`) when any watched workflow on `main` is `red`, printing the workflow, commit and run URL. Done when: with a stubbed `gh` reporting red, `resolve` on a ready section exits 5 and names the run; green exits 0 as today. Cheaper substitute: a reminder line in the skill text, which is what exists now.
- [ ] Treat an unknown CI state (`ci_status.py` exit 3, no `gh`) as a printed warning, not a refusal, so offline and unauthenticated sessions still work. Done when: a test with `gh` missing shows `resolve` exits 0 with a `ci unknown` warning on stderr.
- [ ] Add `--allow-red '<reason>'` to `resolve` for the section that repairs the red itself, recording the reason in the section's `Started:` note. Done when: a test shows `--allow-red` exits 0 on red and the reason is required.
- [ ] Add the tests to `tests/scripts/test_todo_graph.py` with a stubbed `gh` on `PATH`. Done when: each case above fails if its branch in `resolve` is removed.
- [ ] Update `process-todo-section` step 0's exit table and `todo/README.md` "Commands" for exit 5. Done when: both name exit 5 and `--allow-red`.
- [ ] Commit: `todo: resolve refuses a new section while main is red`

**Test checkpoint:** `python3 -m unittest tests.scripts.test_todo_graph` passes, including a red case that exits 5 and an unknown case that exits 0 with a warning.

## Verification

- A clean clone runs `pnpm install --frozen-lockfile && pnpm typecheck && pnpm lint && pnpm test` to green, and CI shows the same on `main`.
- The deployed `/health` returns the SHA of `main`.
- The smoke-test record shows Spark, SAM 3.1 and Wonder working through the gateway, or a named fallback for any that failed.
- `python3 scripts/todo-graph.py validate` and `python3 scripts/todo-graph.py plan --check` pass.
