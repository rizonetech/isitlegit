# Configured gateway relay ranges

D02 T02 §9. Design date: 4 November 2026. The operator decision recorded in `todo/02-checks/TODO-02-headers-and-sender.md` on 2 November approves admin-entered ranges that are verified and revocable. This document specifies that choice; it does not claim the feature is implemented. Cross-lane settings ownership and this verification mechanism await the coordinator's recorded decision before this design is complete.

## Owning layer and trust source

The organisation's receiving-chain configuration owns the ranges. `src/auth/receiving-chains.ts` assembles the per-case chains, and `src/checks/receiving-chain.ts` selects the provider's trusted header boundary. The existing DNS-discovered `org_receiving_chains` table remains a cache of discovery, not a place for user configuration. Configured revisions live separately so discovery cannot overwrite an administrator's configuration or revive a revoked revision.

An organisation administrator may propose public IPv4 and IPv6 CIDRs for one verified domain claim, its currently discovered gateway and its DNS-named provider (Microsoft or Google). Entry is not verification. Neither an uploaded original, a forwarded message, a header, a model result, an arbitrary URL nor a checker's assertion can verify ownership of those relay addresses. The configured ranges must be a subset of gateway egress ranges independently published by the gateway operator. A platform reviewer checks the gateway's official documentation using a separately established provider identity, records the source URL, retrieval date and digest of the reviewed range set, and approves exactly the proposed revision. A tenant-provided document is a request for review, never proof by itself. When an independent source is unavailable or ambiguous, the revision stays unverified and cannot confer trust.

This deliberately supports gateways that publish relay ranges outside SPF. It does not promise automatic verification for a gateway that publishes no independent evidence. No API token, tenant connector credential or message content is collected for this feature. A future automated provider connector can replace the verification step through its own reviewed section; it cannot silently change this trust source.

## Configuration lifecycle

The storage contract is a revision with organisation ID, verified claim ID, gateway identity, provider, canonical CIDRs, revision number, state (`pending`, `verified`, `rejected` or `revoked`), creation actor/time, verification actor/time, source URL/digest/retrieval time and a bounded reason code. A platform reviewer is a distinct authenticated role behind the existing administrative access controls; a tenant admin cannot approve a revision. The API enforces that separation, including when one user has more than one membership. Audit entries store actions, actor, revision and reason, never raw email or credentials.

All input passes an explicit schema before use. Accept at most 64 CIDRs per revision, canonicalize network addresses, deduplicate exact ranges, reject host bits rather than silently widening them, reject a prefix of zero, and reject any range overlapping non-global or reserved space. Do not accept hostnames, URL fetch targets or mixed address-family spellings as CIDRs. The synthetic documentation networks below are test data only and never admitted by production validation. Empty input is a removal action, not an allow-all range.

Creation persists a pending revision and returns the stored representation. Verification is a compare-and-swap against that same immutable revision and still-verified domain claim. Repeating a request with its idempotency key returns the prior outcome; conflicting payloads fail explicitly. A stale editor or reviewer receives a conflict and reloads the current revision. Rejected verification includes a safe reason and permits a corrected pending revision. Failed writes return failure and leave the previous database state intact.

An edit creates a new pending revision and immediately retires configured trust in the prior revision, even when only one address changes. Revocation disables configured trust in the same transaction as its audit event and is idempotent. Re-enabling requires a fresh pending revision and independent verification. Removing or unverifying the domain claim prevents every configuration read and late verification write; claim deletion cascades its range records. Tenant closure follows the same purge boundary. A changed gateway or provider identity also makes the old binding ineligible.

## Consumption, precedence and revocation

`chainsForOrg` reads current configuration state on each invocation, scoped by organisation and still-verified claim. A verified current revision is the exclusive address source for that claim/gateway/provider tuple. Its ranges replace, rather than union with, the DNS-discovered address rules. The provider's ingress peer must still match those ranges and all existing header-boundary rules still apply. A range match is provenance for reading the provider's authentication results, never a verdict by itself; the deterministic floor and evidence rules stay unchanged.

A pending, rejected or revoked current configuration is an explicit hold on that tuple: it returns an unverified chain and must not fall back to a cached discovered rule. This avoids a revoked configured address continuing to confer trust through a matching SPF cache entry. Restoring automatic DNS discovery is a separate, explicit administrator action with persisted read-back and audit; it deletes the active override, invalidates the corresponding discovery cache and requires fresh complete discovery before automatic trust returns. A configuration read failure returns unverified, never fallback success.

