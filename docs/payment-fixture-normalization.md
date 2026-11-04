# Payment fixture PNG normalization

D06 T02 §9, 4 November 2026. Owning layer: `scripts/fixtures/make-doctored.ts` publishes provider images. The old producer decoded metadata but wrote the unchanged provider bytes under a PNG name. Inspection found exactly 19 WebP files, pair-02 through pair-20 doctored images, all 1328 by 1648 pixels. The code-made pair-01 and all genuine PNG files were already correctly encoded.

`normalizePng` now fully decodes an image, encodes actual PNG and reads it back to prove exact RGBA decoded-pixel equality. The producer also compares decoded pixels to the genuine image: a lossless re-encoding of unchanged content uses the existing code fallback with truthful attribution. Truncated images use that same recorded fallback. No model, recipient, verdict or severity policy changed.

## Plan findings disposition

P2-1: the offline operation verifies external backups and writes the original-hash conversion receipt before atomic image publication; tests inject failure before and after replacement and prove restart preserves that receipt. P2-2: decoded-pixel comparison now rejects a losslessly re-encoded unchanged genuine image as a model edit, with a failing-before regression.

## Existing corpus

`node scripts/fixtures/make-doctored.ts --normalize-existing --backup-dir <external-originals-directory>` converted the 19 artifacts without a model call. `test/fixtures/payment-docs/normalization.json` records each original WebP format and SHA-256, output PNG SHA-256, dimensions, channels and decoded-pixel SHA-256. Every conversion passed exact decoded-pixel equality. A second invocation verified all 19 records without changing the receipt. Original bytes were backed up outside the repository before the conversion intent was published; git history also retains the original files at plan candidate `20f4747fed9c73eca1d4eec1ebd818db8e2ea839`.

The conversion receipt is written before atomic image replacement. A resumed operation verifies both the backup and recorded hashes, accepts only the original or planned output and preserves the original evidence. Failed publication is recoverable from the verified originals. The operation refuses an in-corpus backup and unexpected altered fixture bytes. `labels.json`, pair sidecars and historical measurement results are preserved; existing extraction measurements remain historical, not fresh measurements of the new encoded bytes. Eval was notified before conversion and must refresh its pinned raster hashes at the coordinated integration boundary.

## Verification

The two producer regressions failed before the fix: saved output was WebP instead of PNG, and losslessly re-encoded genuine pixels were attributed to a model edit. The targeted command `taskset -c 9 pnpm exec vitest run --project node test/node/make-doctored.test.ts` passed 10 tests after repair, including interrupted publication before and after image replacement, corrupted-backup refusal, invalid-image preservation and truncated provider output. Full-buffer equality uses Buffer.equals, avoiding per-byte assertion overhead without changing the assertion.

This corrects raster encoding only. Native-PDF detection and missing-date coverage remain D06 T02 §8; no medium evidence was promoted, no corpus label changed and no detection target is claimed met by this conversion.
