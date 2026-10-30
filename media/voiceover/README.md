# Voiceover with a cloned voice (ElevenLabs)

The operator's own voice, cloned with ElevenLabs Instant Voice Cloning, narrates videos 01 to 03 (operator, 2026-10-30). Everything here runs on the operator's machine, not in the cloud session: the API key and the voice sample never leave it, and the cloud session cannot reach ElevenLabs.

The API details below come from ElevenLabs' official Python SDK (`elevenlabs` 2.75.0 on PyPI, read 2026-10-30), because the documentation site was not reachable from the cloud session. Check pricing, plan limits and terms on elevenlabs.io yourself before you start.

## Never commit

- The voice sample recordings. They are biometric data and the repository is public.
- The API key. It lives in your password vault and in your shell's environment only.
- The generated audio. `voiceover.py` writes it to `media/out/voice/`, which git ignores.

## 1. Account and API key

1. Sign in at elevenlabs.io on a plan that includes Instant Voice Cloning (check the current plans; cloning is not on every tier).
2. Create an API key in the ElevenLabs dashboard. If it offers per-key permissions, allow only text to speech and voices.
3. Save the key in your password vault as `ElevenLabs API key (IsItLegit voiceover)`.
4. In the terminal you will run the steps from, load it without typing it into a file:

```bash
read -rs ELEVENLABS_API_KEY && export ELEVENLABS_API_KEY
```

Paste the key and press Enter; nothing is shown and nothing is written to disk or shell history.

## 2. Record the voice sample

1. A quiet room, a decent USB or headset microphone, 15 to 30 cm from your mouth, no music or fans.
2. Read [sample-text.md](sample-text.md) aloud in your normal presenting voice: steady pace, natural, not a performance. It takes about 4 minutes and covers the technical words the videos use, so the clone learns how you say them.
3. Save it as MP3 or WAV outside the repository, for example `~/voice/derick-sample-1.mp3`. Two or three separate takes of the same text are fine.
4. Listen back once: no clipping, no background noise, no long silences.

## 3. Create the cloned voice

Either in the dashboard (add a voice, choose instant voice cloning, upload the recordings) or with the API:

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

What the script sends: only the narration text from `media/data/narration/`, to `POST /v1/text-to-speech/{voice_id}/with-timestamps` with `model_id` `eleven_multilingual_v2`, `output_format` `mp3_44100_128`, and the neighbouring segments' text as `previous_text` and `next_text` so the clips join smoothly. It never sends repository files, client data or anything else.

## 6. Render with the voice

```bash
cd media && pnpm install --frozen-lockfile && pnpm render:01
```

When `media/out/voice/01/manifest.json` exists, each scene plays its clip and stays on screen until the clip ends; without it, the video renders silent as before. Repeat for `02` and `03`.

## 7. Upload

On YouTube, answer "Yes" to altered or synthetic content: the voice is realistic and generated, even though it is yours. Say in the description that the narration is an AI clone of the presenter's own voice.
