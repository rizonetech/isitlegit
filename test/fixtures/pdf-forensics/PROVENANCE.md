# PDF forensics fixtures

Made by `node test/fixtures/pdf-forensics/make.ts` on 2026-10-31 for D06 T02 §1. Every document is synthetic: Kestrel Bank and Hadeda Couriers are fictional, the account and branch numbers are invented, and each page says "SYNTHETIC TEST DOCUMENT". The generators only produced the files; none of their code is in the repository.

| File                      | Generator                                      | Licence of the generator | What it is                                                |
| ------------------------- | ---------------------------------------------- | ------------------------ | --------------------------------------------------------- |
| `gs-genuine-pop.pdf`      | Ghostscript 10.06.0 `pdfwrite`                 | AGPL-3.0                 | A proof of payment as written                             |
| `gs-logo.pdf`             | Ghostscript 10.06.0 `pdfwrite`                 | AGPL-3.0                 | The POP with an image clear of the text                   |
| `gs-edited-pop.pdf`       | Ghostscript, then `appendUpdate`               | AGPL-3.0, own code       | The POP with a later save over its amount                 |
| `gs-modified-pop.pdf`     | Ghostscript 10.06.0 `pdfwrite`                 | AGPL-3.0                 | The POP modified a week after its payment date            |
| `gs-substituted-font.pdf` | Ghostscript 10.06.0 `pdfwrite`                 | AGPL-3.0                 | The POP's amount in Times, its other amounts in Helvetica |
| `gs-pasted-image.pdf`     | Ghostscript 10.06.0 `pdfwrite`                 | AGPL-3.0                 | The POP with an image painted over its amount             |
| `chromium-pop.pdf`        | Chromium (Skia PDF) via playwright-core 1.64.1 | BSD-3-Clause             | A POP printed from a web page                             |
| `chromium-invoice.pdf`    | Chromium (Skia PDF) via playwright-core 1.64.1 | BSD-3-Clause             | A supplier invoice printed from a web page                |
