---
schema_version: 1
id: attachments
domain: 02-checks
status: active
title: "TODO-04 -- Attachment Checks"
track: day-2
---

# TODO-04 -- Attachment Checks

> **Goal:** Every attachment is identified by its content, not its name, and flagged when its real type disagrees with its extension, when it is an HTML file (smuggling or a local phishing page), an Office file with macros, an encrypted archive, or an executable or script; nothing is ever opened or run.

> **Current state:** Measured 2026-10-26 20:00 SAST. Attachments are stored in R2 with their media type from MIME (D01 T01 §5); no content inspection exists.

## Inputs

- Design spec 4.3 (Attachments), 4.6 (malware-type attachment is critical evidence for the deterministic floor).
- ECMA-376 (Office Open XML: `vbaProject.bin` marks macros), MS-CFB (OLE compound files), PKWARE APPNOTE section 4.4.4 (ZIP general purpose bit 0: encryption).

## Outcome

- Synthetic fixtures for a renamed executable, an HTML smuggling page, a macro-enabled document, an encrypted ZIP and a plain PDF each yield the expected evidence, and the PDF yields none.

**Adjacency:** all=not-applicable (pure evidence producers; shown and governed on the report, D07 T03 §3)

**Adjacency rationale:** These checks only add evidence to a case.

## Implementation Order

| Order | Section | Deliverable | Depends On | Status |
| ----- | ------- | ----------- | ---------- | ------ |
| 1 | §1 | Content-type sniffing against the extension | D02 T01 §2 | [x] |
| 2 | §2 | HTML attachments and smuggling | §1 | [x] |
| 3 | §3 | Macros, encrypted archives and executables | §1 | [x] |
| 4 | §4 | Type mismatch for uploaded files | §1, D01 T03 §1 | [x] |
| 5 | §5 | RTF and further formats in the type check | §1 | [x] |
| 6 | §6 | Obfuscated HTML attachments, measured | §2 | [ ] |
| 7 | §7 | Compressed 7z headers read | §3 | [x] |
| 8 | §8 | Archive members read by content | §3 | [x] |
| 9 | §9 | Embedded objects in RTF documents | §5 | [x] |
| 10 | §10 | Attachment content | §8 | [ ] |

## 1. Content-type sniffing against the extension

A `.pdf` that is really a Windows executable is the classic trick. Magic bytes decide the real type; a mismatch with the extension or the declared MIME type is evidence.

> **Started:** 2026-10-30T19:54Z

