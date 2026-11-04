## PDF forensics (D08 T02 section 6)

Manifest SHA-256: 8b443a0db771e2054fdaecf2cdbe23ddc32f8c9f38de9c04554fbd29ac41c31d. 14 native PDFs; 40 raster files inventoried separately as unsupported and excluded from PDF denominators.

Component only: high or critical forensic evidence counts as verdict-level detection, matching src/agent/floor.ts. Any-finding counts include medium evidence and are reported separately. Partial/unavailable PDFs stay in their labelled denominators and make the affected group's targets incomplete. No model or production accuracy is measured.

Targets: detection >= 95%; false positives <= 2%. This small synthetic engineering set cannot establish a population false-positive rate of 2%.

Missed proof-of-payment and Ghostscript targets, plus missing invoice date coverage: filed at D06 T02 section 8 (console plan commit 20f4747f). This filing is not a repair or target-attainment claim.

| Group | Detection | False positives | Complete coverage | Any finding | Detection target | FP target |
| --- | --- | --- | --- | --- | --- | --- |
| all | 3/7 (42.9%) | 0/7 (0.0%) | 13/14 | 8/14 | incomplete | incomplete |
| type: proof-of-payment | 1/5 (20.0%) | 0/4 (0.0%) | 9/9 | 6/9 | missed | met |
| type: bank-letter | 1/1 (100.0%) | 0/1 (0.0%) | 2/2 | 1/2 | met | met |
| type: invoice | 1/1 (100.0%) | 0/2 (0.0%) | 2/3 | 1/3 | incomplete | incomplete |
| generator: Chromium-Skia | 0/0 (not measured) | 0/2 (0.0%) | 1/2 | 1/2 | not measured | incomplete |
| generator: Ghostscript-10.06.0 | 0/4 (0.0%) | 0/2 (0.0%) | 6/6 | 4/6 | missed | met |
| generator: project-pdf-writer | 3/3 (100.0%) | 0/3 (0.0%) | 6/6 | 3/6 | met | met |

| Document | Label | Verdict-level flag | Findings | Coverage |
| --- | --- | --- | --- | --- |
| eval/sets/pdf-forensics/proof-of-payment-genuine.pdf | genuine | false | none | complete |
| eval/sets/pdf-forensics/proof-of-payment-doctored.pdf | doctored | true | document.forensics.revisions:high, document.forensics.fonts:high | complete |
| eval/sets/pdf-forensics/bank-letter-genuine.pdf | genuine | false | none | complete |
| eval/sets/pdf-forensics/bank-letter-doctored.pdf | doctored | true | document.forensics.revisions:high, document.forensics.fonts:high | complete |
| eval/sets/pdf-forensics/invoice-genuine.pdf | genuine | false | none | complete |
| eval/sets/pdf-forensics/invoice-doctored.pdf | doctored | true | document.forensics.revisions:high, document.forensics.fonts:high | complete |
| test/fixtures/pdf-forensics/chromium-invoice.pdf | genuine | false | none | dates: unavailable: the document states no payment date |
| test/fixtures/pdf-forensics/chromium-pop.pdf | genuine | false | document.forensics.producer:medium | complete |
| test/fixtures/pdf-forensics/gs-edited-pop.pdf | doctored | false | document.forensics.revisions:medium | complete |
| test/fixtures/pdf-forensics/gs-genuine-pop.pdf | genuine | false | none | complete |
| test/fixtures/pdf-forensics/gs-logo.pdf | genuine | false | none | complete |
| test/fixtures/pdf-forensics/gs-modified-pop.pdf | doctored | false | document.forensics.dates:medium | complete |
| test/fixtures/pdf-forensics/gs-pasted-image.pdf | doctored | false | document.forensics.overlay:medium | complete |
| test/fixtures/pdf-forensics/gs-substituted-font.pdf | doctored | false | document.forensics.fonts:medium | complete |
