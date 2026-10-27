---
schema_version: 1
id: upload-and-voice
domain: 01-intake
status: active
title: "TODO-03 -- Web Upload and Voice Notes"
track: day-1
---

# TODO-03 -- Web Upload and Voice Notes

> **Goal:** A signed-in member uploads an email (`.eml`, `.msg`), a document (PDF), a screenshot (PNG, JPEG, WebP) or a voice note (`.ogg`, `.opus`, `.wav`, `.mp3`, `.m4a`) and gets the same investigation as a forwarded email; voice notes and voicemail-lure attachments are decoded to 16 kHz mono WAV, transcribed by Muse Voice Transcribe and turned into evidence about what the caller wants and who they claim to be.

> **Current state:** Measured 2026-10-26 20:00 SAST. No upload or audio code exists. WhatsApp intake is out of the event scope (design spec 4.1a), so uploads carry voice notes during the event.

## Inputs

- Design spec 4.1 (upload), 4.2a (voice notes and voicemail lures), 4.5a (standalone documents), 11 (WhatsApp decision).
- Stack doc: `ogg-opus-decoder` 1.7.5; Muse Voice Transcribe takes WAV, 16 kHz mono 16-bit, at most 10 minutes per request.
- Meta docs `speech-to-text.md` and `api-reference_voice_transcribe.md` (look up with `python3 scripts/meta-docs.py find transcribe diarization`).
- -> XREF: D07 T02 §1 -- the session that authorises uploads
- -> XREF: D03 T01 §1 -- the model client every Voice Transcribe and Spark call goes through

## Outcome

- Uploading each accepted type creates a case and runs the same Workflow; an unsupported or oversized file is refused with a clear message.
- A synthetic voice note asking for an urgent payment produces a transcript artefact and evidence naming the request, the claimed identity and the urgency.

**Adjacency:** list=applicable @ D07 T04 §1; document=applicable @ D07 T03 §1; settings=not-applicable (accepted types and limits are fixed in code from spec 4.8); reporting=applicable @ D07 T04 §2; notifications=not-applicable (upload results show on the page; no mail is sent for uploads); permissions=applicable @ D01 T03 §1; audit=applicable @ D01 T01 §7; exchange=not-applicable (single files only, no bulk import); reverse=not-applicable (an upload starts an analysis; cases expire by retention)

**Adjacency rationale:** Uploads become ordinary cases, listed and reported like forwarded mail. The session check in §1 is the permission boundary.

## Implementation Order

| Order | Section | Deliverable | Depends On | Status |
| ----- | ------- | ----------- | ---------- | ------ |
| 1 | §1 | Upload API for mail, documents and audio | D01 T01 §7, D07 T02 §1 | [ ] |
| 2 | §2 | Audio decoding to 16 kHz mono WAV | D01 T01 §2 | [x] |
| 3 | §3 | Muse Voice Transcribe client with chunking | §2, D03 T01 §5 | [ ] |
| 4 | §4 | Voice evidence: request, claimed identity, urgency | §3 | [ ] |
| 5 | §5 | Voicemail-lure attachments in email | §4 | [ ] |
| 6 | §6 | Upload page | §1, D07 T01 §10 | [ ] |
| 7 | §7 | MP3 decoding | §2 | [ ] |
| 8 | §8 | M4A decoding | §2 | [ ] |
| 9 | §9 | Filtered resampling for WAV | §2 | [ ] |

## 1. Upload API for mail, documents and audio

`POST /api/upload` accepts one file from a signed-in member and creates a case with channel `upload` (spec 4.1). The file is sniffed by content, not trusted by its extension, and routed: mail goes through the D01 T01 parse path; a PDF or image becomes a standalone document case (spec 4.5a); audio goes through §2 to §4.

**Phase:** 1
**Needs:** none
**Surface:** no

**Build order:**

1. Write the route in `src/intake/upload.ts`. Done when: a test uploads each accepted type and gets a case id.
2. Refuse the rest. Done when: an executable, a 30 MiB file and an unauthenticated request are each refused with the right status.