**Corrected 2026-10-30** (at start, checked against the repository): (1) the view carries attachment metadata only (`Attachment` in `src/checks/case-view.ts`: key, name, media type, size), and checks are pure, so the Workflow's `checks` step reads each attachment's first `SNIFF_BYTES` (36 KiB, enough for ISO 9660's `CD001` at offset 32769) from R2 for at most `MAX_SNIFFED` (20) attachments and puts them in the view as `attachmentHeads` (base64, since the runner freezes the view and a typed array cannot be frozen); the rest are counted as not checked; (2) `sniff` here (`src/checks/sniff.ts`) is the attachments' own identifier, apart from the upload door's (`src/intake/sniff.ts`, which decides what a member may upload); (3) the synthetic samples are built in the tests (`test/fixtures/attachments/samples.ts`), not by a script under `scripts/`, which is shared tooling outside this lane; (4) a claimed type is read from the extension and from the declared media type, each mapped to a type family (document, image, archive, executable, script, shortcut, text, web); OOXML (`.docx`, `.xlsx`, `.pptx`) is a ZIP whose first entries name `word/`, `xl/` or `ppt/` or `[Content_Types].xml`, and OLE matches `.doc`, `.xls`, `.ppt` and `.msg`; an unknown extension and an unrecognised body make no claim and no finding; (5) each item cites the attachment's stored key as its artefact, with `detail.filename`, `detail.extension`, `detail.declared`, `detail.sniffed` and `detail.claims` (which of the extension and the media type disagree).

**Corrected 2026-10-30** (plan review): (6) scripts are identified too, as `script`, by bounded markers read from the first 4 KiB of text: a `#!` interpreter line, a batch file's `@echo off`, an HTML Application's `<hta:application`, and Windows Script Host or PowerShell markers (`WScript.`, `CreateObject(`, `Invoke-Expression`, `-EncodedCommand`); a script behind a document or image name is high; anything else readable stays `text`; (7) claims are compared as concrete formats, never families: each extension and media type lists the formats it may be (`.docx` a DOCX, an OOXML package or a ZIP; `.doc` an OLE file), so a Word file named `.pdf` or JPEG bytes declared `image/png` is a medium mismatch; families only decide the severity; (8) attachments not compared are a stored `attachment.type_mismatch` info item counting them (past `MAX_SNIFFED`, or missing from R2); a storage error other than a missing object fails the `checks` step, which the Workflow retries, rather than being counted as unread; (9) an uploaded document or image keeps no submitted name or media type in its summary, so the check has no claim to compare there; filed as §4, which keeps the upload's claims and runs the check over them; (10) the tests cover an extension-only, a media-type-only and a both-claims mismatch, matching and unknown claims, `detail.claims` read back from storage, and the step's 20-object and 36 KiB limits.

**Phase:** 2
**Needs:** none
**Surface:** no

**Build order:**

1. Write `sniff(bytes)` covering the types IsItLegit meets. Done when: each synthetic fixture is identified.
2. Register `attachment.type_mismatch`. Done when: a renamed executable is high and a correct PDF yields nothing.

- [x] Write `sniff(bytes)` in `src/checks/sniff.ts` for PDF, ZIP (and OOXML inside it), OLE, PE (`MZ`), ELF, Mach-O, RAR, 7z, ISO 9660, PNG, JPEG, GIF, WebP, HTML (leading `<!doctype html` or `<html` after whitespace), SVG, LNK, and plain text. Done when: `test/checks/sniff.test.ts` identifies a synthetic sample of each, built in `test/fixtures/attachments/samples.ts` (correction 3), never real files. (**Corrected 2026-10-30**, at start.) Done 2026-10-30: `sniff` and `attachmentHeadsOf` in `src/checks/sniff.ts`, scripts by bounded markers; samples in `test/fixtures/attachments/samples.ts`.
- [x] Register `attachment.type_mismatch` over the view's `attachmentHeads`, filled by the `checks` step (correction 1), comparing the sniffed type with the extension and the MIME type: high when an executable, script or shortcut hides behind a document or image name, medium otherwise. Done when: the renamed-executable fixture is high, a correct PDF yields nothing, and a Workflow read-back test stores the high item citing the attachment's key. (**Corrected 2026-10-30**, at start.) Done 2026-10-30: `src/checks/attachment-type.ts`; `test/checks/sniff.test.ts` (15 tests) with stored read-backs; five mutations (scripts and shortcuts not dangerous, the media type ignored, an HTA read as HTML, more attachments read, the whole object read) each fail a test; 467 tests across checks, pipeline and intake pass.
- [x] Commit: `checks: content-type sniffing against the extension` Done 2026-10-30: 4eeacda, with 522145e (completion review), 1f13a57 and f5616ac (rounds 1 and 2).

**Test checkpoint:** `pnpm exec vitest run test/checks/sniff.test.ts` passes and fails if the extension is used instead of the bytes.

> **Verified:** 2026-10-30 | §1 | f091bcf80cf9e53897b5671da3476d5002ddc077
> **Review:** `docs/reviews/d02-t04-s1.json`

## 2. HTML attachments and smuggling

An HTML attachment is either a local phishing page (opened from disk, so link checks miss it) or a smuggling loader that assembles a file in the browser from base64 or a blob URL (spec 4.3).

> **Started:** 2026-10-30T22:04Z

**Corrected 2026-10-31** (at start, checked against the repository): (1) checks are pure, so the Workflow's `checks` step reads each HTML or SVG attachment (by its sniffed type, `sniff` in `src/checks/sniff.ts`, or its extension or declared type) from R2, at most `MAX_HTML_ATTACHMENTS` (10) of them and `MAX_HTML_BYTES` (5 MiB) of each, in its charset, and puts each one's features in the view as `htmlAttachments`; the rest are counted as not read; (2) the features: a password field (`input type=password`), a card field (`autocomplete` `cc-*`, or a field named or labelled for a card number, expiry or CVV), a form whose action is an absolute `http(s)` URL (a page opened from disk has no site of its own, so any such action posts off it), and smuggling: script or markup holding a base64 run over 10 KiB (in a `data:` URL or a string) together with a `Blob` or `data:` construction and a download trigger (an anchor's `download`, `msSaveOrOpenBlob`, `URL.createObjectURL` followed by a click or a navigation); (3) the case's link list does not exist yet (URL extraction is D02 T07 §1, Phase 3), so the HTML attachment's links and form actions are added to that section as its own item, not built here; (4) each item cites the attachment's key, its detail naming each feature found; a harmless HTML attachment is medium, as the plan says, since an HTML file opened from disk is itself a risk.

**Corrected 2026-10-31** (plan review): (5) the production path is proven: a test stores synthetic attachments in R2, runs the `checks` step and reads the evidence back, and fails when the check is unregistered or the step does not supply `htmlAttachments`; (6) coverage is stored: a file past `MAX_HTML_BYTES` is read from its start and its item says so (`truncated`), attachments past `MAX_HTML_ATTACHMENTS` or missing from R2 are counted in an info item, and any other storage error fails the step for the Workflow to retry; (7) an attachment's MIME charset is not kept in the summary (correction 1's "in its charset" is struck), so its bytes are read by HTML's own encoding sniffing (`decodeHtml`): a byte order mark, then a `charset` declared in its first 1024 bytes, then strict UTF-8, then windows-1252; (8) the loader rule's parts must belong together: a long base64 run, a construction (`Blob`, `atob`, `Uint8Array.from`, a `data:` URL) and a download, all in script, or a link with a `download` attribute whose own `data:` payload is over 10 KiB; a large inline image beside an ordinary download link is no loader; each branch (a card field alone, an off-site form alone, an SVG's script, a downloading `data:` link) and each way of recognising the file (its bytes, extension, declared type) is tested, with each loader part missing and the 10 KiB boundary.

**Phase:** 2
**Needs:** none
**Surface:** no

**Build order:**

1. Register `attachment.html`. Done when: the fixtures for a local login page, a smuggling loader and a harmless receipt each give the expected result.

- [x] Flag any HTML or SVG attachment as medium `attachment.html`, and raise to high when it contains a password or card field, a form posting off-site, or script building a `Blob` or a `data:` URL from a long base64 string (over 10 KB) with a download trigger. Done when: `test/checks/html-attachment.test.ts` gives high for both hostile fixtures and medium for the receipt. Done 2026-10-31: `src/checks/html-attachment.ts` (`analyseHtml`, `htmlAttachmentsOf`, `decodeHtml`), wired in the `checks` step; `test/checks/html-attachment.test.ts` (14 tests); five mutations (unregistered, not wired, never high, the password field ignored, a loader without a download) each fail a test.
- [x] Extract links and form actions from the HTML attachment into the case's link list for D02 T07. Done 2026-10-31: moved to D02 T07 §1 as its own item (correction 3), since the link list is built there.
- [x] Commit: `checks: HTML attachments and smuggling` Done 2026-10-31: 625e0a3, with 601a4cd (completion review) and the round fixes after it.

**Test checkpoint:** `pnpm exec vitest run test/checks/html-attachment.test.ts` passes and fails if the base64 blob loader is rated medium.

> **Verified:** 2026-10-31 | §2 | 1ef8c5c16cd7a1b7e1cf892dd3e264d213314853
> **Review:** `docs/reviews/d02-t04-s2.json`

## 3. Macros, encrypted archives and executables

Macro documents, password-protected archives (which defeat scanning) and executables or scripts are critical or high evidence (spec 4.3, 4.6: malware-type attachments set the deterministic floor).

> **Started:** 2026-10-30T23:03Z

**Corrected 2026-10-31** (at start, checked against the repository): (1) checks are pure, so the Workflow's `checks` step reads each attachment's structure and puts it in the view as `attachmentRisks`, for at most `MAX_RISK_ATTACHMENTS` (20) attachments, the rest counted: a ZIP's central directory by ranged R2 reads (the end-of-central-directory record within the last 65,557 bytes, then the directory, at most 1 MiB of it), an OLE compound file whole up to `MAX_OLE_BYTES` (10 MiB) through `readCompoundFile` (`src/intake/cfb.ts`), and a RAR or 7z archive's headers from its start (a 7z's next header by range, at most 1 MiB); a structure that cannot be read is said to be not checked, never taken as clean, and a storage error fails the step for the Workflow to retry; (2) a macro is `vbaProject.bin` anywhere in an OOXML package, a macro-enabled name (`.docm`, `.xlsm`, `.pptm`, `.dotm`, `.xltm`, `.potm`), or an OLE file holding a `Macros` storage or a `_VBA_PROJECT` stream; (3) an encrypted archive is a ZIP with any entry's general purpose bit 0 set, a RAR5 archive with an archive encryption header or an encrypted file header, a RAR4 archive with encrypted headers or files, or a 7z whose header names the AES coder (`06F10701`); (4) executables, scripts and shortcuts are recognised by their bytes (`sniff`: PE, ELF, Mach-O, a script, a shortcut, a disk image) and by their names (`.exe`, `.scr`, `.com`, `.bat`, `.cmd`, `.js`, `.jse`, `.vbs`, `.vbe`, `.wsf`, `.ps1`, `.hta`, `.lnk`, `.iso`, `.img`, `.msi`, `.jar`), and inside a plain ZIP one level deep by its entries' names; a nested archive is named but not opened; (5) severities: an executable `critical`, a macro and an encrypted archive `high`; each item cites the attachment's key, its detail naming what was found and where (the attachment, or the ZIP entry's name).

**Corrected 2026-10-31** (plan review): (6) the production path is proven: tests store synthetic attachments in R2, run the `checks` step and read the evidence back, all three check names with their severities, attachment keys and where each finding sits, the same after a replayed step, and they fail when a check is unregistered or the step does not supply `attachmentRisks`; (7) every route has a positive and a negative fixture: `vbaProject.bin`, a macro-enabled name, an OLE `Macros` storage and an OLE `_VBA_PROJECT` stream; a ZIP with an encrypted entry and a plain one; RAR4 and RAR5 with encrypted headers and with an encrypted file; a 7z with an AES coder in a plain header; an executable by its bytes alone, by its name alone and as a ZIP entry; a ZIP holding a PDF; and the limits and refusals: attachments past the limit, a structure past its bound, a malformed or truncated file, a missing object (each a stored not-checked item) and a storage error (the step fails), one unreadable attachment never hiding another's finding; (8) a 7z whose main header is encoded (`kEncodedHeader`) is read for its coders: an AES coder there is an encrypted archive; any other coder (LZMA, as 7-Zip writes by default) hides the header, so the archive is said to be not checked, never clean; decoding compressed 7z headers is filed as §7; (9) a RAR archive is walked header by header from its start by ranged reads, each payload skipped by its validated length, at most `MAX_RAR_HEADERS` (1,000) headers, `MAX_RAR_READS` (64) requests and 2 MiB read; an archive not walked to its end is said to be not fully checked, with any encryption found before the cap still reported.

**Phase:** 2
**Needs:** none
**Surface:** no

**Build order:**

1. Register `attachment.macro`, `attachment.encrypted_archive` and `attachment.executable`. Done when: each synthetic fixture yields its item.

- [x] Detect macros: OOXML containing `vbaProject.bin` or a `.docm`, `.xlsm`, `.pptm` content type (ECMA-376), or an OLE file with a `Macros` or `_VBA_PROJECT` stream (MS-CFB). Done when: `test/checks/attachment-risk.test.ts` flags a synthetic macro OOXML as high. Done 2026-10-31: `src/checks/attachment-risk.ts` (`zipEntries`, `oleMacros`), `attachment.macro`.
- [x] Detect encrypted archives from the ZIP general purpose bit 0 (APPNOTE 4.4.4) and RAR or 7z encryption headers. Done when: a synthetic encrypted ZIP is high and a plain ZIP is not flagged. Done 2026-10-31: ZIP bit 0, RAR4 and RAR5 walked by validated lengths within caps, 7z coders; `attachment.encrypted_archive`.
- [x] Flag executables, scripts and shortcuts (PE, ELF, Mach-O, `.js`, `.vbs`, `.ps1`, `.hta`, `.lnk`, `.iso`, `.img`, also inside a plain ZIP one level deep) as critical `attachment.executable`. Done when: the fixtures pass and a ZIP holding a PDF is not flagged. Done 2026-10-31: by bytes, by name and as ZIP entries; `attachment.executable` (critical), which also states what was not checked; `test/checks/attachment-risk.test.ts` (13 tests, through the `checks` step); six mutations (unregistered, unwired, ZIP bit 0 ignored, RAR5 file encryption ignored, OLE macros ignored, the RAR walk uncapped) each fail a test.
- [x] Commit: `checks: macros, encrypted archives and executables` Done 2026-10-31: 25b9635, with 39b9a2a (completion review) and the round fixes after it.

**Test checkpoint:** `pnpm exec vitest run test/checks/attachment-risk.test.ts` passes and fails if a ZIP's inner executable is missed.

> **Verified:** 2026-10-31 | §3 | 8c8a0febd38ca00c96c728ed58594bc5ea2cc8bc
> **Review:** `docs/reviews/d02-t04-s3.json`

## 4. Type mismatch for uploaded files

Filed 2026-10-30 from §1's plan review (its correction 9): an uploaded document or image is accepted by its bytes, and its summary keeps the detected media type only, so `attachment.type_mismatch` has no claim to compare: a PDF uploaded as `invoice.png` gives no evidence. The upload's own name and submitted media type are kept apart from what was detected, and the check runs over them.

> **Started:** 2026-10-31T03:25Z

**Corrected 2026-10-31** (at start, checked against the repository): (1) the upload keeps neither claim today: its name survives only inside the stored key (`safeName`d) and the media type the member's browser submitted is not kept at all, the artefact row holding the detected type; so the claims are kept on the case row, as `uploaded_by` is (D01 T03 §11): `cases.upload_name` and `cases.upload_media_type`, each nullable and at most 255 characters, in migration 0043 (asked of the coordinator 2026-10-31), written through `admitDelivery`'s delivery (`src/intake/admit.ts`) and `createCase`'s two inserts (`src/db/cases.ts`) from `src/intake/upload.ts`'s `file.name` and `file.type`; (2) the parse step (`src/pipeline/analysis-workflow.ts`) copies them into the upload's summary as `source.claimed` (`{ name, mediaType }`, absent from summaries stored before, so `UploadSummary` in `src/checks/case-view.ts` takes it optionally); (3) the checks step reads the uploaded file's first bytes as it does an attachment's, and `attachment.type_mismatch` compares them with the claims, the stored key the artefact; an uploaded `.eml` or `.msg` is parsed as a message and has its own attachments, so it is not compared.

**Corrected 2026-10-31** (from the plan review, `docs/reviews/02-checks/D02-T04-s4.md`): (4) an upload's identity is its bytes with the name and media type it was sent with (`uploadKey` in `src/intake/upload.ts`, in the shape an email's key has), so the same file sent again under the same name and type is still a repeat, while a renamed or retyped copy is a case of its own whose claims are checked; this narrows D01 T03 §1's duplicate contract, whose two repeat tests now send the same name; (5) a name or media type longer than 255 characters (`MAX_CLAIM_CHARS`) is refused with a 400 before anything is admitted, never cut short (a cut could lose the extension being checked); (6) the tests run from the HTTP upload through the Workflow to stored evidence (`test/intake/upload.test.ts`, not `test/checks/sniff.test.ts`): an extension-only, a media-type-only and a combined mismatch each store `attachment.type_mismatch` with its severity, `claims`, the submitted values and the upload's key as the artefact, a matching upload stores none, and the claims read back from the case row and the summary; a part sent without a type arrives as `application/octet-stream`, which is kept as sent.

**Phase:** 2
**Needs:** none
**Surface:** no

**Build order:**

1. Keep the upload's claims and compare them. Done when: a PDF uploaded as `invoice.png` stores a mismatch item; a correctly named upload stores none.

- [x] Keep the submitted file name and media type in the uploaded source's summary (`src/intake/upload.ts`, `parse` in `src/pipeline/analysis-workflow.ts`), apart from the detected type. Done when: `test/intake/upload.test.ts` reads both back.
- [x] Run `attachment.type_mismatch` (`src/checks/attachment-type.ts`) over the uploaded source as one more attachment, its stored key the artefact. Done when: `test/checks/sniff.test.ts` stores the mismatch for a PDF uploaded as `invoice.png` and nothing for `invoice.pdf`.
- [x] Commit: `checks: type mismatch for uploaded files` Done 2026-10-31: 708ea97b, with the completion review's fix after it.

**Test checkpoint:** `pnpm exec vitest run test/checks/sniff.test.ts test/intake/upload.test.ts` passes.

> **Verified:** 2026-10-31 | §4 | 7100097f4b8ba307b9bcaa1e4ff941e316e61239
> **Review:** `docs/reviews/d02-t04-s4.json`

## 5. RTF and further formats in the type check

Filed 2026-10-30 from §1's completion review (out of scope): §1 recognises the formats a forwarded invoice usually carries, so a program named `invoice.rtf` and declared `application/rtf` claims a format the check does not know, and nothing is said. RTF, and the other document and voice formats members send (OpenDocument, older Office templates, M4A and Ogg voice notes), join the identifier and the claim tables.

> **Started:** 2026-10-31T03:52Z

**Corrected 2026-10-31** (at start, checked against the repository): (1) RTF is text, which `sniff` (`src/checks/sniff.ts`) reads as `text` today, so `{\rtf` is recognised before the text rule; (2) OpenDocument is told by `zipKind`'s first entry, a stored `mimetype` whose content names `application/vnd.oasis.opendocument.`, and is a ZIP the archive check (`src/checks/attachment-risk.ts`) opens like the Office packages, so a program or macro inside one is found; (3) a new `audio` family (M4A by an `ftyp` audio brand, `M4A `, `M4B ` or `M4P `; Ogg by `OggS`; WAV by `RIFF` with `WAVE`; MP3 by an `ID3` tag or a valid MPEG audio frame header) joins the families a program behind a claim is high for, as document and image are; (4) the older Office templates are the same containers as their documents (`.dot`, `.xlt`, `.pot` OLE; `.dotx`, `.xltx`, `.potx` OOXML; `.ott`, `.ots`, `.otp` OpenDocument), so their extensions and media types join the claim tables; (5) the WAV upload test sits in `test/intake/upload.test.ts`, where §4 put it.

**Corrected 2026-10-31** (from the plan review, `docs/reviews/02-checks/D02-T04-s5.md`): (6) an OpenDocument file's native macros are its Basic modules (`Basic/<library>/<module>.xml`, beside the libraries' `script-lb.xml` and `dialog-lb.xml` and the container's `script-lc.xml`), which the archive check now names as a macro; through the checks step a Basic module is a high `attachment.macro`, a program inside is a critical `attachment.executable`, a plain file is silent and a cut directory is not checked; (7) the tests take every added extension and every added media type alone, each with a program, a script and a shortcut behind it (high) and its genuine bytes (silent), both MP3 branches (an ID3 tag and a bare frame header, read after the UTF-16 marks, since `FF FE` is also an MPEG-1 Layer I header) and two near misses; the WAV upload stores the mismatch and a `ran` outcome; the checkpoint runs `test/checks/attachment-risk.test.ts` and `test/intake/upload.test.ts` too; (8) `.zip`, `application/zip` and `application/x-zip-compressed` accept an OpenDocument file, as they accept an Office package, and a test keeps that silent.

**Phase:** 2
**Needs:** none
**Surface:** no

**Build order:**

1. Widen the formats. Done when: a program, script or shortcut behind each new claim is high, and a genuine file of each new format is silent.

- [x] Add RTF (`{\\rtf`), OpenDocument (a ZIP whose first entry is `mimetype` naming `application/vnd.oasis.opendocument.*`), M4A (`ftyp` with an audio brand) and Ogg to `sniff` in `src/checks/sniff.ts`, with their extensions and media types in `src/checks/attachment-type.ts`. Done when: `test/checks/sniff.test.ts` identifies a synthetic sample of each.
- [x] Add WAV (`RIFF` with `WAVE`) and MP3 (an ID3 tag or an MPEG audio frame sync) to `sniff` the same way, so an audio upload (D02 T04 §4) is compared rather than stated as a type not identified. Done when: `test/checks/sniff.test.ts` identifies each, and `test/intake/upload.test.ts`'s WAV uploaded as `invoice.pdf` stores a mismatch instead of a partial outcome. Source: D02 T04 §4's completion review, 2026-10-31.
- [x] Prove the disguise and the silence for each new claim. Done when: the test reads high for a program behind `.rtf`, `.odt`, `.m4a` and `.ogg` names, and nothing for a genuine sample of each.
- [x] Commit: `checks: RTF and further formats in the type check` Done 2026-10-31: 4c42edad, with the completion review's and the rounds' fixes after it.

**Test checkpoint:** `pnpm exec vitest run test/checks/sniff.test.ts test/checks/attachment-risk.test.ts test/intake/upload.test.ts` passes.

> **Verified:** 2026-10-31 | §5 | 0595f2c93c6d635167c2392740f2e19b293b410e
> **Review:** `docs/reviews/d02-t04-s5.json`

## 6. Obfuscated HTML attachments, measured

Filed 2026-10-31 from §2's completion review (out of scope): §2 reads an HTML attachment's literal features, so a payload split across strings, encoded twice, or a login form written by script at load time can show none of them. Finding those needs more than signatures, and is judged on a labelled set, not on examples.

**Phase:** 7
**Needs:** none
**Surface:** no

**Build order:**

1. Measure, then widen the analysis. Done when: on a labelled set of HTML attachments, detection is at least 95% and false positives at most 2% (the project's targets), with each obfuscation family represented.

- [ ] Build a labelled set of synthetic HTML attachments in `test/fixtures/attachments/obfuscated/`: split and twice-encoded payloads, script-written login forms, and as many benign pages that use script, base64 images and forms honestly. Done when: each family has at least 20 cases and the benign set at least 60.
- [ ] Measure `analyseHtml` on the set and record the result in `docs/frontier-log.md`, then add analysis (for example, joining string literals before the base64 run is measured, reading the inputs a script writes into markup) until the targets hold. Done when: the log records detection and false positives per family, both within target.
- [ ] Commit: `checks: obfuscated HTML attachments, measured`

**Test checkpoint:** `pnpm exec vitest run test/checks/html-attachment.test.ts` passes with the labelled set.

## 7. Compressed 7z headers read

> **Started:** 2026-10-31T17:30Z

Filed 2026-10-31 from §3's plan review (its correction 8): 7-Zip compresses an archive's main header with LZMA by default, so §3 cannot see whether the files inside are encrypted and reports such an archive as not checked. Reading those headers needs a bounded LZMA decoder.

**Corrected 2026-10-31** (at start, checked against the repository): (1) the decoder is a port of the LZMA SDK's public-domain reference decoder (Igor Pavlov's `LzmaSpec.cpp`, placed in the public domain) into `src/checks/lzma.ts`, not a dependency: no LZMA library is installed, the few on npm decode the `.lzma` container rather than a raw LZMA1 stream, and a port of about 300 lines keeps every bound in this repository's hands; (2) an encoded header (`kEncodedHeader`, `0x17`) is a StreamsInfo naming one packed stream (`PackPos` from the end of the start header, its size) through one folder of one LZMA coder (`030101`, its properties the `lc`/`lp`/`pb` byte and a 4-byte dictionary size) and its unpacked size; `sevenZipEncrypted` in `src/checks/attachment-risk.ts` already parses the coders (`coders7z`), so it gains the pack position, pack size, coder properties and unpack size, reads the packed bytes by range, decodes them and reads the result as a plain header (`0x01`), the path it already has; (3) bounds: packed bytes at most `MAX_DIRECTORY_BYTES` (1 MiB), the declared and the decoded output at most 1 MiB, the dictionary taken as no larger than the output (the output buffer is the window), and `lc + lp` at most 4 as the SDK's own decoder refuses; anything past them, a coder other than LZMA, or more than one folder or coder is not checked (`Unreadable`), never clean; (4) the fixtures are raw LZMA1 streams `xz --format=raw --lzma1=lc=3,lp=0,pb=2,dict=64KiB` writes from known header bytes, made by `scripts/fixtures/make-7z-lzma.ts` and kept as files under `test/fixtures/attachments/`, so the tests decode what a real encoder wrote; (5) the `Done when:` of item 2 names a `.7z` of encrypted files with visible names whose header is LZMA-compressed, which is what 7-Zip writes without `-mhe`.

**Corrected 2026-10-31** (from the plan review, `docs/reviews/02-checks/D02-T04-s7.md`; corrections 3 and 4 refined): (6) AES comes first and stays as it is: an encoded header whose coders include AES (`06f10701`), alone or with compression, is an encrypted archive without decoding anything; only an encoded header of exactly one folder of one LZMA coder (`030101`) is decoded, and any other coder, folder or pack layout is not checked; (7) every decoding failure (`LzmaError`: a truncated stream, a properties byte out of range or past `lc + lp` 4, a back-reference before the start, a stream that ends before its declared size, a size or packed length past its bound) is `Unreadable`, so the archive is not checked with that reason, never clean; an R2 failure still throws, so the step retries; the decoded bytes must be a plain header (`0x01`) and are then read by the path that reads one today; (8) the fixtures are complete archives: `scripts/fixtures/make-7z-lzma.ts` writes the start header, a payload of packed file data, the LZMA-compressed header packed after it (a nonzero `PackPos`), and the encoded header naming that range and the unpacked size, for an encrypted-names and a plain archive, so the tests read the packed range from R2 as an upload would.

**Corrected 2026-10-31** (from the completion review, `docs/reviews/02-checks/D02-T04-s7.md`): (9) a header that decodes but is not what the archive says it is was read as clean: the reader now checks the start header's own CRC, its CRC of the next header and, when the encoded header gives it, the decoded header's CRC, and a mismatch is not checked with its reason; (10) the archives were this repository's own: three 7z archives 7-Zip 25.01 itself made with its defaults (plain files, files encrypted with visible names, encrypted names), each passing `7zz t`, are kept as fixtures (`scripts/fixtures/make-7z-real.ts`, `test/fixtures/attachments/seven-zip.ts`, provenance in `eval/DATASETS.md`), and read as nothing, high and high.

**Phase:** 3
**Needs:** none
**Surface:** no

**Build order:**

1. Decode compressed 7z headers within bounds. Done when: an archive of encrypted files with visible names, its header LZMA-compressed, is an encrypted archive, and one of plain files is not.

- [x] Add a bounded LZMA decoder for 7z headers in `src/checks/sevenzip.ts` (a vetted library or the reference decoder), with limits on compressed bytes, expanded bytes (1 MiB) and dictionary memory, refusing anything past them as not checked. Done when: `test/checks/lzma.test.ts` decodes raw LZMA1 streams XZ Utils wrote (text, random, a match-heavy run, a single byte) byte for byte, decodes one exactly at the 1 MiB bound, and refuses with `LzmaError` a truncated stream, an out-of-range and an `lc + lp` past 4 properties byte, a back-reference before the start, a stream shorter than its declared size, and a declared size past the bound (correction 7).
- [x] Read the decoded header's coders for AES in `attachmentRisksOf`. Done when: `test/checks/attachment-risk.test.ts` reads the encrypted-names fixture as `attachment.encrypted_archive` high and the plain one as nothing, both through R2 with a nonzero `PackPos` (correction 8); an AES-only and an AES-with-LZMA encoded header stay high (correction 6); a packed range past the file, a short read and a corrupted packed stream are not checked with their reason, never clean; and `test/checks/check-outcomes.test.ts` stores an unreadable compressed header's archive as not checked while another attachment's finding in the same case still stands.
- [x] Commit: `checks: compressed 7z headers read`

**Test checkpoint:** `pnpm exec vitest run test/checks/lzma.test.ts test/checks/attachment-risk.test.ts test/checks/check-outcomes.test.ts` passes.

> **Verified:** 2026-10-31 | §7 | 499f12d55473b11efee14ae29e523906ca1bf643
> **Review:** `docs/reviews/d02-t04-s7.json`

## 8. Archive members read by content

> **Started:** 2026-10-31T18:12Z

Filed 2026-10-31 from §3's completion review (out of scope): §3 names a ZIP's members and reads their names only, opens no archive inside an archive, and reads no member of a RAR or 7z. A renamed program inside a plain ZIP therefore passes, and a second archive layer hides everything.

**Corrected 2026-10-31** (at start, checked against `src/checks/attachment-risk.ts`): (1) a ZIP's members are listed by `zipEntries` from R2 ranges and read only for an OpenDocument manifest (`memberBytes`, at most `MAX_MANIFEST_BYTES`); members are now read for their first `SNIFF_BYTES` too, a stored member by its first bytes and a deflated one inflated from at most the first `MAX_MEMBER_PACKED_BYTES` (1 MiB) of its data through `DecompressionStream("deflate-raw")`, stopped once `SNIFF_BYTES` are out, and sniffed by `sniff()` (`src/checks/sniff.ts`): a program's bytes are `attachment.executable`, where `<archive> > <member>`, how `its contents (<type>)`, by bytes; (2) `zipEntries` and the member reader take a byte source, R2's ranges for the attachment and an in-memory buffer for a ZIP member, so a ZIP inside a ZIP is read the same way: a nested ZIP is read whole when its expanded size is at most `MAX_NESTED_BYTES` (8 MiB), and its members read as at the first level; a ZIP inside that (a third level), and any nested archive of another kind, is named in `nested` as today, not opened; (3) bounds per attachment: at most `MAX_MEMBERS_READ` (200) members read, at most `MAX_EXPANDED_BYTES` (16 MiB) inflated in all; an encrypted member, a method other than stored or deflated, a member past a bound or one whose bytes cannot be read is counted, and the outcome says how many members were not read (`partial`), never clean; (4) `test/checks/attachment-risk.test.ts` builds its ZIPs with `zip()` (`test/fixtures/attachments/archives.ts`), which stores members; deflated members are made with `CompressionStream("deflate-raw")` in the test, so both methods are read.

**Corrected 2026-10-31** (from the plan review, `docs/reviews/02-checks/D02-T04-s8.md`; corrections 3 and 4 refined): (5) a member whose bytes are damaged (a bad local header, data past the archive, a deflate stream that fails) is counted as not read and the next member is still read; an R2 failure throws, so the step retries; (6) the stored outcome is proven, not only the evidence: `test/checks/check-outcomes.test.ts` reads, through the checks step, a case's archive checks `partial` with the count of members not read, a ZIP of PDFs nested in a ZIP read whole and `ran` with no "archive not opened" (that file's expectation for an ordinary nested ZIP changes with this section), and a finding kept beside members not read; (7) the fixtures are real ZIPs: `scripts/fixtures/make-zips.py` writes them with Python's own `zipfile` (deflated and stored members with their right methods, sizes and CRCs, fixed times, so the same bytes every run), a renamed program among PDFs, a ZIP of PDFs, a ZIP in a ZIP holding a program (deflated at both levels), a ZIP in a ZIP in a ZIP, a nested ZIP whose declared size is below its real one, and a member whose data is damaged; each is tested with 7-Zip (`7zz t`) before it is kept, as base64 in `test/fixtures/attachments/zips.ts`; (8) the bounds are measured: the tests count the bytes requested from R2 and the bytes inflated, and read that a deflated member stops at `SNIFF_BYTES` out, that `MAX_EXPANDED_BYTES` is one budget across both levels, that a nested ZIP whose real size passes `MAX_NESTED_BYTES` though its header says less is stopped at the bound, and that each bound met exactly still reads.

**Corrected 2026-10-31** (from the completion review, `docs/reviews/02-checks/D02-T04-s8.md`): (9) a member `sniff()` calls a ZIP container (`docx`, `xlsx`, `pptx`, `ooxml`, `odf`) is opened as a nested ZIP is, and a RAR or 7z known only by its bytes is named as not opened; (10) once the expansion budget is spent no further member is inflated, each counted; (11) the bounds' tests also count the bytes asked of R2 (a stored member's first `SNIFF_BYTES`, a deflated one's first `MAX_MEMBER_PACKED_BYTES`), meet `MAX_NESTED_BYTES` and `MAX_EXPANDED_BYTES` exactly and one byte past, and read back the stored outcome of a member of another method and of an encrypted one; (12) the worst cases are timed on the wall clock against the checks step's 30-second attempt, measured once in Node and recorded in the findings file (workerd's clock stands still while code runs, and the Node test project cannot type-check Worker code).

**Phase:** 3
**Needs:** none
**Surface:** no

**Build order:**

1. Read members' first bytes, two levels deep, within bounds. Done when: a renamed program inside a ZIP, and a program inside a ZIP inside a ZIP, are `attachment.executable`, and a ZIP of PDFs is not.

- [x] Read each stored or deflated ZIP member's first `SNIFF_BYTES` (deflated through `DecompressionStream`) and sniff it in `src/checks/attachment-risk.ts`, within limits on members read, bytes expanded and depth (two levels). Done when: `test/checks/attachment-risk.test.ts` finds `invoice.pdf` that is a program, stored and deflated, finds nothing in a ZIP of PDFs, and says members were not read for one past `MAX_MEMBERS_READ`, an expansion past `MAX_EXPANDED_BYTES`, an encrypted member and an unknown method.
- [x] Open a nested ZIP to the second level the same way, and say what lies past the limits. Done when: a program inside a ZIP inside a ZIP is found (where naming both levels), a nested ZIP past `MAX_NESTED_BYTES` is named and not opened, and a ZIP at a third level is named, not opened.
- [x] Commit: `checks: archive members read by content`

**Test checkpoint:** `pnpm exec vitest run test/checks/attachment-risk.test.ts test/checks/check-outcomes.test.ts` passes, with the measured bounds of correction 8.

> **Verified:** 2026-11-01 | §8 | 9442ca11f4f0ad255cd663971662280b6406ddf0
> **Review:** `docs/reviews/d02-t04-s8.json`

## 9. Embedded objects in RTF documents

> **Started:** 2026-10-31T18:55Z

Filed 2026-10-31 from §5's completion review (out of scope): §5 identifies an RTF document by its signature, but an RTF file can carry embedded objects (`\object` with `\objdata`, an OLE package holding a program or a document with macros), which nothing reads, so a matching RTF wrapper hides what it carries.

**Corrected 2026-10-31** (at start, checked against `src/checks/attachment-risk.ts`, `src/checks/sniff.ts` and `src/intake/cfb.ts`): (1) `sniff()` names an RTF document (`"rtf"`, from `{\rtf`) and `risksOf` reads nothing of it today; the document is now read from R2 whole when it is at most `MAX_RTF_BYTES` (16 MiB), and one larger is said not checked, never clean; (2) each `\object` group's `\objdata` destination is decoded as the RTF specification gives it (hex digits, whitespace and line breaks ignored; a `\bin N` run taken as N raw bytes), at most `MAX_RTF_OBJECTS` (20) objects and `MAX_OBJECT_BYTES` (8 MiB) decoded each; (3) the decoded bytes are an OLE 1.0 object as MS-OLEDS 2.2 gives it: the `ObjectHeader` (OLEVersion, FormatID 2 for an embedded object, the ClassName as a length-prefixed ANSI string, TopicName, ItemName) and then `NativeDataSize` and the native data; a `Package` object's native data carries the packaged file's name and its bytes (the Packager format: a 2-byte header, the file name and source path as NUL-ended strings, then the data's size and the data), read by the name's extension (`EXECUTABLE_NAMES`, `MACRO_NAMES`) and by `sniff()` of its first `SNIFF_BYTES`; any other class's native data is read as a compound file when it is one (`readCompoundFile`, then `oleMacros`, as an attached OLE document is), and its first bytes sniffed otherwise; (4) findings name `<document> > object <n>` (with the packaged file's name when there is one, `<document> > object 2 (setup.exe)`); an object whose header, size or data does not hold, one past a bound, or a document past `MAX_RTF_BYTES` is counted in `membersNotRead`, so the macro and program checks are `partial` with "N archive members not read by content"; (5) the fixtures are built in the test: RTF text with `\objdata` hex of an OLE 1.0 `Package` holding `samples.pe` as `setup.exe` and as `invoice.pdf`, and of a `Word.Document.8` object whose native data is a compound file with a `_VBA_PROJECT` stream (`makeDecoyCompoundFile` and `renameEntry` from `scripts/fixtures/msg-builder.ts`, as the OLE macro test does), plus a truncated object, an object of FormatID 1 (linked, no data) and 21 objects for the count bound.

**Corrected 2026-10-31** (from the plan review, `docs/reviews/02-checks/D02-T04-s9.md`; corrections 3 to 5 refined): (6) a `Package` object's native data is laid out as oletools' `OleNativeStream` (`oletools/oleobj.py`) reads it: a 2-byte header, the file name and the source path as NUL-ended strings, two 4-byte fields, the temporary path as a NUL-ended string, the data's 4-byte size, then the data; correction 3's shorter layout was wrong; (7) a packaged file's bytes are read as an embedded object's are: a compound file through `oleMacros` (a packaged `invoice.doc` or `invoice.pdf` carrying a VBA project is a high `attachment.macro`), a ZIP container opened as §8 opens a nested one (`memberContents` at depth 2), and its first bytes sniffed; a container this does not read (a RAR, a 7z, a CAB) is counted as not read, never taken as read; (8) the fixtures are written by `scripts/fixtures/make-rtf.py` and each is read back by oletools 0.60.2 (`rtfobj` for the objects, `oleobj` for the package) before it is kept, the extracted file name and bytes asserted equal to what was packed: objects in hex, in `\bin` (with braces and backslashes inside the binary data) and mixed; a program known by its name only (`setup.exe` holding text), one by its bytes only (`invoice.pdf` holding `samples.pe`), a packaged macro document, an object of exactly `MAX_OBJECT_BYTES` (read) and one byte over (counted, decoding stopped at the bound, measured); (9) an object that cannot be read does not end the document's reading: the reader goes on from the end of that object's group (its braces counted, `\bin` runs skipped by their length), keeps every finding so far and reads the objects after it; the tests put a damaged object before and after a packaged program and read back both the critical finding and the `partial` outcome.

**Corrected 2026-10-31** (at build): (10) objects not read are counted in their own `objectsNotRead`, with the reason "N embedded objects not read", not in `membersNotRead`: an RTF object is not an archive member, and correction 4's wording would have said one was; members of a ZIP packaged in an object still count in `membersNotRead`; (11) a damaged object in the fixtures is one whose header has a FormatID that is neither embedded nor linked, since oletools reads an odd count of hex digits by dropping the last one; the reader here still counts an odd count as not read, the stricter of the two.

**Corrected 2026-10-31** (from the completion review, `docs/reviews/02-checks/D02-T04-s9.md`): (12) a class name's trailing NULs past its terminator are padding, stripped as oletools strips them (`Package\0\0` is a Package); (13) every ASCII whitespace character (space, tab, line feed, vertical tab, form feed, carriage return) is ignored inside hex data; (14) a cabinet is known by its bytes (`sniff()` gains `"cab"`, `MSCF` and the reserved field, with its extension, media type, family and name in `src/checks/attachment-type.ts`) and its members are never read: packaged in an RTF object it is an object not read, inside a ZIP it is named as not opened, and attached it leaves the macro and program checks partial ("N RAR, 7z or CAB archive's contents not read"), where before this a cabinet attachment was checked as holding nothing.

**Phase:** 3
**Needs:** none
**Surface:** no

**Build order:**

1. Read an RTF document's embedded objects statically, without opening or running them. Done when: an RTF carrying an embedded program is a critical `attachment.executable`, one carrying a macro document is a high `attachment.macro`, and an object that cannot be read leaves the checks partial.

- [x] Find each `\objdata` group in `src/checks/attachment-risk.ts`, decode its hex within limits on objects and bytes, and read the OLE package's file name and first bytes through `sniff` and `readCompoundFile`. Done when: `test/checks/attachment-risk.test.ts` finds the packaged program by its name and by its bytes, the macro document's `_VBA_PROJECT`, nothing in an RTF without objects, and counts as not read a truncated object, a linked object, the 21st object and a document past `MAX_RTF_BYTES`; `test/checks/check-outcomes.test.ts` reads the stored outcomes `partial` for those and `ran` for a plain RTF.
- [x] Commit: `checks: embedded objects in RTF documents`

**Test checkpoint:** `pnpm exec vitest run test/checks/attachment-risk.test.ts test/checks/check-outcomes.test.ts` passes.

> **Verified:** 2026-10-31 | §9 | ef359abd3344a243e2b9e0d5fcef4b8b00149f46
> **Review:** `docs/reviews/d02-t04-s9.json`

## 10. Attachment content

Filed 2026-10-31 from §8's completion review (Part 2 item 1, out of scope): the attachment checks say what a file is by its bytes and structure (a program, a macro, an encrypted archive) but not whether a file of an ordinary type is harmful: a malicious PDF that stays a PDF passes. Microsoft Defender for Office 365's Safe Attachments analyses attachments in a detonation environment; this product never opens or runs an attachment (design spec 4.3), so any deeper analysis is a design decision first: a static analyser of document internals, a reputation lookup of file hashes, or neither. The reviewer's target, at least 95% detection with at most 2% false positives on a licensed, labelled archive corpus including malicious documents with correct extensions, needs that corpus, which the repository does not hold.

**Phase:** 7
**Operator decision 2026-11-02:** Static document analysis, without opening or running any attachment; the design names the licensed corpus and the measured target.

**Needs:** none
**Surface:** no

**Build order:**

1. Decide whether and how attachments are analysed beyond their type. Done when: a dated design in `docs/specs/` names the approach (static document analysis, hash reputation, or none), the labelled corpus and its licence, the measured target, and the sections that build it, approved by the operator.

- [ ] Write the design in `docs/specs/YYYY-MM-DD-attachment-content-analysis-design.md` from design spec 4.3 (no attachment is opened or run) and the current checks in `src/checks/attachment-risk.ts`. Done when: the operator's approval is recorded in it.
- [ ] File the sections it names through `add-todo`. Done when: they are in the plan, depending on this one.
- [ ] Commit: `docs: attachment content analysis decided`

**Test checkpoint:** `python3 scripts/todo-graph.py validate` passes with the filed sections.

## Verification

- Attachment fixtures produce exactly the expected evidence; no attachment is executed or rendered outside Browser Run.
- `pnpm test` passes; `python3 scripts/todo-graph.py validate` and `plan --check` pass.
