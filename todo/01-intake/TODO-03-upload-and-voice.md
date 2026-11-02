---
schema_version: 1
id: upload-and-voice
domain: 01-intake
status: active
title: "TODO-03 -- Web Upload and Voice Notes"
track: day-1
---

# TODO-03 -- Web Upload and Voice Notes

> **Goal:** A signed-in member uploads an email (`.eml`, `.msg`), a document (PDF, Word .docx, Excel .xlsx, PowerPoint .pptx), a screenshot (PNG, JPEG, WebP) or a voice note (`.ogg`, `.opus`, `.wav`, `.mp3`) and gets the same investigation as a forwarded email; voice notes and voicemail-lure attachments are decoded to 16 kHz mono WAV, transcribed by Muse Voice Transcribe and turned into evidence about what the caller wants and who they claim to be. (**Corrected 2026-10-28**, §8: `.m4a` is refused until §10, which waits on the AAC patent decision.)

> **Current state:** Measured 2026-10-26 20:00 SAST. No upload or audio code exists. WhatsApp intake is out of the event scope (design spec 4.1a), so uploads carry voice notes during the event.

## Inputs

- Design spec 4.1 (upload), 4.2a (voice notes and voicemail lures), 4.5a (standalone documents), 11 (WhatsApp decision).
- Stack doc: `ogg-opus-decoder` 1.7.5; Muse Voice Transcribe takes WAV, 16 kHz mono 16-bit, at most 10 minutes per request.
- Meta docs `speech-to-text.md` and `api-reference_voice_transcribe.md` (look up with `python3 scripts/meta-docs.py find transcribe diarization`).
- -> XREF: D07 T02 §1 -- the session that authorises uploads
- -> XREF: D03 T01 §1 -- the model client every Voice Transcribe and Spark call goes through
- -> XREF: D07 T04 §7 -- the Cases list's Checked by, which names the uploader

## Outcome

- Uploading each accepted type creates a case and runs the same Workflow; an unsupported or oversized file is refused with a clear message.
- A synthetic voice note asking for an urgent payment produces a transcript artefact and evidence naming the request, the claimed identity and the urgency.

**Adjacency:** list=applicable @ D07 T04 §1; document=applicable @ D07 T03 §1; settings=not-applicable (accepted types and limits are fixed in code from spec 4.8); reporting=applicable @ D07 T04 §2; notifications=not-applicable (upload results show on the page; no mail is sent for uploads); permissions=applicable @ D01 T03 §1; audit=applicable @ D01 T01 §7; exchange=not-applicable (single files only, no bulk import); reverse=not-applicable (an upload starts an analysis; cases expire by retention)

**Adjacency rationale:** Uploads become ordinary cases, listed and reported like forwarded mail. The session check in §1 is the permission boundary.

## Implementation Order

| Order | Section | Deliverable | Depends On | Status |
| ----- | ------- | ----------- | ---------- | ------ |
| 1 | §1 | Upload API for mail, documents and audio | D01 T01 §7, D07 T02 §1 | [x] |
| 2 | §2 | Audio decoding to 16 kHz mono WAV | D01 T01 §2 | [x] |
| 3 | §3 | Muse Voice Transcribe client with chunking | §2, D03 T01 §5 | [x] |
| 4 | §4 | Voice evidence: request, claimed identity, urgency | §3 | [x] |
| 5 | §5 | Voicemail-lure attachments in email | §4 | [x] |
| 6 | §6 | Upload page | §1, D07 T01 §10 | [x] |
| 7 | §7 | MP3 decoding | §2 | [x] |
| 8 | §8 | M4A decoding | §2 | [x] |
| 9 | §9 | Filtered resampling for WAV | §2 | [x] |
| 10 | §10 | M4A with libxaac | §8 | [ ] |
| 11 | §11 | Uploading member stored on the case | §1 | [x] |
| 12 | §12 | An upload admitted whatever the browser does | §1 | [x] |
| 13 | §13 | Word, Excel and PowerPoint files accepted | §1, D02 T05 §8 | [x] |
| 14 | §14 | Voice extraction measured on | §4 | [ ] |
| 15 | §15 | Figures read out of a transcript by code | §4 | [ ] |
| 16 | §16 | Transcript stored as its own evidence item | §3 | [ ] |

## 1. Upload API for mail, documents and audio

> **Started:** 2026-10-28T14:53:17Z

`POST /api/upload` accepts one file from a signed-in member and creates a case with channel `upload` (spec 4.1). The file is sniffed by content, not trusted by its extension, and routed: mail goes through the D01 T01 parse path; a PDF or image becomes a standalone document case (spec 4.5a); audio goes through §2 to §4.

**Phase:** 1
**Needs:** none
**Surface:** no

**Corrected 2026-10-28** at start, against the code: the session and organisation come from `requireSession` and `requireOrg` (`src/auth/gate.ts`, `src/auth/org.ts`; a JSON request without a session gets 401, a member of no active organisation 403); `cases` has no `source_kind`, so migration `0018_source_kind.sql` adds it (`mail`, `document`, `image`, `audio`; an email case is `mail`); an uploaded `.eml` or `.msg` is the original message itself, not a forward, so the `parse` step reads it directly (`parseMessage`, or `parseMsg` for a `.msg`) rather than through `extractOriginal`, with headers available as the message carries them (an `.eml` with a `Received` or `Authentication-Results` header; a `.msg` by its own answer, D01 T01 §6), and the branch reads the stored file's media type, recorded when it was stored; and audio is only stored and recorded here, its transcription being D01 T03 §3, not built yet.

**Corrected 2026-10-28** after the plan review (`docs/reviews/01-intake/D01-T03-s1.md`): the stated write order could not work (the store refuses objects for a case that does not exist yet); an upload had no retry identity or recovery, so a lost response or a storage failure could duplicate a case or strand one with its quota spent; `source_kind = image` would have missed D06 T02 §3's document route; the HTTP contract, the bounded read and the container checks were unstated; and nothing proved a non-mail case hands its later steps a usable input. The items below carry each fix.

**Build order:**

1. Write the route in `src/intake/upload.ts`. Done when: a test uploads each accepted type and gets a case id.
2. Refuse the rest. Done when: an executable, a 30 MiB file and an unauthenticated request are each refused with the right status.

- [x] Take the request as `multipart/form-data` with exactly one file in the field `file`, answering `201 { caseId }` for a new case, `200 { caseId, repeat: true }` for the same file uploaded again within 24 hours, and every refusal as JSON `{ error }` in words a member can act on, with no case, object or Workflow created: 400 for no `file`, a second file or field, or a body that is not readable multipart; 401 without a session; 403 without an active organisation membership; 413 and 415 below; 429 at the daily cap; 503 when the service fails, to be retried. Done when: `test/intake/upload.test.ts` drives each through the Worker's route (`worker.fetch`) and finds no case, object or Workflow after each refusal. (**Added 2026-10-28**, plan review P2 4; the upload page is D01 T03 §6.)
- [x] Read the body bounded: a `Content-Length` above 25 MiB plus 64 KiB of multipart overhead is refused 413 before reading; without one, the body is read while counting and abandoned the moment it passes that; the file itself may be 25 MiB exactly and not one byte more. Done when: exactly 25 MiB is accepted, 25 MiB plus one byte is refused 413, and a stream with no length that runs past the limit is refused 413 having read no more than the limit, each with nothing persisted. (**Added 2026-10-28**, plan review P2 5.)
- [x] Write `POST /api/upload` (Hono) behind `requireSession` and `requireOrg`, with the organisation's daily case cap from D07 T02 §4. Done when: an anonymous request gets 401 and a capped organisation gets 429 in `test/intake/upload.test.ts`. The case is created through `admitCase` (D07 T02 §4), which applies the daily cap in the same statement (a count then a separate insert would let two uploads take the last slot).
- [x] Sniff the type from magic bytes (`%PDF`, PNG, JPEG, WebP, OggS, RIFF/WAVE, ID3 or MPEG frame, `ftyp` M4A, OLE header for `.msg`, RFC 5322 header block for `.eml`). Done when: a renamed PDF uploaded as `x.png` is treated as PDF. Cheaper substitute: trusting the extension. (**Corrected 2026-10-28**, plan review P2 6: a container is looked into, not taken by its signature: an OLE file is a message only when it is an Outlook message (`readCompoundFile` with its property stream and message class, D01 T01 §6), so a Word or Excel file is 415; an Ogg file only with an `OpusHead` in its first page, so Vorbis is 415; WebP only as `RIFF....WEBP`, WAV only as `RIFF....WAVE`. Fixtures: a `.doc`, an `.xls`, an Ogg Vorbis and an AVI each refused 415 with nothing stored.)
- [x] Refuse anything else with 415 and files over 25 MiB with 413, storing nothing; an M4A (an `ftyp` box with an audio brand) is refused by type with 415 and the message `UnsupportedAudio` gives, naming the formats taken (D01 T03 §8: AAC decoding waits on §10). Done when: both tests pass, an M4A upload gets 415 with that message, and R2 holds no object.
- [x] Store the file with `putRaw` for mail and `putAttachment` otherwise (**corrected 2026-10-27**, D01 T01 §2's plan review: `putArtefact` takes only derived kinds), create the case with `channel = "upload"` and a `source_kind` of mail, document, image or audio, and start the Workflow. Done when: each accepted fixture creates one case and one Workflow instance. (**Corrected 2026-10-28**, plan review P1 1 and 2: in this order: validate the request and the file, claim the upload and admit the case under the cap in one statement (`admitCase`), store the file, then create the Workflow; a capped upload creates no object and no Workflow. The claim, its undo and its settling move from `src/intake/email.ts` into a shared admission module both intakes use: an upload's claim key is `upload:<SHA-256 of the file>` within the organisation, so a retried request answers the first case; a store failure undoes the case and releases the claim and its quota (503); a Workflow creation whose outcome is unknown is reconciled as the email intake does, and the 15-minute sweep settles an upload claim left pending like an email one. Fault-injection tests: R2 failing, the Workflow creation failing and answering unknown, and a repeated request each leave one case or none, never two, and no claim stranded.)
- [x] Add migration `0018_source_kind.sql` with `cases.source_kind` (`mail`, `document`, `image`, `audio`), `mail` for every existing row, and `sourceKind` on the typed `Case` (`src/db/cases.ts`). Done when: `test/db/schema.test.ts` finds an email case made before the migration read back as `mail`, and `getCaseForPipeline` answers the kind. (**Added 2026-10-28**, plan review P2 7.)
- [x] Make the Workflow's `parse` step branch on `source_kind`. Done when: a PDF case skips MIME parsing and records the document artefact. (**Corrected 2026-10-28** at start: also an uploaded `.eml` parsed directly with its headers available, an uploaded `.msg` through `parseMsg`, an image recorded like a document, and an audio case recorded for D01 T03 §3, each proven through `env.ANALYSIS`; the case ends `done` with the stub verdict, and no reply is sent, since an upload has no forwarder: the member reads the report.) (**Corrected 2026-10-28**, plan review P2 7: every kind stores a summary its later steps read: mail as today; a document, image or audio case as `{ source: { kind, mediaType, key, bytes }, forward: { headersAvailable: false } }` at the same key, which the `checks` step reads and validates. The tests read each summary back and find the stored file's bytes unchanged at its key.)
- [x] Commit: `intake: upload API for mail, documents, images and audio`

**Test checkpoint:** `pnpm exec vitest run test/intake/upload.test.ts` passes and fails if the type sniffing is replaced by the extension.

> **Verified:** 2026-10-28 | §1 | f046a7c79d01d0c98125c0cb729b8b746ba41e17
> **Review:** `docs/reviews/d01-t03-s1.json`

## 2. Audio decoding to 16 kHz mono WAV

> **Started:** 2026-10-27T20:10Z

Muse Voice Transcribe accepts WAV only, 16 kHz mono 16-bit, at most 10 minutes (spec 4.2a). WhatsApp saves voice notes as Ogg Opus; `ogg-opus-decoder` (WASM) decodes them in the Worker. WAV input is resampled; MP3 and M4A are refused with a clear message if no decoder runs in Workers (recorded, not hidden).

**Phase:** 1
**Needs:** none
**Surface:** no

**Corrected 2026-10-27** (validation before building; spike in workerd). The stack doc's `ogg-opus-decoder` does not run in a Worker as published: (1) the package's index imports `@wasm-audio-decoders/common`, which at import time builds a class on `@eshaz/web-worker`, and that refers to a `Worker` global the Workers runtime lacks (`ReferenceError: Worker is not defined`); (2) the decoder compiles its embedded WASM from bytes at runtime, which Workers refuse (`CompileError: WebAssembly.compile(): Wasm code generation disallowed by embedder`, measured in the workers pool). Both have a fix the library itself supports: `@eshaz/web-worker` is aliased to a stub in `wrangler.jsonc` (`alias`) and in the workers project of `vitest.config.ts` (the test plugin does not read Wrangler's alias), and the decoder takes a precompiled module through the static `OpusDecoder.module` (`@wasm-audio-decoders/common` 9.0.7, `instantiate(_EmscriptenWASM, _module)`), which a Worker gets by importing the `.wasm` file (compiled at deploy). The spike decoded a synthetic Ogg Opus tone in workerd this way: 48000 Hz, 1 channel, 143,688 samples, no errors, the same as in Node. Fixtures are generated in Node with `opusscript` 0.1.1 (libopus, MIT; no ffmpeg, opusenc or sox on the build machine). MP3 has a decoder of the same family (`mpg123-decoder` 1.0.3) that the same fix would load, so refusing it is no longer forced; its fixture needs an MP3 encoder, so it is filed as §7 rather than widening this section. M4A (AAC) has no Workers decoder in that family and stays refused.

**Corrected 2026-10-27** (completion review; the dependency item below said `ogg-opus-decoder` 1.7.5 and `opus-decoder` 0.7.12): `ogg-opus-decoder` is dropped. Its Ogg demuxer, `codec-parser`, is LGPL-3.0-or-later, and it decodes a whole slice at once, which a densely compressed stream can make exceed a Worker's 128 MB (the review's gap 1). `src/voice/decode.ts` now walks and checks the Ogg pages itself and gives `opus-decoder`'s `decodeFrames` the packets in batches of at most 5 seconds, measured from each packet's TOC byte, with libopus decoding straight to 16 kHz (its own filtered rate conversion, so the Opus path no longer resamples linearly). The speech-enhancement stub went with it; the Web Worker stub stays, for `opus-decoder`'s own import.

