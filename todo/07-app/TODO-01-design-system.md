---
schema_version: 1
id: design-system
domain: 07-app
status: active
title: "TODO-01 -- Design Session, Tokens and App Shell"
track: day-1
---

# TODO-01 -- Design Session, Tokens and App Shell

> **Goal:** `design/SPEC.md` is the interface source of truth for every IsItLegit surface (report page, reply email, upload, member console, admin console, auth pages, marketing site), approved by the operator in one attended session; its tokens compile into the CSS every page uses; and one shared app shell and component set renders every state (empty, loading, partial, error) so no page invents its own.

> **Current state:** Measured 2026-10-26 20:00 SAST. No `design/` folder exists. The brand decision is recorded in design spec section 11: IsItLegit is its own sub-brand with Rizonetech DNA (own wordmark and verdict colours on Rizonetech orange `#FF4A14`, Exo and Exo 2, "by Rizonetech" footer). The Rizonetech brand kit is on the operator's Google Drive mirror.

## Inputs

- Design spec 4.7 (report page), 4.8 (tenancy, consoles, site), 5 (demo), 11 (Brand, Design, Pricing decisions); `docs/manifesto.md` (Experience standards: WCAG 2.2 AA, every state designed, tokens only).
- `AGENTS.md` Interface rules.
- -> XREF: D00 T01 §8 -- the README wordmark and social preview banner that come out of this session

## Outcome

- `design/SPEC.md` exists, operator-approved, with a section per surface, every control and state named, and mockups under `design/mockups/`.
- `design/tokens/*.json` compile into `src/web/static/app.css`; a test fails if any page uses a raw colour.
- Every page renders inside one shell with the shared components.

