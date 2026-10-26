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

> **Current state:** Measured 2026-10-26 20:00 SAST. No `design/` folder exists. The brand decision is recorded in design spec section 11: IsItLegit is its own sub-brand with Rizonetech DNA (own wordmark and verdict colours on Rizonetech orange `#FF4A14`, Exo and Exo 2, "by Rizonetech" footer). The Rizonetech brand kit is on the operator's Google Drive mirror. **Updated 2026-10-26 21:10 SAST:** the operator approved the IsItLegit brand in session; the kit (logo, mark, PROTECTED seal and badge, app icons, favicons, banners, motion frames, guide) is generated into `design/brand/` by `design/tools/build-brand.py`, and the Exo fonts are vendored in `design/fonts/`. The verdict colours are safe `#0E7C5B`, suspicious `#B26A00`, malicious `#C8102E` (`design/brand/README.md`). **Updated 2026-10-26 22:20 SAST:** every page in `design/SPEC.md` section 0 was designed on the design canvas (70 boards, ink deepened to `#181519` at the operator's request) and the operator approved all of it in session; §1 imports it.

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

> **Started:** 2026-10-26T20:21:27Z

The operator chose an attended design session before any surface is built (design spec section 11). Claude drafts the SPEC, the tokens and mockups as a viewable page; the operator approves or adjusts in session; the approved version is committed. Backend sections run unattended meanwhile.

**Phase:** 1
**Needs:** attended
**Surface:** no

**Build order:**

1. Draft `design/SPEC.md`, `design/tokens/` and mockups for every surface. Done when: the draft names every screen, control and state the design spec and plan require.
2. Review with the operator and record the approval. Done when: `design/SPEC.md` carries an `Approved: YYYY-MM-DD by the operator` line.

- [ ] Import the operator-approved design canvas (70 boards, `https://claude.ai/artifact/7gNnLiAFvNBaUXyPmHrhxv`) into `design/mockups/source/` (`canvas.json`, `ui.css`, one `<Board>.dc.html` per board) with `design/tools/export-mockups.py import`, rewriting canvas asset links through `design/mockups/source/assets.json` (canvas asset id to `design/brand/` file) and failing on an unmapped asset; record the approved inventory once, independently of `canvas.json`, in `design/mockups/approved.json` (each board's name, title and SHA-256 at approval). Done when: `tests/scripts/test_design_spec.py` fails if a board in `approved.json` is missing from `canvas.json` or from disk (dropping one from both still fails), if a board's hash differs from its approved hash, if a `/_blob/` link remains, or if any `src` does not resolve to a repository file. **Corrected 2026-10-26 (plan review):** completeness was measured against the imported manifest itself.
- [ ] Write `design/tools/export-mockups.py export`, turning each source board into a standalone page under `build/mockups/` (`dc-import` parts inlined with their attribute props over the part's defaults, `{{...}}` values from the part's `renderVals` run in Node, the part's own styles kept, Exo and Exo 2 from `design/fonts/`, no network) and rendering it with headless Chromium to `design/mockups/png/<Board>.png` at the board's size, each PNG written to a temporary file and replaced only after Chromium succeeds; with `--audit` the page also reports every text element's computed colour, effective background, size and weight, whether every image loaded and whether both fonts loaded, into `build/mockups/audit.json`. Done when: `tests/scripts/test_export_mockups.py` proves on fixtures that imported content appears with distinct prop values (two `active` values give two different active items) and the `renderVals` output, and fails on an unresolved import, a leftover template value, a missing asset, a Chromium failure (the old PNG left untouched) and, where Chromium is installed, a PNG whose size differs from its board or an audit reporting an unloaded font or image; and `design/mockups/png/` holds one PNG per approved board. **Corrected 2026-10-26 (plan review):** the export tests proved only the absence of markers, not correct rendering.
- [ ] Write `design/tokens/colors.json` from the approved brand kit (`design/brand/README.md`) and the canvas stylesheet: surface, subtle, light, ink, ink 2, muted, line, line strong, control border, orange, orange text, orange wash, the dark-section colours, and per verdict (safe, suspicious, malicious, partial) a text colour, a graphic colour where it differs, a wash and a band fill, each in a light and a dark theme. Done when: `tests/scripts/test_design_tokens.py` maps every pair in `build/mockups/audit.json` (all 70 boards) to token names, fails on a board colour that is no token (content inside an element marked `data-illustration`, such as a fake brand logo, excepted), and checks each mapped pair in both themes at 4.5:1 for text (3:1 at 24 px, or 18.66 px bold) and 3:1 for control boundaries and verdict graphics; a planted unlisted failing pair in a fixture board makes it fail. **Corrected 2026-10-26 (plan review):** the original list proved only hand-listed pairs; the audit now reconciles the boards against the tokens.
- [ ] Write `design/tokens/typography.json` (font roles Exo and Exo 2, weights, the type scale with line heights for display, h1 to h4, body, small, tiny, eyebrow and mono) and `design/tokens/spacing.json` (a 4 px spacing scale, radii, shadow), from `design/mockups/source/ui.css` and the board values. Done when: `tests/scripts/test_design_tokens.py` fails if a role named here is missing, if a `ui.css` variable or class size disagrees with its token, or if a board uses a font size or spacing that rounds to no token by more than 2 px. **Corrected 2026-10-26 (plan review):** the section created colour tokens only, but §2 compiles typography and spacing tokens that no step wrote.
- [ ] Write `design/mockups/coverage.json`: for every section 0 row, each required control and state (every state the row names after "states:" or in its content, plus loading, empty and error where the page has them), mapped either to the board that shows it with a short text the board contains as evidence, or to `not-applicable` with a reason, or to a deferral naming a resolving TODO section. Done when: `tests/scripts/test_design_spec.py` fails if a section 0 row has no entry, if a state the row names is absent from its entry, if an evidence text is missing from its board, or if a deferral does not resolve with `scripts/todo-graph.py resolve`; removing a state's text from its board makes it fail. **Corrected 2026-10-26 (plan review):** the link test proved boards exist, not that each required control and state was designed.
- [ ] Write `design/SPEC.md` sections 1 onward, one per surface group of section 0 (shared parts, marketing site, trust pages, sign-in and onboarding, member app with the report page in full, admin console, error pages, email messages, judge demo), each page listing its controls and states as in `coverage.json` and linking its board PNGs and sources; correct the header's spacing claim to the token scale. Done when: `tests/scripts/test_design_spec.py` fails if a board in `approved.json` is not linked from the SPEC, a linked file does not exist, or a page section omits a control or state its `coverage.json` entry names. **Corrected 2026-10-26 (plan review):** the list named only part of section 0.
- [x] Publish the draft for the operator to view and approve in session (an Artifact page or local HTML). Done when: the operator has seen it. Evidence: the design canvas above, reviewed in session and approved by the operator on 2026-10-26 at 22:19 SAST ("I approve everything").
- [ ] Apply the operator's changes and add `Approved: YYYY-MM-DD by the operator` to `design/SPEC.md`. Done when: the line is present. Cheaper substitute: committing an unapproved draft.
- [ ] Commit: `design: approved interface specification, tokens and mockups`

**Test checkpoint:** `python3 design/tools/export-mockups.py export --audit && python3 -m unittest tests.scripts.test_design_tokens tests.scripts.test_export_mockups tests.scripts.test_design_spec` passes, and `grep -cE '^Approved: 2026-[0-9]{2}-[0-9]{2} by the operator$' design/SPEC.md` prints `1`.

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