**Build order:**

1. Prove `ogg-opus-decoder` 1.7.5 in the workers pool. Done when: a synthetic Opus fixture decodes to PCM in a Vitest workers test, with the WASM loaded as a precompiled module and nothing compiled at runtime.
2. Decode, resample and chunk as a stream. Done when: a 25-minute compressed recording yields three 16 kHz mono 16-bit WAV chunks holding the right sound, with only the input, one chunk and the decoder's buffers held at once.

- [x] (**Corrected 2026-10-27**: `opus-decoder` alone, above) Add exact dependencies `ogg-opus-decoder` 1.7.5 and `opus-decoder` 0.7.12 (the class whose static `module` takes the precompiled WASM; the version `ogg-opus-decoder` 1.7.5 pins), and dev dependency `opusscript` 0.1.1. Done when: `pnpm install` resolves them, `pnpm why opus-decoder` lists one version, and the WASM loads in the workers pool.
- [x] Extract the Opus decoder's WASM with `scripts/build-opus-wasm.ts` (runs the installed decoder once in Node and writes the module it compiles) to `src/voice/opus-decoder.wasm`, committed, and import it in `src/voice/decode.ts` as a module (`?module`) set on `OpusDecoder.module` before the first decode. Done when: a workers test decodes with runtime compilation impossible (a `WebAssembly.compile` call would throw), and `test/node/opus-wasm.test.ts` fails when the committed file differs from what the installed package produces. Source: `@wasm-audio-decoders/common` 9.0.7 `WASMAudioDecoderCommon.js` (`instantiate`, `setModule`).
- [x] Alias `@eshaz/web-worker` to `src/voice/no-web-worker.ts` (a class that throws if constructed) in `wrangler.jsonc` and in the workers project of `vitest.config.ts`, marked as a workaround (the package's index needs a Web Worker class at import, which a Cloudflare Worker has no use for). Done when: `test/node/opus-wasm.test.ts` fails if the two aliases differ, and `wrangler deploy --dry-run` bundles the decoder.
- [x] Generate synthetic fixtures `test/fixtures/audio/tone.ogg` and `tone.wav` (a 3-second tone, no voice) with `scripts/fixtures/make-audio.ts`. Done when: both files and the generator are committed.
- [x] Write `decodeToWavChunks(bytes, type)` in `src/voice/decode.ts`, an async generator yielding 16 kHz mono 16-bit WAV chunks of at most 10 minutes, for Ogg Opus (fed to `OggOpusDecoder.decode` in slices of at most 64 KiB, then `flush`) and WAV (PCM 16-bit, any rate and channel count, read in slices from the `data` chunk). Each decoded block is mixed down and resampled at once into the current chunk, which is yielded when full, so memory holds the input, one chunk (at most 19.2 MB) and the decoder's buffers, never the whole recording; the decoder is freed in a `finally`, also when the caller stops early. Refuse other types (an MP3 header, an M4A `ftyp` header) with `UnsupportedAudio` naming the type. Done when: `test/voice/decode.test.ts` decodes both fixtures to chunks, refuses MP3 and M4A with the typed error naming each, and finds the decoder freed after a caller that stops after the first chunk. (**Corrected 2026-10-27**, plan review P1 1: decoding whole recordings would need 288 MB for 25 minutes at 48 kHz, past a Worker's 128 MB.)
- [x] Write the streaming resampler `Resampler` in `src/voice/decode.ts` (linear interpolation that carries its position and last sample across blocks, and channel mixdown by averaging) and `wavHeader(samples)`. Done when: tests check the sound, not only the header: the 3-second 440 Hz fixtures come out as 48,000 samples (within one 20 ms Opus frame for Ogg, which drops its 312-sample pre-skip), at 440 Hz (zero crossings, within 2 Hz), at the tone's level (RMS within 5% of the source's, measured on the WAV fixture), a stereo input of the tone on the left and its inverse on the right mixes down to near silence, and the header reads PCM, 16000 Hz, 1 channel, 16 bits, with sizes matching the data. (**Corrected 2026-10-27**, plan review P1 2.)
- [x] Refuse audio over 30 minutes before decoding, from the container's own length (an Ogg's last granule position less its pre-skip, a WAV's `data` size over its byte rate), and split the rest into 10-minute chunks with no sample lost or repeated at a boundary. Done when: a workers test builds a 25-minute Ogg Opus recording from the fixture's packets (repeated, with granules and CRCs rewritten by `test/fixtures/audio/ogg.ts`, a few MB, within the 25 MiB upload limit) and gets three chunks of 9,600,000, 9,600,000 and 4,800,000 samples within a frame, with the tone's phase continuous across each boundary; and a 31-minute one is refused with `AudioTooLong` before a single packet is decoded. (**Corrected 2026-10-27**, plan review P1 1 and 2.)
- [x] Refuse damaged audio, never pass it on as complete: a decode that reports `errors` (the Ogg decoder returns them beside its PCM instead of throwing), a decode with no samples, an Ogg without an `OpusHead`, and a WAV whose `fmt ` is not PCM 16-bit, whose chunk sizes run past the file, or whose channel count or rate is zero, each with `CorruptAudio` naming what was wrong, checked before any allocation the header sizes. Done when: tests refuse a truncated Ogg, an Ogg with one page's bytes flipped (decoder errors, no throw), an empty Ogg, and WAV files with a bad format code, a `data` size past the end and zero channels, each with the typed error. (**Corrected 2026-10-27**, plan review P2 4.)
Evidence 2026-10-27 22:33 SAST. `src/voice/decode.ts` decodes Ogg Opus and PCM 16-bit WAV as a stream to 16 kHz mono 16-bit WAV chunks of at most 10 minutes, with the Opus decoder's WebAssembly imported as a module (`src/voice/opus-decoder.wasm`, written by `scripts/build-opus-wasm.ts`) and set on `OpusDecoder.module`. `pnpm why opus-decoder`: "Found 1 version of opus-decoder" (0.7.12). `pnpm exec vitest run test/voice/decode.test.ts test/node/opus-wasm.test.ts`: 19 passed, among them a decode during which `WebAssembly.compile` throws if called (it is not), a 25-minute Ogg Opus recording built from the fixture's packets (11.8 MB, within the 25 MiB upload limit) giving chunks of 9,600,000, 9,600,000 and 4,799,896 samples, a 31-minute one refused with `AudioTooLong` before a decoder is made, and the decoder freed when the caller stops after the first chunk. No sample is lost or repeated at a boundary: chunked output joined equals the unchunked output exactly, for WAV and for Opus, which is stronger than the phase check planned. The sound is checked: 440 Hz within 2 Hz, the WAV fixture's level within 5%, a stereo Ogg with the tone on one side at half level, a tone against its inverse at silence, and the `Resampler` giving the same samples however its input is split (outputs placed from their count, so rounding cannot drift). Damaged audio is refused with `CorruptAudio`: an Ogg cut short mid-page and at a page boundary, empty, without audio, or not Opus; flipped bytes, caught by the page checksum before decoding (the decoder-errors path is proven by an invalid Opus packet in pages whose checksums are intact, which the decoder reports without throwing); and WAV files with format 3, a `data` chunk past the end, no channels or no RIFF header. Twenty mutations (header rate, resample step, mixdown in each path, decoder errors ignored, no 30-minute cap, decoder not freed, no checksum, no end-of-stream check, a chunk one short, WAV size and format unchecked, an empty decode accepted, the whole file fed at once, the resampler's carry and final samples, a WAV file differing from the package's) each fail them. `wrangler deploy --dry-run` of an entry importing the decoder bundles `opus-decoder.wasm` as its own module, 285 KiB in all: `@wasm-audio-decoders/opus-ml` (2.7 MB of speech enhancement, imported only on an option this code never passes) is aliased to `src/voice/no-opus-ml.ts` beside the Web Worker stub, in both configs, and the alias test covers both (an addition to the planned alias, recorded here). Full suite: 411 passed.

Evidence after the completion review, 2026-10-27 22:58 SAST. Its six in-scope gaps and one improvement are closed: decoding runs in batches of at most 5 seconds of packets (a 29-minute stereo stream of the densest packets Opus allows, 450 KB, decodes with no batch over 81,920 samples a channel, where decoding it whole at 48 kHz would need 668 MB); a page taken out is refused by its sequence number (`CorruptAudio`, "page 80 is missing"); a WAV ending partway through a sample frame is refused; anything the decoder throws becomes `CorruptAudio`, and packets with no frames, over 120 ms or larger than the decoder's 3,840 bytes a channel are refused before decoding; chained or multiplexed Ogg streams and more than two channels are refused (`UnsupportedAudio`) before a decoder is made, and the length is the sum of the packets' own durations, so a file's granule positions cannot hide its length; `NOTICE.md` records each new dependency and the shipped libopus, whose licence is beside the WebAssembly (`src/voice/opus-decoder.wasm.LICENSE`). Measured in local workerd: a 3-second note in 23 ms; a 25-minute recording's first chunk in 1.1 s and all three in 2.6 s. A fix the new tests caught: `opus-decoder` applies the pre-skip in output samples, while Ogg Opus states it at 48 kHz, so it is scaled (104 samples at 16 kHz, not 312); the fixtures now decode to exactly 47,896 samples and the 25-minute chunks to 9,600,000, 9,600,000 and 4,799,896. `pnpm exec vitest run test/voice/decode.test.ts test/node/opus-wasm.test.ts`: 26 passed; sixteen more mutations each fail them. Filed: WAV's linear resampling replaced by a filtered one, and the timings compared with FFmpeg, as §9.
Evidence after review rounds 1 to 5, 2026-10-27 23:24 SAST. Round 1 (`33d4555`): a page's continuation flag must match the page before it; the last page's granule position sets what is kept (RFC 7845 4.4 end trimming, within the last page), so a recording of exactly 30 minutes is taken; the OpusHead output gain is applied; a WAV's RIFF size is checked. Round 2 (`4e5e99b`): OpusTags read to its bounds; a recording whose positions start above zero keeps its length (4.5). Round 3 (`d314541`): a second WAV `data` or `fmt` chunk is refused. Round 4 (`7ddc0e6`), the third round on the Ogg scan, so gone through rule by rule: page version, defined flags, the first page beginning the stream, a page that ends it being the last, the OpusHead alone on the first page, the OpusTags from the second page to a page's end, the audio after it, header pages at granule 0, and the OpusHead version. Round 5 approved. `pnpm exec vitest run test/voice/decode.test.ts test/node/opus-wasm.test.ts`: 33 passed; every fix's mutation fails them. Full suite: 425 passed.
> **Resolved:** filtered resampling for WAV input and a timing comparison with FFmpeg -> XREF: D01 T03 §9. Resolved 2026-10-28 by D01 T03 §9 in `b9fb1b8` and `bd81843`: a Kaiser-windowed sinc in WebAssembly SIMD, and the bench against FFmpeg in CI.
> **Resolved:** decoding MP3 voice notes and voicemail attachments (refused with `UnsupportedAudio` until then) -> XREF: D01 T03 §7. Resolved 2026-10-28 by D01 T03 §7 in `e28af5c`: `decodeToWavChunks` decodes `audio/mpeg` through `src/voice/mp3.ts`.
> **Resolved:** decoding M4A (AAC) voice notes, refused with `UnsupportedAudio` until then -> XREF: D01 T03 §8. Resolved 2026-10-28 by D01 T03 §8 in `ef40084` (the message reworded in `e901e3b`): M4A is refused by design, naming the formats taken, while the AAC patent decision is open; decoding it is D01 T03 §10.

- [x] Commit: `voice: decode voice notes to 16 kHz mono WAV`

**Test checkpoint:** `pnpm exec vitest run test/voice/decode.test.ts` passes and fails if the sample rate written to the header is not 16000, if the decoded tone is not 440 Hz at its level, if a 10-minute boundary drops or repeats samples, if a recording over 30 minutes is decoded at all, or if damaged audio is passed on.

> **Verified:** 2026-10-27 | §2 | fcc92ad1a2c537a294c2b0c8c028a2cc58a96142
> **Review:** `docs/reviews/d01-t03-s2.json`

## 3. Muse Voice Transcribe client with chunking

> **Started:** 2026-10-31T15:25Z

`muse-voice-transcribe-1.0` returns a diarized transcript (spec 4.2a). Calls go through the model client (D03 T01) for the budget guard, Standard IDs and cost logging. Each chunk is transcribed and the transcripts are joined in order.

