# Cases calendar ranges: proposed M1 companion

D07 T04 §30. Prepared 2026-11-04 under coordinator ACTIVITY-27-console. This is the exact proposed treatment for coordinator incorporation, not an approved SPEC change, implementation, review receipt or runtime claim. The coordinator owns `design/SPEC.md`; console owns this companion and its assigned section. Existing relay, admin reconciliation and verification integration holds remain unchanged.

## Controls and wording

Add a fieldset labelled **Calendar period** beside the existing Period, From and To controls in `Filters`. Keep the existing custom date inputs, active range text and Clear dates control. Use the existing input, select, button, focus and spacing tokens; wrap controls at 360px without horizontal scrolling in both themes.

| Control | Exact label or text | Submitted value |
| --- | --- | --- |
| First submit button in form order | Apply filters | No calendar action; applies the current ordinary filters and custom dates |
| Text input, numeric input mode, four-character maximum | Year | `calendar_year`, four decimal digits accepted by the existing real-date validator |
| Native select | Month | `calendar_month`, integers 1 through 12, displayed January through December |
| Submit button | Show month | `calendar=month` |
| Native select | Quarter | `calendar_quarter`, integers 1 through 4, displayed Q1 (January to March), Q2 (April to June), Q3 (July to September), Q4 (October to December) |
| Submit button | Show quarter | `calendar=quarter` |
| Hint | Choose a year and month or quarter, then show its cases. This fills From and To with SAST dates. | No value |

On a canonical page load the draft controls default to the current SAST year, month and quarter using the route's existing `now`. They are choices to apply, not a label describing the active range. The visible From/To fields and active range text remain the only applied date state. Do not infer a named mode from custom dates, add storage or restrict choices to recent months. A member can choose any calendar year whose resulting dates satisfy the existing date contract; this section does not expand that validator's accepted year range.

## Interaction and canonical address

The controls live in the existing GET filter form. Changing Year, Month or Quarter alone does not issue a request or change the range. Exclude these three draft fields from the form's automatic change trigger. Make the existing scripts-disabled Apply button a visible **Apply filters** button in both script modes and the first submit button in form order. This ordinary submit action is the implicit Enter default. Only the explicitly activated Show month or Show quarter button applies a named range. Normal search, Enter in the search field, other filter changes and custom date changes ignore the calendar drafts unless that calendar action is submitted. Ensure normal implicit submission cannot accidentally activate a calendar button; prove this in the browser test.

A calendar submission sends the current search, verdict, channel, checker, period and custom dates with its selected action and drafts. Resolve it in the authenticated `GET /cases` route after the existing membership and displayed-organisation checks. Validate the selected year and the selected month or quarter strictly, rejecting duplicate or unknown calendar actions and malformed selected values. The other draft selector is irrelevant to the selected action. Compute first and last calendar dates, validate both through the existing real-date contract, replace only `from` and `to`, reset pagination to page 1 and call `casesHref` with the resulting existing `CaseFilters`. Do not add calendar fields to persisted `CaseFilters` or change SQL date filtering.

A valid ordinary GET redirects with 303 to that canonical address. A valid htmx request uses the existing full-navigation convention, 204 with `HX-Redirect` to the same canonical address. Thus the resulting address contains only the established filters and inclusive SAST `from`/`to`, without temporary calendar parameters. From and To display those exact dates after navigation, and existing paging, Back, reload, empty-state wording and Clear dates work through the existing range behavior. Clearing dates keeps the other filters and returns to the retained fixed period. Manually changing either date after applying a named range remains a custom range until the member explicitly applies another calendar choice.

Examples: October 2026 gives `from=2026-10-01&to=2026-10-31`; Q4 2026 gives `from=2026-10-01&to=2026-12-31`; February 2028 ends on 29 February. Existing SQL interprets each as SAST midnight on the first day through the last included day, not UTC calendar boundaries. No new duration, result, spending or execution cap is introduced.

## Invalid, pending and recovery states

Invalid calendar input must not silently apply a default period, widen the list or overwrite the submitted custom dates. For ordinary GET render the Cases page with status 400, the original valid filters and From/To pair unchanged, the submitted calendar drafts retained and a visible alert **Choose a valid year and month or quarter.** beside the fieldset. Do not claim a calendar range was applied. For an htmx invalid request return 204 with `HX-Redirect` to the same submitted local Cases address so the ordinary GET renders that full validation page; never redirect the ordinary invalid GET again. Values remain escaped as normal JSX. Invalid selector values need an explicitly selected invalid option so the native select does not silently display a valid fallback. The member can correct the draft and submit again or use their unchanged custom dates. Existing authentication, membership and storage outage handling still take precedence over rendering case data.

Use the existing loading and request-failure behavior. A transport or server outage keeps the displayed list and filters and offers the existing retry; it is not an empty result. Calendar submission must carry the newest form values, including search text typed while its delayed request is pending. Prove a stale search response cannot overwrite a later calendar navigation. If the existing client request ordering does not support that safely, escalate the concrete shared-client change to the coordinator before touching `src/web/client/app.ts`.

