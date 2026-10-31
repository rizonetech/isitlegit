# Voice sample text

Read this aloud for the ElevenLabs voice (about 5 minutes). It has three parts, so the voice learns three ways you speak: the calm technical narration of videos 01 to 03, the tense opening of the demo, and the warm close. Steady pace, natural pauses at full stops, no need to be perfect: a stumble you correct naturally is fine. Record each part as its own take, in one sitting, 15 to 30 cm from the microphone, in a quiet room.

---

## Part 1: calm and clear (the technical videos)

Hi, I'm Derick Payne, founder of Rizonetech, an IT company in George, South Africa, that looks after small businesses.

IsItLegit is a phishing, invoice fraud and impersonation checker. You forward a suspicious email, and you get a verdict with the evidence. Safe, suspicious or malicious, the top reasons, and what to do first.

Under the hood, it is one Cloudflare Worker written in TypeScript. Mail arrives through Email Routing, and Cloudflare Workflows runs the investigation one step at a time. Evidence lives in D1, R2 and KV, and every call to Meta's models goes through AI Gateway.

The checks read the headers first: SPF, DKIM, DMARC and ARC, the Reply-To and the Return-Path. A lookalike check compares domains using Unicode confusable skeletons and edit distance. Domain ages come from RDAP.

Meta's models each do one job. Muse Spark reads the mail and writes the cited verdict. Muse Wonder walks a suspicious page in a contained browser. SAM three point one compares logos and stamps. And Loupe, our LoRA fine-tune of Muse Glimmer thirty B, screens lookalike pages cheaply.

The way we build it matters too. One operator directs nine AI lanes and a coordinator. Each lane works its own domains, on its own branch, around the clock. Every section is reviewed by a different model family, and nothing ships without a receipt.

Some numbers, read naturally: twenty-five mebibytes, twenty-four hours, one thousand eight hundred seconds, fourteen days, ninety-five point eight percent, three hundred and ninety-two of four hundred, thirty-four of six hundred, one hundred and thirty point seven seconds, one hundred and forty-one gigabytes, a million eighty-five thousand, eight hundred and ninety-six rand, two point four billion rand.

And some words worth getting right: Remotion, Wrangler, Vitest, Biome, pnpm, Hono, htmx, Better Auth, Astro, POPIA, zod, Fireworks, LoRA, H200, idempotent, deterministic, adversarial, impersonation, SABRIC, Interpol, Hawarden, ZASCA, Fynbos Freight, Karoo, Stellenbosch, Gqeberha, Rizonetech.

## Part 2: quiet and tense (the demo's opening)

Slower, lower, close to the microphone, almost a whisper of a warning. Leave a full second after each line.

Tuesday morning. A supplier you trust sends an invoice.

Same logo. Same wording. Same person's name at the bottom.

It looks exactly like your supplier. The bank details aren't theirs.

And in South Africa, this is not rare. It is the fastest growing way to lose money. Billions of rand lost to banking crime in a year, and the account that gets paid belongs to a stranger.

Nobody is hacked. Nobody clicks a bad link. One person simply pays the wrong account, and the court says it was their job to check.

## Part 3: warm and confident (the close)

Back to your normal, friendly voice, a little brighter.

This is IsItLegit. Forward the email, and in seconds you know whether to trust it, and why.

Everything you saw was recorded live, on the real service. The models are Meta's, and every verdict shows its evidence.

We built it because our own clients get these emails every single day. Now they have somewhere to send them.

Thanks for watching. The code is on GitHub at rizonetech slash isitlegit, and the product is at app dot isitlegit dot co dot za.
