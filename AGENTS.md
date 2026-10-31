# AGENTS.md

Agent instructions for this repository. Claude Code loads this file through the `CLAUDE.md` stub; the Codex reviewer reads it directly.

## What is here

IsItLegit (`isitlegit.co.za`) is Rizonetech's phishing, invoice-fraud and impersonation checker for small businesses, built for the Meta Global AI Developer Hackathon (Startup track, 26 Oct to 4 Nov 2026). Members forward a suspicious email to `check@isitlegit.co.za` or upload it (an email, a document, a screenshot or a voice note), and get a verdict with cited evidence; registered businesses also get a trust network (verified identity, impersonation alerts, closed-loop bank verification). One Cloudflare Worker in TypeScript, Meta models for vision, reasoning, segmentation, computer use and speech.

| Path | Purpose |
| ---- | ------- |
| `docs/specs/2026-10-26-phishing-invoice-analyser-design.md` | Product design: the governing spec (sections 1 to 10) |
| `docs/specs/2026-10-26-tech-stack-design.md` | Services, libraries, versions, secrets, repo layout |
| `docs/plans/2026-10-26-phishing-invoice-analyser.md` | Day-by-day build plan the TODO tree executes |
| `docs/manifesto.md` | Derick's manifesto: the quality bar every change is held to |
| `docs/hackathon-criteria.md` | The event rules and judging criteria as checks: apply them to every section, commit and demo decision |
| `design/SPEC.md` | Interface source of truth: every page, its controls and states, linked to its approved board |
| `design/mockups/` | Approved boards: `png/` to look at, `source/` for exact values, `coverage.json` for required controls and states |
| `design/tokens/` | Colour (both themes, tested contrast), type and spacing tokens |
| `todo/` | Live execution plan (`README.md`, generated plan) |
| `src/`, `site/`, `test/`, `eval/` | Worker, Astro site, tests, eval harness (layout: stack doc) |
| `scripts/` | TODO graph, review dispatch, run guard; stdlib Python |
| `tests/scripts/` | Tests for the tooling in `scripts/` |
| `.claude/` | Agent kit: skills, rules, read-only subagents |
| `.conclave/` | Reviewer pin |
| `sources/`, `competitors/` | Local research captures and competitor profiles, git-ignored: never published |
| `samples/` | Real client mail, git-ignored: never committed, never in fixtures, eval, demo or Discord |

## The bar

Read [docs/manifesto.md](./docs/manifesto.md) before any work. Its first priority is to push the boundaries of what Meta's models can do: every model does what only it can do, chained into one investigation, with its contribution measured by ablation in the eval and shown in the model trace. IsItLegit is held to the standard of the best product in its field, whoever built it, and the most demanding person who examines it should finish asking how it was done this well. "It works" is the start of a section, not its end; its Standards (security and privacy, reliability, measured quality, experience, engineering craft) are review criteria. Inside the ten-day build, scope is cut before quality.

## Who writes and who reviews

