# Voice sample text

Read this aloud in your normal presenting voice for the voice clone (about 4 minutes). Steady pace, natural pauses at full stops, no need to be perfect: a stumble you correct naturally is fine.

---

Hi, I'm Derick Payne, founder of Rizonetech, an IT company in George, South Africa that looks after small businesses.

This channel is where I show what I build. Right now that is IsItLegit: you forward a suspicious email, and you get a verdict with the evidence. Safe, suspicious or malicious, the top three reasons, and what to do now.

The costliest case we see is invoice fraud. An invoice arrives from a real supplier, and the only thing that changed is the bank account. Nobody notices until the money is gone. That is the problem we set out to solve.

Under the hood, IsItLegit is one Cloudflare Worker written in TypeScript. Mail arrives through Email Routing, and Cloudflare Workflows runs the investigation step by step: admit, parse, checks, verdict, store, reply and finish. Evidence lives in D1, R2 and KV, and every call to Meta's models goes through AI Gateway, with store set to false.

The checks read the headers first: SPF, DKIM, DMARC and ARC, the Reply-To and the Return-Path. A lookalike check compares domains using Unicode confusable skeletons and edit distance. Reputation comes from Google Web Risk and Cloudflare's one dot one dot one dot two resolver over DNS over HTTPS.

Meta's models each do one job. Muse Spark reads the mail and the evidence, and writes the cited verdict. Muse Wonder walks a suspicious landing page in a contained browser, typing canary credentials, never real ones. SAM three point one finds and compares logos, stamps and signatures. Muse Voice Transcribe turns voice notes into text. And Loupe, our LoRA fine-tune of Muse Glimmer thirty B, screens lookalike pages cheaply.

The way we build it matters too. One operator directs five lanes of AI developers: the coordinator, the checks lane, the app lane, the Glimmer lane and the media lane. Each lane works its own domains, on its own branch, around the clock. The plan is a graph of small sections, two hundred and ninety-three of them, and nothing ships without a receipt.

Every section is reviewed by a different model family. GPT-6 Astra runs adversarial rounds at high, medium and low effort, and the loop stops at the first round with no P1 or P2 finding. Then Muse Wonder gives one final review. Only then does the stamp command mark the row as done.

Some numbers, read naturally: twenty-five mebibytes, twenty-four hours, one thousand, eight hundred seconds, fourteen days, fifty cases a day, ninety-five percent, two percent, one hundred and twenty-nine thousand, eight hundred and ninety-two pages.

And some words worth getting right: Remotion, Wrangler, Vitest, Biome, pnpm, Hono, htmx, Better Auth, Astro, POPIA, zod, Fireworks, LoRA, H100, idempotent, deterministic, adversarial, impersonation.

Thanks for watching. The code is on GitHub at rizonetech slash isitlegit.
