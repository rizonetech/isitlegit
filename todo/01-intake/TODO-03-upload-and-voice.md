---
schema_version: 1
id: upload-and-voice
domain: 01-intake
status: active
title: "TODO-03 -- Web Upload and Voice Notes"
track: day-1
---

# TODO-03 -- Web Upload and Voice Notes

> **Goal:** A signed-in member uploads an email (`.eml`, `.msg`), a document (PDF), a screenshot (PNG, JPEG, WebP) or a voice note (`.ogg`, `.opus`, `.wav`, `.mp3`) and gets the same investigation as a forwarded email; voice notes and voicemail-lure attachments are decoded to 16 kHz mono WAV, transcribed by Muse Voice Transcribe and turned into evidence about what the caller wants and who they claim to be. (**Corrected 2026-10-28**, §8: `.m4a` is refused until §10, which waits on the AAC patent decision.)

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
| 7 | §7 | MP3 decoding | §2 | [x] |
| 8 | §8 | M4A decoding | §2 | [x] |
| 9 | §9 | Filtered resampling for WAV | §2 | [ ] |
| 10 | §10 | M4A with libxaac | §8 | [ ] |

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
- [ ] Refuse anything else with 415 and files over 25 MiB with 413, storing nothing; an M4A (an `ftyp` box with an audio brand) is refused by type with 415 and the message `UnsupportedAudio` gives, naming the formats taken (D01 T03 §8: AAC decoding waits on §10). Done when: both tests pass, an M4A upload gets 415 with that message, and R2 holds no object.
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
> **Resolved:** filtered resampling for WAV input and a timing comparison with FFmpeg -> XREF: D01 T03 §9. Resolved 2026-10-28 by D01 T03 §9 in `b9fb1b8` and `bd81843`: a Kaiser-windowed sinc in WebAssembly SIMD, and the bench against FFmpeg in CI.
> **Resolved:** decoding MP3 voice notes and voicemail attachments (refused with `UnsupportedAudio` until then) -> XREF: D01 T03 §7. Resolved 2026-10-28 by D01 T03 §7 in `e28af5c`: `decodeToWavChunks` decodes `audio/mpeg` through `src/voice/mp3.ts`.
> **Resolved:** decoding M4A (AAC) voice notes, refused with `UnsupportedAudio` until then -> XREF: D01 T03 §8. Resolved 2026-10-28 by D01 T03 §8 in `ef40084` (the message reworded in `e901e3b`): M4A is refused by design, naming the formats taken, while the AAC patent decision is open; decoding it is D01 T03 §10.

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

- [ ] Commit: `voice: filtered resampling for WAV, timed against FFmpeg`

**Test checkpoint:** `pnpm exec vitest run test/voice/decode.test.ts test/voice/mp3.test.ts` passes, and fails if a passband tone moves more than 0.5 dB, a stopband tone or an upsampling image leaves more than -60 dB, an MP3's 12 kHz tone is not suppressed against its decoded level, or a length or continuity test breaks. (**Corrected 2026-10-28**, plan review P2 2.)

## 10. M4A with libxaac

§8 found one AAC decoder whose copyright licence allows shipping it in the Worker: libxaac (Ittiam for Android, Apache-2.0). It was not taken because AAC, unlike MP3, is still licensed through a patent pool, and whether decoding uploaded voice notes on a server needs that licence is a business decision. Filed from §8 (2026-10-28) so M4A has an owner.

**Phase:** 2
**Needs:** operator
**Surface:** no

**Operator decision (open):** whether IsItLegit may decode AAC (iPhone voice memos and other `.m4a` recordings) in the Worker, given the AAC patent pool, and if so under which licence. Recording `AAC decoding: <decision> (YYYY-MM-DD)` here and removing `operator` from Needs releases the section.

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

## Verification

- Each accepted upload type creates a case; the synthetic voice fixture yields transcript and claim evidence; refused files store nothing.
- `pnpm test` passes; `python3 scripts/todo-graph.py validate` and `plan --check` pass.
