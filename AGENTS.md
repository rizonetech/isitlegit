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

Opus 5.5 (`claude-opus-5-5` through Claude Code) is the only writer: code, tests, the plan and docs. Subagents that write run on Opus 5.5; Sonnet or Haiku run only read-only helpers whose output the main session verifies. GPT-6 Astra through the Codex CLI, in its read-only sandbox, runs every plan, completion and regular review round: it reads this file and never edits the repository. `.conclave/reviewers.toml` pins it with the schedule `scripts/review-dispatch.py` applies to every pass: a plan review before the build and a completion review after it (medium), round 1 at high across adversarial, integration, source-defect and plan-delivery, round 2 adversarial at medium, round 3 adversarial at low, then one low lens per round; the first round with no `P1` or `P2` finding ends the loop. Tooling adopted from Rizonetech's Recto repository through the Conclave-SDK `base`, `todo` and `reviewer` kits on 2026-10-26; it is development process, not product code, and `CONTRIBUTIONS.md` says so. After the rounds stop, Muse Wonder Full (`muse-wonder-full-1.0` through Muse Code, `[schedule.final]` in the pin, medium effort) gives each section one final review; a P1 or P2 it finds is fixed and proven by one more Astra round, and it is never repeated. Muse Code review calls run on the operator's Muse Code subscription with `--contributor-mode off`, not on Model API credit, so the `Meta credit visible:` gate does not apply to them (operator, 2026-10-26 23:03). Every review runs in the foreground: nothing in the working tree changes while a reviewer reads it.

## The TODO system

Plan and build through the TODO system in [docs/todo-workflow.md](./docs/todo-workflow.md); format spec: `todo/README.md`. Markdown is canonical. Domains: `00-workspace`, `01-intake`, `02-checks`, `03-vision`, `04-agent`, `05-trust`, `06-invoice`, `07-app`, `08-eval`, `09-launch`, `99-manual` (operator only). Phases (names in `todo/plan.json`) follow the build plan's days, 0 (Mon 26 Oct) to 6 (Sun 1 to Wed 4 Nov), 7 after the event, 99 manual.

A row flips to `[x]` only through `python3 scripts/todo-graph.py stamp`, backed by a review receipt in `docs/reviews/`; `todo/implementation-plan.md` is regenerated by `plan --sync`, never edited by hand. Use the skill that owns the step: `add-todo`, `create-todo`, `process-todo-section`, `review-todo-section`, `process-todo-file`, `process-phase`, `process-plan`, `groom-plan`. Lifecycle: capture, author, validate, plan review (gaps fixed in the section before code), record `Started:`, implement, gates, commit, completion review, review rounds and stamp, sync the plan.

`frozen: true` marks a TODO file that touches the safety contract below; each of its sections carries a `**Freeze check:**` naming the tests that must not move.

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
- Real client mail (anything under `samples/`, or any client's name, domain or address) in a fixture, eval file, screenshot, demo or log. `scripts/hooks/pre-commit` refuses a staged line or path that contains a name from the git-ignored `samples/client-names.txt`.
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
- Commits: trunk-based `main`, concise imperative messages, the section ref in the body, no AI attribution lines. Never amend a candidate under review, never bypass hooks, never force-push. Every clone runs `git config core.hooksPath scripts/hooks`.
- Credentials never enter tracked files, arguments or logs. The source of truth is the Conclave 1Password vault; Worker secrets go through `wrangler secret put`.

## Safety

- Local reversible work in the repository needs no confirmation.
- **Standing authorisation (operator, 2026-10-26 19:30, design spec section 11):** without asking, deploy the `isitlegit` Worker; create, migrate and configure its own D1, R2, KV, Workflow, AI Gateway and Browser Run bindings; change DNS records and Email Routing rules on the `isitlegit.co.za` zone only; configure the Cloudflare Access application for `/admin`; set GitHub Actions secrets in `rizonetech/isitlegit`. Never touch another zone, Worker, account or repository, and never delete a resource holding data without asking.
- Outbound mail goes only to registered members and Rizonetech-controlled test mailboxes (design spec section 11); the sender allowlist in code enforces it.
- Spend stays inside the code-enforced budget (design spec section 11); a run never raises a cap.
- Deploy with the local Wrangler login only after typecheck, lint, tests and `python3 scripts/check-publication.py` pass; CI never deploys. Once D00 T01 §5 has shipped, every stamped section that changes `src/` or `site/` is deployed before the next section starts, so each day ends with the live service working end to end (build plan standing rules).
- If Codex hits a usage limit, keep implementing and committing ready sections, queue their reviews, retry every 30 minutes and stamp each section when its review returns. Nothing is stamped without its review.
- Ask the operator once before anything else that sends, deletes or changes something outside the repository: mail to real people, a resource outside the authorisation above, credentials.
- **Unattended runs never ask.** A section that cannot finish is parked with a dated note, its reason goes to `todo/findings.md`, a push notification goes to the operator only for a real blocker (an account, a credential, a spent budget, a provider outage longer than an hour), and the run continues with other ready work.
- Never send real client mail to the Meta Model API without that client's written consent.
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

```bash
python3 scripts/todo-graph.py validate             # graph integrity; any fault exits 2 with the reason
python3 scripts/todo-graph.py plan --check         # generated plan is current (CI runs this)
python3 scripts/todo-graph.py query ready          # dependency-safe work right now
python3 scripts/review-dispatch.py --check-pin --json   # the reviewer pin loads and codex is on PATH
python3 -m unittest discover -s tests/scripts      # TODO graph, run guard, pre-commit hook, CI and merge tooling
python3 -m unittest discover -s scripts/tests      # review dispatcher
node scripts/verify-agent-tiers.mjs                # subagent model tiers
python3 scripts/meta-docs.py sync                   # refresh the local Meta docs and cookbook mirror
python3 scripts/check-publication.py                # before every push: nothing private in the index (exit 2: cannot run)
```

Worker commands (typecheck, Biome, Vitest, `wrangler deploy`) are added here by the scaffold section that creates them. Report only commands actually run, and distinguish static evidence, test output and review proof.
