# Domain Connect publication (D07 T04 §5)

These artefacts make IsItLegit's Domain Connect template real. Publication is the operator's step (section 5's checklist); the code refuses to offer Connect until a provider's Query Supported Template answers yes for this exact template.

1. Submit `template.json` to the Domain Connect template registry (the public templates repository), with `txtValue` as the template's one variable: the whole verification value (`isitlegit-verify=<token>`) the provider writes into the `_isitlegit` TXT record.
2. Publish the signing public key: one TXT record at `_domainconnect.isitlegit.co.za` carrying the value in `public-key.txt`. The matching private key never enters this repository: keep it in the 1Password Conclave vault and set it as the Worker secret `DOMAIN_CONNECT_PRIVATE_KEY` (PKCS8 PEM) in the same sitting.
3. Onboard one real DNS provider and record its Query Supported Template yes (provider, date) in D07 T04 §5. That recorded answer is the readiness evidence; until then every domain falls back to the manual TXT and emailed-code ways.
