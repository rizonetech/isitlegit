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
| 2 | §2 | Audio decoding to 16 kHz mono WAV | D01 T01 §2 | [ ] |
| 3 | §3 | Muse Voice Transcribe client with chunking | §2, D03 T01 §5 | [ ] |
| 4 | §4 | Voice evidence: request, claimed identity, urgency | §3 | [ ] |
| 5 | §5 | Voicemail-lure attachments in email | §4 | [ ] |
| 6 | §6 | Upload page | §1, D07 T01 §10 | [ ] |
| 7 | §7 | MP3 decoding | §2 | [ ] |
| 8 | §8 | M4A decoding | §2 | [ ] |

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

**Build order:**

1. Prove `ogg-opus-decoder` 1.7.5 in the workers pool. Done when: a synthetic Opus fixture decodes to PCM in a Vitest workers test, with the WASM loaded as a precompiled module and nothing compiled at runtime.
2. Decode, resample and chunk as a stream. Done when: a 25-minute compressed recording yields three 16 kHz mono 16-bit WAV chunks holding the right sound, with only the input, one chunk and the decoder's buffers held at once.

- [ ] Add exact dependencies `ogg-opus-decoder` 1.7.5 and `opus-decoder` 0.7.12 (the class whose static `module` takes the precompiled WASM; the version `ogg-opus-decoder` 1.7.5 pins), and dev dependency `opusscript` 0.1.1. Done when: `pnpm install` resolves them, `pnpm why opus-decoder` lists one version, and the WASM loads in the workers pool.
- [ ] Extract the Opus decoder's WASM with `scripts/build-opus-wasm.ts` (runs the installed decoder once in Node and writes the module it compiles) to `src/voice/opus-decoder.wasm`, committed, and import it in `src/voice/decode.ts` as a module (`?module`) set on `OpusDecoder.module` before the first decode. Done when: a workers test decodes with runtime compilation impossible (a `WebAssembly.compile` call would throw), and `test/node/opus-wasm.test.ts` fails when the committed file differs from what the installed package produces. Source: `@wasm-audio-decoders/common` 9.0.7 `WASMAudioDecoderCommon.js` (`instantiate`, `setModule`).
- [ ] Alias `@eshaz/web-worker` to `src/voice/no-web-worker.ts` (a class that throws if constructed) in `wrangler.jsonc` and in the workers project of `vitest.config.ts`, marked as a workaround (the package's index needs a Web Worker class at import, which a Cloudflare Worker has no use for). Done when: `test/node/opus-wasm.test.ts` fails if the two aliases differ, and `wrangler deploy --dry-run` bundles the decoder.
- [ ] Generate synthetic fixtures `test/fixtures/audio/tone.ogg` and `tone.wav` (a 3-second tone, no voice) with `scripts/fixtures/make-audio.ts`. Done when: both files and the generator are committed.
- [ ] Write `decodeToWavChunks(bytes, type)` in `src/voice/decode.ts`, an async generator yielding 16 kHz mono 16-bit WAV chunks of at most 10 minutes, for Ogg Opus (fed to `OggOpusDecoder.decode` in slices of at most 64 KiB, then `flush`) and WAV (PCM 16-bit, any rate and channel count, read in slices from the `data` chunk). Each decoded block is mixed down and resampled at once into the current chunk, which is yielded when full, so memory holds the input, one chunk (at most 19.2 MB) and the decoder's buffers, never the whole recording; the decoder is freed in a `finally`, also when the caller stops early. Refuse other types (an MP3 header, an M4A `ftyp` header) with `UnsupportedAudio` naming the type. Done when: `test/voice/decode.test.ts` decodes both fixtures to chunks, refuses MP3 and M4A with the typed error naming each, and finds the decoder freed after a caller that stops after the first chunk. (**Corrected 2026-10-27**, plan review P1 1: decoding whole recordings would need 288 MB for 25 minutes at 48 kHz, past a Worker's 128 MB.)
- [ ] Write the streaming resampler `Resampler` in `src/voice/decode.ts` (linear interpolation that carries its position and last sample across blocks, and channel mixdown by averaging) and `wavHeader(samples)`. Done when: tests check the sound, not only the header: the 3-second 440 Hz fixtures come out as 48,000 samples (within one 20 ms Opus frame for Ogg, which drops its 312-sample pre-skip), at 440 Hz (zero crossings, within 2 Hz), at the tone's level (RMS within 5% of the source's, measured on the WAV fixture), a stereo input of the tone on the left and its inverse on the right mixes down to near silence, and the header reads PCM, 16000 Hz, 1 channel, 16 bits, with sizes matching the data. (**Corrected 2026-10-27**, plan review P1 2.)
- [ ] Refuse audio over 30 minutes before decoding, from the container's own length (an Ogg's last granule position less its pre-skip, a WAV's `data` size over its byte rate), and split the rest into 10-minute chunks with no sample lost or repeated at a boundary. Done when: a workers test builds a 25-minute Ogg Opus recording from the fixture's packets (repeated, with granules and CRCs rewritten by `test/fixtures/audio/ogg.ts`, a few MB, within the 25 MiB upload limit) and gets three chunks of 9,600,000, 9,600,000 and 4,800,000 samples within a frame, with the tone's phase continuous across each boundary; and a 31-minute one is refused with `AudioTooLong` before a single packet is decoded. (**Corrected 2026-10-27**, plan review P1 1 and 2.)
- [ ] Refuse damaged audio, never pass it on as complete: a decode that reports `errors` (the Ogg decoder returns them beside its PCM instead of throwing), a decode with no samples, an Ogg without an `OpusHead`, and a WAV whose `fmt ` is not PCM 16-bit, whose chunk sizes run past the file, or whose channel count or rate is zero, each with `CorruptAudio` naming what was wrong, checked before any allocation the header sizes. Done when: tests refuse a truncated Ogg, an Ogg with one page's bytes flipped (decoder errors, no throw), an empty Ogg, and WAV files with a bad format code, a `data` size past the end and zero channels, each with the typed error. (**Corrected 2026-10-27**, plan review P2 4.)
> **Deferred:** decoding MP3 voice notes and voicemail attachments (refused with `UnsupportedAudio` until then) -> XREF: D01 T03 §7
> **Deferred:** decoding M4A (AAC) voice notes, refused with `UnsupportedAudio` until then -> XREF: D01 T03 §8

