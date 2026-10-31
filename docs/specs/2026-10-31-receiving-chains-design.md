# Receiving chains behind a filtering gateway (D02 T02 §6)

Status: decided 2026-10-31 by the checks lane in an unattended run (the industry-standard option, recorded with its reversal cost). Owner: D02 T02 §6.

## The problem

An organisation's receivers are learned from its verified domains' MX records (`src/auth/receivers.ts`). When the MX points at a filtering gateway in front of Microsoft 365 or Google (Microsoft documents this as "enhanced filtering for connectors"; Google calls it an inbound gateway), only the gateway is learned. The mailbox provider then receives every message from the gateway and writes its own hops and its `Authentication-Results` stamp above the gateway's, outside every learned receiver, so `trustedAuthResults` (`src/checks/auth-results.ts`) finds no boundary and the check reads `no-boundary` for every message the organisation forwards.

## What counts as proof

A chain (this gateway hands this organisation's mail to this provider) is trusted only from evidence that neither the sender nor the forwarder can write:

- The provider's ingress hop is written by the provider on receipt, above anything the message brought with it. It is not always the topmost: Microsoft 365 writes internal hops above it (`*.prod.outlook.com`, HTTPS delivery) and Google writes address-only ones, so the provider's hops are walked down, its own hosts and address literals passed over, to the first hop whose `by` is the provider's and whose connecting address is outside it. That address, in parentheses after the greeting (`from <greeting> (<address>) by ...`, IPv4, IPv6 or `[IPv6:...]`), is the one the provider saw the connection come from. No such hop, or one without an address, is unprovable.
- The gateway's own addresses are those it receives on and those it sends from, which can differ: its MX hosts' A and AAAA records, and the addresses its sending domain (the MX hosts' registrable domain) publishes in SPF, followed through `ip4`, `ip6`, `a`, `mx` and `include` within RFC 7208's limit of 10 DNS lookups (section 4.6.4). Google's inbound-gateway setting takes the gateway's addresses as configured ranges; the published SPF is the public source of the same ranges. A vendor that publishes no SPF for its relays cannot be proven this way and needs its connector settings (D01 T01 §21).

A chain is proven by a message whose provider ingress hop is written by Microsoft 365 or Google (by their host patterns, as §1 reads them) and whose connecting address is one of the gateway's addresses. Never evidence: the greeting name (the connecting host writes it; §1 round 2), an `X-` header, an `authserv-id` (RFC 8601 section 7.1: anyone can write one), or a header lower in the message.

## Where the evidence comes from

Chosen: the organisation's own forwarded originals. Every case already holds the original's headers in its stored parse summary, and the checks step already learns receivers again when they are stale. When the organisation has a gateway receiver, the checks step (beside `receiversForOrg` in `src/pipeline/analysis-workflow.ts`) finds the case's provider ingress hop and, if its address is one of the gateway's, stores the chain for the claim whose receiver the gateway is. The frozen view carries the chains (`tenant.chains`), and `trustedAuthResults` and `receiverZone` both take them, so `auth.results`, the alignment check and the ARC verdict read the same boundary. The first such message is still judged `no-boundary` (the chain is learned while it is read, and only a later case uses it), so no message is ever trusted by the evidence it brings itself.

Not chosen: the provider's connector settings (Microsoft Graph or Exchange Online's `Get-InboundConnector`, Google's Admin SDK). They state the configuration directly, but the product holds no credentials for an organisation's tenant and asking for them widens what it can read; D01 T01 §21 records that decision as the operator's.

Reversal cost: moving to connector settings later replaces the learning step only. The table, the selector's use of a chain and the tests of a stored chain stay; the forwarded-original learner would be removed or kept as a fallback.

## Storage

Migration `0059_org_receiving_chains.sql` (the coordinator's number) adds `org_receiving_chains`: the claim it was learned under (a foreign key to `org_domains`, deleted with it), the organisation, the gateway receiver's pattern, the provider kind (`microsoft` or `google`), when it was learned and when it was last seen. One row per claim, gateway and provider.

## Lookups

At most 10 DNS lookups per gateway per case, each `MX_DEADLINE_MS`; answers are validated (each address parses as IPv4 or IPv6, a CIDR's prefix is in range). The gateway's addresses are kept in the chain row with when they were fetched and used for 24 hours. A lookup that fails or times out gives `chain-unverified`, a reason distinct from `no-boundary` (a proven bypass), stored in the evidence; the next case tries again.

## Staleness

A chain is dropped when the claim's receivers are learned again and the gateway's pattern is no longer among them (the MX moved), and when it has not been seen again for `RECEIVERS_STALE_MS` (30 days). A case that proves it again updates its last-seen time only when its ingress hop's date is later than the one stored, so replaying an old case renews nothing. A dropped chain makes the check read `no-boundary` again until a new proof, never a trust carried over.

## How the selector uses it

With a chain stored and the message's ingress hop written by its provider, that hop's connecting address must be one of the gateway's addresses at the time of the check. Then the provider's zone is read as §1 reads Microsoft 365 and Google: its topmost stamp, read down to the first hop another host wrote, the gateway's hops counting as the receiver's. A message the provider received from any other address (delivered to it directly, skipping the gateway) keeps `no-boundary`.

## Out of scope

A receiver other than Microsoft 365 or Google that writes its header between its own hops stays untrusted: nothing it writes can be proven its own, since no provider's recorded address stands above it. A source for that proof, if one is found, is a section of its own.