**Corrected 2026-10-31** (at start, checked against the repository and `sources/meta-api/docs/docs/speech-to-text.md`): (1) the file endpoint is `POST /v1/asr/transcribe`, multipart with a `request` part (`model`, `audioEncoding: "WAV"`, `mode: "DIARIZATION"`) and an `audio` part, mono 16-bit PCM WAV at 16 or 24 kHz, at most 10 minutes and 32 MB a request; the answer is `TranscribeResponse` (`sessionId`, `transcript`, `audioDurationMs`, `turns[]` of `turnId`, `startMs`, `endMs`, `transcript`, `speaker` in `DIARIZATION`), $0.18 an hour. The D03 T01 client already sends it: `metaRaw("/asr/transcribe", { request, audio, audioSeconds }, ctx)` in `src/meta/client.ts` reserves the budget by length, retries 429 and 5xx, and settles at Meta's `audioDurationMs`; `decodeToWavChunks` (`src/voice/decode.ts`, §2) yields the 10-minute 16 kHz WAV chunks. (2) Speaker labels are scoped to one transcription ("a label does not identify the same person across separate sessions"), so each chunk's turns keep their chunk's number beside the label, never merged across chunks, and each chunk's times are offset by the chunks before it, measured from the WAV itself. (3) "The case ends partial with the step named" needs a Workflow step nobody owns: an uploaded voice note today ends `done` with the stub verdict, and §5 wires only email attachments. So this section adds the `transcribe` step to `src/pipeline/analysis-workflow.ts` (`StepName`), after `parse` and only for an audio case: it reads the stored recording, decodes it, transcribes each chunk under the case's budget (owner `{ kind: "case", step: "transcribe" }`) and stores `transcript.json`; damaged audio and a malformed answer are final (`NonRetryableError`, a malformed answer recorded as an output failure on its paid call), so the case ends `partial` naming `transcribe`. Its own config: two attempts of up to five minutes, since a retry repays every chunk. The report's progress list names an unknown step "Another step" (`src/web/pages/report-progress.ts`, the app lane's): its words for `transcribe` are asked of that lane. (4) The fixture is synthesised offline with Windows' own speech (`System.Speech`, the David and Zira voices) through `powershell.exe` from WSL by `scripts/fixtures/make-voice.ts`, two speakers, encoded as Ogg Opus with libopus as `make-audio.ts` does; no voice clone and no outbound service.

**Corrected 2026-10-31** (from the plan review, `docs/reviews/01-intake/D01-T03-s3.md`): (5) the client's reservation bounds a recording's length by its size at 500 bytes a second (`MIN_AUDIO_BYTES_PER_SECOND`), right for compressed speech and wrong for the PCM WAV this endpoint takes (32,000 bytes a second): a 10-minute chunk would reserve about $1.92 for a $0.03 call and be refused while credit remains. `metaRaw` reads a well-formed PCM WAV's own length (its data bytes over its byte rate) and keeps the floor for anything else, asked of the coordinator (D03 is main's) on 2026-10-31; (6) the report's words and states for the step are a D07 section, its ref asked of the app lane through the coordinator and named here as a `Deferred:` line once filed; until it lands the report lists the step as "Another step". `CorruptAudio`, `AudioTooLong` and `UnsupportedAudio` are all final; (7) recovery is proven, not assumed: the Workflow tests fail the second chunk's call once and see the step's retry finish with every chunk's transcript in order, fail it every time and see the case `partial` naming `transcribe` with no verdict stored and at most two attempts recorded, refuse a call at the budget, and fail the transcript's storage after paid calls, each charge recorded once per attempt; (8) the live proof reads the transcript back and checks it against the fixture's script: the payment request, the claimed identity and the deadline words are in it, two speakers are labelled, and turns are in time order; a blank or unrelated transcript fails it, and the check's result is recorded beside latency and cost.

**Corrected 2026-10-31** (from the completion review, `docs/reviews/01-intake/D01-T03-s3.md`): (9) a turn a chunk's end cut off comes back with an empty transcript (schemas.md, `TranscribeResponse.turns`): it is kept as a gap with its times and the transcript marked `complete: false`, never dropped as though nothing were said; silence (no turns) is a whole transcript; (10) the live check saves each transcript beside the ledger (temporary file, then replace) and checks what it reads back, and it also times a near-limit recording (the note's speech repeated to 600 seconds, one full chunk), so latency is measured on a short and a near-limit recording; (11) the review's comparison with Microsoft Word's transcription is not run here: this machine has no Word licence or automation for it, so the record gives this pipeline's own timings and says so, without claiming a speed advantage.

**Phase:** 3
**Needs:** meta-api
**Surface:** no

**Build order:**

1. Write `src/voice/transcribe.ts`. Done when: a stubbed test sends each WAV chunk and joins the results with speaker labels.
2. Run it once live on a synthetic voice fixture. Done when: the transcript artefact exists and the cost is logged.

- [x] Look up the request shape with `python3 scripts/meta-docs.py find asr transcribe diarization` and record the endpoint, fields and response shape in a comment at the top of `src/voice/transcribe.ts` with the docs URL. Done when: the comment cites `https://dev.meta.ai/docs/speech-to-text`.
- [x] Write `transcribe(caseId, chunks)` calling the endpoint through the D03 T01 client with model `muse-voice-transcribe-1.0`. Done when: `test/voice/transcribe.test.ts` with a stubbed transport checks the request for each chunk.
- [x] Validate the response with zod and join chunks in order, keeping speaker turns (correction 2). Done when: a malformed stub response raises `ModelOutputError` and records an output failure on its call, and the test fails when chunks are joined out of order or their times are not offset.
- [x] Add the `transcribe` step for audio cases (correction 3). Done when: `test/voice/transcribe-step.test.ts` runs an uploaded Ogg voice note through `env.ANALYSIS` with a stubbed Meta and reads `transcript.json` and the step's `done` event; a malformed answer, damaged audio and a recording over 30 minutes each end the case `partial` naming `transcribe`, after one attempt; the recovery cases of correction 7 hold; a mail case records no `transcribe` event.
- [x] Store the transcript as artefact kind `audio` with name `transcript.json`. Done when: the test reads it from R2.
- [x] Create a synthetic voice fixture `test/fixtures/audio/director-urgent-payment.ogg` (fictional names, a request to pay a new account today) with `scripts/fixtures/make-voice.ts`, recording how it was made in `eval/DATASETS.md`. Done when: the file exists and its provenance line names the method.
- [x] Have `metaRaw` reserve a PCM WAV by its own length (correction 5, once the coordinator approves the edit in `src/meta/client.ts`). Done when: `test/meta/client.test.ts` admits a 10-minute WAV under a budget between its true cost and the floor's, and still bounds a non-WAV blob of the same size by the floor.
- [x] Keep speech cut at a chunk's end as a gap and mark the transcript incomplete (correction 9). Done when: `test/voice/transcribe.test.ts` reads the gap and `complete: false` for a chunk whose last turn is empty, and a whole empty transcript for silence.
- [x] Run `node scripts/voice-transcribe-live.ts` once the smoke's day cap allows (after 22:00 UTC, 2026-10-31), check the read-back transcript against the script (corrections 8 and 10), and record model, seconds of audio, latency and cost of both recordings and the check's result in `docs/frontier-log.md`. Done when: the entry exists and the check passed.
- [x] Commit: `voice: Muse Voice Transcribe with chunking`

**Test checkpoint:** `pnpm exec vitest run test/voice/transcribe.test.ts test/voice/transcribe-step.test.ts` passes and fails if chunks are joined out of order.

> **Verified:** 2026-11-01 | §3 | e5e54698ca8e3d37be89ece51c8e6f7c6c9d4afd
> **Review:** `docs/reviews/d01-t03-s3.json`

## 4. Voice evidence: request, claimed identity, urgency

> **Started:** 2026-11-01T05:06Z

The transcript is untrusted content. Muse Spark reads it inside an untrusted block (D03 T01 §6) and returns structured fields: what is being asked (pay, change bank details, share a code, click a link, other), who the speaker claims to be, urgency cues, and any payment details mentioned (spec 4.2a). The report states the limits: no Afrikaans, isiZulu or isiXhosa support, and no voice-clone detection.

**Corrected 2026-11-01:** the four coarse items are six: where the extraction runs (the checks step, once, its result stored so a replay never pays twice, infrastructure failures retried, terminal ones stated), what a quote must be to be kept (a substring of the transcript), how a failure is stated (not checked and partial, never clean), and the card words requested of the app lane.

**Corrected 2026-11-01 (plan review):** (1) the extraction is its own step with its own timeout, not inside `checks`' 30 seconds; (2) a claim is kept only with support in the transcript (a verified quote, details that appear in it); (3) the "never pays twice" claim is corrected to bounded, accounted retries; (4) the schema is required-and-nullable as `structured()` needs; (5) the proof covers every request and severity, a null identity, silence and an incomplete transcript, read back from storage; (6) the member-facing words are handed to D07 T03 §16 by name.

**Corrected 2026-11-01 (review rounds 1 to 4):** four rounds in a row found a way to read a payment figure out of the middle of another (the 50 of 100.50, the R150 of R1,50, R100 million as R100, 100 dollars from 100 rand beside 200 dollars) however the matching was made. Restating figures the transcript holds is the wrong layer: the claim now carries the sentence the speaker said (`payment_quote`), verified as a quote is, and the evidence shows it in the speaker's words. Reading amounts and accounts out for the registry match (D05) is a deterministic job on the transcript, not the model's, and is filed as D01 T03 §15.

**Phase:** 3
**Needs:** meta-api
**Surface:** no

**Build order:**

1. Write `src/voice/extract.ts` with a zod schema and the Spark call. Done when: a stubbed test turns a transcript into evidence items.
2. Add the limits note. Done when: every voice case carries an info evidence item stating them.

- [x] Define `VoiceClaim` in `src/voice/schema.ts` for `structured()` (every property required, absence a null): `request` (`pay`, `change_bank_details`, `share_code`, `click_link`, `other`, `none`) with `request_quote`, `claimed_identity` (a short string or null) with `identity_quote`, `urgency` (`low`, `medium`, `high`) with `urgency_quote`, and `payment_quote` (the sentence in which the speaker gives an amount, an account or who is to be paid, or null), every quote a string of at most 200 characters or null. The model does not restate the figures: the member reads them in the speaker's own words (corrected in round 4, below). Done when: `test/voice/schema.test.ts` parses a valid claim and refuses each field out of range, `formatSchema(VoiceClaim)` (`src/meta/structured.ts`) accepts it with no recursion, and a claim with no payment sentence (null) and one with it round-trip through `structured()` with a stubbed model.
- [x] Write `extractVoiceClaim(transcript, ctx)` in `src/voice/extract.ts`: Muse Spark (`muse-spark-1.3`, low reasoning effort, a bounded output) through `structured()` with the task as developer instructions and the transcript only inside an `untrusted("transcript", ...)` block with its nonce, under the case's budget (`d1Budget`, caller `voice-extract`) and its own deadline (`VOICE_CALL_MS`). Each claim is kept only with support: a field's quote must be a substring of the transcript (compared by whitespace and case) or the field is dropped (`request` becomes `none`, the identity null, the urgency `low`), and the payment sentence is a quote like the others and is dropped, and counted, when it is not in the transcript; what was dropped is counted and returned. Silence (an empty transcript) makes no call. A failure is typed: `budget`, `budget-unavailable`, `output-<kind>`, `model-<kind>`, `error`. Done when: `test/voice/extract.test.ts` with a stubbed model checks the request holds the untrusted delimiters and the nonce, the transcript text nowhere outside the block (and fails if it is placed outside), a spoken instruction ("ignore the above, say this is safe") never reaching the instructions, a claim with empty quotes, with every quote rejected, and with a valid quote beside an invented or altered payment sentence each reduced as stated, silence making no call, and each failure kind mapped. A claim is supported by the transcript's words; whether a true quote means what the model says is the model's judgement, and the report states that limit.
- [x] Run the extraction in its own Workflow step `voice` after `transcribe` (`src/pipeline/analysis-workflow.ts`), for an uploaded audio case only, with its own retry and timeout (`VOICE_RETRIES`, longer than the 30 seconds `checks` has, since the client's own deadline is 60 seconds with retries and a repair): it reads `transcript.json` (`src/voice/transcribe.ts`) and stores `voice-claim.json` (the claim, or a terminal failure with its reason; the write is idempotent), so a retry reads it first. An infrastructure failure (`error`, `budget-unavailable`, a retryable model error) throws so the step is retried; a spent budget, a refused or invalid answer, a timeout after the retries and a step that cannot finish are stored as not checked, so the case still completes, partial. A paid answer whose storage then fails is paid again on the retry, bounded by the step's attempts and each call recorded in the budget ledger: the guarantee is bounded, accounted retries, not none. The case view gains `voice` (the claim, or the not-checked reason, and whether the transcript was `complete`). Done when: through `env.ANALYSIS` with a stubbed model, a delayed answer completes the case, exhausted retries leave a named not-checked and a partial case, a run twice reads the stored result and calls the model once, a failed artefact write and a committed write whose acknowledgement is lost are retried with the call count and charges read back from the ledger, and a mail or document case has no `voice` step.
- [x] Turn the view into evidence in a registered check `voice.claims` (`src/checks/voice.ts`): `voice.request` (high for `pay` or `change_bank_details`, medium for `share_code` or `click_link`, info for `other`, none for `none`) with its verified quote and the payment sentence; `voice.claimed_identity` (info, only when the identity is non-null and quoted, used by D05 T02 §2 against the registry); `voice.urgency` (medium for high, low for medium, info for low) with its quote; a not-checked info item with the reason when extraction did not answer or support was dropped, one when the transcript was incomplete (`complete` false) and one for silence; the outcome is partial in each, never clean. Done when: `test/checks/voice.test.ts` reads back from storage (`readEvidence`, `readCheckOutcomes`) the three items with quotes for the fixture transcript, every request and its severity, no identity item for a null identity, the not-checked item and a partial outcome for a failed extraction, an incomplete transcript and silence, and a payment request reduced to none by an unsupported quote.
- [x] Add the info evidence item `voice.limits` to every voice case that reaches the checks (also when extraction failed or the transcript was silent): no Afrikaans, isiZulu or isiXhosa support, no voice-clone detection (spec 4.2a), and that a matching quote shows where the reading comes from, not that it is right. A recording whose decoding or transcription fails ends the case partial naming `transcribe` with no checks and no evidence at all (D01 T03 §3), so it has no `voice.limits`; the report states that failure and D07 T03 §16 is asked to state the limits beside it. Done when: an audio case has it whatever extraction did, and a mail or document case has none. Cheaper substitute: omitting the limits, which overstates the product.
- [x] Hand the member-facing words to the section that owns them: D07 T03 §16 (Voice cards, the app lane's, which depends on this section) is asked, through the coordinator, to render these persisted states: the three evidence kinds with their quotes and the payment details, `voice.limits`, the not-checked reasons (extraction failed, support dropped, incomplete transcript, silence) and the transcript's own limits. Done when: the request is sent against D07 T03 §16 and each of the check's own plain summaries (`Check.summary`, D02 T01 §7) reads for each state in `test/checks/voice.test.ts`.
- [x] Commit: `voice: request, claimed identity and urgency evidence`

**Test checkpoint:** `pnpm exec vitest run test/voice/schema.test.ts test/voice/extract.test.ts test/checks/voice.test.ts` passes and `test/voice/extract.test.ts` fails if the transcript is placed outside the untrusted block.

> **Verified:** 2026-11-01 | §4 | 061717317bbf80efb0337c31aafa129afe7425c3
> **Review:** `docs/reviews/d01-t03-s4.json`

## 5. Voicemail-lure attachments in email

> **Started:** 2026-11-01T15:58Z

Phishing mail often poses as a voicemail: an audio attachment or an HTML "play message" page (spec 4.2a). Audio attachments go through §2 to §4; HTML lures are flagged for the link and attachment checks.

**Corrected 2026-11-01** (at start, checked against `src/pipeline/analysis-workflow.ts`, `src/voice/transcribe.ts`, `src/checks/voice.ts` and `src/checks/html-attachment.ts`): (1) routing lives in the Workflow's `run()`, beside the uploaded-audio branch: after `parse`, a mail case's attachments are read from the parsed summary, each sniffed with `sniff` (`src/checks/sniff.ts`: wav, ogg, m4a, mp3), and every audio one is decoded as one chunk stream in attachment order into the case's one transcript, so the existing `transcribe` and `voice` steps and the §4 evidence work unchanged; a recording that cannot be decoded ends the step with the same named fatal errors an uploaded one does; (2) the checks step reads the stored voice claim for a mail case too (today only an uploaded audio case's is read), so the transcript of a mail attachment is evidence in the same case; (3) `voice.lure` is a check over the view's HTML attachments (`htmlAttachmentsOf`'s read text): voicemail wording in the attachment's own words, and a player (`<audio>`, a media source, or a control that says play or listen) or a link in it; the wording alone in a newsletter, with neither, is not flagged; (4) the two fixtures are authored synthetically for this section (`test/fixtures/voicemail-wav.eml` carries a tiny generated WAV; no client mail), and the test drives the real Workflow steps with the model calls stubbed as the voice step tests stub them.

