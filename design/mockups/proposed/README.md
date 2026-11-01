# Proposed boards (not approved)

Boards drawn for the operator's approval (D07 T03 §8, §19, §22, §37, §43; decision of 2026-11-01 03:30 SAST, `docs/coordinator.md`). They are kept apart from `source/` and `png/` on purpose: everything in `source/canvas.json` is the approved inventory, which `design/tools/check-design.py` and `tests/scripts/test_design_spec.py` hold to be complete, so an unapproved board there fails both. Nothing here is built until the operator approves it.

Each board is `<Board>.dc.html` (its source, reading `../source/ui.css`) and `<Board>.png` (its render, from `python3 design/tools/export-mockups.py export` on a copy of the source in `source/`).

## On approval

For each approved board: move `<Board>.dc.html` into `source/`, restore the three stylesheet links to `ui.css`, `./support.js` and the part names, add its entry to `source/canvas.json` (`boards` and `order`), export its PNG (`export-mockups.py export --only <Board>`), add its coverage items and the SPEC entries below, then record the approval in `approved.json` and the section (`Viewer approved: YYYY-MM-DD (<board>)` and its equivalents), and run `python3 design/tools/check-design.py`.

## The boards

- `Report-EvidenceViewer`, `Report-EvidenceViewer-Mobile`: D07 T03 §8, the full-size evidence viewer (open, phone, capture gone).
- `Report-MessagePreview`: D07 T03 §19, the original message preview (message, complete headers, long or hostile message, gone).
- `Report-Running-Early`: D07 T03 §37, the early authentication results on the running report.
- `Report-Dispute`: D07 T03 §22, the one-press dispute.
- `Report-Mobile-Attribution`: D07 T03 §43, the phone attribution, options A (recommended) and B for the operator to choose.

## `source/canvas.json` entries to add

```json
{
 "Report-EvidenceViewer.dc.html": {
  "x": 4560,
  "y": 4300,
  "w": 1440,
  "h": 1480,
  "title": "M3 Report: full-size evidence viewer",
  "page": "app"
 },
 "Report-EvidenceViewer-Mobile.dc.html": {
  "x": 6100,
  "y": 4300,
  "w": 390,
  "h": 800,
  "title": "M3 Report: full-size evidence viewer, phone",
  "page": "app"
 },
 "Report-MessagePreview.dc.html": {
  "x": 0,
  "y": 4300,
  "w": 1440,
  "h": 2260,
  "title": "M3 Report: original message preview",
  "page": "app"
 },
 "Report-Running-Early.dc.html": {
  "x": 1520,
  "y": 6600,
  "w": 1440,
  "h": 1100,
  "title": "M3 Report: early authentication results",
  "page": "app"
 },
 "Report-Dispute.dc.html": {
  "x": 3040,
  "y": 8200,
  "w": 1100,
  "h": 1180,
  "title": "M3 Report: one-press dispute",
  "page": "app"
 },
 "Report-Mobile-Attribution.dc.html": {
  "x": 4220,
  "y": 9400,
  "w": 860,
  "h": 700,
  "title": "M3 Report: phone attribution options",
  "page": "app"
 }
}
```

## `coverage.json` M3 items to add

```json
[
 {
  "name": "evidence viewer, open",
  "kind": "state",
  "board": "Report-EvidenceViewer",
  "evidence": "Screenshot 2 of 3 \u00b7 1280 \u00d7 800 px"
 },
 {
  "name": "evidence viewer, capture gone",
  "kind": "state",
  "board": "Report-EvidenceViewer",
  "evidence": "This screenshot is no longer stored"
 },
 {
  "name": "evidence viewer, phone",
  "kind": "state",
  "board": "Report-EvidenceViewer-Mobile",
  "evidence": "scrolls both ways"
 },
 {
  "name": "original message preview",
  "kind": "state",
  "board": "Report-MessagePreview",
  "evidence": "Plain text only: pictures, links and scripts in it were not loaded or run."
 },
 {
  "name": "early authentication results",
  "kind": "state",
  "board": "Report-Running-Early",
  "evidence": "What the receiving mail system recorded"
 },
 {
  "name": "one-press dispute",
  "kind": "state",
  "board": "Report-Dispute",
  "evidence": "I think this is safe"
 },
 {
  "name": "phone attribution",
  "kind": "state",
  "board": "Report-Mobile-Attribution",
  "evidence": "Forwarded by"
 }
]
```

## `design/SPEC.md` lines to add (M3 Report)

