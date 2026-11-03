# Archived first plan review for D05 T04 section 7

Moved here 2026-11-03: its closing OVERALL line did not use the dispatcher's verdict form, so a replacement pass was recorded in the section's findings file. The review itself is unchanged.

## Plan review: astra (`gpt-6-astra` via `codex`)

- Writer: muse
- Run: 2026-11-03T00:06:33Z
- Candidate: 1877c06316c87c53a86ef72cbebf2c194bea51c9
- Effort: medium
- Lenses: plan
- Pin: ce29c18a398871b473c634630dbf588c04ec5ef2
- Lines: 20
- Digest: 960312a5e2e1286a

**Plan lens: gaps.** Reviewed `trust-lane` at `1877c06316c87c53a86ef72cbebf2c194bea51c9`. No P1 findings; six P2 gaps.

1. **P2: Brand tokens have no defined source.** [Section 7](../../../todo/05-trust/TODO-04-impersonation-monitor.md#L252) says “each brand token” without choosing registered display names, verified-domain labels, or both. Specify derivation, normalization, minimum length, token limits and the no-usable-token outcome. Test exact queries from a stored fictional identity.

2. **P2: Query and response bounds are missing.** [The CT task](../../../todo/05-trust/TODO-04-impersonation-monitor.md#L254) defines no timeout, request/concurrency limit, response-byte or record limit, pagination policy, or query escaping. Specify schema validation, hostname normalization, multiline names, wildcard handling and malformed-name rejection. Test oversized, malformed and truncated responses as well as valid matches.

3. **P2: CT failure can fail the run or masquerade as success.** The plan defines no outage semantics. The [run’s catch](../../../src/monitor/run.ts#L438) marks thrown failures fatal; its [final outcome calculation](../../../src/monitor/run.ts#L428) would overwrite an earlier partial status unless CT incompleteness participates. Require a distinct CT unavailable/partial result, continued ordinary monitoring, persisted error/status read-back and next-day recovery. Test timeout, HTTP failure, invalid response, partial token failure and genuine zero matches separately.

4. **P2: CT merging has no dedupe, ownership or cap policy.** [candidatesForBusiness](../../../src/monitor/candidates.ts#L145) excludes owned domains and caps generated candidates at 300. Appending CT names bypasses those protections; appending then slicing can discard every CT discovery. Define canonical deduplication across tokens and generated candidates, exclusion of owned domains and their subdomains, and deterministic priority within the shared cap. Test an already-full generated list containing duplicate and owned CT results.

5. **P2: Daily production integration is unspecified.** The [daily run](../../../src/monitor/run.ts#L277) checks eligibility, builds generated candidates, then resolves them. [monitorDeps](../../../src/monitor/workflow.ts#L108) has no CT dependency. Name the production adapter and hook after eligibility but before candidate merging and DNS. Require the stubbed test to drive this actual path, prove a CT-only host reaches DNS and stored observations, and prove ineligible organisations make no CT request.

6. **P2: “New” names have no persistence or retry contract.** [Section 7](../../../todo/05-trust/TODO-04-impersonation-monitor.md#L244) defines neither a discovery window/checkpoint nor retention of discovered candidates. The [known-host read](../../../src/monitor/run.ts#L285) supplies history but does not add those hosts to the DNS list. Define how CT discoveries remain monitored, how outages avoid losing discoveries, and how retries avoid duplicates. Test discovery, a subsequent empty or failed CT response, and continued monitoring with persisted state.

The source-terms requirement is explicitly covered by the plan; `NOTICE.md` has no CT entry yet. Both behavioral `Done when:` statements can fail, but a helper-only happy-path test could satisfy them without delivering daily monitoring. No additional UI, Ctrl+K or undo control is required for this declared backend-only section.

Read-only review; no files changed or tests run.

PLAN: gaps  
OVERALL: P2, revise the plan before implementation.

- Planned: gaps 1 to 6 in the section amendment after 1877c063 (token source, query bounds, failure semantics, merge policy, production hook, discovery persistence)