- [ ] Commit: `voice: decode voice notes to 16 kHz mono WAV`

**Test checkpoint:** `pnpm exec vitest run test/voice/decode.test.ts` passes and fails if the sample rate written to the header is not 16000, if the decoded tone is not 440 Hz at its level, if a 10-minute boundary drops or repeats samples, if a recording over 30 minutes is decoded at all, or if damaged audio is passed on.

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

Spec 4.2a lists `.mp3` among voice-note uploads and as the usual format of a voicemail-lure attachment. §2 found that `mpg123-decoder` (the same WASM family as `ogg-opus-decoder`) can run in a Worker with the same fix: a precompiled module and the `@eshaz/web-worker` stub. Filed from §2's validation (2026-10-27) so that section stays one format family.

**Phase:** 1
**Needs:** none
**Surface:** no

**Build order:**

1. Decode MP3 in the workers pool. Done when: a synthetic MP3 fixture decodes to PCM in a Vitest workers test with nothing compiled at runtime.
2. Route MP3 through §2's pipeline. Done when: an MP3 voice note yields 16 kHz mono WAV chunks like any other.

- [ ] Add exact dependency `mpg123-decoder` 1.0.3 and extract its WASM with `scripts/build-opus-wasm.ts` (extended to both decoders) to `src/voice/mpg123-decoder.wasm`, set on the decoder's static `module`. Done when: `test/node/opus-wasm.test.ts` checks both committed files against the installed packages.
- [ ] Generate `test/fixtures/audio/tone.mp3` (the same 3-second tone) in `scripts/fixtures/make-audio.ts` with an MP3 encoder whose licence allows a development dependency, recording the choice. Done when: the fixture and generator are committed and the generator's output is the same on every run.
- [ ] Decode MP3 in `decodeToPcm` (`src/voice/decode.ts`), and stop refusing it. Done when: `test/voice/decode.test.ts` decodes the MP3 fixture and refuses a truncated one with a typed error.
- [ ] Close §2's deferral as `Resolved:`. Done when: §2's Deferred line reads resolved with this section's commit.
- [ ] Commit: `voice: decode MP3 voice notes and voicemail attachments`

**Test checkpoint:** `pnpm exec vitest run test/voice/decode.test.ts` passes and fails if an MP3 is refused, if its decoded tone is not 440 Hz at its level and length, or if its WAV header is not 16000 Hz, 1 channel, 16 bits.

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

## Verification

- Each accepted upload type creates a case; the synthetic voice fixture yields transcript and claim evidence; refused files store nothing.
- `pnpm test` passes; `python3 scripts/todo-graph.py validate` and `plan --check` pass.
