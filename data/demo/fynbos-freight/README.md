# Fynbos Freight, the demo company

Fynbos Freight is a fictional Cape Town road-freight company. It is the one company every lane's demos and tests use, so the demo video, the eval sets, the checks' fixtures, the trust network's protected identity and the marketing site tell the same story. It is not a real business, and every identifier in `brand.json` is chosen so it cannot belong to one.

## What is here

| File | What it holds |
| ---- | ------------- |
| `brand.json` | The company facts: names, the impossible registration number, address, domains and lookalikes, mailboxes, roles, the fictional bank and account, the hero case, colours and typeface |
| `logo/mark.svg` | The protea bloom, on light backgrounds |
| `logo/mark-on-dark.svg` | The bloom for dark backgrounds |
| `logo/icon.svg` | The app icon: the simplified bloom on fynbos green |
| `logo/lockup.svg` | Bloom and wordmark together (the wordmark is set in Manrope) |

## How to use it

- Read `brand.json` instead of retyping a fact, so a change reaches every lane at once.
- Use the `.example` domains in tests and the `demo.isitlegit.co.za` domain only where mail must really arrive.
- Give people roles (Accounts, Dispatch, Director), never invented personal names.
- Need a VAT number? Build one in the test with a failing check digit and say so: a valid one could be a real vendor's.

The logo is direction A1 from the logo mockups, chosen by the operator on 2026-10-31.
