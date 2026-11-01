# Receiving chains behind a filtering gateway (D02 T02 §6)

Status: decided 2026-10-31 by the checks lane in an unattended run (the industry-standard option, recorded with its reversal cost); revised the same day after §6's round 1 review, which showed that a chain learned from forwarded originals could be planted by a member attaching a crafted file. Owner: D02 T02 §6.

## The problem

An organisation's receivers are learned from its verified domains' MX records (`src/auth/receivers.ts`). When the MX points at a filtering gateway in front of Microsoft 365 or Google (Microsoft documents this as "enhanced filtering for connectors"; Google calls it an inbound gateway), only the gateway is learned. The mailbox provider then receives every message from the gateway and writes its own hops and its `Authentication-Results` stamp above the gateway's, outside every learned receiver, so `trustedAuthResults` (`src/checks/auth-results.ts`) finds no boundary and the check reads `no-boundary` for every message the organisation forwards.

## Where a chain comes from

A chain (this gateway hands this organisation's mail to this provider) is read from the organisation's own DNS, which a verified claim already proves it controls, never from a message:

- The gateway is the claim's MX, as receivers are learned today.
- The provider is what the claimed domain's own records name: Microsoft 365's domain verification record (`MS=ms` and digits, which a tenant requires to accept the domain) or its SPF include (`include:spf.protection.outlook.com`), and Google Workspace's SPF include (`include:_spf.google.com`). A site verification record, or a lookalike include, names nothing.

Not chosen: learning the chain from the organisation's forwarded originals (the first design). A member's forward can carry any attached file as its original, so a crafted file with invented provider hops would have set trust for every later case; a message can never prove a chain. Also not chosen: the provider's connector settings (Microsoft Graph or Exchange Online's `Get-InboundConnector`, Google's Admin SDK), which need credentials for the organisation's tenant; D02 T02 §9 records where a gateway's ranges come from when its SPF does not name them.

Reversal cost: a chain read from connector settings instead replaces `chainsForOrg`'s discovery only; the table, the selector and its tests stay.

## How each message is judged

A chain proves nothing about a message on its own. The message's provider ingress hop decides: Microsoft 365's is the topmost hop received by `*.mail.protection.outlook.com`, Google's the topmost received by `mx.google.com`, every hop above it the provider's own. That hop's connecting address, in parentheses after the greeting (`from <greeting> (<address>) by ...`, IPv4, IPv6 or `[IPv6:...]`), is the address the provider saw the connection come from, written above anything the message brought. Only when the gateway's rules pass that address is the provider's stamp read, with the provider alone as the receiver, so the zone ends at the gateway's hop and a header below it is never read. A greeting name, an `X-` header or an `authserv-id` is never evidence; a message handed to the provider directly keeps `no-boundary`.

## The gateway's addresses

Rules in evaluation order (RFC 7208 4.6.2): its MX hosts' addresses first (its own), then its sending domain's SPF (the MX hosts' registrable domain) with each term's qualifier, so only a `+` term passes an address and a `-`, `~` or `?` term stops it; an `include` matches when its own rules pass and then its qualifier decides (`-include:x` excludes what x passes, RFC 7208 5.2); `+all` proves nothing; `exists` and `ptr` make the rules incomplete. Google's inbound-gateway setting takes the gateway's addresses as configured ranges; the published SPF is the public source of the same ranges. A vendor that publishes no SPF for its relays cannot be proven this way (D02 T02 §9).

## Lookups

At most 10 DNS lookups per case for every gateway together, none started after two lookups' time (`CHAIN_DEADLINE_MS`), at most 256 rules kept; answers are validated (each address parses as IPv4 or IPv6, a CIDR's prefix is in range). A proven chain's rules are kept in `org_receiving_chains` and used for 24 hours with no DNS, then read again. Discovery that a failed lookup, a limit or the rule count left incomplete stores the chain `unverified`, for each provider the claim names (both, when even its records could not be read); the case reads `chain-unverified`, a reason distinct from `no-boundary` (a proven bypass), and the next case tries again. A chain is proven only from complete discovery.

## Storage

Migration `0059_org_receiving_chains.sql` (the coordinator's number): the claim (a foreign key to `org_domains`, deleted with it), the organisation, the gateway's pattern, the provider, `proven` or `unverified`, the rules (JSON) and when they were read. A gateway that is no longer the claim's receiver, or a provider the claim no longer names, keeps no row.

## Out of scope

A receiver other than Microsoft 365 or Google that writes its header between its own hops stays untrusted: nothing it writes can be proven its own. Configured relay ranges are D02 T02 §9.
