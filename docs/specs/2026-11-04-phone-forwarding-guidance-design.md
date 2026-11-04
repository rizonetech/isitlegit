# Phone forwarding guidance

D07 T04 §35 companion proposal, prepared under the coordinator's 2026-11-04 11:09 SAST research/plan authority. The coordinator approved the exact wording at2026-11-04T09:44:41UTC and authorized implementation after the genuine plan review. Incorporation into `design/SPEC.md` M1 remains required before completion. Console owns this companion and `FirstRun`; coordinator owns shared SPEC. No change to forwarding, upload admission or authentication checks is proposed.

## Source-backed limits

Sources checked 2026-11-04. [Google's original-message instructions](https://support.google.com/mail/answer/9261412?hl=en) explicitly place both Download message and Forward as attachment on a computer. [Apple's iPhone forwarding guide](https://support.apple.com/guide/iphone/reply-to-and-forward-emails-iph3caef30a/27/ios/27) describes Reply followed by Forward and optional inclusion of received attachments; this is not evidence of exporting an original message file. [Apple's phishing guidance](https://support.apple.com/en-ca/102568) documents the Mac's Message menu and Forward As Attachment for preserving header information. Apple guide direct fetches returned429; after the recorded backoff, the official indexed guide text was successfully retrieved. No original-message export command on iPhone is claimed, and absence from the guide is not treated as proof that every version lacks one.

The product's `src/intake/accepted-formats.ts` accepts original `.eml`/`.msg`, PDF and screenshot files; `src/intake/upload.ts` only sets original headers available for a qualifying mail file. `src/intake/forward.ts` marks ordinary inline forwards as original headers unavailable. Saving a received attachment, printing an email to PDF and taking a screenshot are not original-message export. Do not direct people to open a suspicious attachment to create an export, or claim that an ordinary forward preserves original authentication.

## Proposed M1 wording and controls

Keep all three existing desktop HOW_TO tiles and their text byte-for-byte. Add these two tiles within the same token-based wrapping list, with visible titles and instructions:

- **Apple Mail on iPhone:** "Reply, then Forward sends an ordinary forward. For the original email, open the same mailbox in Mail on a Mac, select the message, then choose Message, Forward As Attachment."
- **Gmail on a phone:** "For the original email, use Gmail on a computer. Tick the message in your inbox, then choose More, Forward as attachment. You can also open the message, choose More, Download message, and upload the saved .eml file."

Add a visible **Checking from your phone?** paragraph after the tiles: "Already have the original .eml or .msg file? Upload it from your phone. You can also check a screenshot or a PDF you already have, but those do not include the original email headers. An ordinary forward also leaves those checks unavailable. Use a computer and the steps above when you need the original email checked."

Provide one nearby link named **Upload a file** to `/upload`, followed by "Choose a file and select your saved file. The check starts automatically, or with Check this file if that button is shown." Reuse existing focus, link and text tokens; no new JavaScript, file handling or upload form. The existing accepted-senders line and its upload link remain unchanged. Do not suggest a phone save/export command that has not been verified, and do not offer Print to PDF as equivalent to an email file. The fallback is explicit and the phone-only screenshot/document option states its limitation beside the action.

## Verification and reversal

The rendered first-run browser test at360px in light and dark, with scripts enabled and disabled, reads both phone tiles and their desktop fallback, exact unchanged desktop instructions, original-file/limited-document distinction and the Upload a file link. Keyboard Tab/Enter follows that link to the real rendered upload page in the fixture harness and finds its labelled file input, with Check this file shown only without scripts as the existing upload page specifies. Browser proof covers the product guidance and navigation, not a physical iPhone/Gmail application. Existing Cases accessibility checks at360and1280both themes must still pass. A counterfactual removing the phone tiles must fail the new test. No new model call, mail, capture, media render or provider spend is needed.

Reversal removes only the new guidance tiles, explanatory paragraph and link in an ordinary corrective commit. Stored records, sender eligibility, original-header decisions and upload behavior remain unchanged.
