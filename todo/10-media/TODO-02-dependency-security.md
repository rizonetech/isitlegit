---
schema_version: 1
id: media-dependency-security
domain: 10-media
status: active
title: "Media dependency security"
track: day-6
---

# TODO-02 -- Media dependency security

> **Goal:** Remove the vulnerable media Zod dependency without changing product contracts or generating media.

> **Current state:** Media independently pins Zod4.5.4 and Remotion runtime consumers also request exact4.5.4. Baseline TypeScript noEmit passes. A bounded eight-element check visits all elements before rejecting a max-two array on4.5.4 and zero elements on cached4.6.7. No dependency implementation has changed.

## Inputs

- `media/package.json`, `media/pnpm-workspace.yaml` and `media/pnpm-lock.yaml`: isolated dependency ownership.
- `AGENTS.md`, `docs/manifesto.md` and `.agents/skills/codex-lane-workflow/SKILL.md`: safety, quality and genuine two-pass review.
- [GitHub advisory GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5): affected below4.6.6, patched4.6.6.

## Outcome

- The isolated media package resolves exactly Zod4.6.7, with a reproducible lock and nonrender compatibility evidence.

**Adjacency:** all=not-applicable (dependency maintenance, no product records or user-facing surface)

**Adjacency rationale:** Media has its own package root and lockfile. This maintenance changes dependency resolution and tests only, not Worker dependencies, data, narrative, assets or publication.

## Implementation Order

| Order | Section | Deliverable | Depends On | Status |
| ----- | ------- | ----------- | ---------- | ------ |
| 1 | §1 | Patch vulnerable media Zod | -- | [ ] |

## 1. Patch vulnerable media Zod

Coordinator MEDIA-ZOD-SECURITY authorizes this narrow remediation for alerts63/64, one HIGH advisory GHSA-mrhx-c7xc-m3w5. The GitHub advisory reports versions below4.6.6 affected. Use exact4.6.7, already cached in the root workspace, without changing that workspace. This closes the media dependency exposure, not GitHub alert state or an inferred Worker deployment block. Preserve dirty D10 T01§12 evidence separately; do not restamp it or migrate its historical review chain.

**Phase:** 6
**Needs:** none
**Surface:** no

**Build order:**

1. Add bounded synthetic regression coverage in `media/tools/zod-security.test.mjs` and run it against installed4.5.4 before upgrading. Done when: oversized constrained arrays fail without visiting elements under patched Zod, the old dependency demonstrably fails that invariant, and valid bounded/invalid scalar inputs preserve strict validation and useful errors without memory-stress inputs.
2. Pin only `media/package.json` Zod to4.6.7 and add a Zod-only override in the owning `media/pnpm-workspace.yaml` for Remotion runtime consumers pinned to4.5.4, then regenerate `media/pnpm-lock.yaml` using pnpm offline with install scripts disabled. Done when: runtime package version, importer and all Zod resolutions are4.6.7, frozen offline install succeeds, and no unrelated dependency/version or root lockfile changes.
3. Run the regression, media TypeScript noEmit check, existing capture and kit unit tests, Python media tooling tests and publication scan without invoking capture/render/studio/voice/stats generation. Done when: all affected checks pass, or any genuine pre-existing unrelated issue is evidenced and escalated rather than hidden; no new regression is accepted. Record source advisory, exact versions and limitations in the review record.

- [ ] Add falsifiable bounded regression coverage for early rejection and strict compatible parsing. Done when: regression fails on4.5.4 and passes on4.6.7.
- [ ] Upgrade only Zod and its media lock resolution to exact4.6.7. Done when: frozen offline install and installed version readback match; no4.5.4 resolution remains.
- [ ] Verify nonrender compatibility and publication safety without modifying assets or the root workspace. Done when: targeted gates pass and original media is untouched.
- [ ] Commit: `media: patch Zod constrained collection vulnerability`

**Test checkpoint:** `cd media && node --test tools/zod-security.test.mjs && pnpm exec tsc --noEmit && pnpm test:capture && pnpm test:kit` exits0; `python3 -m unittest discover -s media/tools` and `python3 scripts/check-publication.py` pass; frozen offline install retains exact4.6.7 and the dependency diff contains no broad upgrades.

## Verification

- The section Test checkpoint and exact dependency readback pass without media generation.
- `python3 scripts/todo-graph.py validate` and `python3 scripts/todo-graph.py plan --check` pass with genuine review evidence.