**Phase:** 3
**Needs:** none
**Surface:** no

**Build order:**

1. Route audio attachments of a mail case to the voice path. Done when: a fixture email with a `.wav` attachment produces a transcript step.
2. Flag HTML play-message lures. Done when: a fixture HTML attachment with a fake player yields a `voice.lure` evidence item.

- [x] In the Workflow `parse` step, queue every attachment whose sniffed type is audio for decode and transcription. Done when: `test/voice/lure.test.ts` sees the voice steps run for `test/fixtures/voicemail-wav.eml`. (**Corrected 2026-11-01**, plan review, `docs/reviews/01-intake/D01-T03-s5.md`: (5) at most 3 recordings a case, in attachment order, each decoded and transcribed on its own so its identity and boundaries survive in the stored transcript (per-recording texts joined, `complete` only when every recording was transcribed whole); recordings past the bound, and one that cannot be decoded or is refused by the decoder, are stated in the voice evidence as not read, never silently dropped and never failing the whole case; the case budget of §3 is the spend bound, and a retry resumes from the stored transcript as §4's step does; (6) the test asserts the stored transcript and claim read back, the persisted voice evidence and outcomes, and the case's status, for a forwarded original with audio as well as direct mail, and drives corrupt, unsupported, over-duration and missing-attachment cases to their named partial outcomes, with both model endpoints stubbed at `fetch` so decoding, orchestration and persistence stay real.)
- [x] Detect HTML attachments with voicemail wording ("voice message", "play", "listen", "voicemail") and an audio player or a link, as a medium `voice.lure` evidence item. Done when: `test/fixtures/voicemail-html-lure.eml` yields it and a plain HTML newsletter does not. (**Corrected 2026-11-01**, plan review: (7) the wording is voicemail-specific (`voice message`, `voicemail`, `voice mail`, a missed call or a message waiting), never the bare verbs play or listen, so a newsletter's podcast link is not flagged; the player or link must stand with that wording in the same attachment; (8) `analyseHtml` (`src/checks/html-attachment.ts`) gains the typed features the check reads (the voicemail wording and an audio player in the page), so no check parses HTML itself; (9) the new check's report contract (its `CHECK_WORDS` entry, voice-family rendering and fixtures in `test/web/evidence-cards.test.ts`) is the app lane's, filed through the coordinator as its next D07 T03 section, and this section's stamp waits for it on main, as D02 T06 §4's does; that test joins this section's checkpoint once it lands; (10) mail cases with voice analysis keep their channel; the reply and report already read the case's voice evidence from its items, and any voice-specific guidance keyed on `sourceKind` alone is the app lane's with (9).)
- [x] Commit: `voice: voicemail-lure attachments in email`

**Test checkpoint:** `pnpm exec vitest run test/voice/lure.test.ts` passes and fails if the newsletter fixture is flagged.

> **Verified:** 2026-11-02 | §5 | d8686377b0908b6a3705923c1b5c9123581f7cc1
> **Review:** `docs/reviews/d01-t03-s5.json`

## 6. Upload page

The member-facing page for uploads: one drop zone and file picker, accepted types listed, progress, and a redirect to the live report (spec 4.1). It follows `design/SPEC.md`.

