# Approved page designs

Every IsItLegit page and email, as the operator approved it on 2026-10-26. `design/SPEC.md` links each page to its board here and names its controls and states.

## What is here

- `png/<Board>.png`: what the page must look like, at the board's size. `png/manifest.json` records the inputs each PNG was rendered from.
- `source/<Board>.dc.html`: the board itself, for exact values (sizes, spacing, wording). `source/ui.css` is its stylesheet; `source/canvas.json` lists every board and its size; `source/assets.json` maps canvas artwork to `design/brand/` files.
- `approved.json`: the approved inventory (each board's hash and size, the stylesheet's hash), recorded apart from `canvas.json` so a dropped or changed board is caught.
- `coverage.json`: for every page in `design/SPEC.md` section 0, each required control and state, shown on a board (with the text that proves it), not applicable (with why), or deferred to the TODO section that builds it.

## Commands

- `python3 design/tools/check-design.py` proves the inventory, coverage, SPEC and tokens agree. It renders its own audit of every board first, so it is the one command to run after any change here.
- `python3 design/tools/export-mockups.py export` re-renders the PNGs; add `--only <Board>` for one board.
- `python3 design/tools/export-mockups.py import <canvas folder> --approve YYYY-MM-DD --canvas-url <url>` brings in a re-approved canvas. A board changes only after the operator approves it.

Both tools need a headless Chromium (Playwright's `chrome-headless-shell`, or `MOCKUP_CHROMIUM`); the parts' scripts run inside its sandbox.

## When something goes wrong

- An import is staged beside `source/` and swapped in whole; a failed import leaves the previous `source/` untouched, and an import killed in the middle of the swap is finished by the next import, which restores the moved-aside folder before it reads anything.
- An export replaces each PNG only after Chromium renders it at the right size, and records it in `png/manifest.json` straight away. After an interruption, `check-design.py` names the boards whose PNG is stale; run the export again to finish.
- Canvas files are untrusted input: board names must be plain file names, boards may hold no executable markup (scripts, frames, event handlers, `javascript:` links), part scripts run in Chromium's renderer sandbox, and every page renders offline because all requests, loopback included, go to a proxy nothing listens on.

## Measured timings

Measured on 2026-10-26 on the operator's WSL workstation (Chromium headless shell, sandbox on, offline):

| Run | Time |
| --- | ---- |
| Export, all 70 boards with PNGs | 17.9 s (0.26 s a board) |
| Export, all 70 boards with PNGs and the audit | 41.7 s (0.60 s a board) |
| Export, one board | 0.25 s to 0.4 s |
| `check-design.py`, rendering its own audit | 13.7 s |