Configured revisions are never copied into the 24-hour discovery cache. Edit, revoke, claim removal and restore-automatic operations invalidate that tuple's cached discovery in their database transaction. Each new checks invocation, including workflow retries, reads current state. A frozen case view already used for completed evidence remains historical evidence with the source revision recorded; revocation does not rewrite a past report. An invocation that has not stored its authentication evidence must compare the configuration revision before publishing it and retry under the current revision on mismatch. Tests exercise an edit or revoke between read and persistence, not only sequential calls.

## Settings and review surfaces

The member settings page needs entry, edit, remove, restore automatic discovery and current stored-state read-back, with a verified-domain/gateway/provider selector and the exact pending or verified revision. It explains that entered ranges do not become trusted until verified. Confirmation describes the immediate loss of configured trust on edit/removal and the separate effects of restoring automatic discovery. Empty, saving, saved, validation-error, conflict, verification-pending, rejected, revoked, failed-read and retry states must be designed. Tenant members without administration rights can neither mutate nor inspect another tenant's configuration.

The platform review surface lists pending revisions, exposes the proposed binding and independently established source record, and offers approve or reject with a reason. It must refuse stale revisions, unverified/deleted claims, an unauthenticated reviewer and tenant-admin self-approval. It never renders supplied URLs as a server-side fetch instruction. Both surfaces follow `design/SPEC.md`; their section references and approved design treatment are required before §9 can be stamped. The coordinator owns this cross-lane assignment.

## Synthetic acceptance example

Fictional Juniper Workshop owns `juniper-workshop.example`. Its MX is `ingress.mailshield.example`, resolving to `192.0.2.10`. Its DNS names Microsoft 365 as its mailbox provider. Fictional Mailshield publishes `198.51.100.0/28` as its egress range in an independent synthetic provider record, but no SPF record names it. The provider's ingress hop records peer `198.51.100.7`. The production IP validator is replaced by a test-only fixture adapter for these reserved documentation ranges; production validation still rejects them.

Before verification, that peer cannot establish configured trust. After an independent reviewer approves the exact current revision, `chainsForOrg` returns the configured range and the selector reads only the provider's authentication headers above the gateway boundary. A forged result below that boundary remains ignored. After edit or revoke, the same peer cannot establish trust, even if a pre-existing discovery cache contains it. A peer outside the approved range, a different organisation, a removed claim, an old revision and a forged approval all fail. Restoring automatic discovery still cannot prove this no-SPF egress peer.

## Requirement coverage and delivery

| Requirement | Implementation owner | Falsifiable acceptance |
| --- | --- | --- |
| Canonical bounded proposals and organisation/claim binding | D02 T02 §10 | Reject zero-prefix, reserved-space overlap, malformed/host-bit ranges, 65 ranges and foreign/unverified claims; round-trip a valid pending revision. |
| Independent approval, rejection, version conflicts and audit | D02 T02 §10 | Tenant self-approval and stale approval fail; exact platform approval and safe rejection persist with one audit event. |
| Edit, revoke, restoration and deletion lifecycle | D02 T02 §10 | Read-back proves state, version and cache invalidation; retry is idempotent; removed claims cannot be revived by a late approval. |
| Exclusive precedence and provider boundary | D02 T02 §11 | Verified no-SPF egress succeeds; SPF-only address fails under an override; forged lower headers remain untrusted. |
| Fail-closed reads, revoked cache and in-flight races | D02 T02 §11 | Read failure, pending/revoked override, cross-tenant binding and revision changes before evidence persistence cannot publish configured trust. |
| User/admin settings and platform review controls | Coordinator assignment pending | Surface tests must exercise entry, edit, revoke, restore automatic, review, refusal, conflict, read-back and retry against real persisted revisions. |

The final row is an explicit unresolved design dependency, not a placeholder that permits completion. The coordinator must assign resolving sections and the approved surface treatment; §9 remains open until the table and those contracts agree. The two checks-owned sections are filed in the existing headers-and-sender TODO rather than creating a duplicate subject. Migration numbers are allocated by the coordinator before implementation.

## Decision cost and reversal

This choice adds no model calls or external-service spending. Independent human verification trades onboarding speed for a reviewable trust source; its staffing cost is proportional to proposed revisions. Reversal to provider-connector verification changes the verifier and consent surface, keeping immutable proposals and the consumer's version checks. Removing the feature revokes all overrides, deletes their active configuration, invalidates discovery caches and restores fresh automatic discovery through the normal API; historical audit/evidence provenance remains under existing retention rules. No direct database write bypasses the lifecycle API.