- [ ] Write `POST /api/upload` (Hono) requiring a session from D07 T02 and the organisation's daily case cap from D07 T02 §4. Done when: an anonymous request gets 401 and a capped organisation gets 429 in `test/intake/upload.test.ts`.
- [ ] Sniff the type from magic bytes (`%PDF`, PNG, JPEG, WebP, OggS, RIFF/WAVE, ID3 or MPEG frame, `ftyp` M4A, OLE header for `.msg`, RFC 5322 header block for `.eml`). Done when: a renamed PDF uploaded as `x.png` is treated as PDF. Cheaper substitute: trusting the extension.
- [ ] Refuse anything else with 415 and files over 25 MiB with 413, storing nothing. Done when: both tests pass and R2 holds no object.
- [ ] Store the file with `putRaw` for mail and `putAttachment` otherwise (**corrected 2026-10-27**, D01 T01 §2's plan review: `putArtefact` takes only derived kinds), create the case with `channel = "upload"` and a `source_kind` of mail, document, image or audio, and start the Workflow. Done when: each accepted fixture creates one case and one Workflow instance.
- [ ] Make the Workflow's `parse` step branch on `source_kind`. Done when: a PDF case skips MIME parsing and records the document artefact.
- [ ] Commit: `intake: upload API for mail, documents, images and audio`

**Test checkpoint:** `pnpm exec vitest run test/intake/upload.test.ts` passes and fails if the type sniffing is replaced by the extension.

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
> **Deferred:** filtered resampling for WAV input and a timing comparison with FFmpeg -> XREF: D01 T03 §9
> **Deferred:** decoding MP3 voice notes and voicemail attachments (refused with `UnsupportedAudio` until then) -> XREF: D01 T03 §7
> **Deferred:** decoding M4A (AAC) voice notes, refused with `UnsupportedAudio` until then -> XREF: D01 T03 §8

- [x] Commit: `voice: decode voice notes to 16 kHz mono WAV`

**Test checkpoint:** `pnpm exec vitest run test/voice/decode.test.ts` passes and fails if the sample rate written to the header is not 16000, if the decoded tone is not 440 Hz at its level, if a 10-minute boundary drops or repeats samples, if a recording over 30 minutes is decoded at all, or if damaged audio is passed on.

> **Verified:** 2026-10-27 | §2 | fcc92ad1a2c537a294c2b0c8c028a2cc58a96142
> **Review:** `docs/reviews/d01-t03-s2.json`

## 3. Muse Voice Transcribe client with chunking

`muse-voice-transcribe-1.0` returns a diarized transcript (spec 4.2a). Calls go through the model client (D03 T01) for the budget guard, Standard IDs and cost logging. Each chunk is transcribed and the transcripts are joined in order.

**Phase:** 3
**Needs:** meta-api
**Surface:** no

**Build order:**

1. Write `src/voice/transcribe.ts`. Done when: a stubbed test sends each WAV chunk and joins the results with speaker labels.
2. Run it once live on a synthetic voice fixture. Done when: the transcript artefact exists and the cost is logged.

- [ ] Look up the request shape with `python3 scripts/meta-docs.py find asr transcribe diarization` and record the endpoint, fields and response shape in a comment at the top of `src/voice/transcribe.ts` with the docs URL. Done when: the comment cites `https://dev.meta.ai/docs/speech-to-text`.
- [ ] Write `transcribe(caseId, chunks)` calling the endpoint through the D03 T01 client with model `muse-voice-transcribe-1.0`. Done when: `test/voice/transcribe.test.ts` with a stubbed transport checks the request for each chunk.
- [ ] Validate the response with zod and join chunks in order, keeping speaker turns. Done when: a malformed stub response raises `ModelOutputError` and the case ends `partial` with the step named.
- [ ] Store the transcript as artefact kind `audio` with name `transcript.json`. Done when: the test reads it from R2.
- [ ] Create a synthetic voice fixture `test/fixtures/audio/director-urgent-payment.ogg` (fictional names, a request to pay a new account today) with `scripts/fixtures/make-voice.ts`, recording how it was made in `eval/DATASETS.md`. Done when: the file exists and its provenance line names the method.
- [ ] Run one live transcription of that fixture after the credit gate line is present and record model, seconds of audio, latency and cost in `docs/frontier-log.md`. Done when: the entry exists.
- [ ] Commit: `voice: Muse Voice Transcribe with chunking`

**Test checkpoint:** `pnpm exec vitest run test/voice/transcribe.test.ts` passes and fails if chunks are joined out of order.

## 4. Voice evidence: request, claimed identity, urgency

The transcript is untrusted content. Muse Spark reads it inside an untrusted block (D03 T01 §6) and returns structured fields: what is being asked (pay, change bank details, share a code, click a link, other), who the speaker claims to be, urgency cues, and any payment details mentioned (spec 4.2a). The report states the limits: no Afrikaans, isiZulu or isiXhosa support, and no voice-clone detection.

**Phase:** 3
**Needs:** meta-api
**Surface:** no

**Build order:**

1. Write `src/voice/extract.ts` with a zod schema and the Spark call. Done when: a stubbed test turns a transcript into evidence items.
2. Add the limits note. Done when: every voice case carries an info evidence item stating them.

- [ ] Define `VoiceClaim` in `src/voice/schema.ts` (`request` enum, `claimed_identity`, `urgency` low medium high, `payment_details` optional, `quotes` array of short transcript spans). Done when: `z.toJSONSchema(VoiceClaim)` is non-recursive and used as the structured output schema.
- [ ] Call `muse-spark-1.3` through the D03 T01 structured-output helper with the transcript in an untrusted block. Done when: `test/voice/extract.test.ts` with a stubbed model checks the prompt contains the untrusted delimiters and not raw instructions outside them.
- [ ] Turn the result into evidence: `voice.request` (high when it is a payment or bank change), `voice.claimed_identity` (info, used by D05 T02 §2 against the registry), `voice.urgency`. Done when: the fixture transcript yields the three items with quotes as detail.
- [ ] Add an info evidence item `voice.limits` stating the unsupported languages and that voice cloning is not detected (spec 4.2a). Done when: every voice case has it. Cheaper substitute: omitting the limits, which overstates the product.
- [ ] Commit: `voice: request, claimed identity and urgency evidence`

**Test checkpoint:** `pnpm exec vitest run test/voice/extract.test.ts` passes and fails if the transcript is placed outside the untrusted block.

## 5. Voicemail-lure attachments in email

Phishing mail often poses as a voicemail: an audio attachment or an HTML "play message" page (spec 4.2a). Audio attachments go through §2 to §4; HTML lures are flagged for the link and attachment checks.

**Phase:** 3
**Needs:** none
**Surface:** no

**Build order:**

1. Route audio attachments of a mail case to the voice path. Done when: a fixture email with a `.wav` attachment produces a transcript step.
2. Flag HTML play-message lures. Done when: a fixture HTML attachment with a fake player yields a `voice.lure` evidence item.

- [ ] In the Workflow `parse` step, queue every attachment whose sniffed type is audio for decode and transcription. Done when: `test/voice/lure.test.ts` sees the voice steps run for `test/fixtures/voicemail-wav.eml`.
- [ ] Detect HTML attachments with voicemail wording ("voice message", "play", "listen", "voicemail") and an audio player or a link, as a medium `voice.lure` evidence item. Done when: `test/fixtures/voicemail-html-lure.eml` yields it and a plain HTML newsletter does not.
- [ ] Commit: `voice: voicemail-lure attachments in email`

**Test checkpoint:** `pnpm exec vitest run test/voice/lure.test.ts` passes and fails if the newsletter fixture is flagged.

## 6. Upload page

The member-facing page for uploads: one drop zone and file picker, accepted types listed, progress, and a redirect to the live report (spec 4.1). It follows `design/SPEC.md`.

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

- [ ] Build the upload page in `src/web/pages/upload.tsx` with the drop zone, file picker button and accepted-types list from the SPEC. Done when: a rendered-page test finds each element by its accessible name. Cheaper substitute: a bare file input without the SPEC layout.
- [ ] Show upload progress and disable the button while sending. Done when: the test sees the busy state attribute during a pending request.
- [ ] Show the 401, 413, 415 and 429 messages from the API in the page's error region. Done when: a test for each status finds the message text.
- [ ] Redirect to `/cases/<id>` on success. Done when: the test follows the redirect.
- [ ] Commit: `web: upload page`

**Test checkpoint:** `pnpm exec vitest run test/web/upload-page.test.ts` passes and fails if the error region is removed.

## 7. MP3 decoding

> **Started:** 2026-10-27T21:26Z

Spec 4.2a lists `.mp3` among voice-note uploads and as the usual format of a voicemail-lure attachment. §2 found that `mpg123-decoder` (the same WASM family as `ogg-opus-decoder`) can run in a Worker with the same fix: a precompiled module and the `@eshaz/web-worker` stub. Filed from §2's validation (2026-10-27) so that section stays one format family.

**Phase:** 1
**Needs:** none
**Surface:** no

**Corrected 2026-10-27** (validation before building; the items said `mpg123-decoder` 1.0.3 and §2's precompiled-module route). `mpg123-decoder` is MIT around libmpg123, which is LGPL-2.1, and the WebAssembly would be committed to this repository and shipped in the Worker; the repository has no policy on copyleft code (the product is FSL-1.1-ALv2, and spec section 10's default is "all rights reserved"), so the permissive decoder is taken: minimp3 (CC0, https://github.com/lieff/minimp3), as compiled to a 21 KB WebAssembly module with no imports by `minimp3-wasm` 0.1.0 (Apache-2.0, https://github.com/bashi/minimp3-wasm; it calls itself a demo, so only its `.wasm` is used, with a binding written here, never its `fetch`-based loader). Measured in Node: a 3-second 440 Hz tone at 44.1 kHz from LAME decodes to 3.03 s (the encoder's padding) at 440 Hz. Like libopus, minimp3 does not report damage: a file cut at 60 % and one with 400 bytes flipped both decoded without complaint, shorter. So the Worker walks the MP3 frames itself before decoding, as it walks Ogg pages. The fixture is encoded with LAME (`@breezystack/lamejs` 1.2.7, LGPL-3.0), a development dependency that never ships.

**Operator decision (open, not blocking):** whether copyleft code may ship in the Worker. Reversing this choice to `mpg123-decoder` costs one module swap (`src/voice/mp3.ts`) and its notice; the frame walk and tests stay.

**Build order:**

1. Decode MP3 in the workers pool. Done when: a synthetic MP3 fixture decodes to the tone in a Vitest workers test with nothing compiled at runtime.
2. Route MP3 through §2's pipeline. Done when: an MP3 voice note yields 16 kHz mono WAV chunks like any other.

- [ ] Add exact development dependencies `minimp3-wasm` 0.1.0 and `@breezystack/lamejs` 1.2.7, and commit `minimp3-wasm`'s `dist/decoder.opt.wasm` as `src/voice/minimp3.wasm` with its licences beside it (`src/voice/minimp3.wasm.LICENSE`: minimp3's CC0 and minimp3-wasm's Apache-2.0) and rows in `NOTICE.md`. Done when: `test/node/opus-wasm.test.ts` fails when the committed file differs from the installed package's, and `NOTICE.md` names both.
- [ ] Generate in `scripts/fixtures/make-audio.ts` with LAME: `tone.mp3` (the 3-second tone, 44.1 kHz mono, 64 kbit/s, MPEG-1), `tone-stereo.mp3` (the tone on the left, silence on the right), `tone-16k.mp3` (16 kHz, MPEG-2) and `tone-8k.mp3` (8 kHz, MPEG-2.5), each with the encoder's Xing/Info frame and LAME tag when the encoder writes one; tests build a variable-bitrate stream from frames of two bitrates, and tagged copies (ID3v2.4 with its footer, ID3v1, APE) from the fixtures. Done when: the files and the generator are committed and the generator's output is the same on every run. (**Corrected 2026-10-27**, plan review P2 1.)
- [ ] Walk the MP3 before decoding, in `src/voice/mp3.ts`: skip an ID3v2 tag at the start (its syncsafe size counts neither the 10-byte header nor the 10-byte footer the flags may announce, ID3v2.4 3.1) and an ID3v1 or APE tag at the end; read every frame header (MPEG 1, 2 or 2.5, Layer III, a defined bitrate and sample rate, not free format; one sample rate and channel mode throughout) and require each frame to start where the one before it ends and the last to end with the file. The length is the frames' count times their samples (1,152 or 576), less the encoder delay and end padding a LAME tag declares (the Xing/Info frame itself is metadata, not audio), so a recording of exactly 30 minutes is taken and one over it refused unread; when a Xing/Info frame declares a frame count, the walk must find exactly that many frames, which catches a file cut at a frame boundary. A file without that count, cut exactly at a frame boundary, cannot be told from a shorter recording: MP3 carries no other length or checksum, and this limit is recorded rather than claimed away. Done when: `test/voice/decode.test.ts` decodes the MPEG-2, MPEG-2.5, variable-bitrate and tagged files; refuses with `CorruptAudio` a file cut mid-frame, one cut at a frame boundary whose Xing count says more frames, one with bytes flipped inside a frame header, one with junk between frames, one whose ID3v2 size runs past the file, an empty file and a tag-only file, each by name; refuses a free-format or Layer II file with `UnsupportedAudio`; takes a recording of exactly 30 minutes by its LAME tag; and refuses a 31-minute file with `AudioTooLong` before decoding. (**Corrected 2026-10-27**, plan review P2 1, 2 and 4.)
- [ ] Decode with minimp3 in `src/voice/mp3.ts`: instantiate `src/voice/minimp3.wasm` (imported as a module) once per decode, copy the input into its memory, decode at most 5 seconds at a time, drop the encoder delay (plus the decoder's 529 samples) and end padding a LAME tag declares, mix down and resample each block to 16 kHz with §2's `Resampler` into §2's chunk writer; turn anything the module throws into `CorruptAudio`; refuse a decode that stops short of the frame walk's length (no progress before the end) or runs past it. Done when: the MP3 fixtures decode to 440 Hz within 2 Hz at the tone's level (RMS within 5 %), the stereo one at half level, to the frame walk's length, and a 25-minute MP3 to three chunks, in the workers pool; output is identical whatever the decode batch and chunk sizes (so no sample is lost or repeated at either boundary); no decode call returns more than 5 seconds; a caller that stops after the first chunk ends the decode cleanly; and a module that throws or stalls is refused with `CorruptAudio`. (**Corrected 2026-10-27**, plan review P2 2 and 3.)
- [ ] Route `audio/mpeg` and `audio/mp3` through `decodeToWavChunks` in `src/voice/decode.ts`, stop refusing them, and make `UnsupportedAudio`'s message name the formats taken (Ogg Opus, WAV and MP3). Done when: the MP3 refusal test is replaced by these, M4A is still refused, and the refusal's message is tested to name MP3. (**Corrected 2026-10-27**, plan review P2 5.)
- [ ] Close §2's MP3 deferral as `Resolved:`. Done when: §2's Deferred line reads resolved with this section's commit.
- [ ] Commit: `voice: decode MP3 voice notes and voicemail attachments`

**Test checkpoint:** `pnpm exec vitest run test/voice/decode.test.ts test/node/opus-wasm.test.ts` passes and fails if an MP3 is refused, if its decoded tone is not 440 Hz at its level and length, if damage passes the frame walk, or if a long MP3 is decoded at all.

## 8. M4A decoding

Spec 4.2a lists `.m4a` among voice-note uploads (iPhone voice memos are AAC in an MP4 container). §2 found no AAC decoder in the WASM family that runs in a Worker, so M4A is refused there with `UnsupportedAudio`. Filed from §2's plan review (P1 3, 2026-10-27) so the refusal has an owner.

**Phase:** 1
**Needs:** none
**Surface:** no

**Build order:**

1. Find a decoder. Done when: an AAC decoder that runs in a Worker (WASM loadable as a precompiled module, no runtime compilation, no Web Worker) is chosen with its licence and version, or none is found and the governing contract is corrected.
2. Decode or refuse for good. Done when: an M4A voice note yields 16 kHz mono WAV chunks through §2, or spec 4.2a, this file's Goal and §1's accepted types no longer list M4A and the upload refuses it with a clear message.

- [ ] Survey AAC decoders for Workers (a WASM build of FAAD2 or FDK AAC, a demuxer for MP4's `moov` and `mdat`) and record each candidate's licence (FDK AAC's licence restricts redistribution), version, release date and whether it loads in the workers pool. Done when: the finding is recorded here with sources.
- [ ] If one qualifies: add it exactly pinned, extract its WASM the way §2 does, generate `test/fixtures/audio/tone.m4a`, and decode M4A in `decodeToWavChunks`. Done when: `test/voice/decode.test.ts` decodes the fixture to the tone (440 Hz, its level, its length) and refuses a truncated one with `CorruptAudio`.
- [ ] If none qualifies: correct spec 4.2a and the Goal of this file to drop `.m4a` (dated, with the reason), and make §1 refuse it by type with a message naming the formats it takes. Done when: the spec and Goal are corrected and `test/intake/upload.test.ts` (§1) refuses an M4A with that message.
- [ ] Close §2's M4A deferral as `Resolved:`. Done when: §2's Deferred line reads resolved with this section's commit.
- [ ] Commit: `voice: M4A voice notes decoded or refused by design`

**Test checkpoint:** `pnpm exec vitest run test/voice/decode.test.ts` passes, and fails if an M4A is silently accepted without being decoded.

## 9. Filtered resampling for WAV

§2 resamples WAV input linearly, which passes energy above 8 kHz through as aliases: measured in §2's completion review, a half-scale 12 kHz tone at 48 kHz comes out as a full-strength 4 kHz alias. Ogg Opus no longer has this problem, because libopus decodes it straight to 16 kHz with its own filter. The strongest alternative for this job, FFmpeg's libswresample, filters by default (https://ffmpeg.org/ffmpeg-resampler.html). Filed from §2's completion review (2026-10-27), with its request for timings compared with FFmpeg, which needs FFmpeg (installed on GitHub's Ubuntu runners, not on the build machine).

**Phase:** 1
**Needs:** none
**Surface:** no

**Build order:**

1. Filter before decimating. Done when: a 12 kHz tone in a 48 kHz WAV comes out at least 60 dB down, with §2's tone, level and continuity tests unchanged.
2. Measure against FFmpeg. Done when: the decoder's first-chunk and completion times are recorded beside FFmpeg's for the same inputs.

- [ ] Replace `Resampler`'s linear interpolation in `src/voice/decode.ts` with a windowed-sinc (or polyphase) low-pass resampler that keeps its state across blocks, cut off below 8 kHz. Done when: `test/voice/decode.test.ts` finds a 12 kHz tone in a 48 kHz WAV at least 60 dB below its input level and a 3 kHz tone within 0.5 dB, and the existing block-split test still gives identical output however the input is split.
- [ ] Keep §2's guarantees: 440 Hz at its level, exact output lengths, no seam at chunk boundaries. Done when: §2's tests pass unchanged.
- [ ] Add `scripts/voice-bench.ts`, which times the decoder (first chunk and completion) on a 3-second note, a 25-minute recording, a dense low-bitrate stream and a damaged file, and runs `ffmpeg -ar 16000 -ac 1 -c:a pcm_s16le` on the same inputs when FFmpeg is installed, printing both. Done when: a CI job on `ubuntu-latest` runs it and its output is recorded here with the FFmpeg version.
- [ ] Commit: `voice: filtered resampling for WAV, timed against FFmpeg`

**Test checkpoint:** `pnpm exec vitest run test/voice/decode.test.ts` passes, and fails if a 12 kHz tone in a 48 kHz WAV comes out less than 60 dB down.

## Verification

- Each accepted upload type creates a case; the synthetic voice fixture yields transcript and claim evidence; refused files store nothing.
- `pnpm test` passes; `python3 scripts/todo-graph.py validate` and `plan --check` pass.
