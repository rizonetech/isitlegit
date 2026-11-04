# Loupe 1.1 release evidence

Updated 4 November 2026. This record separates training, model registration, diagnostic measurement and live application release. The historical [Loupe 1.0 model card](model-card.md) retains its original version-specific results.

## Completed training

Loupe 1.1 is a LoRA fine-tune of Muse Glimmer 30B trained through Fireworks AI. The completed run processed 72,375 training examples in one epoch and 4,524 consecutive optimizer steps. Batch size was 16, with seven examples in the final batch: 4,523 × 16 + 7 = 72,375. A training example is one serialized training conversation for a page, not an independently authored instruction, a unique source family, or a successful detection. The count is not a measure of quality. The instruction is one canonical task prompt reused with page-specific inputs, not 72,375 different instructions. Its SHA-256 is `c0de39473966340136e2ef543ae4c8141b1b612e32cbae3eb23864e6b38e0232`. Each training record carries system, user and assistant turns; the user input contains the host, delimited visible text and screenshot, and the assistant target follows the strict brand-free schema. A bounded first-record structural check passed; this does not claim a new audit of every historical row.

The run finished on 4 November 2026 at 19:53:56 UTC with completed outcome and status code 0. Its registered model is `accounts/rizonetech/models/isitlegit-loupe-1-1`, checkpoint `step-4524`, training session `ts-db85d8de82174aa6824b775ca6e40075`. Training dataset SHA-256: `5fb1d93b4549bd8b64c69c943ad5f23a7411cdfc8d4d3f2e339f0442d2eb253b`. Registration of an artifact is separate from deployment and application selection.

The completed training evidence binds metrics SHA-256 `3475907b835edba53a4563e2bc4b30e0156e9a706b406d62a25f2ff0edba3feb` and output-model record SHA-256 `3a3d2ecf8ee9330cbe3b674bf848803712c7d4240a37053dfa8ae8a3b7f5935c`. The [training record](training.md) records the dataset and historical runs.

## Output contract and hosting

Version 1.1 uses the brand-free answer contract in [`page-screen.ts`](../../src/vision/page-screen.ts): login-form presence, payment-form presence, lure classification, lure type and confidence. Brand metadata is not a required model answer. The runtime must choose the matching prompt and strict response schema; changing a model name alone is insufficient. Missing or invalid model output remains an error, never a fabricated successful classification.

Training and inference run on Fireworks AI. The Cloudflare Worker orchestrates investigations and calls the dedicated inference endpoint through AI Gateway. The model weights do not execute inside the Worker. This release does not claim a public Hugging Face weight upload or model repository.

## Preregistered diagnostic

The post-training synthetic diagnostic v2 contains 40 original inert pages: 20 labelled lures and 20 benign pages, ten layout families and one shared generator family. Both model versions receive the same brand-free prompt and the same screenshots, visible text and order. V1 was preserved; v2 changes the request contract before measurement. V2 manifest SHA-256: `5722055c70fb41c9bb43db9d04f10115b85f79857cebd9b2d3797e609c19ad67`.

This is a small synthetic diagnostic, not an independent held-out population or acceptance of D03 T04 §50. It does not establish general phishing accuracy, superiority over Muse Wonder, or compliance with the project's false-positive target. The existing 17 provenance issues and 257 baseline-training overlaps remain unresolved; complete source/template lineage and prior-exposure exclusion against both training exports have not been proved. Its 40 pages must not be presented as 40 independent source groups.

Initial v2 attempts produced provider errors, not quality measurements: the first run returned HTTP 404 on all 40 baseline requests and made no candidate requests; a second run stopped after one HTTP 404. No valid model answer or comparative quality metric is available from those attempts. Report each model's attempted, valid, invalid and failed responses separately, with lure recall numerator/20 and false-positive numerator/20. Include response latency sampling and error denominators. A missing answer is not a correct classification. GPU deployment cost is elapsed capacity cost, not a known per-request token charge; do not replace an unknown cost with zero.

## Live release evidence

Live Loupe 1.1 serving is not yet verified in this documentation snapshot. Source selector, provider deployment model binding, deployed Worker commit and an application-level trace must agree before that claim is updated. The initial source snapshot at `3a4ee6ba8842d5016d3750eec8b5b1413497e5cc` selects Loupe 1.0. A direct provider response alone does not prove the application used 1.1.
