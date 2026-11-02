## Completion review: astra (`gpt-6-astra` via `codex`)

- Writer: muse
- Run: 2026-11-02T22:03:24Z
- Candidate: 75887cfecdcffa7c2d17ba25248c801a0f49cd25
- Effort: medium
- Pin: ce29c18a398871b473c634630dbf588c04ec5ef2
- Lines: 43
- Digest: fe99aacf10193b0e

Candidate `75887cfecdcffa7c2d17ba25248c801a0f49cd25` has completion gaps. The earlier lifecycle and delivery repairs are present, but several checked requirements remain incomplete.

Source and test inspection only; I did not run tests or verify the deployed service. No files changed. The existing deletion of `D05-T04-s5-completion.md` was left untouched; I read its committed version.

**Part 1: completeness**

| Required piece | Assessment and evidence |
|---|---|
| Settled investigations create persistent findings | **Present.** Workflow wiring at [workflow.ts:303](../../../src/monitor/workflow.ts#L303); organisation/host identity and persistence at [findings.ts:44](../../../src/monitor/findings.ts#L44). |
| Confirmed, unconfirmed and incomplete outcomes | **Present.** Separate wording at [monitor-view.tsx:30](../../../src/web/pages/monitor-view.tsx#L30); only confirmed findings enter alert selection at [findings.ts:177](../../../src/monitor/findings.ts#L177). |
| One alert, delivery recovery and refusal states | **Present in source.** Stable send key, duplicate reconciliation, failed/uncertain/refused persistence at [findings.ts:184](../../../src/monitor/findings.ts#L184); delivery warnings at [monitor-view.tsx:180](../../../src/web/pages/monitor-view.tsx#L180). |
| Alert facts, finding link, download button and screenshot | **Partly present; missing-in-scope.** Facts and both destinations exist, but the email contains no screenshot, only a link to it. See [findings.ts:190](../../../src/monitor/findings.ts#L190), against the checked requirement at [TODO:211](../../../todo/05-trust/TODO-04-impersonation-monitor.md#L211). |
| Findings list, first seen, selection, screenshot and evidence | **Present.** Selection reaches the page at [monitor.tsx:90](../../../src/web/pages/monitor.tsx#L90); detail and list at [monitor-view.tsx:102](../../../src/web/pages/monitor-view.tsx#L102). |
| Approved M6 structure and monitoring summaries | **Missing-in-scope.** The board places the list beside its detail panel and shows “Lookalikes watched” and “Parked or empty”. Implementation stacks detail above the list and substitutes lifecycle counts. No M6 deviation records this. Compare [Monitor.dc.html:26](../../../design/mockups/source/Monitor.dc.html#L26), [monitor-view.tsx:84](../../../src/web/pages/monitor-view.tsx#L84) and [SPEC.md:12](../../../design/SPEC.md#L12). |
| Accurate last/next-run information | **Missing-in-scope.** The page always promises “tomorrow at 03:00 SAST”, while the configured monitor runs at **06:15 SAST**. Before today’s run, “tomorrow” is also incorrect. [monitor-view.tsx:61](../../../src/web/pages/monitor-view.tsx#L61), [schedules.ts:8](../../../src/schedules.ts#L8). |
| Empty, not-yet-monitored and partial-run states | **Present**, at [monitor-view.tsx:60](../../../src/web/pages/monitor-view.tsx#L60) and [monitor-view.tsx:138](../../../src/web/pages/monitor-view.tsx#L138). Server rendering supplies the agreed loading treatment. |
| Read failures visibly distinguished from valid empty data | **Missing-in-scope.** A failed last-run query becomes “Not yet monitored”; failed evidence reads silently remove evidence; failed navigation-count reads become zero. These are outages presented as ordinary data. [monitor.tsx:49](../../../src/web/pages/monitor.tsx#L49), [monitor.tsx:59](../../../src/web/pages/monitor.tsx#L59), [member-shell.ts:54](../../../src/web/pages/member-shell.ts#L54). |
| Screenshot absence, loading failure and retry | **Partly present; missing-in-scope.** The initial R2 existence check supplies an unavailable message. If the subsequent image request fails, the bare image has no error/retry treatment. The previously filed P3 remains at [monitor-view.tsx:117](../../../src/web/pages/monitor-view.tsx#L117). |
| Markdown and PDF downloads, filenames and screenshot embedding | **Present.** Authenticated download responses at [monitor.tsx:155](../../../src/web/pages/monitor.tsx#L155); shared content and PDF generation at [takedown.ts:15](../../../src/monitor/takedown.ts#L15) and [takedown.ts:72](../../../src/monitor/takedown.ts#L72). |
| Registrar/network abuse contacts and unavailable-contact handling | **Present.** Role-based extraction and lookup fallbacks at [rdap-contacts.ts:65](../../../src/monitor/rdap-contacts.ts#L65). |
| Evidence-backed pack wording | **Missing-in-scope for some confirmed outcomes.** Every confirmed pack asserts use of the business’s “name and branding”. Pipeline confirmation can instead come solely from high-severity walkthrough evidence. That outcome does not establish this specific allegation. [takedown.ts:19](../../../src/monitor/takedown.ts#L19), [pipeline.ts:303](../../../src/monitor/pipeline.ts#L303). Derive the allegation from the supporting evidence. |
| No registrar/host contact by IsItLegit | **Present.** Pack generation returns downloadable content; instructions explicitly leave submission to the member at [takedown.ts:53](../../../src/monitor/takedown.ts#L53). |
| Dismiss reason, validation, cancellation and pending feedback | **Present.** Form, native disclosure cancellation and busy hook at [monitor-view.tsx:213](../../../src/web/pages/monitor-view.tsx#L213); server validation at [findings.ts:241](../../../src/monitor/findings.ts#L241). |
| Restore, dismissal persistence and controlled reopening | **Present.** Conditional reopening uses capture time and the dismissal timestamp; restore persists watching. [findings.ts:99](../../../src/monitor/findings.ts#L99), [findings.ts:257](../../../src/monitor/findings.ts#L257). |
| Mutation failure, redirect and persistence read-back | **Present in source.** Refusal/failure responses and redirect to a fresh list at [monitor.tsx:97](../../../src/web/pages/monitor.tsx#L97); happy-path read-back test at [monitor-page.test.ts:129](../../../test/web/monitor-page.test.ts#L129). |
| Authentication, tenant isolation and request-origin protection | **Present in source.** Session and active-organisation scoping protect reads and mutations; origin validation protects changes. [monitor.tsx:28](../../../src/web/pages/monitor.tsx#L28), [monitor.tsx:98](../../../src/web/pages/monitor.tsx#L98). |
| Registered identity privacy | **Present within the inspected feature.** Downloads read finding evidence and public RDAP data, not registered bank details. [monitor.tsx:189](../../../src/web/pages/monitor.tsx#L189). |
| Workflow failure persistence | **Present.** Exhausted findings failures use a retried partial-status write and propagate failure if that cannot persist. [workflow.ts:263](../../../src/monitor/workflow.ts#L263). |
| Required tests, phone layout and keyboard verification | **Missing-in-scope proof.** The four page tests cover basic listing, downloads/selection, dismiss/restore and empty state. They do not prove cross-tenant mutations, all anonymous endpoints, partial/E5 states, failed mutations, pending/cancel recovery, counts after dismissal or phone/keyboard behaviour promised at [TODO:213](../../../todo/05-trust/TODO-04-impersonation-monitor.md#L213). See [monitor-page.test.ts:79](../../../test/web/monitor-page.test.ts#L79). The refusal test also conditionally skips its refusal assertions at [findings.test.ts:154](../../../test/monitor/findings.test.ts#L154). |
| Live fixture detection and alert-arrival demonstration | **Missing-out-of-scope.** Explicitly owned by section 6 at [TODO:218](../../../todo/05-trust/TODO-04-impersonation-monitor.md#L218). |

The round-8 asynchronous-read regression test has been corrected in this candidate. I am not repeating that earlier finding.

**Part 2: excellence**

My strongest benchmark is **Netcraft Threat Detection and Takedown**, based on its documented combination of discovery, evidence collection, provider coordination and continuing monitoring. This is a product-fit judgment, not an independently measured ranking. [Netcraft platform](https://www.netcraft.com/platform), [takedown service](https://www.netcraft.com/platform/threat-detection-and-takedown).

- **In-scope:** IsItLegit needs more dependable evidence presentation: the promised email screenshot, recovery when the console image fails, allegations tied to actual evidence, and explicit read-outage states. These directly affect whether an owner can understand and act on a finding.
- **In-scope:** The approved investigation workspace and accurate scheduling information remain unfinished. These are existing commitments, not enterprise extras.
- **Out-of-scope:** Netcraft handles provider submissions, escalation and takedown operations. IsItLegit deliberately leaves those actions to the business; adding them would contradict this section’s boundary.
- **Out-of-scope:** Netcraft documents continuous monitoring, broader impersonation channels and anti-cloaking collection. Matching that discovery breadth belongs to monitoring/capture expansion, not section 5’s alert-and-pack completion. [Netcraft brand protection](https://www.netcraft.com/solutions/use-cases/brand-protection-and-monitoring).

COMPLETION: gaps

- Implemented: accurate daily 06:15 SAST run wording and the board summary counts in 09e38ba7
- Implemented: pack allegations derived from the supporting evidence in 09e38ba7
- Implemented: read failures surface as outages (last run, evidence, shell count) in 09e38ba7
- Implemented: finding detail image load-error recovery in 09e38ba7 (also closes the filed round 4 P3)
- Implemented: cross-tenant mutation refusal, anonymous endpoint refusal and counts-after-dismissal tests in 09e38ba7; the refusal assertions in test/monitor/findings.test.ts are unconditional there
- Implemented: alert screenshot travels in the linked pack PDF and on the console, and the stacked detail panel, both recorded as a Deviation in design/SPEC.md M6 (mail layer sends no attachments) in 09e38ba7
