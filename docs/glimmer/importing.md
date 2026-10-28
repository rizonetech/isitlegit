# Importing a public page dataset into Loupe's store

How the operator takes a downloaded dataset to a reconciled import (D03 T04 §5 and §18). Every command runs from the repository root; the store is `~/isitlegit-data/glimmer` (`GLIMMER_DATA_DIR` moves it) and never sits inside a git work tree. Run one import at a time: each renders pages in a headless browser.

## 1. Verify the download

Each source's files sit under `<store>/raw/<source>/` with their SHA-256 (or the publisher's own checksum) recorded where they were fetched: Astra's `COLLECTED.md` for a source it collected, `docs/glimmer/sources.md` for one fetched by hand. Re-check every file against it before anything else; a mismatch removes the source. Re-read the licence at the dataset's own page and record the decision as a row of `docs/glimmer/sources.md`, and an accepted source in `NOTICE.md`.

## 2. Turn the archive into rows or files

| Source | Command |
| ------ | ------- |
| ScamFerret | `python3 scripts/glimmer/extract_archive.py <archive> <store>/raw/scamferret/extracted/<name> --only artifact-8cf8dc631edafe584141e2f95f0c0f51855fb7bc/dataset/` (the archive's entries start with its commit folder) |
| PhreshPhish | `~/.venvs/fireworks/bin/python scripts/glimmer/phreshphish_rows.py` |
| CompPhish, Ariyadasa 2021, Kempf HTML, Look For Mallory | `~/.venvs/fireworks/bin/python -I scripts/glimmer/dataset_rows.py <source> [--max 15000]` |
| 7 Days Later | `~/.venvs/fireworks/bin/python -I scripts/glimmer/sevendays_rows.py [--max 15000]` |

Archives are read entry by entry, never run; each entry is bounded in size. Each command first removes the staging a killed earlier run left (`scripts/glimmer/staging.py`) and writes its output temp-then-rename.

## 3. Import

| Source | Command |
| ------ | ------- |
| ScamFerret | `node scripts/glimmer/import-scamferret.ts [--concurrency 4]` |
| PhreshPhish | `node scripts/glimmer/import-phreshphish.ts [--concurrency 4]` |
| The rest | `node scripts/glimmer/import-rows.ts <source> [--concurrency 4]` |

The import writes `<store>/raw/<source>/IMPORT.json` as `running` before it touches a page, and at the end as `complete` or `incomplete` with every item accounted for: imported, a duplicate of a stored page, skipped (already stored from an earlier run, not rendered again), filtered (renders under 20 characters of text) or excluded (with its reason). More than 5 percent excluded, or a stop on a write failure, reads `incomplete`. A source is trained on and evaluated only once its import reads `complete`. A stopped or killed import is resumed by running the same command again.

## 4. Check, inspect and reverse

- `node scripts/glimmer/sources.ts check` reconciles `docs/glimmer/sources.md`, every accepted source's `IMPORT.json` (complete, accounting for every item, at least one page) and the store, and prints `sources: reconciled`.
- `node scripts/glimmer/sources.ts status` lists each source's pages and its import's status, counts and rate.
- `node scripts/glimmer/sources.ts remove <source>` takes a source's pages out of the store and marks its `IMPORT.json` as removed; a rejected source must have no page left.