**Adjacency:** all=not-applicable (design system and shared chrome; each surface's own adjacency is declared in its TODO file)

**Adjacency rationale:** This file produces the specification, tokens and shell. Lists, documents, settings and the rest belong to the feature files that build each surface against the SPEC.

## Implementation Order

| Order | Section | Deliverable | Depends On | Status |
| ----- | ------- | ----------- | ---------- | ------ |
| 1 | §1 | Attended design session and design/SPEC.md | -- | [ ] |
| 2 | §2 | Design tokens compiled to the stylesheet | §1, D00 T01 §3 | [ ] |
| 3 | §3 | App shell and shared components with every state | §2 | [ ] |

## 1. Attended design session and design/SPEC.md

The operator chose an attended design session before any surface is built (design spec section 11). Claude drafts the SPEC, the tokens and mockups as a viewable page; the operator approves or adjusts in session; the approved version is committed. Backend sections run unattended meanwhile.

**Phase:** 1
**Needs:** attended
**Surface:** no

**Build order:**

1. Draft `design/SPEC.md`, `design/tokens/` and mockups for every surface. Done when: the draft names every screen, control and state the design spec and plan require.
2. Review with the operator and record the approval. Done when: `design/SPEC.md` carries an `Approved: YYYY-MM-DD by the operator` line.

- [ ] Draft the IsItLegit wordmark (light and dark) and the verdict colour set (safe, suspicious, malicious, partial) on Rizonetech orange `#FF4A14` with Exo and Exo 2, checking WCAG 2.2 AA contrast for text and badges in both themes. Done when: `design/brand/` holds the SVGs and `design/tokens/colors.json` the values with their contrast ratios.
- [ ] Write `design/SPEC.md` sections for: report page (verdict banner, headline, three reasons, what to do now, evidence cards by kind, model trace, feedback, pending, partial, failed), reply email, upload, sign-in and signup with invite code, domain verification, member console (cases, stats, team, domains, supplier ledger, protected identity), admin console, marketing site (home, how it works, invoice fraud, pricing, privacy), and the judge demo. Done when: each section lists its controls and states.
- [ ] Draw mockups for the report page (malicious, safe, partial), the member cases list and the home page under `design/mockups/` as HTML or PNG. Done when: the files exist and the SPEC links each.
- [ ] Publish the draft for the operator to view and approve in session (an Artifact page or local HTML). Done when: the operator has seen it.
- [ ] Apply the operator's changes and add `Approved: YYYY-MM-DD by the operator` to `design/SPEC.md`. Done when: the line is present. Cheaper substitute: committing an unapproved draft.
- [ ] Commit: `design: approved interface specification, tokens and mockups`

**Test checkpoint:** `grep -cE '^Approved: 2026-[0-9]{2}-[0-9]{2} by the operator$' design/SPEC.md` prints `1`.

## 2. Design tokens compiled to the stylesheet

Colours, type and spacing come from tokens only (`AGENTS.md`, manifesto). Tailwind 4.3.3 builds one static stylesheet from the token files; pages reference token classes, never raw values.

**Phase:** 1
**Needs:** none
**Surface:** no

**Build order:**

1. Generate the Tailwind theme from `design/tokens/*.json`. Done when: `pnpm build:css` writes `src/web/static/app.css` with the token variables.
2. Guard against raw colours. Done when: a test fails on a hex colour in `src/web/`.

- [ ] Add exact dev dependencies `tailwindcss` and `@tailwindcss/cli` 4.3.3. Done when: `pnpm install` resolves them.
- [ ] Write `scripts/build-tokens.ts` turning `design/tokens/*.json` into `src/web/styles/tokens.css` (`@theme` variables, light and dark). Done when: the generated file lists every token.
- [ ] Add script `build:css` compiling `src/web/styles/app.css` to `src/web/static/app.css`, and serve it as a static asset from the Worker. Done when: `GET /static/app.css` returns it with a long cache header and a content hash in the name.
- [ ] Load Exo and Exo 2 from self-hosted WOFF2 files in `src/web/static/fonts/` with their SIL OFL 1.1 licence recorded in `NOTICE.md`. Done when: the files and the NOTICE row exist.
- [ ] Write `test/web/no-raw-colours.test.ts` failing on any `#rgb`, `#rrggbb`, `rgb(` or `hsl(` in `src/web/**/*.tsx`. Done when: the test passes now and fails on a planted `#ff0000`.
- [ ] Commit: `web: design tokens compiled to the app stylesheet`

**Test checkpoint:** `pnpm build:css && pnpm exec vitest run test/web/no-raw-colours.test.ts` passes.

## 3. App shell and shared components with every state

One layout and one component set for every app page (`AGENTS.md`: a second toolbar or panel shape is a defect). Server-rendered with `hono/jsx`; htmx for partial updates. Every page works at phone width, and every icon-only control has an accessible name.

**Phase:** 2
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` shell and component sections
**Job:** every IsItLegit page looks and behaves as one product
**Treatment:** the approved shell, tokens only, every state designed
**Chrome:** this section defines the chrome: `AppShell`, `VerdictBadge`, `EvidenceCard`, `Button`, `Field`, `EmptyState`, `LoadingState`, `ErrorState`, `PartialNotice`

**Build order:**

1. Build `src/web/components/` and `AppShell`. Done when: a test page renders every component in every state.
2. Check accessibility and phone width. Done when: an automated check finds no missing accessible names and no horizontal overflow at 360 px.

- [ ] Build `AppShell` (header with wordmark and organisation switcher, main region, footer "by Rizonetech") in `src/web/components/shell.tsx`. Done when: `test/web/components.test.ts` renders it with landmarks `banner`, `main` and `contentinfo`. Cheaper substitute: per-page headers.
- [ ] Build `VerdictBadge` for safe, suspicious, malicious and partial with icon plus text, never colour alone. Done when: the test finds the text label in each variant.
- [ ] Build `EvidenceCard` with slots for severity, summary, detail and an artefact (image, crop, header excerpt). Done when: the test renders one of each artefact kind.
- [ ] Build `Button`, `Field` (label, hint, error), `EmptyState`, `LoadingState`, `ErrorState` and `PartialNotice`. Done when: the test renders each with its SPEC text.
- [ ] Add htmx 2.0.11 as a self-hosted static asset and a `hx-` helper for partial updates. Done when: `GET /static/htmx.min.js` serves it and `NOTICE.md` lists it (BSD 2-Clause).
- [ ] Add a `/dev/components` page (only when `ENV` is `development`) showing every component in every state. Done when: it returns 404 in production config.
- [ ] Add an accessibility check with Browser Run plus axe-core 4.11 on `/dev/components` at 360 px and 1280 px. Done when: `pnpm test:a11y` reports zero violations and fails on a planted unlabeled icon button.
- [ ] Commit: `web: app shell and shared components`

**Test checkpoint:** `pnpm exec vitest run test/web/components.test.ts && pnpm test:a11y` passes.

## Verification

- `design/SPEC.md` is approved; every page uses the shell, the components and token classes only; the accessibility check passes at phone and desktop widths.
- `python3 scripts/todo-graph.py validate` and `plan --check` pass.
