# D07 T04 section 30 completion disposition

Prepared 2026-11-04. This is an author disposition, not reconciliation approval. Preserve the original plan and combined completion in `docs/reviews/07-app/D07-T04-s30.md`. The combined completion at2026-11-04T11:31:31Z has digest `618693d38aea5f98`, exact candidate `a7de32b0cabd26dbc5af994209c041c38e5e61f0`, policy `codex-two-pass-v1`, pin `e46165fa04230623e480f729a98b1893e0a236ed`. Original plan candidate `64fa917fe293dc0dfa48eb6b6eb69caafea09110`, digest `f07541a34d6f3c0c`. No original bytes or verdicts are changed.

## Blocking finding 1: result-loading outage retention

Verified and unresolved. The approved companion promises retained displayed results and filters on outages. A valid calendar command currently uses full navigation before the canonical request reads list/stats/member data. A failure in that subsequent request replaces the old page. The current fault-injection browser test covers only the initial command and is insufficient proof of the complete promise. No passing-test claim resolves this gap.

Coordinator request `console-calendar-canonical-recovery` records the concrete proposed repair: one authenticated htmx request reads and renders the final Cases panel and updates its canonical URL, without a second result-loading navigation; old content remains on failure. This changes an explicitly approved navigation treatment and may need a broader shared-client integration than the existing narrow 5xx hunk, so coordinator authority is required before source changes. Preserve the unchanged user-facing recovery obligation, authentication/membership refusal behavior, ordinary filters and request ordering. No navigation repair is implemented or approved by this document. Do not invoke bounded reconciliation until this gap is actually resolved and verified.

## Blocking finding 2: implicit submission proof

Resolved in the test changes accompanying this disposition. Year Enter now waits for a matching real Cases response containing the changed draft year and no calendar action, awaits its completion, verifies status200 and both original dates. Separate From and To Enter coverage uses differing2028month/quarter drafts, waits for the submitted response and verifies the intended dates, absence of calendar action and resulting case identities. Both script modes are exercised. The two targeted browser tests passed after strengthening the assertions; no product change or weakened assertion was needed. Log: `/tmp/console-calendar-enter-proof.log`. These are local browser observations, not deployment proof.

## Additional suggestion: comparative benchmark

The reviewer proposes measuring retrieval tasks against Gmail. This is additional scope outside the unchanged calendar-control and recovery contract. Owner: console for task design with eval for measurement, coordinated before any future execution. Explicit disposition: deferred as a separate proposed benchmark; not performed, not claimed delivered and not a prerequisite substituted for either blocking finding. No measured superiority, median or p95 claim is made.

## Candidate and next verification

The current source remains the failed implementation candidate plus this proof correction; the original approved TODO contract, companion and SPEC remain unchanged. Once the authorized source repair and affected regression gates are complete, update this disposition with the exact descendant candidate and evidence and use the supported first bounded reconciliation. There is no additional ordinary review or replacement completion. A stamp remains prohibited until a genuine complete reconciliation verifies all original obligations and repairs.
