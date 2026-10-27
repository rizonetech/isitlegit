# Third-party notices

IsItLegit is licensed under the Functional Source License 1.1, Apache 2.0 future license (`FSL-1.1-ALv2`); see [`LICENSE`](LICENSE).

## Present in the repository now

| Component | Path | Licence | Notes |
| --------- | ---- | ------- | ----- |
| Exo and Exo 2 variable fonts | `design/fonts/` | SIL Open Font License 1.1 (`OFL-Exo.txt`, `OFL-Exo2.txt`) | By Natanael Gama, Copyright 2017 The Exo Project Authors. Converted to outlines in the brand files by `design/tools/build-brand.py`; self-hosted by the app and site |

No other third-party code, data or assets are vendored. The development tooling in `scripts/`, `.claude/` and `.conclave/` and the logo files in `design/brand/rizonetech/` are Rizonetech's own (see [`CONTRIBUTIONS.md`](CONTRIBUTIONS.md)).

## Entering the build

Runtime and development dependencies are pinned in the [tech stack spec](docs/specs/2026-10-26-tech-stack-design.md). Each enters through the TODO section that adds it, and that section adds its row here: name, version, licence and whether it ships in the Worker.

| Component | Version | Licence | Ships in the Worker? |
| --------- | ------- | ------- | -------------------- |
| `hono` | 4.13.14 | MIT | Yes |
| `zod` | 4.6.7 | MIT | Yes, once imported |
| `typescript` | 7.0.2 | Apache-2.0 | No: type checking only |
| `wrangler` | 4.152.0 | MIT OR Apache-2.0 | No: build and deploy tool |
| `vitest` | 4.1.12 | MIT | No: test runner |
| `@cloudflare/vitest-plugin` | 1.4.7 | MIT | No: runs the tests inside workerd |
| `@biomejs/biome` | 2.6.3 | MIT OR Apache-2.0 | No: lint and format |
