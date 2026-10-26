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
| 6 | §6 | Upload page | §1, D07 T01 §3 | [ ] |

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
- [ ] Store the file with `putArtefact` (kind `raw` for mail, `attachment` otherwise), create the case with `channel = "upload"` and a `source_kind` of mail, document, image or audio, and start the Workflow. Done when: each accepted fixture creates one case and one Workflow instance.
- [ ] Make the Workflow's `parse` step branch on `source_kind`. Done when: a PDF case skips MIME parsing and records the document artefact.
- [ ] Commit: `intake: upload API for mail, documents, images and audio`

**Test checkpoint:** `pnpm exec vitest run test/intake/upload.test.ts` passes and fails if the type sniffing is replaced by the extension.

## 2. Audio decoding to 16 kHz mono WAV

Muse Voice Transcribe accepts WAV only, 16 kHz mono 16-bit, at most 10 minutes (spec 4.2a). WhatsApp saves voice notes as Ogg Opus; `ogg-opus-decoder` (WASM) decodes them in the Worker. WAV input is resampled; MP3 and M4A are refused with a clear message if no decoder runs in Workers (recorded, not hidden).

**Phase:** 1
**Needs:** none
**Surface:** no

**Build order:**

1. Prove `ogg-opus-decoder` 1.7.5 in the workers pool. Done when: a synthetic Opus fixture decodes to PCM in a Vitest workers test.
2. Resample and encode WAV. Done when: the output header reads 16000 Hz, 1 channel, 16 bits.

- [ ] Add exact dependency `ogg-opus-decoder` 1.7.5. Done when: `pnpm install` resolves it and the WASM loads in the workers pool.
- [ ] Generate synthetic fixtures `test/fixtures/audio/tone.ogg` and `tone.wav` (a 3-second tone, no voice) with `scripts/fixtures/make-audio.ts`. Done when: both files and the generator are committed.
- [ ] Write `decodeToPcm(bytes, type)` in `src/voice/decode.ts` for Ogg Opus and WAV, and refuse other types with `UnsupportedAudio` naming the type. Done when: tests decode both fixtures and refuse an MP3 header with the typed error.
- [ ] Write `toWav16kMono(pcm, sampleRate, channels)` with linear resampling and channel mixdown. Done when: a test reads the WAV header fields 16000, 1 and 16.
- [ ] Cap at 10 minutes per chunk by splitting longer audio into 10-minute WAV chunks, and refuse audio over 30 minutes. Done when: a synthetic 25-minute PCM buffer yields three chunks and a 31-minute one is refused.
- [ ] Commit: `voice: decode voice notes to 16 kHz mono WAV`

**Test checkpoint:** `pnpm exec vitest run test/voice/decode.test.ts` passes and fails if the sample rate written to the header is not 16000.

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
**Chrome:** the shared app shell and form controls from D07 T01 §3

**Build order:**

1. Build `src/web/pages/upload.tsx` against the SPEC. Done when: the page renders with the shell, the drop zone and the type list.
2. Wire it to `POST /api/upload` with htmx. Done when: a successful upload redirects to the report and a refused one shows the server's message.

- [ ] Build the upload page in `src/web/pages/upload.tsx` with the drop zone, file picker button and accepted-types list from the SPEC. Done when: a rendered-page test finds each element by its accessible name. Cheaper substitute: a bare file input without the SPEC layout.
- [ ] Show upload progress and disable the button while sending. Done when: the test sees the busy state attribute during a pending request.
- [ ] Show the 401, 413, 415 and 429 messages from the API in the page's error region. Done when: a test for each status finds the message text.
- [ ] Redirect to `/cases/<id>` on success. Done when: the test follows the redirect.
- [ ] Commit: `web: upload page`

**Test checkpoint:** `pnpm exec vitest run test/web/upload-page.test.ts` passes and fails if the error region is removed.

## Verification

- Each accepted upload type creates a case; the synthetic voice fixture yields transcript and claim evidence; refused files store nothing.
- `pnpm test` passes; `python3 scripts/todo-graph.py validate` and `plan --check` pass.
