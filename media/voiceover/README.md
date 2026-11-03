# Voiceover in the operator's voice (ElevenLabs)

The operator's own voice, set up as a custom ElevenLabs voice, narrates videos 01 to 03 (operator, 2026-10-30). Everything here runs on the operator's machine, not in the cloud session: the API key and the voice sample never leave it, and the cloud session cannot reach ElevenLabs.

The API details below come from ElevenLabs' official Python SDK (`elevenlabs` 2.75.0 on PyPI, read 2026-10-30), because the documentation site was not reachable from the cloud session. Check pricing, plan limits and terms on elevenlabs.io yourself before you start.

## Never commit

- The voice sample recordings. They are biometric data and the repository is public.
- The API key. It lives in your password vault and in your shell's environment only.
- The generated audio. `voiceover.py` writes it to `media/out/voice/`, which git ignores.

## 1. Account and API key

1. Sign in at elevenlabs.io on a plan that includes custom voices made from your own recordings (check the current plans; not every tier has them).
2. Create an API key in the ElevenLabs dashboard. If it offers per-key permissions, allow only text to speech and voices.
3. Save the key in the Conclave vault item `ElevenLabs API key (IsItLegit voiceover)`, field `credential`, and the voice ID (step 3) in its `voice_id` field.
4. In the terminal you will run the steps from, load it without typing it into a file:

```bash
read -rs ELEVENLABS_API_KEY && export ELEVENLABS_API_KEY
```

Paste the key and press Enter; nothing is shown and nothing is written to disk or shell history.

## 2. Record the voice sample

1. A quiet room, a decent USB or headset microphone, 15 to 30 cm from your mouth, no music or fans.
2. Read [sample-text.md](sample-text.md) aloud in your normal presenting voice: steady pace, natural, not a performance. It takes about 4 minutes and covers the technical words the videos use, so the voice learns how you say them.
3. Save it as MP3 or WAV outside the repository, for example `~/voice/derick-sample-1.mp3`. Two or three separate takes of the same text are fine.
4. Listen back once: no clipping, no background noise, no long silences.

## 3. Create the voice

Either in the dashboard (add a voice from your own recordings and upload them) or with the API:

```bash
curl -sS -X POST https://api.elevenlabs.io/v1/voices/add -H "xi-api-key: $ELEVENLABS_API_KEY" -F "name=Derick Payne" -F "description=IsItLegit channel narration" -F "remove_background_noise=false" -F "files=@$HOME/voice/derick-sample-1.mp3"
```

The reply is JSON with `voice_id` and `requires_verification`. If `requires_verification` is `true`, finish the verification ElevenLabs asks for in the dashboard before you continue. Keep `remove_background_noise=false` for a clean recording; the SDK notes it can make a clean sample worse.

Export the voice ID for the next steps (it is an identifier, not a secret):

```bash
export ELEVENLABS_VOICE_ID=<the voice_id from the reply>
```

## 4. Test one sentence

```bash
curl -sS -X POST "https://api.elevenlabs.io/v1/text-to-speech/$ELEVENLABS_VOICE_ID?output_format=mp3_44100_128" -H "xi-api-key: $ELEVENLABS_API_KEY" -H "Content-Type: application/json" -d '{"text": "Forward a suspicious email. Get a verdict with the evidence.", "model_id": "eleven_multilingual_v2"}' --output ~/voice/test.mp3
```

Listen to `~/voice/test.mp3`. If it does not sound like you, record a longer or cleaner sample and repeat step 3.

## 5. Generate the narration

From the repository root on the media branch, with both variables exported:

```bash
python3 media/tools/voiceover.py 01 --dry-run
```

The dry run sends nothing: it lists every segment, the total characters (which is what ElevenLabs bills) and where the audio will go. Then:

```bash
python3 media/tools/voiceover.py 01
```

It shows what it will send and asks once before sending. Each scene's narration becomes `media/out/voice/01/NN.mp3`, plus `manifest.json` with each clip's length. A clip whose text has not changed is not generated again, so a re-run only pays for edited lines. Repeat for `02` and `03`.

The narration is `media/data/narration/<video>.json`: one segment per sequence (the title, every scene, the close), each labelled with its scene; `test_voice_index.py` keeps the labels in step with the storyboards. Names the voice misreads are fixed once in `media/data/pronunciation.json` (written form to spoken form, for example `IsItLegit` to `Is It Legit`), applied to every line before sending, so the narration keeps the normal spelling and a new line is said the same way; a changed entry re-makes only the clips that use it. A segment may name a pinned `{fact.key}`, filled in before sending; a `{stats.x}` is refused, because it changes with every commit and would re-bill the clip.

What the script sends: only the narration text from `media/data/narration/`, facts filled in, to `POST /v1/text-to-speech/{voice_id}/with-timestamps` with `model_id` `eleven_multilingual_v2`, `output_format` `mp3_44100_128`, and the neighbouring segments' text as `previous_text` and `next_text` so the clips join smoothly. It never sends repository files, client data or anything else.

## 6. Music and sound effects

```bash
python3 media/tools/sound.py --dry-run
python3 media/tools/sound.py
```

It sends only the prompts and lengths in `media/data/sound.json` (one channel bed through Eleven Music, instrumental, and a title swell and chapter whoosh through Sound Effects) and writes `media/out/sound/`. Unchanged entries are reused. Edit a prompt and re-run to replace one file; the videos pick it up on the next render.

## 7. Render with the voice

```bash
cd media && pnpm install --frozen-lockfile && pnpm render:01
```

Every render first runs `tools/voice-index.py`, which writes the git-ignored `src/data/voice.ts` from `media/out/voice/<video>/manifest.json`. When a video has a manifest, each scene plays its clip half a second in and stays on screen until the clip has ended; without one, the video renders silent at its reading pace. A manifest that misses a segment, or whose clip says other words than the narration file now does, stops the render and names the `voiceover.py` run that fixes it. Each render is normalised to -14 LUFS after Remotion writes it (`out/raw/` to `out/`). Repeat for `02` and `03`.

## 8. Upload

On YouTube, answer "Yes" to altered or synthetic content: the voice is realistic and generated, even though it is yours. The videos and their descriptions do not describe how the narration was made (operator, 2026-10-31).