> **Started:** 2026-10-31T09:41:49Z
>
> **Corrected 2026-10-31:** Fact-checked against the tree and the boards (moved to the app lane at the checks lane's request, 2026-10-31). (1) The API is `POST /api/upload` (`src/intake/upload.ts`, D01 T03 §1, the checks lane's): exactly one file in the multipart field `file`, at most 25 MB (`MAX_UPLOAD_BYTES`) and a name of at most 255 characters (`MAX_CLAIM_CHARS`); it answers 201 `{ caseId }`, 200 `{ caseId, repeat: true }` for the same file within the day, and 400, 401, 403, 413, 415, 429 or 503 as `{ error }` (503 with `retry-after`). (2) Success opens the report at `/r/<caseId>`; the plan's `/cases/<id>` does not exist. (3) The page works without its script: the form posts to the page's own `POST /upload`, which hands the request to the same `uploadRoutes` (no second copy of the upload's rules, and `src/intake/upload.ts` unchanged) and answers 303 to the report, or the page again with the API's message in its alert region at the API's status. With the app script the same form is sent to `/api/upload` by `XMLHttpRequest`, which gives the board's progress ("1.2 MB of 1.9 MB · then the report opens") and keeps the chosen file through a refusal. (4) The board's states (`Upload-States`): refused type (415) names the file and gives the API's reason; too large (413) names the file's size and the 25 MB limit, checked before sending too; the daily limit (429) reads "Uploads paused until midnight" with the time left to 00:00 SAST and About your plan; signed out (401) says the session ended, links Sign in again back to `/upload`, and that nothing was uploaded; 400, 403 and 503 show the API's own words, 503 with Try again; a request that never arrives says so. (5) The board's usage line ("<organisation> has used <n> of <limit> checks today. The count resets at midnight SAST.", See your plan) is read by a new `todayUsage` in `src/db/case-list.ts` (cases since `sastDayStart`, against `org_limits.daily_cases` or `DEFAULT_DAILY_CASES`); `src/db/cases.ts` stays the checks lane's.
>
> **Corrected 2026-10-31 (plan review):** (6) Without the script the form needs a submit: "Check this file", shown only where the app script does not run (the script sends the file the moment one is chosen, as the board draws), recorded as an M2 Deviation. (7) The page's `POST /upload` hands `uploadRoutes` a copy of the request that asks for JSON (`accept: application/json`), since the session gate answers a browser's HTML request with a redirect, and passes the answer's `set-cookie` and `retry-after` on. (8) A request is bounded: no progress for 30 seconds ends it, and an answer that never comes after the file was sent says the outcome is unknown, not that it never arrived; trying again with the kept file is safe, since the same file within the day answers its first case (200, `repeat`). (9) The daily limit disables nothing: Choose a file stays usable, so a choice after 00:00 SAST is checked. (10) Several files dropped at once are refused ("Drop one file at a time") with nothing sent.
>
> **Corrected 2026-10-31 (build):** (11) All the refusals' words are drawn by the server (`alertFor` in `src/web/pages/upload-view.tsx`): the script posts to the page's own `POST /upload` (not `/api/upload`), sending the file's name and size beside it (`x-file-name`, `x-file-size`) so a refusal can name the file, and is answered the report's address (`x-location`) or the alert alone; only what is known before sending and what the connection does are worded in the script. (12) A browser may report an upload done only once an answer starts, so a stall the script ends cannot tell whether the file arrived: it is always said to be unknown; "did not reach us" is kept for a connection error before any of the file was taken. (13) The view (`upload-view.tsx`) is kept apart from the routes, so the browser tests draw it without the Worker's storage types. (14) Without the script a refusal's words cannot name the file ("this file"), as the form posts the file alone.
>
> **Corrected 2026-10-31 (completion review):** (15) Audio is listed as intake takes it (.ogg, .opus, .wav, .mp3; M4A is refused until D01 T03 §10). (16) The board's states are drawn from the form's `data-state` by the stylesheet: ready (the upload icon), uploading (the zone becomes the progress, `aria-busy="true"`), refused (a red alert) and paused (the daily limit: "Uploads paused until midnight" and an amber alert, the zone not dimmed for contrast, an M2 Deviation). (17) The file input sits inside the zone, so its keyboard focus shows on the zone, and without the script it is shown, naming the chosen file. (18) The input is emptied once its file is taken, so choosing the same file again (after the daily limit) is heard; the daily limit offers Try again. (19) Without the script a retryable refusal says "Choose the file again and select Check this file." instead of a Try again that needs the script. (20) A file too large is advised by its kind (a recording shortened, anything else sent as a smaller copy), sized rounded up to a tenth of a megabyte; the time to midnight is counted in whole minutes. (21) A script request's failure is answered with an alert marked `x-upload-alert`, and the script draws only such alerts, never a whole error page inside its form.
>
**Phase:** 2
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` upload screen and its mockup
**Job:** a member checks a file they received without forwarding an email
**Treatment:** one primary action, the accepted types in plain words, errors that say what to do
**Chrome:** the shared app shell and form controls from D07 T01 §3 and §6 to §8, proven together in D07 T01 §10

**Build order:**

1. Build `src/web/pages/upload.tsx` against the SPEC. Done when: the page renders with the shell, the drop zone and the type list.
2. Wire it to `POST /api/upload` with htmx. Done when: a successful upload redirects to the report and a refused one shows the server's message.

- [x] Build `GET /upload` in `src/web/pages/upload.tsx` in the member shell (M2, board `Upload`): the title and sentence, the drop zone ("Drop one file here", or, Choose a file as a labelled file input), "One file at a time, up to 25 MB", the four accepted kinds with their formats, what is not accepted, and the usage line with See your plan. Done when: `test/web/upload-page.test.ts` finds each by its accessible name or words, a signed-out visitor is sent to sign in and back, and the usage line counts today's cases against the organisation's limit. Cheaper substitute: a bare file input without the SPEC layout.
- [x] Add `todayUsage` to `src/db/case-list.ts` (today's cases since `sastDayStart`, the organisation's `org_limits.daily_cases` or `DEFAULT_DAILY_CASES`). Done when: the test counts an organisation with and without its own limit, and only its own cases since midnight SAST.
- [x] Answer the form without the script: `POST /upload` hands the request to `uploadRoutes` and answers 303 to `/r/<caseId>` on 201 or 200, else the page again at the API's status with its message in the alert region (the board's words for 413, 415, 429 and 401). Done when: the test posts a file and follows the 303 to the report, and for each refusal finds the status and the words.
- [x] With the app script, send the form to `/api/upload` by `XMLHttpRequest` (`src/web/client/app.ts`): the button disabled and reading "Uploading...", the progress bar and "<sent> of <size> · then the report opens", then the report; a refusal in the alert region with the file kept; a request that never arrives said so; a file over 25 MB or with a name over 255 characters refused before sending. Done when: `test/node/upload-browser.test.tsx` sees the busy state and progress, lands on the report for a 201 and a 200, shows each refusal's words with focus on the alert, and sends nothing for an oversized file or name.
- [x] Drop a file on the zone to choose it (the same input, no second path), and refuse several dropped at once ("Drop one file at a time") with nothing sent. Done when: the browser test drops one file and it is sent, drops two and nothing is sent, then chooses one and it is sent.
- [x] Give the page without its script a "Check this file" submit (hidden where the app script runs) and record the M2 Deviation in `design/SPEC.md`. Done when: the browser test with JavaScript off chooses a file, submits the rendered form and lands on the report.
- [x] Hand `uploadRoutes` a JSON-asking copy of the request in `POST /upload`, passing `set-cookie` and `retry-after` on. Done when: the test posts with a browser's own headers and an expired session and gets the signed-out state (not a redirect), and a 503 keeps its `retry-after`.
- [x] Bound the script's request: 30 seconds without progress ends it; a lost answer after the file was sent reads "We could not tell whether the file arrived. Try again: the same file opens its first report."; the controls usable again and the file kept. Done when: the browser test stalls a request and sees the unknown-outcome words, then retries and reaches the report; a refusal followed by a retry succeeds; a 200 `repeat` after a lost answer opens the original case.
- [x] Keep Choose a file usable through a daily-limit refusal, so a choice after midnight is checked. Done when: the browser test is refused with 429, then chooses again with the limit lifted and reaches the report.
- [x] Prove the page in Chromium at 360 px and 1280 px in light and dark: no sideways scroll, the accessibility gate's rules clean, every control reached by keyboard. Done when: the browser test passes.
- [x] Commit: `web: upload page`

**Test checkpoint:** `pnpm exec vitest run test/web/upload-page.test.ts test/node/upload-browser.test.tsx` passes and fails if the error region is removed.

> **Verified:** 2026-10-31 | §6 | cf3057cbb72e085a9fc7ea7dee88f2bcd4a978aa
> **Review:** `docs/reviews/d01-t03-s6.json`

## 7. MP3 decoding

> **Started:** 2026-10-27T21:26Z

Spec 4.2a lists `.mp3` among voice-note uploads and as the usual format of a voicemail-lure attachment. §2 found that `mpg123-decoder` (the same WASM family as `ogg-opus-decoder`) can run in a Worker with the same fix: a precompiled module and the `@eshaz/web-worker` stub. Filed from §2's validation (2026-10-27) so that section stays one format family.

**Phase:** 1
**Needs:** none
**Surface:** no

**Corrected 2026-10-27** (validation before building; the items said `mpg123-decoder` 1.0.3 and §2's precompiled-module route). `mpg123-decoder` is MIT around libmpg123, which is LGPL-2.1, and the WebAssembly would be committed to this repository and shipped in the Worker; the repository has no policy on copyleft code (the product is FSL-1.1-ALv2, and spec section 10's default is "all rights reserved"), so the permissive decoder is taken: minimp3 (CC0, https://github.com/lieff/minimp3), as compiled to a 21 KB WebAssembly module with no imports by `minimp3-wasm` 0.1.0 (Apache-2.0, https://github.com/bashi/minimp3-wasm; it calls itself a demo, so only its `.wasm` is used, with a binding written here, never its `fetch`-based loader). Measured in Node: a 3-second 440 Hz tone at 44.1 kHz from LAME decodes to 3.03 s (the encoder's padding) at 440 Hz. Like libopus, minimp3 does not report damage: a file cut at 60 % and one with 400 bytes flipped both decoded without complaint, shorter. So the Worker walks the MP3 frames itself before decoding, as it walks Ogg pages. The fixture is encoded with LAME (`@breezystack/lamejs` 1.2.7, LGPL-3.0), a development dependency that never ships.

**Corrected 2026-10-28** (completion review, gap 1): `minimp3-wasm`'s prebuilt binding counted samples from the frame headers alone and gave silence for frames minimp3 refused, so a file whose frame contents were damaged decoded "successfully" to silence. minimp3 is now vendored at commit `ea99364` (`native/minimp3/minimp3.h`, CC0) with a binding of our own (`native/minimp3/decoder.c`) that decodes one frame per call and returns minimp3's own result, compiled to `src/voice/minimp3.wasm` by `scripts/build-minimp3-wasm.py` with Zig (`ziglang` 0.15.2 from pip: no system packages, and the build machine has no WebAssembly linker otherwise); CI rebuilds it and fails when the committed file differs. `minimp3-wasm` is no longer a dependency. The checkpoint now runs the MP3 suite (gap 2).

**Operator decision (open, not blocking):** whether copyleft code may ship in the Worker. Reversing this choice to `mpg123-decoder` costs one module swap (`src/voice/mp3.ts`) and its notice; the frame walk and tests stay.

**Build order:**

1. Decode MP3 in the workers pool. Done when: a synthetic MP3 fixture decodes to the tone in a Vitest workers test with nothing compiled at runtime.
2. Route MP3 through §2's pipeline. Done when: an MP3 voice note yields 16 kHz mono WAV chunks like any other.

- [x] (**Corrected 2026-10-28**: minimp3 is built from source, above, so `minimp3-wasm` was removed and `ziglang` 0.15.2 pinned in `native/minimp3/requirements.txt`; the identity test became CI's rebuild check and a test of the module's imports and exports) Add exact development dependencies `minimp3-wasm` 0.1.0 and `@breezystack/lamejs` 1.2.7, and commit `minimp3-wasm`'s `dist/decoder.opt.wasm` as `src/voice/minimp3.wasm` with its licences beside it (`src/voice/minimp3.wasm.LICENSE`: minimp3's CC0 and minimp3-wasm's Apache-2.0) and rows in `NOTICE.md`. Done when: `test/node/opus-wasm.test.ts` fails when the committed file differs from the installed package's, and `NOTICE.md` names both.
Evidence for the item above, 2026-10-27 23:52 SAST: `src/voice/minimp3.wasm` is `minimp3-wasm` 0.1.0's `dist/decoder.opt.wasm` unchanged, 21,116 bytes with no imports; `src/voice/minimp3.wasm.LICENSE` carries minimp3's CC0 dedication and minimp3-wasm's Apache-2.0 text (the package names no author, so none is given); `NOTICE.md` has the shipped module and both development dependencies, LAME's LGPL-3.0 marked as never bundled. `pnpm exec vitest run --project node test/node/opus-wasm.test.ts`: 3 passed, among them the check that the committed file equals the installed package's.

- [x] Generate in `scripts/fixtures/make-audio.ts` with LAME: `tone.mp3` (the 3-second tone, 44.1 kHz mono, 64 kbit/s, MPEG-1), `tone-stereo.mp3` (the tone on the left, silence on the right), `tone-16k.mp3` (16 kHz, MPEG-2) and `tone-8k.mp3` (8 kHz, MPEG-2.5), each with the encoder's Xing/Info frame and LAME tag when the encoder writes one; tests build a variable-bitrate stream from frames of two bitrates, and tagged copies (ID3v2.4 with its footer, ID3v1, APE) from the fixtures. Done when: the files and the generator are committed and the generator's output is the same on every run. (**Corrected 2026-10-27**, plan review P2 1.)
Evidence for the item above, 2026-10-27 23:55 SAST: the generator writes `tone.mp3` (24,241 bytes, header `fffb50c4`, MPEG-1), `tone-128k.mp3` (added so two encodings can be joined into a variable-bitrate stream), `tone-stereo.mp3`, `tone-16k.mp3` (`fff348c4`, MPEG-2) and `tone-8k.mp3` (`ffe328c4`, MPEG-2.5); regenerated into a scratch folder, all eight audio fixtures matched the committed bytes. This LAME writes no Xing/Info frame, so `test/voice/mp3.test.ts` builds one (with and without a LAME tag), the variable-bitrate stream and the ID3v2.4-with-footer, ID3v1 and APE tagged copies.

- [x] Walk the MP3 before decoding, in `src/voice/mp3.ts`: skip an ID3v2 tag at the start (its syncsafe size counts neither the 10-byte header nor the 10-byte footer the flags may announce, ID3v2.4 3.1) and an ID3v1 or APE tag at the end; read every frame header (MPEG 1, 2 or 2.5, Layer III, a defined bitrate and sample rate, not free format; one sample rate and channel mode throughout) and require each frame to start where the one before it ends and the last to end with the file. The length is the frames' count times their samples (1,152 or 576), less the encoder delay and end padding a LAME tag declares (the Xing/Info frame itself is metadata, not audio), so a recording of exactly 30 minutes is taken and one over it refused unread; when a Xing/Info frame declares a frame count, the walk must find exactly that many frames, which catches a file cut at a frame boundary. A file without that count, cut exactly at a frame boundary, cannot be told from a shorter recording: MP3 carries no other length or checksum, and this limit is recorded rather than claimed away. Done when: `test/voice/decode.test.ts` decodes the MPEG-2, MPEG-2.5, variable-bitrate and tagged files; refuses with `CorruptAudio` a file cut mid-frame, one cut at a frame boundary whose Xing count says more frames, one with bytes flipped inside a frame header, one with junk between frames, one whose ID3v2 size runs past the file, an empty file and a tag-only file, each by name; refuses a free-format or Layer II file with `UnsupportedAudio`; takes a recording of exactly 30 minutes by its LAME tag; and refuses a 31-minute file with `AudioTooLong` before decoding. (**Corrected 2026-10-27**, plan review P2 1, 2 and 4.)
- [x] Decode with minimp3 in `src/voice/mp3.ts`: instantiate `src/voice/minimp3.wasm` (imported as a module) once per decode, copy the input into its memory, decode at most 5 seconds at a time, drop the encoder delay (plus the decoder's 529 samples) and end padding a LAME tag declares, mix down and resample each block to 16 kHz with §2's `Resampler` into §2's chunk writer; turn anything the module throws into `CorruptAudio`; refuse a decode that stops short of the frame walk's length (no progress before the end) or runs past it. Done when: the MP3 fixtures decode to 440 Hz within 2 Hz at the level minimp3 decodes them to (RMS within 1 %; **corrected 2026-10-27**, was "the tone's level within 5 %": LAME itself scales this tone to 0.950, measured from minimp3's own output at 64 and 128 kbit/s, before anything here touches it), the stereo one at half level, to the frame walk's length, and a 25-minute MP3 to three chunks, in the workers pool; output is identical whatever the decode batch and chunk sizes (so no sample is lost or repeated at either boundary); no decode call returns more than 5 seconds; a caller that stops after the first chunk ends the decode cleanly; and a module that throws or stalls is refused with `CorruptAudio`. (**Corrected 2026-10-27**, plan review P2 2 and 3.)
- [x] Route `audio/mpeg` and `audio/mp3` through `decodeToWavChunks` in `src/voice/decode.ts`, stop refusing them, and make `UnsupportedAudio`'s message name the formats taken (Ogg Opus, WAV and MP3). Done when: the MP3 refusal test is replaced by these, M4A is still refused, and the refusal's message is tested to name MP3. (**Corrected 2026-10-27**, plan review P2 5.)
Evidence for the three items above, 2026-10-28 00:05 SAST. `src/voice/mp3.ts` walks the file before decoding (ID3v2 with its footer, ID3v1 and APE set aside; every frame MPEG 1, 2 or 2.5 Layer III, contiguous, one sample rate and channel count; a Xing/Info frame's count checked and its LAME tag's delay and padding applied as minimp3_ex.h does) and decodes with minimp3 in batches of at most 5 seconds; `src/voice/decode.ts` routes `audio/mpeg` and `audio/mp3` through it into §2's resampler and chunk writer; the refusals moved to `src/voice/errors.ts`, and `UnsupportedAudio` now names Ogg Opus, WAV and MP3. `pnpm exec vitest run test/voice test/node/opus-wasm.test.ts`: all pass, among them MPEG-1 at 440 Hz and minimp3's own level within 1 %, the stereo file at half level, MPEG-2 and MPEG-2.5 at 440 Hz, a variable-bitrate join, tagged copies decoding to the same samples, identical output at 0.37-second batches and 0.1-second chunks, no call over 5 seconds, a 25-minute MP3 in three chunks (5.1 s locally), exactly 30 minutes taken by its LAME tag and 31 refused before a decoder is made (4.1 s), and damage refused by name (cut mid-frame, cut at a frame boundary short of its Xing count, a damaged header, junk between frames, an ID3v2 size past the file, empty, tags only, Layer II and free format as unsupported, a decoder that throws or stalls). Twenty-one mutations each fail them (accepting free format makes the walk hang on a zero-length frame, which the test also catches). Full suite: 444 passed. Known limit, recorded rather than claimed away: an MP3 without a Xing frame count, cut exactly at a frame boundary, decodes as a shorter recording.

Evidence after the completion review and rounds 1 and 2, 2026-10-28 00:31 SAST. Completion review (`e88cfbd`): minimp3 is built from source with a per-frame binding, so a frame minimp3 refuses is `CorruptAudio`, proven against the real WebAssembly with side information damaged in every frame and in frame 50 alone; CI rebuilds `src/voice/minimp3.wasm` and was green on the first run with that step (`70837ce`); the checkpoint now runs the MP3 suite and fails when MP3 routing is removed. Round 1 (`2a0255d`): a LAME tag in a frame announcing a CRC is read where LAME writes it, so such a file keeps its frame-count check and gapless trim; a batch never passes 5 seconds. Round 2 approved (with 1,024 header mutations probed). `pnpm exec vitest run test/voice/decode.test.ts test/voice/mp3.test.ts test/node/opus-wasm.test.ts`: all pass. Full suite: 446 passed.
> **Resolved:** filtered resampling for MP3 and its timing against FFmpeg -> XREF: D01 T03 §9. Resolved 2026-10-28 by D01 T03 §9 in `b9fb1b8` and `e3440c6`: the same filter for MP3, and MP3 rows in the bench.

- [x] Close §2's MP3 deferral as `Resolved:`. Done when: §2's Deferred line reads resolved with this section's commit.
- [x] Commit: `voice: decode MP3 voice notes and voicemail attachments`

**Test checkpoint:** `pnpm exec vitest run test/voice/decode.test.ts test/voice/mp3.test.ts test/node/opus-wasm.test.ts` passes (**corrected 2026-10-28**, completion review gap 2: the MP3 suite was missing) and fails if an MP3 is refused, if its decoded tone is not 440 Hz at its level and length, if damage passes the frame walk, or if a long MP3 is decoded at all.

> **Verified:** 2026-10-28 | §7 | b37cf3345ad30571681e20a70bd9b1740c3cfd5e
> **Review:** `docs/reviews/d01-t03-s7.json`

## 8. M4A decoding

> **Started:** 2026-10-27T22:31Z

Spec 4.2a lists `.m4a` among voice-note uploads (iPhone voice memos are AAC in an MP4 container). §2 found no AAC decoder in the WASM family that runs in a Worker, so M4A is refused there with `UnsupportedAudio`. Filed from §2's plan review (P1 3, 2026-10-27) so the refusal has an owner.

**Phase:** 1
**Needs:** none
**Surface:** no

**Build order:**

1. Find a decoder. Done when: an AAC decoder that runs in a Worker (WASM loadable as a precompiled module, no runtime compilation, no Web Worker) is chosen with its licence and version, or none is found and the governing contract is corrected.
2. Decode or refuse for good. Done when: an M4A voice note yields 16 kHz mono WAV chunks through §2, or spec 4.2a, this file's Goal and §1's accepted types no longer list M4A and the upload refuses it with a clear message.

- [x] Survey AAC decoders for Workers (a WASM build of FAAD2 or FDK AAC, a demuxer for MP4's `moov` and `mdat`) and record each candidate's licence (FDK AAC's licence restricts redistribution), version, release date and whether it loads in the workers pool. Done when: the finding is recorded here with sources.

Finding, 2026-10-28 (**corrected** the same day after §8's completion review: versions, dates and what was tested added, and FDK's licence described as it reads). No candidate was run in the Workers pool: three were set aside on their licence before testing, and the fourth waits on a business decision.

| Candidate | Version (date) | Licence, as read | Workers |
| --------- | -------------- | ---------------- | ------- |
| FAAD2 (https://github.com/knik0/faad2) | 2.11.4 (2026-10-01) | GPL-2.0 or later; its COPYING says "Any non-GPL usage of this software or parts of this software is strictly forbidden"; `@audio/aac-decode` 1.0.2, its WebAssembly build on npm, is GPL-2.0 too | Not tested: the GPL would cover this source-available product |
| FDK AAC (https://github.com/mstorsjo/fdk-aac) | v3.0.0 (2026-10-11) | Fraunhofer's own: redistribution without copyright licence fees, but binary recipients must be given the complete source free of charge, no one may be charged copyright licence fees, and it grants no patent licence (NOTICE, sections 2 and 3) | Not tested: the source obligation and the missing patent licence |
| FFmpeg's AAC decoder (https://ffmpeg.org/download.html) | 9.0.2 (2026-09-18) | Inside FFmpeg, LGPL-2.1 or later (GPL with some build options) | Not tested: copyleft, as `mpg123-decoder` was for §7 |
| libxaac (https://github.com/ittiam-systems/libxaac) | v0.1.13 (2026-01-28), the newest at least two weeks old; v0.1.14 is of 2026-10-27 | Apache-2.0 | Not built: AAC is still licensed through a patent pool (Via LA), and whether decoding uploads on a server needs that licence is a business decision; building it the way §7 builds minimp3 (Zig, a per-frame binding) plus an MP4 demuxer is §10 |

So M4A stays refused, with a message naming the formats taken, and adopting libxaac is filed as §10, waiting on that decision.
- [x] ~~If one qualifies: add it exactly pinned, extract its WASM the way §2 does, generate `test/fixtures/audio/tone.m4a`, and decode M4A in `decodeToWavChunks`.~~ Struck 2026-10-28: none is taken while the AAC patent question is open (the finding above); the build is §10's.
- [x] If none qualifies: correct spec 4.2a and the Goal of this file to drop `.m4a` (dated, with the reason and §10), and make the refusal plain where it happens: `decodeToWavChunks` refuses `audio/mp4` with `UnsupportedAudio` naming Ogg Opus, WAV and MP3 (§7's message), and §1's contract refuses an M4A upload by type with 415 and that message, storing nothing. Done when: the spec and Goal are corrected; `test/voice/decode.test.ts` refuses `audio/mp4` with the message naming the formats; and §1's sniff item names M4A among the refused types with its Done when, for §1's own test to prove when §1 is built (it is not yet). (**Corrected 2026-10-28**: §1, the upload route, is not built, so its test cannot exist here.)
- [x] Close §2's M4A deferral as `Resolved:`. Done when: §2's Deferred line reads resolved with this section's commit.
Evidence 2026-10-28 00:40 SAST. Spec 4.2a and this file's Goal drop `.m4a` with a dated correction naming the reason and §10; §1's refusal item names M4A (415, the formats taken, nothing stored) for §1's own test; `decodeToWavChunks` refuses `audio/mp4` with `UnsupportedAudio` whose message names Ogg Opus, WAV and MP3 (`test/voice/decode.test.ts`, "refuses M4A by type until D01 T03 §10 decodes it, naming the formats it takes"); §2's M4A deferral is resolved, and the decoding is deferred to §10 below. `pnpm exec vitest run test/voice/decode.test.ts`: all pass.

Evidence after round 1, 2026-10-28 00:49 SAST: adversarial, integration and source-defect approved; plan-delivery's one P3 (§2's resolution line named no commit) is fixed in this commit. `pnpm exec vitest run test/voice/decode.test.ts`: all pass. Full suite: 446 passed.

> **Deferred:** decoding M4A (AAC) voice notes with libxaac, once the AAC patent decision is made -> XREF: D01 T03 §10

- [x] Commit: `voice: M4A voice notes decoded or refused by design`

**Test checkpoint:** `pnpm exec vitest run test/voice/decode.test.ts` passes, and fails if an M4A is silently accepted without being decoded.

> **Verified:** 2026-10-28 | §8 | 4709018b9a2c1c726f16fd4d32b581194d17d456
> **Review:** `docs/reviews/d01-t03-s8.json`

## 9. Filtered resampling for WAV

> **Started:** 2026-10-27T22:50Z

§2 resamples WAV input linearly, which passes energy above 8 kHz through as aliases: measured in §2's completion review, a half-scale 12 kHz tone at 48 kHz comes out as a full-strength 4 kHz alias. Ogg Opus no longer has this problem, because libopus decodes it straight to 16 kHz with its own filter. The strongest alternative for this job, FFmpeg's libswresample, filters by default (https://ffmpeg.org/ffmpeg-resampler.html). Filed from §2's completion review (2026-10-27), with its request for timings compared with FFmpeg, which needs FFmpeg (installed on GitHub's Ubuntu runners, not on the build machine).

**Phase:** 1
**Needs:** none
**Surface:** no

**Corrected 2026-10-28** (validation before building). A windowed-sinc filter needs samples on both sides of each output, so the resampler must hold a lookahead across blocks and pad the end with silence, keeping §2's exact output lengths (ceil(N x 16000 / rate)) and identical output however the input is split; 44.1 kHz input needs an arbitrary-ratio (fractional-phase) filter, not a fixed polyphase bank; going up (8 kHz to 16 kHz) the cut-off is the input's Nyquist. The decoder cannot run in plain Node (its WebAssembly is a `?module` import the bundler resolves), so the timing of our decoder runs in the Workers test pool and a Node script times FFmpeg on the same files, CI printing both.

**Build order:**

1. Filter before decimating. Done when: a 12 kHz tone in a 48 kHz WAV comes out at least 60 dB down, with §2's tone, level and continuity tests unchanged.
2. Measure against FFmpeg. Done when: the decoder's first-chunk and completion times are recorded beside FFmpeg's for the same inputs.

- [x] Replace `Resampler`'s linear interpolation in `src/voice/decode.ts` with a Kaiser-windowed sinc low-pass resampler at an arbitrary ratio, centred on each output (a lookahead held across blocks, silence past the end), cut off below the lower of the two Nyquist frequencies. Done when, measured with a Goertzel filter at each tone's frequency on the 16 kHz output (`test/voice/decode.test.ts`), for 48 kHz and 44.1 kHz WAV input: tones of 300 Hz, 1 kHz, 3 kHz and 6.4 kHz (the passband, up to 0.4 of the output rate) come out within 0.5 dB of their input level; tones of 9 kHz, 12 kHz and 20 kHz (folding into 7 kHz, 4 kHz and 4 kHz) leave at most -60 dB at the frequency they would alias to; between 6.4 and 8 kHz (the transition band) nothing is promised. For 8 kHz input (upsampling): a 3 kHz tone comes out within 0.5 dB, and its image at 5 kHz at most -60 dB. The existing block-split and length tests pass unchanged. (**Corrected 2026-10-28**, plan review P2 1: a passband, transition and stopband, and image rejection.)
- [x] Keep §2's guarantees: 440 Hz at its level, exact output lengths, no seam at chunk boundaries. Done when: §2's tests pass unchanged.
- [x] Time our decoder in the Workers pool (`test/voice/bench.test.ts`, run only when `VOICE_BENCH` is set: first chunk and completion for a 3-second note, a 25-minute recording, a dense low-bitrate stream and a damaged file, written as JSON to `build/voice-bench.json`) and FFmpeg on the same files in Node (`scripts/voice-bench.ts`: `ffmpeg -ar 16000 -ac 1 -c:a pcm_s16le`, its version, the same timings), printing both side by side. The events are the same on both sides: first output is the time until 9,600,000 samples (a full 10-minute chunk, or all of a shorter file) have been produced; completion is the time until all output is drained; a damaged file has a refusal time and no first output (`null`). A timing is accepted only after the output's length is checked (and a damaged file's refusal confirmed), so a truncated or failed run cannot pass for a fast one. (**Corrected 2026-10-28**, plan review P2 3.) Done when: a CI job on `ubuntu-latest` (which has FFmpeg) runs both and its output is recorded here with the FFmpeg version. (**Corrected 2026-10-28**, as above.)
Evidence for the two items above, 2026-10-28 01:05 SAST. `Resampler` (`src/voice/decode.ts`) is a Kaiser-windowed sinc at an arbitrary ratio: cut-off 0.95 of the lower Nyquist frequency, transition 0.3 of it, designed for 70 dB; for the usual rates (a ratio p/q of 16 kHz with q up to 1,024: 44.1, 48, 22.05, 11.025, 8 kHz and more) each output phase's taps are computed once, and an unusual rate reads the kernel from a table; a lookahead of the half-width is held across blocks, silence lies past either end, and 16 kHz input passes through unchanged. `test/voice/decode.test.ts`, measured by Goertzel at each frequency: at 48, 44.1 and 44.101 kHz (the table path) tones of 300 Hz, 1, 3 and 6.4 kHz within 0.5 dB, and 9, 12 and 20 kHz leaving at most -60 dB where they would alias; at 8 kHz a 3 kHz tone within 0.5 dB and its 5 kHz image at most -60 dB; the edges run into silence as the window's own sums say (the first output of a constant 0.5 at 48 kHz is 0.329). The block-split, exact-length, continuity and level tests pass unchanged. Mutations each fail them: linear interpolation put back, a half-width of 1, the cut-off at the full Nyquist, no Kaiser window, the phase taps reversed, the phase index off by one, the edge path skipped, the table kernel stretched, pass-through removed, too little lookback. Cost, measured locally: the 25-minute MP3 decodes in 6.0 s (5.1 s with linear interpolation; 26 s before the phases were precomputed). Full suite: 452 passed, 2 skipped (the benchmark, which runs only with `VOICE_BENCH`).

- [x] Use the same filtered resampler for MP3 (§7 decodes it at its own rate, 44.1 kHz and below, then resamples), and time MP3 in the bench beside FFmpeg too. Done when: `tone-12k.mp3` (a 12 kHz tone, 44.1 kHz, 128 kbit/s, generated by `scripts/fixtures/make-audio.ts`) is shown by its own minimp3 output to hold the tone (within 3 dB of the source level), its alias at 4 kHz after resampling is at least 60 dB below that decoded level, the test fails with linear interpolation put back, and the bench prints MP3 rows. (Added 2026-10-28 from D01 T03 §7's completion review, out-of-scope items 6 and 7; **corrected 2026-10-28**, plan review P2 2.)
Evidence for the two items above, 2026-10-28 01:20 SAST. `tone-12k.mp3` holds its tone in minimp3's own output (within 3 dB of the 0.5 encoded) and its 4 kHz alias after resampling is at least 60 dB below that decoded level (`test/voice/mp3.test.ts`); with linear interpolation put back the test fails. The bench ran in CI (run 40600325736, job "Voice decoder against FFmpeg", `f7face8`), every output's length and our refusal of the damaged file checked first; FFmpeg is "ffmpeg version 6.1.1-3ubuntu5", and its times include starting its process:

| Input | Ours: first output | Ours: done or refused | FFmpeg: first output | FFmpeg: done |
| ----- | ------------------ | --------------------- | -------------------- | ------------ |
| note (3 s, Ogg Opus) | 17 ms | 18 ms | 191 ms | 191 ms |
| recording (25 min, Ogg Opus) | 833 ms | 1,914 ms | 1,431 ms | 3,515 ms |
| dense stereo (29 min, Ogg Opus) | 220 ms | 588 ms | 605 ms | 1,690 ms |
| damaged (Ogg Opus) | none | refused in 0 ms | 54 ms | 54 ms (decoded, damage concealed) |
| note (3 s, MP3) | 27 ms | 27 ms | 49 ms | 49 ms |
| recording (25 min, MP3) | 1,780 ms | 4,653 ms | 984 ms | 2,377 ms |

Ours is faster on every Ogg Opus input (libopus decodes straight to 16 kHz) and on the short MP3, and refuses the damaged file where FFmpeg conceals it; FFmpeg is about twice as fast on the 25-minute MP3, where our windowed sinc runs in JavaScript. That is the trade taken: the filter keeps aliases 60 dB down, and the slowest case still finishes well inside a Worker's CPU limit. The first CI run (`b9fb1b8`) decoded every input but its report line was missed behind the reporter's colour codes; fixed in `f7face8`.

Evidence after the completion review, 2026-10-28 01:40 SAST. Its three in-scope gaps and two improvements are closed. A WAV claiming a rate outside 8 to 192 kHz is refused (`UnsupportedAudio`) before a filter is built (a header can claim 4,294,967,295 Hz, which would have asked for a 7.9 GB table; tested at both edges, and the check removed makes the test hang where CI times out). FFmpeg's first output is taken when its chunk's samples have come out or, for a shorter output, when its last sample did, not at process exit (`timeOutput`, tested with a process that lingers a second after its output; **corrected** after round 1, which replaced the 99 % threshold first written here). The bench saves `build/voice-bench.json` through a temporary file and reads it back (tested). The polyphase sums now run in `native/resample/resample.c`, four taps at a time (WebAssembly SIMD, `src/voice/resample.wasm`, built by `scripts/build-wasm.py`, which now builds both modules and CI rechecks), MP3 frames decode in place, and minimp3 is built at `-O3` with SIMD: the 25-minute MP3 went from 6.9 s to about 3.1 s locally. The bench now times WAV too (the note, upload-sized 25 MiB files at 48 and 44.1 kHz, a malformed one) and reports the median of three runs of each input on one runner, since FFmpeg's own time for the same file moved by half between two CI runs. CI run 40602990459 (`335df7e`, FFmpeg 6.1.1-3ubuntu5, medians of three):

| Input | Ours: first output | Ours: done or refused | FFmpeg: first output | FFmpeg: done |
| ----- | ------------------ | --------------------- | -------------------- | ------------ |
| note (3 s, Ogg Opus) | 14 ms | 14 ms | 63 ms | 66 ms |
| recording (25 min, Ogg Opus) | 1,029 ms | 2,464 ms | 2,477 ms | 6,109 ms |
| dense stereo (29 min, Ogg Opus) | 236 ms | 659 ms | 939 ms | 2,637 ms |
| damaged (Ogg Opus) | none | refused in 0 ms | none | 64 ms (decoded, damage concealed) |
| note (3 s, MP3) | 24 ms | 24 ms | 58 ms | 61 ms |
| recording (25 min, MP3) | 1,232 ms | 3,049 ms | 1,843 ms | 4,570 ms |
| note (3 s, WAV 44.1 kHz stereo) | 10 ms | 10 ms | 63 ms | 67 ms |
| upload-sized (25 MiB, WAV 48 kHz) | 216 ms | 216 ms | 505 ms | 514 ms |
| upload-sized (25 MiB, WAV 44.1 kHz) | 221 ms | 221 ms | 511 ms | 520 ms |
| malformed (WAV) | none | refused in 0 ms | none | 67 ms (decoded) |

Ours is faster on every input, first output and completion, and refuses both damaged files where FFmpeg decodes through them. FFmpeg's times include starting its process, which is part of using it. `pnpm exec vitest run`: 455 passed, 2 skipped (the bench halves).

Evidence after rounds 1 to 3 and the final review, 2026-10-28 02:08 SAST. Round 1 (`8c41630`): the unusual-rate path compared a floating-point position with the input's length (600 s at 8,008 Hz gave a stray sample); positions are compared in integers, and FFmpeg's first output on a short file is taken at its last sample. Round 2 approved. The final review (Muse Wonder at high effort, re-enabled by the operator as optional at 01:44) found the unusual-rate path still JavaScript (`bd81843`): the kernel now blends 512 tap sets for any rate with more phases than are worth holding, so every rate runs in WebAssembly and a 25 MiB WAV at 44,101 Hz decodes in 409 ms on CI against FFmpeg's 554 ms; `Resampler` refuses rates outside 8 to 192 kHz itself; the filter is measured at 96 and 192 kHz and by its residual after a sinusoid fit (at most -80 dB; about -90 dB as built, where reading the wrong tap set leaves about -66 dB); the bench pairs rows by name and states FFmpeg's 1 % allowance. Round 3 approved the fixes. CI run 40606229380 (`bd81843`): green, our decoder ahead of FFmpeg on all eleven inputs and refusing both damaged files. `pnpm exec vitest run`: 459 passed, 2 skipped (the bench halves).

- [x] Commit: `voice: filtered resampling for WAV, timed against FFmpeg`

**Test checkpoint:** `pnpm exec vitest run test/voice/decode.test.ts test/voice/mp3.test.ts` passes, and fails if a passband tone moves more than 0.5 dB, a stopband tone or an upsampling image leaves more than -60 dB, an MP3's 12 kHz tone is not suppressed against its decoded level, or a length or continuity test breaks. (**Corrected 2026-10-28**, plan review P2 2.)

> **Verified:** 2026-10-28 | §9 | 6017d449c3584693563232b73311b0a7b567efee
> **Review:** `docs/reviews/d01-t03-s9.json`

## 10. M4A with libxaac

**Operator decision 2026-11-01 03:30 SAST (`docs/coordinator.md`):** skipped for now, the AAC patent question open.

§8 found one AAC decoder whose copyright licence allows shipping it in the Worker: libxaac (Ittiam for Android, Apache-2.0). It was not taken because AAC, unlike MP3, is still licensed through a patent pool, and whether decoding uploaded voice notes on a server needs that licence is a business decision. Filed from §8 (2026-10-28) so M4A has an owner.

**Phase:** 7
**Needs:** operator
**Surface:** no

**Operator decision (open):** whether IsItLegit may decode AAC (iPhone voice memos and other `.m4a` recordings) in the Worker, given the AAC patent pool, and if so under which licence. Recording `AAC decoding: <decision> (YYYY-MM-DD)` here and removing `operator` from Needs releases the section.

AAC decoding: not during the event; M4A stays refused with its MP3-or-WAV message, and the question returns after the event with legal advice (2026-10-28). **Operator decision (2026-10-28 22:42 SAST):** moved to Phase 7 (after the event); `operator` stays in Needs for that later decision.

**Build order:**

1. Build the decoder. Done when: libxaac, pinned to a release at least two weeks old, builds to WebAssembly with a per-frame binding the way §7 builds minimp3, and CI rebuilds it.
2. Demux and decode M4A. Done when: an M4A voice note yields 16 kHz mono WAV chunks through §2, and damage is refused.

- [ ] Vendor libxaac's decoder at a pinned release in `native/libxaac/`, write a binding that decodes one access unit per call and reports libxaac's result, and build it to `src/voice/aac.wasm` with `scripts/build-aac-wasm.py` and the pinned Zig; add the CI rebuild check and the `NOTICE.md` rows (Apache-2.0, with its NOTICE file). Done when: the module has no imports and CI's rebuild check passes.
- [ ] Generate `test/fixtures/audio/tone.m4a` (the 3-second tone, AAC-LC in MP4) and a stereo one in `scripts/fixtures/make-audio.ts` with an encoder whose licence allows a development dependency (libxaac's own encoder, built natively, is the first candidate; record the choice and its licence). Done when: the fixtures and generator are committed and the output is the same on every run. (**Added 2026-10-28**, D01 T03 §8's plan review P2 1.)
- [ ] Walk the MP4 container in `src/voice/m4a.ts`: the `ftyp`, `moov` (`trak`, `mdia`, `minf`, `stbl`: `stsd` with the `mp4a` sample entry and its `esds` AudioSpecificConfig, `stsz`, `stco` or `co64`, `stsc`, `stts`) and `mdat` boxes, every size and offset checked against the file, one audio track, the length from `stts` checked against 30 minutes before decoding. Done when: `test/voice/m4a.test.ts` refuses with `CorruptAudio` a file cut short, a box size past its parent, a sample table pointing outside `mdat`, and an empty file, each by name; takes a recording of exactly 30 minutes; and refuses a longer one with `AudioTooLong` with no decoder made. (**Corrected 2026-10-28**, D01 T03 §8's plan review P2 2.)
- [ ] Decode the samples in batches of at most 5 seconds into §2's resampler and chunk writer, refusing an access unit libxaac refuses, and route `audio/mp4` and `audio/x-m4a` through `decodeToWavChunks`. Done when: in the Workers test pool, with the real `src/voice/aac.wasm` imported as a module (no substitute decoder), the M4A fixtures decode to 440 Hz at the level libxaac decodes them to, the stereo one at half level, their length from `stts`, identical output across batch and chunk sizes, and a 25-minute file in three chunks; and an access unit libxaac refuses is `CorruptAudio`, proven with real damaged data. (**Corrected 2026-10-28**, D01 T03 §8's plan review P2 1.)
- [ ] Undo §8's refusal: spec 4.2a and this file's Goal list `.m4a` again (dated); `UnsupportedAudio` in `src/voice/errors.ts` names M4A among the formats taken; and §1 accepts M4A, its 415 test replaced. Done when: the corrections are recorded, `test/voice/decode.test.ts` asserts the message names M4A, and `test/intake/upload.test.ts` uploads an M4A and finds one stored object, one case and one Workflow instance, where it found 415 and nothing stored. (**Corrected 2026-10-28**, D01 T03 §8's plan review P2 3.)
- [ ] Commit: `voice: M4A voice notes decoded with libxaac`

**Test checkpoint:** `pnpm exec vitest run test/voice/m4a.test.ts test/voice/decode.test.ts` passes, and fails if an M4A is refused, decoded to the wrong length or pitch, or damage is passed on.

## 11. Uploading member stored on the case

Filed 2026-10-30 at the app lane's request, through the coordinator: the cases list's "Checked by" column (D07 T04 §1, drawn by the app lane's D07 T04 §7) names the member who checked each case. An email case has `forwarded_by`; an upload case records no one, so the list can only say "Not recorded". The uploading member's user id goes on the case when the upload admits it.

> **Started:** 2026-10-30T17:24Z

**Corrected 2026-10-30** (at start, checked against the repository): (1) the member reaches `admitCase` through `admitDelivery`'s `Delivery` (`src/intake/admit.ts`), which gains `uploadedBy`, as `forwardedBy` came; both case inserts in `src/db/cases.ts` (`admitCase`, `createCase`) name the column; (2) the id is Better Auth's user id from `c.get("signedIn").user.id`, kept as given: a member who later leaves the organisation or deletes their account leaves an id the list cannot resolve, which D07 T04 shows as a former member, so no foreign key ties the case to the user row (the closure purge, D07 T02 §9, deletes whole case rows, so the column needs no purge entry of its own); (3) `NewCase` refuses `uploadedBy` on an email case and requires it on an upload case.

**Corrected 2026-10-30** (plan review): (4) the repeat proof uses two members of one organisation: A uploads, B uploads the same file, one case, its uploader still A; (5) the refusals are tested on both inserts: an upload without an uploader and an email case with one are `invalid` from `admitCase` and `createCase` alike, and no case is stored.

**Phase:** 2
**Needs:** none
**Surface:** no

**Build order:**

1. Record and read the uploader. Done when: a case admitted through `POST /api/upload` carries the signed-in member's user id, an email case carries null, and it reads back only within the organisation.

- [x] Add `uploaded_by` (nullable, the user id) to `cases` in `src/db/migrations/0039_case_uploaded_by.sql` (0039 offered by the coordinator, 2026-10-30). Done when: the migration applies locally and existing cases read null. Done 2026-10-30: `src/db/migrations/0039_case_uploaded_by.sql`.
- [x] Accept `uploadedBy` in `NewCase` and `admitCase` (`src/db/cases.ts`), refused on an email case, and pass the signed-in member's id from `uploadRoutes` (`src/intake/upload.ts`, `c.get("signedIn")`) through `admitDelivery` (`src/intake/admit.ts`). Done when: `test/intake/upload.test.ts` reads the uploader on a new upload case; a repeat of the same file within the day answers the first case and keeps its first uploader (the claim answers the case, it does not re-admit it). Done 2026-10-30: `test/intake/upload.test.ts` ("records the uploading member", "keeps the first uploader when another member uploads the same file again"); three mutations (the uploader not passed, `admitDelivery` dropping it, no rule in `NewCase`) each fail a test.
- [x] Return it as `Case.uploadedBy` through `getCase`. Done when: `test/db/cases.test.ts` reads it back for its organisation and refuses another organisation; an email case reads null. Done 2026-10-30: `test/db/cases.test.ts` (the uploader read back in its organisation, not_found elsewhere, refusals on both inserts storing nothing); 746 tests across intake, pipeline, db, checks, auth, mail and scheduled pass.
- [x] Name `uploaded_by` in the closure purge's reckoning if the purge lists columns (D07 T02 §9 deletes whole case rows, so likely none). Done 2026-10-30: none needed; D07 T02 §9 deletes whole case rows (correction 2).
- [x] Commit: `intake: the uploading member stored on the case` Done 2026-10-30: 5dc3c11, with 3b003b1 (the completion review's regressions).

**Test checkpoint:** `pnpm exec vitest run test/intake/upload.test.ts test/db/cases.test.ts` passes.

> **Verified:** 2026-10-30 | §11 | 08848553b71c2d274992d43f3e147ed89b6ab9bf
> **Review:** `docs/reviews/d01-t03-s11.json`

## 12. An upload admitted whatever the browser does

> **Started:** 2026-10-31T16:20Z

Filed 2026-10-31 from a production capture (the media lane's, through the coordinator; Fynbos Freight, 16:05 to 16:17 UTC): an uploaded `.eml` showed "Checking" in the Cases list, held its claim (a re-upload of the same file answered 503 "This file is still being taken from an earlier upload"), and by 16:17 UTC was gone, with no case row, events or claim left. The browser had signed out mid-upload. Two causes, each at its layer: (1) the upload route (`src/intake/upload.ts`) awaits `admitDelivery` (`src/intake/admit.ts`) without `ctx.waitUntil`, and Cloudflare may cancel a request's work when the client disconnects unless it is passed to `waitUntil` (https://developers.cloudflare.com/workers/platform/limits/, "Duration"; up to 30 seconds), so the work stopped after the case and its claim were written and before `ANALYSIS.create`; (2) the sweep's `settleStale` then found no Workflow for a case still `received` and removed it with its file, so a case the member had seen vanished without a word. A visible case is never deleted silently: one admitted and stored but never started is started, so it finishes or ends `partial` with a reason the member reads. The same section corrects the file check's reason on an uploaded email (`src/checks/intake.ts`: "the case is not an upload", which an uploaded `.eml` is).

**Corrected 2026-10-31** (from the plan review, `docs/reviews/01-intake/D01-T03-s12.md`): (1) only the sweep releases an unused claim: a retry (an upload again, an email redelivered) that reaches a stale claim whose case was never made keeps the claim it took over and makes its case under it, as `claimDelivery` does today; (2) a stranded case is started only when its stored file is there: one whose file never stored would end `RawMissing` and, with its claim marked done, answer every re-upload for 24 hours with an unusable case. So such a case is ended `partial` with that reason, recorded as its `admit` step's failure so the member reads it, and its claim freed, so the same upload or redelivery makes a new case beside the failed one; (3) the route's test proves the protection, not only a call: the admission is held open (the Workflow's creation deferred), the test reads that its promise was handed to `waitUntil` before it settled, leaves the request unanswered as an abandoning browser does, then lets the creation finish and reads the Workflow created and the claim done; and an admission that stops for good before the Workflow (past `waitUntil`'s 30 seconds) is recovered by the sweep, which starts the stored case.

**Corrected 2026-10-31** (from the completion review, `docs/reviews/01-intake/D01-T03-s12.md`): (4) admission's own failures deleted a case too (`undo`): one whose file could not be stored, or whose insert committed with its answer lost, now ends `partial` (RawMissing) with its claim freed, and one stored whose Workflow did not start keeps its claim pending for the sweep to start; `undo` and `removeCase` are gone; (5) ending an unstored case is one D1 batch (its failure event, `received` straight to `partial` through `unstartedPartial` in `src/db/cases.ts`, and the claim's change), so an interruption leaves it as it was, never `running` without a Workflow or `partial` with its claim still naming it; (6) the intake sweep runs on the minute tick too, so a stranded delivery is taken up within a minute of its lease running out, not up to a quarter-hour after.

**Corrected 2026-10-31** (from the plan review on `checks-s12b`, `docs/reviews/01-intake/D01-T03-s12.md`): (7) a case ended `partial` for `RawMissing` at admission never ran, so it does not use one of the organisation's daily cases: `admitCase` counts today's cases through `COUNTS_TOWARD_CAP` (`src/db/cases.ts`), which leaves out a case whose `admit` step failed `RawMissing`, so a re-upload on the day's last slot makes its replacement where it would be refused 429; the case list's "used" count (`src/db/case-list.ts`, the app lane's) is asked to read the same rule; (8) each correction is proven by a test that fails without it: a committed insert whose answer is lost, a storage failure and a store error with the file committed (`test/intake/email.test.ts`, `test/intake/upload.test.ts`), the settlement's batch interrupted, and the real minute scheduled handler (`scheduled()` on `RETRY_CRON`) taking up a stranded claim (`test/scheduled.test.ts`).

**Phase:** 3
**Needs:** none
**Surface:** no

**Build order:**

1. Finish an upload's admission whatever the client does. Done when: an upload whose request is abandoned after the case is written still starts its Workflow.
2. Start a stranded case instead of removing it. Done when: a stale claim whose case exists and is still `received` with no Workflow gets its Workflow started and the claim marked done; only a claim whose case never committed is released.
3. Word the file check's reason for an uploaded email. Done when: an uploaded `.eml`'s outcome names why the file check does not apply.

- [x] Run the upload's admission under `c.executionCtx.waitUntil` in `src/intake/upload.ts`, still awaiting it for the answer. Done when: `test/intake/upload.test.ts` holds the Workflow's creation open, reads the admission's promise in `waitUntil` before it settles, abandons the request, then reads the Workflow created and the claim done once the creation finishes (correction 3).
- [x] Have `settleStale` in `src/intake/admit.ts` start the Workflow for a `received` case it finds with none whose stored file is there (`ANALYSIS.create` under the case's id), marking the claim done, and leave the claim for the next sweep when that start's outcome is unknown; end a case whose file never stored `partial` (`RawMissing`, its `admit` step's failure) and free its claim; keep a retry caller's taken claim when the case was never made, and have the sweep alone release one (corrections 1 and 2). Done when: `test/intake/upload.test.ts` and `test/intake/email.test.ts` see the sweep start a stored stranded case's Workflow, which finishes, where they saw it removed, and a re-upload answer with that case; a case without its file end `partial` reading `RawMissing` and a re-upload make a new case; and an upload retried and an email redelivered onto a stale claim with no case make their case under it, with no sweep first.
- [x] Give `intake.upload` a reason per case in `src/checks/intake.ts`: for an uploaded message, that an uploaded email is checked as the message it holds, not as a file; for a forward, that it was forwarded, not uploaded. Done when: `test/checks/check-outcomes.test.ts` (or the intake check's test) reads each reason.
- [x] Commit: `intake: an upload admitted whatever the browser does`

**Test checkpoint:** `pnpm exec vitest run test/intake/upload.test.ts test/intake/email.test.ts test/checks/check-outcomes.test.ts test/scheduled.test.ts` passes, with the day-limit replacement test (correction 7) and the minute handler's recovery test (correction 8).

> **Verified:** 2026-10-31 | §12 | cd755b7427a1d37c4b15cb6d5ca1ab87dfb2f70c
> **Review:** `docs/reviews/d01-t03-s12.json`

## 13. Word, Excel and PowerPoint files accepted

> **Started:** 2026-11-01T16:31Z

Filed 2026-11-01 from D02 T05 §8's plan review: the checks read a Word, Excel or PowerPoint file's text when it arrives as an attachment (D02 T05 §4), but the upload sniffs a document as a PDF only (`src/intake/sniff.ts`), so the same DOCX uploaded on its own is refused with the "cannot be checked" answer, and an uploaded document's instructions can only be found in a PDF.

**Corrected 2026-11-01** (at start, checked against `src/intake/sniff.ts`, `src/checks/sniff.ts`'s `zipKind`, `src/intake/upload.ts` and `src/web/pages/upload-view.tsx`): (1) the intake sniff reads a ZIP's entry names with the same bounded local-header walk the checks' sniff uses (at most 64 entries, names only, nothing inflated), and takes it as a document only when the names hold both `[Content_Types].xml` and a `word/`, `xl/` or `ppt/` part, with that kind's OOXML media type; a package holding a macro part (`vbaProject.bin`) is refused, since its bytes are a macro document whatever its name says; (2) the accepted list lives once, exported from `src/intake/sniff.ts`, and both `NOT_TAKEN` and the upload page's kinds and refusal line read it, so the page and the 415 answer cannot drift; (3) the page change is the accepted-types line only (its Fidelity), in `KINDS` and the "Not accepted" line of `src/web/pages/upload-view.tsx`, updated in its own test the same way §1's wording was.

**Phase:** 3
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` upload screen and its mockup (the accepted-types line only)
**Job:** a member checks a Word, Excel or PowerPoint file they received without forwarding an email
**Treatment:** the accepted types in plain words, one list for the page and the refusal, no new control
**Chrome:** the shared app shell and form controls from D07 T01 §3 and §6 to §8; no new control

**Build order:**

1. Admit Office Open XML documents by their bytes. Done when: `POST /api/upload` accepts a DOCX, an XLSX and a PPTX built as the checks' fixtures are and creates a case whose source is that document, and still refuses a ZIP that is none of them, a legacy `.doc` and a renamed executable.
2. Say so where the member reads it. Done when: the upload page's list of accepted files and its refusal text name Word, Excel and PowerPoint files, from one source with the sniff's own message.

- [x] Sniff a ZIP whose central directory holds `[Content_Types].xml` and a `word/`, `xl/` or `ppt/` part as `document` with its OOXML media type in `src/intake/sniff.ts` (the entry names read, never inflated beyond a small bound), keeping every other ZIP refused. Done when: `test/intake/sniff.test.ts` sniffs a DOCX, an XLSX and a PPTX as documents and refuses a plain ZIP, a ZIP with a `word/` name but no content types, a macro-enabled name changed only by extension, and a legacy `.doc`.
- [x] Route an uploaded Office document as the PDF is: stored, summarised as an upload source, and checked (`src/intake/upload.ts`, `src/pipeline/analysis-workflow.ts`'s parse step). Done when: `test/intake/upload.test.ts` uploads each of the three through `POST /api/upload` and reads the case's source kind `document` with its media type and its stored bytes, and an uploaded DOCX holding an instruction is a high `content.ai_instructions` item naming the upload (D02 T05 §8's reading) in `test/checks/upload-document-instructions.test.ts`.
- [x] Update the accepted-types wording in `NOT_TAKEN` and the upload page together. Done when: the page and the 415 answer name the same list, in `test/intake/upload.test.ts` and the upload page's test. (**Corrected 2026-11-01**, plan review, `docs/reviews/01-intake/D01-T03-s13.md`: (4) the intake sniff reads the ZIP's central directory, not its local headers: the end-of-directory record found within the last 64 KiB, at most 512 entries, each central header's signature and bounds checked, names only and nothing inflated; a file whose directory cannot be read whole (truncated, inconsistent, past the bound, a macro part anywhere in it) is refused, with 415 tests for a truncated header, inconsistent lengths, a macro past the first entries and a descriptor-bearing package, each persisting nothing; (5) the downstream proof covers all three kinds through the Workflow (`test/checks/upload-document-instructions.test.ts`: a DOCX, an XLSX and a PPTX each holding an instruction, read as a high item naming the upload), and the checkpoint names `test/checks/upload-document-instructions.test.ts` and `test/web/upload-page.test.ts` too; (6) the accepted words are explicit: Word (.docx), Excel (.xlsx) and PowerPoint (.pptx), with the older .doc, .xls and .ppt and macro files named as not taken, in the one list this file's Goal, the design spec's upload list, `design/SPEC.md`'s upload wording and the page all read or are corrected to; the marketing site's own list (`site/src/pages/how-it-works.astro`) is the site lane's, filed through the coordinator.)
- [x] Commit: `intake: Word, Excel and PowerPoint files accepted`

**Test checkpoint:** `pnpm exec vitest run test/intake/sniff.test.ts test/intake/upload.test.ts test/checks/upload-document-instructions.test.ts test/web/upload-page.test.ts` passes.

> **Verified:** 2026-11-01 | §13 | 24b9d659f7b547b432956750d1432a35e7cba5d9
> **Review:** `docs/reviews/d01-t03-s13.json`

## 14. Voice extraction measured on

Filed 2026-11-01 from §4's completion review (Part 2, item 2): the extraction is tested with scripted model answers, which establish that nothing unsupported is kept and that failures are stated, not how often Spark reads a real voice note's request, identity and urgency correctly, nor how long it takes.

**Phase:** 7
**Needs:** meta-api
**Surface:** no

**Build order:**

1. Build a synthetic corpus of transcripts. Done when: it is committed with its generation script, covering every request value, benign calls, spoken instructions to the AI, incomplete and long transcripts.
2. Measure the extraction on it. Done when: `docs/evals/voice-extraction.md` records, for each request value, errors and false alarms, the share of claims dropped for lack of support, and the median and p95 latency, with the model's cost.

- [ ] Write `scripts/fixtures/make-voice-transcripts.ts` generating `test/fixtures/voice-transcripts/` (at least 20 transcripts of each request value and 40 benign ones, fictional South African callers, a share with spoken instructions to the AI and a share past the length read), deterministic from a seed with a `--check`. Done when: both are committed and the check passes.
- [ ] Write `scripts/measure-voice.ts` running `extractVoiceClaim` on the corpus through the Meta client under its budget, recording per transcript the claim, what support dropped, the latency and the cost. Done when: `docs/evals/voice-extraction.md` holds the table, and names the request values it gets wrong and why, or that none.
- [ ] Commit: `voice: extraction measured on synthetic notes`

**Test checkpoint:** `docs/evals/voice-extraction.md` holds the measured table and the corpus `--check` passes.

## 15. Figures read out of a transcript by code

Filed 2026-11-01 from §4's review rounds: the model does not restate the amounts and accounts a speaker gives (four rounds found a way to read a figure out of the middle of another, however it was matched), so §4 keeps the speaker's sentence. A reader that needs the figures themselves, such as matching a spoken account number against the organisation's supplier accounts (D05 T02), needs them read by code from the transcript, which is deterministic and checkable.

**Phase:** 7
**Needs:** none
**Surface:** no

**Build order:**

1. Read amounts and account numbers out of a transcript by code. Done when: a corpus of spoken forms gives each figure whole, with no figure read out of another.

- [ ] Write `figuresOf(transcript)` in `src/voice/figures.ts` returning each amount (a number with its currency marker, a decimal point or comma understood, thousands grouping, magnitude words such as thousand and million) and each account-like run of digits as a whole token with its position, never a part of another. Done when: `test/voice/figures.test.ts` covers 100.50, R1,50, R1,500, R48 000, R100 million, 100 rand beside 200 dollars, account numbers in groups and a figure inside a longer one, each read whole or not at all.
- [ ] Offer the figures beside the payment sentence in the evidence detail (`voice.request`), each only when it lies inside the verified sentence. Done when: a stored case's `voice.request` item lists the figures of its payment sentence, and none of any other sentence.
- [ ] Commit: `voice: figures read from the transcript by code`

**Test checkpoint:** `pnpm exec vitest run test/voice/figures.test.ts` passes.

## 16. Transcript stored as its own evidence item

Filed 2026-11-02 from the coordinator's routing (report lane, D07 T09 §6): a voice note's transcript is stored as an artefact and read by the voice checks, but no evidence item carries the transcript itself, so the report cannot show what was heard. This section stores one transcript evidence item per recording: its segments with their times, the recording's artefact key, the speaker count and the language.

**Phase:** 7
**Needs:** none
**Surface:** no

**Build order:**

1. Store the transcript as evidence. Done when: a transcribed recording reads back one item with its timed segments, artefact key, speaker count and language.

- [ ] Write the transcript item from the transcription step in `src/pipeline/analysis-workflow.ts` (segments with start and end times, the stored recording's artefact key, the speaker count and the detected language), bounded like every detail, and state an untranscribed recording as not checked on the same item's terms. Done when: the owning voice suite reads the item back for a two-speaker recording and states a silent or missing one apart.
- [ ] Commit: `intake: transcript stored as its own evidence item`

**Test checkpoint:** `pnpm exec vitest run test/checks/voice.test.ts` passes, and fails if a transcribed recording stores no transcript item.

## Verification

- Each accepted upload type creates a case; the synthetic voice fixture yields transcript and claim evidence; refused files store nothing.
- `pnpm test` passes; `python3 scripts/todo-graph.py validate` and `plan --check` pass.