Opus 5.5 (`claude-opus-5-5` through Claude Code) is the only writer: code, tests, the plan and docs. Subagents that write run on Opus 5.5; Sonnet or Haiku run only read-only helpers whose output the main session verifies. GPT-6 Astra through the Codex CLI, in its read-only sandbox, runs every plan, completion and regular review round: it reads this file and never edits the repository. Astra has two more jobs for the Loupe page screener (D03 T04), both outside the repository. It runs collection jobs (operator, 2026-10-28 15:16 SAST) through `scripts/astra-collect.py`: `codex exec --sandbox workspace-write` with network access, rooted at the Glimmer data store (`GLIMMER_DATA_DIR`, default `~/isitlegit-data/glimmer`), never in the repository, following the brief in `docs/glimmer/astra-collection-brief.md`. It judges disputed labels and sorts the tuned model's misses through `scripts/astra-judge.py` at `xhigh` in its `read-only` sandbox (operator, 2026-10-28 15:31 SAST). Claude writes the brief and every script and verifies all data Astra collects; Astra never reviews data it collected. A page derived from the sample mail reaches Astra only when redacted (consent extended 2026-10-28 15:34 SAST). `.conclave/reviewers.toml` pins it with the schedule `scripts/review-dispatch.py` applies to every pass: a plan review before the build and a completion review after it (medium), round 1 at high across adversarial, integration, source-defect and plan-delivery, round 2 adversarial at medium, round 3 adversarial at low, then one low lens per round; the first round with no `P1` or `P2` finding ends the loop. Tooling adopted from Rizonetech's Recto repository through the Conclave-SDK `base`, `todo` and `reviewer` kits on 2026-10-26; it is development process, not product code, and `CONTRIBUTIONS.md` says so. After the rounds stop, Muse Wonder Full (`muse-wonder-full-1.0` through Muse Code, `[schedule.final]` in the pin, medium effort) gives each section one final review; a P1 or P2 it finds is fixed and proven by one more Astra round, and it is never repeated. Its `mode` in the pin switches it: `required`, `optional` (an outage only warns and the stamp may go without it) or `off` (it never runs and the stamp takes none); it is `off` since 2026-10-27 (operator), and turning it back on is a one-line change there. Muse Code review calls run on the operator's Muse Code subscription with `--contributor-mode off`, not on Model API credit, so the `Meta credit visible:` gate does not apply to them (operator, 2026-10-26 23:03). Every review runs alone: nothing in the working tree changes while a reviewer reads it, and the dispatcher is launched with the Bash tool's `run_in_background` option (`CLAUDE.md`).

## The TODO system

Plan and build through the TODO system in [docs/todo-workflow.md](./docs/todo-workflow.md); format spec: `todo/README.md`. Markdown is canonical. Domains: `00-workspace`, `01-intake`, `02-checks`, `03-vision`, `04-agent`, `05-trust`, `06-invoice`, `07-app`, `08-eval`, `09-launch`, `99-manual` (operator only). Phases (names in `todo/plan.json`) follow the build plan's days, 0 (Mon 26 Oct) to 6 (Sun 1 to Wed 4 Nov), 7 after the event, 99 manual.

A row flips to `[x]` only through `python3 scripts/todo-graph.py stamp`, backed by a review receipt in `docs/reviews/`; `todo/implementation-plan.md` is regenerated by `plan --sync`, never edited by hand. Use the skill that owns the step: `add-todo`, `create-todo`, `process-todo-section`, `review-todo-section`, `process-todo-file`, `process-phase`, `process-plan`, `groom-plan`. Lifecycle: capture, author, validate, plan review (gaps fixed in the section before code), record `Started:`, implement, gates, commit, completion review, review rounds and stamp, sync the plan.

`frozen: true` marks a TODO file that touches the safety contract below; each of its sections carries a `**Freeze check:**` naming the tests that must not move.

## Parallel lanes