- (add) Boards: [PNG](mockups/png/Main.png) · [source](mockups/source/Main.dc.html) · [PNG](mockups/png/Report-Safe.png) · [source](mockups/source/Report-Safe.dc.html) · [PNG](mockups/png/Report-Running.png) · [source](mockups/source/Report-Running.dc.html) · [PNG](mockups/png/Report-Partial.png) · [source](mockups/source/Report-Partial.dc.html) · [PNG](mockups/png/Report-Invoice.png) · [source](mockups/source/Report-Invoice.dc.html) · [PNG](mockups/png/Report-Counterparty.png) · [source](mockups/source/Report-Counterparty.dc.html) · [PNG](mockups/png/Report-Voice.png) · [source](mockups/source/Report-Voice.dc.html) · [phone PNG](mockups/png/Report-Mobile.png) · [phone source](mockups/source/Report-Mobile.dc.html) · [PNG](mockups/png/Report-EvidenceViewer.png) · [source](mockups/source/Report-EvidenceViewer.dc.html) · [PNG](mockups/png/Report-EvidenceViewer-Mobile.png) · [source](mockups/source/Report-EvidenceViewer-Mobile.dc.html) · [PNG](mockups/png/Report-MessagePreview.png) · [source](mockups/source/Report-MessagePreview.dc.html) · [PNG](mockups/png/Report-Running-Early.png) · [source](mockups/source/Report-Running-Early.dc.html) · [PNG](mockups/png/Report-Dispute.png) · [source](mockups/source/Report-Dispute.dc.html) · [PNG](mockups/png/Report-Mobile-Attribution.png) · [source](mockups/source/Report-Mobile-Attribution.dc.html)
- evidence viewer, open: the full-resolution capture in an in-page dialog over the report, scrollable, with Close and Escape, the screenshot's number, size and when it was taken, and a download link. (Report-EvidenceViewer; phone, Report-EvidenceViewer-Mobile)
- evidence viewer, phone: the same dialog filling the 390 px screen, with Close in the header, the capture scrolling both ways, and a "Download (PNG)" link. (Report-EvidenceViewer-Mobile)
- original message preview: a dialog over the report with two tabs, "Message" (the stored message as plain text) and "Complete headers" (every header, in the order received), opened from a finding's card by "View the original message" or "View complete headers"; a long or hostile message shows its first 200 KB as text with a line saying so, and an original no longer stored says so. (Report-MessagePreview)
- early authentication results: while the case is running, a card "What the receiving mail system recorded" (SPF, DKIM, DMARC, each a status pill, a name and one plain sentence) with "Early result" and the time it was read, and the line "These are what the receiving system recorded when the message arrived. They are not the verdict, and a later step may add to them." (Report-Running-Early)
- one-press dispute: the footer's question "Was this verdict wrong?" with one button whose words name the opposite verdict ("I think this is safe" on a malicious or suspicious verdict, "I think this is a scam" on a safe one); after the press, "Sent: you said this looks safe." and the optional note with Send the note, Change and Withdraw; from the email's link the report opens with the button focused. (Report-Dispute)
- phone attribution: who brought the case in on a phone, as option A (a line under the subject, recommended) or option B (a line under the verdict band), for the operator to choose. (Report-Mobile-Attribution)
- evidence viewer, capture gone: the preview that opens it is replaced by "This screenshot is no longer stored" and "Kept for 30 days. The finding above still stands.", with nothing to open. (Report-EvidenceViewer)
- Evidence viewer (D07 T03 §8; operator decision 2026-10-28 22:42 SAST for the in-page dialog, built now by the operator's decision of 2026-11-01 03:30 SAST; the boards `Report-EvidenceViewer` and `Report-EvidenceViewer-Mobile` are proposed 2026-11-01 and not built until the operator approves them): an evidence figure's preview is a button, "Open at full size", named by its caption ("Open the screenshot at full size: <caption>"), that opens the capture at its natural size in a native `<dialog>` over the report (modal, the page behind inert), headed by the card's id and the caption, with "Screenshot N of M · W × H px · taken T s into the walk" beneath, a scrollable region (keyboard focusable, scrolling both ways on a phone) holding the capture, a footer line saying what it is and a "Download the screenshot (PNG)" link. Close and Escape shut it and focus returns to the preview that opened it. A capture that is gone (a stored artefact past its 30 days, or missing) is drawn on the card in place of the preview as "This screenshot is no longer stored" with "Kept for 30 days. The finding above still stands.", and offers nothing to open. The capture's alt text names what it shows (its caption). The sample figures on the boards are labelled samples, as the report's are.
- Original message preview (D07 T03 §19; built now by the operator's decision of 2026-11-01 03:30 SAST, board `Report-MessagePreview` proposed 2026-11-01 and not built until the operator approves it): from a finding's card a member opens the original in place, as inert plain text: the stored visible text and the complete headers in their own tab, never the message's HTML, never a remote load, links not clickable, under the report's access rule (a link holder sees what the public view shows; another organisation gets 404). Close and Escape shut it and focus returns to the card's button. A message past 200 KB shows its first 200 KB and says so; one gone after its 30 days says "The original message is no longer stored" and keeps the findings. The download of the original (.eml) stays.
- Early authentication results (D07 T03 §37; built now by the operator's decision of 2026-11-01 03:30 SAST, board `Report-Running-Early` proposed 2026-11-01 and not built until the operator approves it): the operator's choice is the report page's running state, not a first reply. Once the checks step has stored the authentication outcomes (`check_outcomes`, D02 T01 §3) the running report shows the card between the "Checking" band and the progress list, read from what is stored; before they are stored the card is absent, and if the receiving system reported no results the card says so. It names the receiving system's own records and says they are not the verdict.
- One-press dispute (D07 T03 §22; built now by the operator's decision of 2026-11-01 03:30 SAST, board `Report-Dispute` proposed 2026-11-01 and not built until the operator approves it): a dispute is one press on a button naming the opposite verdict, sent once (busy while it posts), with the optional note offered after and Change and Withdraw as §6 and §21 have them; the intent from the email or the signed link survives sign-in, so the report opens with the button focused and focus-visible, and choosing and pressing stay the member's.
- Attribution on a phone (D07 T03 §43; built now by the operator's decision of 2026-11-01 03:30 SAST, board `Report-Mobile-Attribution` proposed 2026-11-01 with two options for the operator to choose, A recommended): the phone report says who brought the case in ("Forwarded by <name>" or "Uploaded by <name>"), in the screen reader's reading order, shown to members and never to a link holder.
