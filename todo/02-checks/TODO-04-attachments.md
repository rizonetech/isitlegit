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
| 7 | §7 | Compressed 7z headers read | §3 | [ ] |
| 8 | §8 | Archive members read by content | §3 | [ ] |
| 9 | §9 | Embedded objects in RTF documents | §5 | [ ] |

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

**Phase:** 6
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

**Phase:** 3
**Needs:** none
**Surface:** no

**Build order:**

1. Decode compressed 7z headers within bounds. Done when: an archive of encrypted files with visible names, its header LZMA-compressed, is an encrypted archive, and one of plain files is not.

- [ ] Add a bounded LZMA decoder for 7z headers in `src/checks/sevenzip.ts` (a vetted library or the reference decoder), with limits on compressed bytes, expanded bytes (1 MiB) and dictionary memory, refusing anything past them as not checked. Done when: `test/checks/attachment-risk.test.ts` decodes a synthetic compressed header and refuses one that expands past the limit.
- [ ] Read the decoded header's coders for AES in `attachmentRisksOf`. Done when: the encrypted-files fixture is `attachment.encrypted_archive` high and the plain one yields nothing.
- [ ] Commit: `checks: compressed 7z headers read`

**Test checkpoint:** `pnpm exec vitest run test/checks/attachment-risk.test.ts` passes.

## 8. Archive members read by content

Filed 2026-10-31 from §3's completion review (out of scope): §3 names a ZIP's members and reads their names only, opens no archive inside an archive, and reads no member of a RAR or 7z. A renamed program inside a plain ZIP therefore passes, and a second archive layer hides everything.

**Phase:** 3
**Needs:** none
**Surface:** no

**Build order:**

1. Read members' first bytes, two levels deep, within bounds. Done when: a renamed program inside a ZIP, and a program inside a ZIP inside a ZIP, are `attachment.executable`, and a ZIP of PDFs is not.

- [ ] Read each stored or deflated ZIP member's first `SNIFF_BYTES` (deflated through `DecompressionStream`) and sniff it in `src/checks/attachment-risk.ts`, within limits on members read, bytes expanded and depth (two levels). Done when: `test/checks/attachment-risk.test.ts` finds `invoice.pdf` that is a program and refuses an expansion past its limit.
- [ ] Open a nested ZIP to the second level the same way, and say what lies past the limits. Done when: the nested program is found and a third level is named, not opened.
- [ ] Commit: `checks: archive members read by content`

**Test checkpoint:** `pnpm exec vitest run test/checks/attachment-risk.test.ts` passes.

## 9. Embedded objects in RTF documents

Filed 2026-10-31 from §5's completion review (out of scope): §5 identifies an RTF document by its signature, but an RTF file can carry embedded objects (`\object` with `\objdata`, an OLE package holding a program or a document with macros), which nothing reads, so a matching RTF wrapper hides what it carries.

**Phase:** 3
**Needs:** none
**Surface:** no

**Build order:**

1. Read an RTF document's embedded objects statically, without opening or running them. Done when: an RTF carrying an embedded program is a critical `attachment.executable`, one carrying a macro document is a high `attachment.macro`, and an object that cannot be read leaves the checks partial.

- [ ] Find each `\objdata` group in `src/checks/attachment-risk.ts`, decode its hex within limits on objects and bytes, and read the OLE package's file name and first bytes through `sniff` and `readCompoundFile`. Done when: `test/checks/attachment-risk.test.ts` finds the program and the macro in synthetic RTF fixtures and names an unreadable object as not checked.
- [ ] Commit: `checks: embedded objects in RTF documents`

**Test checkpoint:** `pnpm exec vitest run test/checks/attachment-risk.test.ts` passes.

## Verification

- Attachment fixtures produce exactly the expected evidence; no attachment is executed or rendered outside Browser Run.
- `pnpm test` passes; `python3 scripts/todo-graph.py validate` and `plan --check` pass.