The plan is worked by four lanes, split by domain (operator, 2026-10-30; `docs/specs/2026-10-30-four-lanes-design.md`), each its own branch in its own worktree, worked by its own session. `todo/lanes.json` names each lane's branch, worktree and the domains (`DNN`), TODO files and single sections (`DNN TNN §N`) it alone claims; a listed section beats a listed file, which beats a domain, and every domain no lane names is main's. A section moves lanes by being listed, never by being renumbered, so every ref that names it still resolves (the upload page, D01 T03 §6, is the app lane's since 2026-10-31).

| Lane | Branch | Worktree | Domains |
| ---- | ------ | -------- | ------- |
| main (the coordinator) | `main` | `../isitlegit-main` | D00, D99 (cores 0 and 1) |
| `checks` | `checks-lane` | `../isitlegit` | D01, D02, D04, and D08 T01 §1 by section (cores 6 and 7) |
| `app` | `app-lane` | `../isitlegit-app` | D07, and D01 T03 §6 by section (cores 8 and 9) |
| `glimmer` | `glimmer-screener` | `../isitlegit-glimmer` | D03 (cores 4 and 5) |
| `walkthrough` | `walkthrough-lane` | `../isitlegit-walkthrough` | D04 T02 §1 to §6 (walkthrough agent), D03 T03 §1 to §4 (SAM logos), by section (core 2) |
| `trust` | `trust-lane` | `../isitlegit-trust` | D05 (trust network), D06 (invoices) (core 3) |
| `eval` | `eval-lane` | `../isitlegit-eval` | D08 (eval), D09 (launch) (shares cores 0 and 1 with main) |
| `console` | `console-lane` | `../isitlegit-console` | D07 T04 §2 to §12 (member console), D07 T05 §1 and §2 (admin console), D07 T08 §1 to §7 (app essentials), by section (shares cores 8 and 9 with app) |
| `site` | `site-lane` | `../isitlegit-site` | D07 T06 §1 to §8 (marketing site), D07 T07 §1 and §2 (demo organisations), by section (shares core 3 with trust) |
| `media` (uncoordinated) | `claude/trusting-pasteur-umwvqz` | `../isitlegit-media` (VS Code since 2026-10-31; a cloud session before) | D10 |

- Three lanes added by the operator on 2026-10-31 to speed the build (walkthrough, trust, eval). The machine (10 cores, 17 GB) holds seven sessions only when each lane runs its own section's tests locally, pinned to its cores (`taskset -c <cores>`), and leaves full suites to GitHub CI (three Worker shards, about 8 minutes); the coordinator's merge gates run in CI too.
- Two more lanes added by the operator on 2026-10-31 (console and site), split from the app lane's backlog, after the 15:57 SAST machine crash. Every lane runs from a plain terminal (`cd ~/isitlegit-<lane> && claude`), never its own VS Code window, and WSL runs without the 8 GB `/swapfile` (the 2 GB `.wslconfig` swap only), so the guest can never outgrow what Windows can give it.
- The coordinator owns `main`: it merges the lanes, owns CI, deploys, the shared tooling (`scripts/`, `scripts/hooks/`, `.claude/`, `.conclave/reviewers.toml`), migration numbers, the machine and the manual list (`query manual`: every lane's rows waiting on the operator or a paid or attended environment, each prepared to the step only the operator can take). It builds no product section.
- Claiming: `query lane` names this checkout's lane (it follows the checked-out branch; `TODO_LANE` overrides it). `query ready`, `query blocked` and `query stats` count only the lane's rows (`--all` the whole plan, `--phase N` one phase), and `resolve` gives another lane's ready row exit 4 with a `lane_note`. Which rows are ready, and the generated plan, are the same on every branch.
- Editing: a lane changes its own TODO files, its own new code and its own data. Cross-lane work is asked for, not done: a lane that needs another lane's row, an XREF in another lane's file, or a change to shared tooling asks through the coordinator.
- Dependencies: a lane row that depends on another lane's row waits until that row is stamped and merged into the lane through `main`.
- Merging: only the coordinator merges into `main`, at a lane's stamp boundaries, with every gate green on the merge. The merge's gates run in GitHub CI, not on this machine (operator, 2026-10-31): the coordinator pushes the merged tip to the `coordinator-gate` branch (a fast-forward, never a force-push), and `main` moves to that same commit only after its CI run is green on every job, the three Worker shards included; locally it runs only `validate`, the build and the local migrations. A lane merges `origin/main` into its branch at its own boundaries and tells the coordinator (a merge, never a rebase or a force-push). The uncoordinated `media` lane merges `origin/main` before each push too: CI runs every gate on every branch, so a branch left on an old `main` reruns old code and goes red on failures `main` has already fixed (2026-10-31). The generated plan never conflicts (D00 T01 §22): a merge that changes `todo/` or `docs/reviews/` stops with `run 'git commit --no-edit' to validate it and regenerate the plan`, and that one command concludes it, `pre-commit` validating both parents and regenerating the plan; a merge with another conflict concludes the same way once that file is resolved and staged. Every stamp is announced to the coordinator with its commit.
- Migration numbers: the coordinator hands out the next D1 migration number before a lane writes one.
- Spend: every checkout spends Meta credit through one ledger outside the repositories, `~/isitlegit-data/ledgers/meta-spend.json` (`metaLedger()` in `scripts/meta-smoke.ts`; `ISITLEGIT_LEDGER_DIR` moves it), so spec 11's Meta caps hold across lanes; a checkout's old `build/meta-smoke-spend.json` is moved into it on first use. Lane data stays outside the repositories as well (`~/isitlegit-data/`). Loupe's training store, every page it trains on with its labels, sources and manifest, is `~/isitlegit-data/glimmer` (`GLIMMER_DATA_DIR` moves it; `storeDir()` in `scripts/glimmer/store.ts`); the monitor's labelled findings flow into it (D05 T04 §10) for Loupe's next version, and the glimmer lane's retraining reads it from there.
- Machine: 10 cores and 17 GB, with `/tmp` memory-backed. Glimmer's long runs keep cores 4 and 5, the checks lane pins its tests to `taskset -c 6,7`, the app and console lanes to `taskset -c 8,9`, the site lane to `taskset -c 3` (with trust), and the coordinator uses what is left, lightly. One whole Worker suite at a time across the machine; otherwise a lane runs only its targeted tests. Check free memory first (`free -m`; wait below about 3000 MB). Tests remove every folder they make.
- Waiting: a lane run whose only work waits on another lane's rows waits instead of ending (D00 T01 §20): `campaign_guard.py wait` records the rows, and each heartbeat's `wake` fetches `main`, merges it into the lane through the plan's merge stop, backs out any failure for a retry, and resumes the run on `READY` with no prompt. Leftovers that wait on a person or an unreachable host still park.
- Campaign runs: each lane runs its own guard and heartbeat from its own worktree (`build/` is per worktree), and never ends or edits another's. The guard pins a run to the lane it was acquired in, and its run files are named `docs/phase-runs/<YYYY-MM-DD>-<lane>-phase-<N>.md`.
- Model providers: the product calls Meta's Model API and Fireworks AI only (operator, 2026-10-28); Baseten and Modal are closed.

## The safety contract (frozen)

From the design spec sections 4.4a, 4.6, 4.6a and 2a. A change that needs to break one records the correction in the spec first, dated, with the cost of reversing it.

- **Deterministic floor.** Critical evidence (bank details changed, credential form on a lookalike domain, malware-type attachment) caps the verdict at suspicious or malicious whatever the model says. The model can raise severity, never lower it below the floor.
- **Evidence or nothing.** Every claim in a verdict cites an existing Evidence ID; a verdict citing a missing ID is rejected, retried once, then replaced by the rule-based verdict.
- **Untrusted content stays data.** Email, PDF, page and transcript text reaches a model only inside delimited untrusted blocks, after hidden text has been extracted as evidence. No model decides who receives mail: recipients, subjects and templates come from code; the model fills validated fields only.
- **Every model output and tool argument passes a zod schema** before use; `tool_choice` is `auto` only.
- **The walkthrough is contained by the driver, not the model.** Muse Wonder gets at most 8 steps and 60 seconds, http(s) only, no downloads, and types only per-case canary values; every action is logged.
- **Meta Model API: Standard model IDs only, `store: false` on every call.** A `-contributor` ID anywhere fails a test.
- **Registered bank details are never revealed** to a checker: match or no match only. Counterparty checks are rate-limited per sender and per protected business.
- **A blocklist hit never decides a verdict alone**, and an IP listing never raises severity alone (spec 4.3a).

## Review failure modes

`review-todo-section` and `independent-review` check these for the area a change touches:

- A Meta model used below its capability: a call a regular expression or plain code could replace, a model output that feeds no later evidence or verdict, a model choice or reasoning effort with no recorded reason, or a model's contribution that the eval does not measure.
- Work below the bar in `docs/manifesto.md`: a placeholder, stub or "coming soon" in anything shown, an undesigned state or raw error, a claim without measured evidence, a silent failure or a step that is unsafe to retry, a regression in a design spec 4.9 target, a workaround reported as a fix, or a cheap improvement left undone.
- A breach of a hard rule in `docs/hackathon-criteria.md`: product code from before the event, an undeclared pre-existing file, a dependency, dataset or asset without a recorded licence, a Meta model used decoratively, or a demo or README claim the live service cannot back.

- A verdict lowered below the deterministic floor, or a claim that cites no Evidence ID or a missing one.
- Email, page, PDF or transcript text placed in a prompt outside an untrusted block, or a model output used as a recipient, URL, subject or header.
- A model output or tool argument used without zod validation, or a schema that silently coerces bad input.
- A walkthrough limit enforced by prompt instead of by the driver, or a real-looking credential typed instead of a canary.
- A Meta call without `store: false`, a `-contributor` model ID, or a secret in code, logs, fixtures or arguments.
- A registered bank account number, or any other registered identity detail, shown to someone who is not that business.
- Real client mail (anything under `samples/`, or any client's name, domain or address) in a fixture, eval file, screenshot, demo or log. `scripts/hooks/pre-commit` refuses a staged line or path that contains a name from the git-ignored `samples/client-names.txt`: the worktree's own, else the main checkout's, which serves every worktree of the clone (D00 T01 §24); `scripts/check-publication.py` finds the same list the same way (§25). A commit with no usable list is refused, never passed unscanned; a new clone needs the operator's list.
- A tenant reading another tenant's case, report, supplier or identity data; an unsigned or non-expiring report link.
- A third-party reputation hit treated as decisive, or an outage reported as "not listed".
- A failure path that reports success: a Workflow step that swallows an error, a reply sent without a stored case, a model outage that yields a verdict instead of a partial report.
- A file under `samples/` staged for commit.

Review lenses read against these sources: `adversarial` covers hostile mail, prompt injection, hostile landing pages, oversized input and races between Workflow steps; `integration` covers the Workflow steps, the R2 and D1 contracts, Email Routing, SMTP2GO and the Meta API; `source-defect` covers RFC 5322, RFC 2045 to 2049, RFC 7208 (SPF), RFC 6376 (DKIM), RFC 7489 (DMARC), RFC 8617 (ARC), the Cloudflare Workers, Workflows, Email Routing and Browser Run docs, the Meta Model API docs and the design spec.

## Interface rules

- `design/SPEC.md` wins over any screenshot, mockup or memory once it exists; until then the report, dashboard and site follow the design spec section 4.7 and the Rizonetech brand: Exo / Exo 2, orange `#FF4A14`, colours only from tokens.
- The Fidelity contract in `design/SPEC.md` decides what a surface must match (controls and states, structure, wording, tokens, accessibility) and what may differ (data and counts, numbers the plan sets, measurements within the token scale); a difference in a must-match item is built as a recorded `Deviation` or raised, anything else is not a finding.
- Build every surface to its approved board (operator approval 2026-10-26): the PNG in `design/mockups/png/` shows the target, the source in `design/mockups/source/` gives exact values, and `design/mockups/coverage.json` names each control and state the page must have or the section that owns it. Values come from `design/tokens/`; a board value between two token steps is built as the nearest step. A board change goes back to the operator, then `design/tools/export-mockups.py import --approve` and `export`, and `design/tools/check-design.py` must pass.
- Plain language first: a verdict, the top three reasons, what to do now. Evidence cards carry their screenshot, crop or header excerpt.
- Every page works at phone width; every icon-only control has an accessible name.

## Working rules

- Verify files, routes, schemas, tools and commands before relying on them. A path someone mentions is a hypothesis until it is on disk.
- Fix at the owning layer: a setting in its setting, behaviour in the code that produces it, data in the data. No output filters that hide a problem. Code changes end the report with a `Layer:` line.
- Tests prove claims: a section's Test checkpoint must be able to fail, and is quoted, not paraphrased, in its stamp. Model calls in tests are stubbed; no test spends Meta credit.
- Synthetic data only in the repository: fictional companies, fictional banks, public phishing corpora with their licences recorded in `eval/DATASETS.md`.
- Output discipline: bound every command; full logs go to scratch (`/mnt/r/scratch` on WSL, `R:\scratch` on Windows, or the session scratchpad).
- Writes are serial: one session owns the working tree. Check `git status` before building over unfamiliar work.
- Markdown prose is never hard-wrapped: one line per paragraph and per list item. Table rows stay `<= 100` characters; section titles, `Deliverable` cells and index scope cells `<= 88`.
- Never use em dashes or en dashes in anything written: prose, code, comments, commit messages, generated files.
- Commits: trunk-based `main`, concise imperative messages, the section ref in the body, no AI attribution lines. Never amend a candidate under review, never bypass hooks, never force-push. Every clone runs `git config core.hooksPath scripts/hooks` and `git config merge.todo-plan.driver true` (the plan's merge driver, D00 T01 §22; every worktree of a clone shares both).
- Credentials never enter tracked files, arguments or logs. The source of truth is the Conclave 1Password vault; Worker secrets go through `wrangler secret put`.

## Safety

- Local reversible work in the repository needs no confirmation.
- **Standing authorisation (operator, 2026-10-26 19:30, design spec section 11):** without asking, deploy the `isitlegit` Worker; create, migrate and configure its own D1, R2, KV, Workflow, AI Gateway and Browser Run bindings; change DNS records and Email Routing rules on the `isitlegit.co.za` zone only; configure the Cloudflare Access application for `/admin`; set GitHub Actions secrets in `rizonetech/isitlegit`. Never touch another zone, Worker, account or repository, and never delete a resource holding data without asking.
- Outbound mail goes only to registered members and Rizonetech-controlled test mailboxes (design spec section 11); the sender allowlist in code enforces it.
- **Live mail tests run without asking (operator, 2026-10-27):** send test mail from the Gmail connector (`rizonetech@gmail.com`, an outside sender) only to `isitlegit.co.za` addresses, and confirm arrival with the Microsoft 365 connector in `derick@rizonetech.com`, where `hostmaster@rizonetech.com` and every `isitlegit.co.za` forward deliver. Record each test with its subject, sender, time and `internetMessageId`. See `docs/live-checks.md`.
- **The operator's inbox for autonomous checks (operator, 2026-10-31):** every lane may read `derick@rizonetech.com` through the Microsoft 365 connector to finish live checks without asking: a probe's arrival, a reply's content, a forwarded alert, and GitHub's "Run failed" CI notifications (`notifications@github.com`, subject `[rizonetech/isitlegit] Run failed: CI - <branch> (<sha>)`; `scripts/ci_status.py` stays the source of truth). Read-only and narrow: search by the probe's own subject token, sender or the GitHub subject, read only the messages that match, and never quote, store or log any other message, a client's name or a mail header from it. Never send, reply, forward, move, flag, categorise or delete in that mailbox: test mail is sent from SMTP2GO (`alerts@isitlegit.co.za`) or the Gmail connector as above, and never through the operator's own account (the forwarding probe of D01 T02 §9 excepted from Gmail, operator 2026-10-30).
- Spend stays inside the code-enforced budget (design spec section 11); a run never raises a cap.
- Deploy with the local Wrangler login only after typecheck, lint, tests and `python3 scripts/check-publication.py` pass; CI never deploys. Apply the pending D1 migrations first (`pnpm db:migrate:remote`, then `wrangler d1 migrations list isitlegit --remote` reads "No migrations to apply"), so the code never runs against a schema behind it (**Corrected 2026-10-29:** deploys had skipped it and the live database stood at 0002 while the code expected 0019). Once D00 T01 §5 has shipped, every stamped section that changes `src/` or `site/` is deployed before the next section starts, so each day ends with the live service working end to end (build plan standing rules).
- If Codex hits a usage limit, keep implementing and committing ready sections, queue their reviews, retry every 30 minutes and stamp each section when its review returns. Nothing is stamped without its review.
- Ask the operator once before anything else that sends, deletes or changes something outside the repository: mail to real people, a resource outside the authorisation above, credentials.
- **Unattended runs never ask.** A section that cannot finish is parked with a dated note, its reason goes to `todo/findings.md`, a push notification goes to the operator only for a real blocker (an account, a credential, a spent budget, a provider outage longer than an hour), and the run continues with other ready work.
- Never send real client mail to the Meta Model API without that client's written consent. **One pilot client is on file (operator, 2026-10-27; D99 T02 §2, named only outside the repository):** Rizonetech manages that client's email security, Microsoft 365, websites and IT with permission to do what is needed to secure it, and the client asked for this problem to be solved. Its real mail may be used to develop and evaluate IsItLegit: it stays under the git-ignored `samples/`, goes to the Meta Model API only in Standard mode with `store: false` through the gateway (metadata-only logs), and never enters a tracked file, fixture, eval set, screenshot, demo or log. Redacted, it may also go into Fireworks training lines for Loupe, the page screener (D03 T04 §7; operator, 2026-10-28 15:16 SAST); unredacted, it goes only to the Meta Model API. No mail is sent to that client's people; the only address in its domain that may receive mail is the Rizonetech-controlled account controller mailbox named in `samples/pilot-consent.md`.
- When a command needs sudo, give the operator the exact command to run with `! sudo ...`.

## Skills

- Claude skills live in `.claude/skills/<name>/` as real files, never symlinks. Follow [Agent Skills and Rules Structure](./docs/agent-skills-and-rules-structure.md) before adding or moving one, and name it for its capability.

## Subagents

- Delegate mechanical subtasks to subagents. Claude subagents pin an explicit `model:`: Sonnet by default, Opus (with a `model_rationale:`) only where judgment quality needs it.
- Subagents read and run; they never write. Every Claude subagent declares an explicit `tools:` list without Edit, Write, MultiEdit, NotebookEdit or `*`. The main loop makes every change and verifies what subagents return.
- Haiku only for near-mechanical work under the rule in `docs/agent-skills-and-rules-structure.md`, never for review, audit, research, security, debugging, planning or design. Run `node scripts/verify-agent-tiers.mjs` after changing an agent definition.

## Unknowns and questions

Answer from source first: the design spec, the stack doc, the RFCs above, and the Cloudflare and Meta docs. Meta's documentation (every page in `https://dev.meta.ai/llms.txt`) and both Meta cookbooks (`meta-models/meta-model-cookbook`, `meta-models/meta-oss-cookbook`) are mirrored locally in git-ignored `sources/meta-api/`: look things up with `python3 scripts/meta-docs.py find <terms>` (every term in one file, results as `path:line [section]`), read a file with `show <path>`, and refresh with `sync` before relying on a page for a new feature. Cite the live URL, not the mirror. When an unanswered question would change implementation, take the industry-standard default, record that it is a default with its cost of changing, and carry on. Questions that truly need the owner become a section Need (`owner-decision`, `third-party`), not a stall.

## Validation

Three hooks run through `git config core.hooksPath scripts/hooks`, in every worktree: `scripts/hooks/pre-commit` (the plan, regenerated while a merge is concluded, client names, private paths), `scripts/hooks/pre-merge-commit` (stops a merge that changes the plan's inputs, D00 T01 §22) and `scripts/hooks/pre-push` (`pnpm typecheck` and `pnpm lint` on a clean tree whose `HEAD` is what the push sends, D00 T01 §13). Push a lane's branch from that lane's own worktree.

```bash
python3 scripts/todo-graph.py validate             # graph integrity; any fault exits 2 with the reason
python3 scripts/todo-graph.py plan --check         # generated plan is current (CI runs this)
python3 scripts/todo-graph.py query ready          # dependency-safe work right now
python3 scripts/review-dispatch.py --check-pin --json   # the reviewer pin loads and codex is on PATH
python3 -m unittest discover -s tests/scripts      # TODO graph, run guard, pre-commit and pre-push hooks, CI and merge tooling
python3 -m unittest discover -s scripts/tests      # review dispatcher
node scripts/verify-agent-tiers.mjs                # subagent model tiers
python3 scripts/meta-docs.py sync                   # refresh the local Meta docs and cookbook mirror
python3 scripts/check-publication.py                # before every push: nothing private in the index (exit 2: cannot run)
pnpm install --frozen-lockfile                      # the Worker's exact pins (Node 24.18.0 from .nvmrc, pnpm 11)
pnpm typecheck                                      # worker-configuration.d.ts matches wrangler.jsonc, then tsc --noEmit
pnpm lint                                           # Biome over the Worker's own files; unused variables are errors
pnpm build:assets                                   # web fonts, tokens, stylesheet, fingerprints -> public/static/, src/web/assets.ts
pnpm test                                           # Vitest: the Worker in workerd, build scripts and style checks in Node
pnpm test:a11y                                      # axe-core (WCAG 2.2 A and AA) over the component gallery in Chromium
pnpm build                                          # bundles the Worker (dry-run deploy into build/dry)
```

Worker commands are added here by the scaffold section that creates them (Biome and Vitest came with D00 T01 §3; `wrangler deploy` comes with D00 T01 §5); `tests/scripts/test_worker_gates.py` fails while a `package.json` gate script is missing here or from `CONTRIBUTING.md`. After changing `wrangler.jsonc`, run `pnpm types` and commit the regenerated `worker-configuration.d.ts`. Report only commands actually run, and distinguish static evidence, test output and review proof.
