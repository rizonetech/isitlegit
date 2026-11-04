# Exact calendar-period counts export

D07 T04 §34 companion treatment, authorized by coordinator `exact-counts-surface-approved` on 2026-11-04 at 10:48 SAST. Console owns this companion and implementation; coordinator owns its incorporation into `design/SPEC.md` M1. That incorporation remains a completion gate. This document does not change other M1 controls, weekly statistics or existing weekly export semantics.

## Control and states

Add one second submit button, **Daily counts CSV**, to the existing From/To GET form in `StatsPanel` (`src/web/pages/cases-view.tsx`). It submits `name="exact" value="1"` to `/cases/stats.csv`, using the same hidden organisation field and the same selected dates. The existing **Export period** button and **This month**, **This quarter** and **Export counts as CSV** links keep their whole-week behaviour. No new links or JavaScript state implement the daily choice.

Both labelled date inputs are required. Browser validation focuses the missing or invalid input. A visible line states that daily export includes one row per selected SAST day, including days with no cases; existing whole-week wording stays. Use the existing button, text, spacing and focus tokens. Controls wrap at 360 px, are keyboard reachable, have their visible accessible names, and work in both themes. No `download` attribute may swallow an authentication, permission or service-error page.

The GET form remains usable without JavaScript. Existing date preservation across a Cases filter redraw also applies to the new action. A successful response uses the browser's ordinary download behaviour. Invalid, reversed, missing or oversized dates return the existing explanatory HTML 400 page with recovery to Cases and no attachment header. A database/session failure uses existing service recovery; an inaccessible organisation remains refused, and a stale organisation selection redirects to the active organisation's Cases page instead of exporting another organisation's counts.

## Data contract

`GET /cases/stats.csv?exact=1&from=YYYY-MM-DD&to=YYYY-MM-DD&org=<current organisation>` returns daily counts for the inclusive selected SAST dates. `exact=1` requires both dates, even when neither parameter was supplied. The existing valid-calendar-date and maximum-span rule remains: the difference between To and From is at most 730 days, producing at most 731 inclusive daily rows. Same-day and leap-day periods work. No daily export silently falls back to weekly data.

The aggregation belongs in `src/db/case-stats.ts`, bounded by the authenticated organisation and a half-open UTC interval from From at 00:00 SAST through the day after To at 00:00 SAST. Bucket arrivals by their SAST calendar day, oldest first, with exactly one row for every requested day, including zero and future days in the permitted range. Do not trim already aggregated weekly rows or query once per day.

Use the existing count meanings: every arrival increments `checked`; a done or partial case's stored verdict increments its verdict count; cases without a settled verdict increment `unfinished`. Every row satisfies `checked = malicious + suspicious + safe + unfinished`, and summing daily rows reconciles to the same exact scoped arrivals. Median seconds to verdict uses the existing arrival-to-stored-verdict calculation and rounding, with an empty CSV cell when no duration is available. No subject, sender, attachment name, evidence detail, user identifier or bank data is exported.

The UTF-8 CSV uses CRLF row endings and the header `day_start,checked,malicious,suspicious,safe,unfinished,median_seconds_to_verdict`. `day_start` is the selected SAST date in `YYYY-MM-DD` form, not a UTC timestamp or a Monday week label. Filename: `isitlegit-daily-counts-<from>-to-<to>.csv`. Preserve `private, no-store`, `nosniff` and the existing CSV content type. A period with no cases still returns all selected daily rows with zeros and an empty median, not an unexplained empty file.

## Proof and reversal

Worker tests cover exact first/last millisecond boundaries and adjacent exclusions, tenant isolation/stale-org handling, zero days, every case state, medians, row/period reconciliation, invalid/missing/reversed/oversized ranges, same-day/leap-day dates, filename/header/no-content leakage, and unchanged whole-week output. Browser tests exercise the actual rendered Daily counts CSV submitter, native required-input validation, keyboard download and filename, retained dates after redraw, existing weekly action, and 360 px in both themes with accessible names and no overflow. Source-only approval does not replace these runtime checks.

Reversal is removal of the daily submitter and `exact=1` route/aggregation mode in an ordinary corrective commit. No stored data or migration changes are needed; weekly export remains available throughout. No provider calls or new spend are authorized by this feature.
