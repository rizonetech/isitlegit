# TODO-00 -- Root Index

Domains in allocation order. Execution order lives in the dependency graph (`todo/implementation-plan.md`), not here.

| Domain | Scope |
| ------ | ----- |
| `00-workspace` | Repository, scaffold, CI, Cloudflare resources, Meta smoke test |
| `01-intake` | Email and upload intake, MIME parsing, voice decoding, outbound mail |
| `02-checks` | Deterministic evidence: headers, sender, domains, attachments, reputation |
| `03-vision` | Model client, rendering, Muse Spark reading, SAM 3.1 logos, page screening on Spark |
| `04-agent` | Verdict agent, citation validator, floor, injection defence, walkthrough |
| `05-trust` | Protected identities, counterparty checks, alerts, impersonation monitor |
| `06-invoice` | Invoice fraud, supplier ledger, payment document check |
| `07-app` | Auth and tenancy, report page, dashboards, admin console, marketing site |
| `08-eval` | Eval datasets, runner, metrics, results |
| `09-launch` | README, CONTRIBUTIONS, demo video, submission |
| `10-media` | Promo and explainer videos for YouTube (Remotion in `media/`), the uncoordinated media lane |
| `99-manual` | Operator-only work: accounts, keys, DNS, consents |

## Active TODOs

- `00-workspace/TODO-01-repo-and-scaffold.md`
- `01-intake/TODO-01-email-intake.md`
- `01-intake/TODO-02-outbound-mail.md`
- `01-intake/TODO-03-upload-and-voice.md`
- `02-checks/TODO-01-evidence-core.md` (reopened 2026-10-31 for §3, check outcomes stored per case)
- `02-checks/TODO-02-headers-and-sender.md`
- `02-checks/TODO-03-domains.md`
- `02-checks/TODO-04-attachments.md`
- `02-checks/TODO-05-hidden-text.md`
- `02-checks/TODO-06-reputation.md`
- `02-checks/TODO-07-links.md`
- `03-vision/TODO-02-vision-pipeline.md`
- `03-vision/TODO-03-sam-logos.md`
- `03-vision/TODO-04-glimmer.md`
- `04-agent/TODO-01-verdict-agent.md`
- `05-trust/TODO-01-protected-identity.md`
- `05-trust/TODO-02-counterparty-checks.md`
- `05-trust/TODO-03-closed-loop-verification.md`
- `05-trust/TODO-04-impersonation-monitor.md`
- `06-invoice/TODO-01-invoice-fraud.md`
- `06-invoice/TODO-02-payment-documents.md`
- `07-app/TODO-01-design-system.md`
- `07-app/TODO-02-auth-and-tenancy.md`
- `07-app/TODO-03-report-page.md`
- `07-app/TODO-04-member-console.md`
- `07-app/TODO-05-admin-console.md`
- `07-app/TODO-06-marketing-site.md`
- `07-app/TODO-07-demo-organisations.md`
- `07-app/TODO-08-app-essentials.md`
- `07-app/TODO-09-report-follow-ups.md`
- `08-eval/TODO-02-runner-and-results.md`
- `08-eval/TODO-03-frontier-experiments.md`
- `09-launch/TODO-01-hardening.md`
- `09-launch/TODO-02-submission.md`
- `10-media/TODO-01-channel-videos.md`
- `99-manual/TODO-01-day0-accounts.md`
- `99-manual/TODO-02-event-operator.md`

## Completed TODOs

- `04-agent/TODO-02-walkthrough.md` (2026-11-03: the contained Muse Wonder walk, canary credentials, the evidence chain, the trigger and cache, one URL policy, and the no-walkthrough ablation arm)
- `03-vision/TODO-01-meta-client.md` (2026-10-29: every model call goes through the gateway with a budget reservation, a trace, validated structured output and untrusted blocks)
- `08-eval/TODO-01-datasets.md` (2026-11-01: a 55-message public sample, a 160-message South African synthetic set and a 60-message challenge set of matched attack and control pairs, each label annotated and read twice, sources and licences recorded in `eval/DATASETS.md`; challenge scoring is D08 T02 §2)
