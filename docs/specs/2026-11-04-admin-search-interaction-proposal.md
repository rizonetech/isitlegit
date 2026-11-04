# Admin search interaction proposal

D07 T05 §7, 2026-11-04. Author assessment for the coordinator, not an approved X1 change. Keep the existing Search/Enter flow and defer typeahead: the current source and local observation establish its interaction cost, while deployed latency, operator demand and a representative organisation workload remain unmeasured. The coordinator's disposition is pending. No product interface, authentication, query semantics or historical review receipt changes in this proposal.

## Existing contract

`src/web/pages/admin-view.tsx` renders a labelled Search organisations GET form, the visible hint Name, verified domain or organisation ID, a Search button and Enter submission. The query is visible in `/admin?q=...`; both CSV links carry that same query. A neutral no-match state repeats the query and offers Clear search. The ordinary GET works without scripts. Existing phone and desktop browser checks cover both themes, accessible names, keyboard submission, clear recovery and overflow.

`overviewRows` in `src/web/pages/admin.tsx` matches literal name, ID or verified domain, escapes SQL wildcard characters, binds parameters and uses verified-only `EXISTS` so multiple matching domains do not duplicate an organisation. A pending domain is not a search match. Both HTML and CSV use that reader. Access and JWT verification remain the boundary for the cross-organisation admin surface; this is not a member-search API. Existing `test/web/admin-page.test.ts` exercises verified-only matching, uniqueness, hostile query strings and table/CSV equivalence. The browser fixture used below does not exercise that authentication or D1 query layer.

The original suggestion is preserved in `docs/reviews/07-app/D07-T05-s4.md`: remove explicit submission for initial matches and consider p95 at or below 500 ms after typing stops. That number is unmeasured, is not an accepted requirement and is not claimed achieved. The review's comparison to another product is not a measured competitor benchmark here. Section4's genuine reconciliation remains about its original name/domain/ID contract and does not approve this proposal.

## Local observation and limits

Reproduce with `taskset -c 9 pnpm exec vitest run test/node/admin-browser.test.tsx --project browser -t 'measures explicit search request cost'`. The test serves the actual `OverviewPage` and shipped assets from a local synthetic server with two organisation rows. After initial page load, it types Plain with a configured 50 ms inter-character delay, observes requests for a further 1,000 ms, presses Enter, waits for navigation and checks the matching visible organisation and both CSV query links. Each request to `/admin` is counted; static assets and the initial page load are excluded. The assertions would fail if typing generated a request or Enter did not submit exactly once.

Observed 2026-11-04 at source baseline `0e03e3e8cc6fe9a3f52dd978c55f3e2ebdcb303c`, with this new measurement test and no admin product-source changes:

| Viewport width | Synthetic rows | Requests before Enter | Explicit submissions | Requests after Enter |
| --- | --- | --- | --- | --- |
| 360 px | 2 | 0 | 1 | 1 |
| 1280 px | 2 | 0 | 1 | 1 |

Both observations passed in the one targeted test. Its stdout emits `admin-submit-request-cost-v1` with these inputs and counts; the retained local log is `/tmp/console-admin-proposal-measure.log`. These counts are measured browser-fixture behavior. The observation window and typing delay are test inputs, not performance targets. No production response time, p95, database load, authentication timing, billing cost or competitor result was measured. No live request, mail, capture or model call was made.

The source shows that a normal overview request also reads spend, incidents, latency, counts and per-organisation details. This is a static dependency observation, not a measured cost. Blindly adding a typing trigger to the full overview could repeat those reads. A future proposal must measure representative authenticated requests before setting latency or load targets. The existing request-count observation alone does not establish a production speed problem.

## Conditional future treatment, not authorization

If the coordinator later authorizes design, keep the explicit Search button, Enter path, ordinary GET fallback and existing hint. A search field remains a search field feeding a table, not a suggestion combobox. Typing may schedule an incremental results request after a documented debounce; composition input must not submit incomplete IME text. Enter cancels a pending debounce and submits immediately. Clear search cancels pending requests and restores the unfiltered table.

A hypothetical five-character query typed without a pause longer than the chosen debounce could make one automatic request; with a qualifying pause after each character it could make five. These are derived examples, not measurements or a chosen debounce setting. Explicit submit makes one request in the observed sequence. Any minimum query length, debounce interval or request cap needs its own justified design and tests; none is introduced here.

Preserve literal name/ID/verified-domain matching and unique rows through a shared server reader. Keep Access/JWT validation on every incremental request and prevent shared caching of admin data. Do not expose pending domains, bypass the admin gate, cache sensitive rows in browser storage or introduce mutation through search. A dedicated result response may avoid unrelated overview reads, but its endpoint, ownership and actual cost require separate design and measurement.

Only the newest successful query may replace results. Abort superseded work and verify request sequence before applying a response. Keep typed text while waiting, clearly mark loading, retain the last successful results with a failure/retry message on transport or server failure, and navigate authentication refusals through the existing sign-in/refusal flow. Retry must preserve the failed query. Never display an outage as an empty result. The table, row counts, both CSV links, canonical address and cap-change return query must agree on the applied query, including after errors, Back and reload; draft text must not silently relabel old results or export them under a different query.

Keep keyboard focus in the search field during an incremental update, retain table headings and named controls, and announce the applied result count through a polite status region without moving focus or announcing each keystroke. Preserve visible labels, tokens, both themes, phone wrapping and reduced-motion behavior. Empty results retain neutral wording and Clear search. Scripts disabled retain the full GET form. A future implementation section must test delayed and reversed responses, retries, authentication expiry, IME input, Enter, CSV consistency, cap-change return state, history and accessibility before delivery.

## Decision and reversal

Recommendation to coordinator: **defer typeahead and keep the approved Search/Enter treatment**. This limits unsupported benchmark scope under evidence-necessity-first and preserves the delivered admin search while core release gates remain open. It does not claim typeahead has no benefit; that benefit is unknown here. No new implementation section is filed unless the coordinator chooses authorize-design.

Coordinator disposition: pending, requested with this exact committed proposal. This section remains unstamped until a real disposition is recorded and the required combined review can run after REVIEW-JOURNAL-HOLD clears. The plan self-review at `0e03e3e8`, digest `12606f2fcfcd5799`, found no gaps; it is not implementation acceptance.

Reversing a defer decision requires an approved X1 treatment, a separately owned implementation section and its regression/review gates. No data migration or product rollback is needed because this proposal changes no product behavior. If a future implementation is authorized, its reversal must preserve ordinary GET, query URLs and CSV semantics. Existing section4 findings and receipt remain byte-exact.