A valid range with no matching cases uses the existing filtered-empty range explanation and clear controls. No calendar-specific success toast, hidden custom range, disabled custom dates or additional persistent state is needed. Every control has its visible label and normal keyboard focus; Show month and Show quarter work with scripts disabled. Enter in custom date/year fields activates the default Apply filters action, keeping the ordinary custom range and ignoring calendar drafts. Tests must exercise this implicit submission as well as explicit calendar buttons before this treatment is complete.

## Implementation boundary and proof owed

The owning layer is the Cases filter form and authenticated query normalization route: `src/web/pages/cases-view.tsx` and `src/web/pages/cases.tsx`. Keep date interpretation in the existing query layer, not a result filter. Add targeted proof in `test/web/cases-page.test.ts` and `test/node/cases-browser.test.tsx`. No shared client, shared SPEC, authentication, schema or migration change is authorized by this preparation.

- Page tests exercise ordinary and htmx canonicalization, selected-action validation including duplicate parameters, impossible years/months/quarters, preservation of custom dates on refusal, preservation of search/verdict/channel/checker/period, page reset and cross-tenant isolation.
- Stored case fixtures prove the first included SAST instant and the final included instant, and exclude the immediately adjacent instants for October 2026 and a quarter crossing the UTC year boundary. Include February 2028, quarter 4, future/empty ranges, custom From-only and To-only ranges, and existing period suppression. The checkpoint must fail if out-of-month cases are listed.
- Browser tests at 360px and desktop in both themes exercise labelled keyboard controls, drafts without automatic requests, Show month and Show quarter, explicit versus implicit submit, latest search values during a pending request, canonical address/history/reload, custom dates after a named choice, Clear dates, invalid input correction and scripts-disabled operation. Existing date-range behavior remains covered.
- Before implementation obtain coordinator incorporation of the exact M1 treatment and the verified review-policy transition. Preserve all earlier section/review history; do not add an ordinary review round during this preparation. Use the dispatcher with `--writer codex` for the genuine required passes once the applicable tooling is supplied. This document supplies no review approval.

## Proposed exact SPEC hunk

Insert this single bullet immediately after M1's existing `date range` bullet. The coordinator may approve or revise it before incorporation; console has not edited shared SPEC.

```diff
+- calendar ranges (D07 T04 §30; [companion contract](../docs/specs/2026-11-04-cases-calendar-ranges-design.md)): Beside Period, From and To, a Calendar period group contains Year, Month and Show month, plus Quarter and Show quarter. Apply filters is the default Enter action and keeps custom dates; draft choices alone do not apply a filter. The explicit calendar action fills the existing From and To with inclusive SAST calendar dates through casesHref, keeps search, verdict, channel, checker and the retained fixed period, and resets paging. Custom dates remain editable and authoritative, and Clear dates returns to the retained period. The canonical address stores only the existing filters and dates. Invalid calendar input keeps the existing range and offers a labelled correction; loading, outage, empty, keyboard, phone, both-theme and scripts-disabled states follow the companion. Use existing tokens and no second persistent date-filter mode.
```

## Decision and reversal

The proposed year plus month/quarter selectors support arbitrary valid calendar periods without a hardcoded recent-period menu. Separate explicit actions prevent draft changes from overwriting custom dates. The canonical navigation reuses the existing range contract and its no-script path. Reversing the treatment would remove these controls and route normalization only; existing bookmarked ranges, stored cases and the date-filter contract remain usable. Coordinator approval and implementation are still pending.

## Approved implementation-treatment correction, 2026-11-04 11:35 UTC

The earlier proposal-status wording is historical. CONSOLE-CALENDAR-APPROVAL at 11:08 UTC approved the exact original companion at `355fa403` and its single M1 bullet. CONSOLE-CALENDAR-PANEL at 11:35 UTC authorizes the following scoped treatment correction and dated SPEC clarification. Neither decision is implementation or review proof.

Coordinator CONSOLE-CALENDAR-PANEL supersedes the htmx redirect treatment above, preserving every original recovery and security obligation. A script calendar action completes the authenticated list, statistics, member and applicable empty-organisation reads in the same request and returns one owned panel containing Filters, statistics and results. Apply the complete panel atomically; only successful application updates canonical history using `casesHref` and `HX-Push-Url`. There is no successful full navigation or second result request. Zero-total organisations return the same complete filter/results panel for an explicit calendar action. Invalid actions return that panel with unchanged custom dates, retained drafts and the existing correction alert, without changing history. Invalid script responses use 200 to deliver a validation panel, not to claim a calendar selection was applied; ordinary invalid GET remains 400. Ordinary valid GET remains the normal 303 canonical flow.

Transport and actual list/statistics/member-read failures keep the previous panel, current drafts and address, with retry of the original action and filters. The narrow approved `casesFailure` recovery changes must retain abort and request-sequence ordering, displayed-organisation headers and 401/403 navigation. Existing ordinary filter behavior is unchanged. Required evidence includes zero-total and invalid actions, actual read failures, network and 5xx failure, retry, automatic network recovery, stale-response ordering and observed Enter submissions. The original failed completion and TODO obligation bytes remain preserved. This is a dated treatment correction, not a relaxed recovery requirement or a review approval. Reversal restores the earlier implementation treatment but would reopen the demonstrated recovery defect; remove the new controls instead if abandoning this feature.
