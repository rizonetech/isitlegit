# Demo video: generated shots

Prompts for the generated footage in the demo's cold open and background plates (`docs/specs/2026-10-31-demo-video-design.md`). The operator generates them; the media lane composites the real product, text and Fynbos Freight's logo on top in Remotion. Written 2026-10-31.

Rules every prompt carries: no legible text on any screen (generated text garbles; real text is added in Remotion), no real brands or logos, no dialogue (our narration and music go over it), 16:9. AI-generated content is disclosed once at upload, never per shot.

Cold-open line, over shot 4: "It looks exactly like your supplier. The bank details aren't theirs."

## Video: Google Veo (the newest Veo available to you, 16:9, 1080p, 8 s; we use about 3 s of each)

### Shot 1: the road (0:00 to 0:03)

```
Cinematic aerial drone shot at golden hour, slowly tracking a single white long-haul freight truck with a plain unbranded trailer driving along an empty two-lane highway through the South African Karoo, flat scrubland and distant flat-topped mountains, long shadows, warm low sun, light haze. Smooth, steady, slow forward camera movement. Photorealistic, shot on a cinema camera, shallow atmospheric depth. No text, no logos, no signage, no people visible. Ambient wind and distant engine sound only, no music, no dialogue.
```

### Shot 2: the attacker (0:03 to 0:06)

```
Dark, moody close-up in a dim room at night: a person's hands typing on a laptop keyboard, face never shown, the only light the cool blue glow of the screen on the hands and keyboard. On the screen, out of focus, an email being written with a document attached; nothing on the screen is readable. Slow push-in towards the screen. Tense, quiet, cinematic, photorealistic, subtle film grain, shallow depth of field. No legible text anywhere, no logos, no brand names. Ambient room tone and soft keyboard clicks only, no music, no dialogue.
```

### Shot 3: the inbox (0:06 to 0:09)

```
Bright, ordinary morning in a small freight company's office in Cape Town: an accounts clerk at a tidy desk with a laptop, a mug of coffee, paper files; through the window behind, a yard with parked unbranded trucks and, far away, the soft outline of a flat-topped mountain. A new email notification appears on the laptop screen and the clerk leans in to read it. Camera at shoulder height, gentle handheld, natural daylight, photorealistic. The screen content is soft and unreadable. No legible text, no logos, no brand names. Ambient office sounds only, no music, no dialogue.
```

### Shot 4: the moment before paying (0:09 to 0:12)

```
Extreme close-up, macro, shallow depth of field: a finger hovering just above a laptop trackpad, about to click; the laptop screen behind is a soft glow of an online banking payment page, completely unreadable. Very slow push-in, a moment of hesitation, the finger stops. Quiet, tense, cinematic, photorealistic, warm indoor light. No legible text, no logos, no numbers visible. Silence with a faint heartbeat-like low pulse, no music, no dialogue.
```

## Stills: OpenAI image generation (the newest image model in ChatGPT, landscape 1536 x 1024; we upscale and crop to 1920 x 1080)

### Plate A: behind the South African charts (0:12 to 0:25)

```
A dark, elegant data-visualisation backdrop: the outline of South Africa seen from above at night, drawn as a fine glowing contour on a near-black background, with thin luminous network lines and small points of light radiating between the major cities, a few lines glowing a warning red-orange. Minimal, premium, lots of empty dark space on the left half for charts. No text, no labels, no numbers, no logos, no borders. Photorealistic lighting, subtle depth, 16:9 landscape.
```

### Plate B: behind the court-case card

```
A quiet, serious still of an empty South African courtroom in soft daylight: dark wooden benches, the judge's bench in the background slightly out of focus, a single bound legal document and a pen resting on a counsel's table in the foreground. Calm, weighty atmosphere, muted warm tones, shallow depth of field, photorealistic, plenty of empty space on the right for a text card. No people, no legible text, no flags, no coats of arms, no logos. 16:9 landscape.
```

### Plate C: behind the closing card

```
A calm wide shot at dawn over the Cape Town harbour and a freight yard, shipping containers and unbranded trucks small in the frame, the city and a flat-topped mountain soft in the background mist, first warm light breaking through. Hopeful, quiet, cinematic, photorealistic, generous empty sky in the upper half for a title. No text, no logos, no brand names, no readable signs. 16:9 landscape.
```

## The background for all four videos (demo, 01, 02, 03)

Replaces the drifting-glow `Backdrop` in `src/brand.tsx`. One 8 s seamless loop, plus one still as the fallback and for thumbnails. Calm and dark, so white text and the real product stay the focus: nothing brighter than the text, no hard edges, no centre of attention, slow movement only. Brand colours: near-black `#0B0A0D` ground, one orange `#FF4A14` accent used sparingly.

### Loop (Google Veo, 16:9, 1080p, 8 s; use the loop or first-and-last-frame option if your Veo offers it)

```
Abstract, slow, premium motion background on a near-black ground. Extremely fine, soft luminous threads and tiny points of light drifting slowly through deep dark space, forming faint flowing curves like a quiet network or a slow tide, with a very subtle depth of field so some strands are out of focus. A single warm orange-red accent colour (hex FF4A14) appears only as a few thin threads and a faint soft glow in the lower right; everything else is deep charcoal and faint cool grey. Low contrast overall, the brightest point is dim. The centre and the left two thirds stay dark and calm so text can sit on top. Very slow, steady, hypnotic drift, no sudden changes, no cuts, no camera shake. The last frame matches the first so it loops seamlessly. No text, no logos, no letters, no numbers, no symbols, no people, no objects. Silent.
```

### Still (OpenAI image generation, landscape 1536 x 1024)

```
Abstract premium dark background: a near-black ground with extremely fine, soft luminous threads and tiny points of light flowing in faint curves like a quiet network, slight depth of field, subtle fine grain. One warm orange-red accent (hex FF4A14) in a few thin threads and a faint glow in the lower right only; the rest deep charcoal and faint cool grey. Very low contrast, nothing bright, the centre and left two thirds calm and empty so text can sit on top. No text, no logos, no symbols, no people, no objects, no borders. 16:9 landscape.
```

Both come back into `~/isitlegit-data/media/generated/` as `background-loop.mp4` and `background.png`. I dim and tint them in Remotion (and keep the glow, if you like the mix), so a slightly brighter result than asked for is fine, a busier one is not. If it distracts when text sits over it, tell me and I add the word "even calmer" to the prompt.

## What to send back

The raw files (the 8 s clips and the PNGs), in a folder outside the repository, for example `~/isitlegit-data/media/generated/`; the media lane picks the best 3 s of each clip and grades them to the brand. Generated files are never committed.
