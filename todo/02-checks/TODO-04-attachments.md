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
| 2 | §2 | HTML attachments and smuggling | §1 | [ ] |
| 3 | §3 | Macros, encrypted archives and executables | §1 | [ ] |
| 4 | §4 | Type mismatch for uploaded files | §1, D01 T03 §1 | [ ] |
| 5 | §5 | RTF and further formats in the type check | §1 | [ ] |

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

**Phase:** 2
**Needs:** none
**Surface:** no

**Build order:**

1. Register `attachment.html`. Done when: the fixtures for a local login page, a smuggling loader and a harmless receipt each give the expected result.

- [ ] Flag any HTML or SVG attachment as medium `attachment.html`, and raise to high when it contains a password or card field, a form posting off-site, or script building a `Blob` or a `data:` URL from a long base64 string (over 10 KB) with a download trigger. Done when: `test/checks/html-attachment.test.ts` gives high for both hostile fixtures and medium for the receipt.
- [x] Extract links and form actions from the HTML attachment into the case's link list for D02 T07. Done 2026-10-31: moved to D02 T07 §1 as its own item (correction 3), since the link list is built there.
- [ ] Commit: `checks: HTML attachments and smuggling`

**Test checkpoint:** `pnpm exec vitest run test/checks/html-attachment.test.ts` passes and fails if the base64 blob loader is rated medium.

## 3. Macros, encrypted archives and executables

Macro documents, password-protected archives (which defeat scanning) and executables or scripts are critical or high evidence (spec 4.3, 4.6: malware-type attachments set the deterministic floor).

**Phase:** 2
**Needs:** none
**Surface:** no

**Build order:**

1. Register `attachment.macro`, `attachment.encrypted_archive` and `attachment.executable`. Done when: each synthetic fixture yields its item.

- [ ] Detect macros: OOXML containing `vbaProject.bin` or a `.docm`, `.xlsm`, `.pptm` content type (ECMA-376), or an OLE file with a `Macros` or `_VBA_PROJECT` stream (MS-CFB). Done when: `test/checks/attachment-risk.test.ts` flags a synthetic macro OOXML as high.
- [ ] Detect encrypted archives from the ZIP general purpose bit 0 (APPNOTE 4.4.4) and RAR or 7z encryption headers. Done when: a synthetic encrypted ZIP is high and a plain ZIP is not flagged.
- [ ] Flag executables, scripts and shortcuts (PE, ELF, Mach-O, `.js`, `.vbs`, `.ps1`, `.hta`, `.lnk`, `.iso`, `.img`, also inside a plain ZIP one level deep) as critical `attachment.executable`. Done when: the fixtures pass and a ZIP holding a PDF is not flagged.
- [ ] Commit: `checks: macros, encrypted archives and executables`

**Test checkpoint:** `pnpm exec vitest run test/checks/attachment-risk.test.ts` passes and fails if a ZIP's inner executable is missed.

## 4. Type mismatch for uploaded files

Filed 2026-10-30 from §1's plan review (its correction 9): an uploaded document or image is accepted by its bytes, and its summary keeps the detected media type only, so `attachment.type_mismatch` has no claim to compare: a PDF uploaded as `invoice.png` gives no evidence. The upload's own name and submitted media type are kept apart from what was detected, and the check runs over them.

**Phase:** 2
**Needs:** none
**Surface:** no

**Build order:**

1. Keep the upload's claims and compare them. Done when: a PDF uploaded as `invoice.png` stores a mismatch item; a correctly named upload stores none.

- [ ] Keep the submitted file name and media type in the uploaded source's summary (`src/intake/upload.ts`, `parse` in `src/pipeline/analysis-workflow.ts`), apart from the detected type. Done when: `test/intake/upload.test.ts` reads both back.
- [ ] Run `attachment.type_mismatch` (`src/checks/attachment-type.ts`) over the uploaded source as one more attachment, its stored key the artefact. Done when: `test/checks/sniff.test.ts` stores the mismatch for a PDF uploaded as `invoice.png` and nothing for `invoice.pdf`.
- [ ] Commit: `checks: type mismatch for uploaded files`

**Test checkpoint:** `pnpm exec vitest run test/checks/sniff.test.ts test/intake/upload.test.ts` passes.

## 5. RTF and further formats in the type check

Filed 2026-10-30 from §1's completion review (out of scope): §1 recognises the formats a forwarded invoice usually carries, so a program named `invoice.rtf` and declared `application/rtf` claims a format the check does not know, and nothing is said. RTF, and the other document and voice formats members send (OpenDocument, older Office templates, M4A and Ogg voice notes), join the identifier and the claim tables.

**Phase:** 2
**Needs:** none
**Surface:** no

**Build order:**

1. Widen the formats. Done when: a program, script or shortcut behind each new claim is high, and a genuine file of each new format is silent.

- [ ] Add RTF (`{\\rtf`), OpenDocument (a ZIP whose first entry is `mimetype` naming `application/vnd.oasis.opendocument.*`), M4A (`ftyp` with an audio brand) and Ogg to `sniff` in `src/checks/sniff.ts`, with their extensions and media types in `src/checks/attachment-type.ts`. Done when: `test/checks/sniff.test.ts` identifies a synthetic sample of each.
- [ ] Prove the disguise and the silence for each new claim. Done when: the test reads high for a program behind `.rtf`, `.odt`, `.m4a` and `.ogg` names, and nothing for a genuine sample of each.
- [ ] Commit: `checks: RTF and further formats in the type check`

**Test checkpoint:** `pnpm exec vitest run test/checks/sniff.test.ts` passes.

## Verification

- Attachment fixtures produce exactly the expected evidence; no attachment is executed or rendered outside Browser Run.
- `pnpm test` passes; `python3 scripts/todo-graph.py validate` and `plan --check` pass.
