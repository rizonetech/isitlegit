# IsItLegit 3-Minute Demo Script (`D09 T02 §3`)

Written for the Meta Global AI Developer Hackathon (Startup track, 26 Oct to 4 Nov 2026). Every product beat is the live deployed service (`app.isitlegit.co.za`), recorded with Playwright (`media/capture/`, capture `2026-11-03T22-23-12`, Worker commit `b86b6957`) and composed with Remotion 4.0.539 (`media/src/videos/Demo.tsx`). Narration is Brian (`eleven_multilingual_v2`, `data/narration/demo.json`, `.co.za` said `"dot C O dot zed A"`). Mastered by `media/tools/master.py` (one fixed gain to about `-14 LUFS`, look-ahead limiter at `-2 dBFS`), `1920 x 1080`, `30 fps`.

## Built-From-Scratch Opening Statement

From zero to production-ready in 9 days: product engineering, brand identity, UI/UX design system, model fine-tuning, evaluation harness, and marketing site, all built from scratch during the hackathon (only the internal TODO and review runner scripts existed beforehand).

## Rules the cut keeps (operator review, 2026-11-04)

Each scene lasts as long as its narration (0.3 s lead, 0.5 s tail), so no line is cut off and no scene runs on in silence. Nothing is drawn on top of the product: captions sit under the browser window and the Meta model at work is named in the window's title bar with the Meta logo. A wait in a capture is shown sped up with its measured time, never cut silently. Nothing is shown that the live service cannot back: no placeholder boards, no `pnpm judge:demo` (not on main), no Hugging Face link (not public), no figure that is not a pinned fact or a sourced statistic.

## Runtime (`2:44`, `164.4 s`)

| Scene | Time | Screen | Meta model on screen |
| ----- | ---- | ------ | -------------------- |
| Intro | `0:00-0:07` | The operator on camera, picture in picture, over the moving background, beside the built-from-scratch line and the attribution | Attribution: Muse Spark, Muse Wonder, SAM 3.1, Muse Voice, Loupe on Muse Glimmer; built with Meta Muse Code |
| 1. Cold open | `0:07-0:15` | Two generated shots and the line "The bank details aren't theirs." | |
| 2. Stakes | `0:15-0:39` | SABRIC 2025 losses chart (R1.09 bn, R1.86 bn, R2.41 bn), then Hawarden v ENS [2024] ZASCA 90 straight after | |
| 3. Live report | `0:39-1:09` | Outlook forward to `check@isitlegit.co.za`, the report filling in (73 s of checks shown sped up), the evidence (E4, E5 hidden text steering an AI; E3 reply address; E6 link), then the verdict and the first advice | Muse Spark 1.3 writes the verdict, every reason citing a finding |
| 4. Identity, suppliers, cases | `1:09-1:31` | `/settings/domains`, `/protect`, `/suppliers`, `/cases` | SAM 3.1 compares the registered logo with mail |
| 5. Monitor | `1:31-1:47` | `/monitor`: 503 lookalikes watched, a live fake Fynbos Freight portal caught | |
| 6. How it works | `1:47-2:11` | The five Meta models inside one safety contract, then the in-Worker voice decoder bench | Muse Spark, Muse Wonder, SAM 3.1, Loupe on Muse Glimmer, Muse Voice |
| 7. Proof | `2:11-2:35` | Loupe 1.0 model card from `media/data/loupe-facts.json`, then the live `/eval` page | Loupe, fine-tuned from Muse Glimmer 30B |
| 8. Close | `2:35-2:44` | Logo, the tagline, `app.isitlegit.co.za`, the capture stamp and the attribution | |

## Narration

1. Cold open: "A supplier you trust sends an invoice. Same logo. Same wording. But the bank details are not theirs."
2. Stakes: "The email is real. It comes from your supplier's own mailbox, so every check your filter runs, passes. In South Africa, digital banking fraud cost two point four one billion rand in twenty twenty-five. And in the Hawarden case, a buyer paid five and a half million rand to a fraudster. The appeal court ruled the loss was theirs: they could have verified the account details."
3. Live report: "Forward it to Is It Legit, and the report fills in live. Before any AI sees the mail, our checks pull out text hidden from the reader, written to steer an AI into calling it safe. They flag a reply address that goes somewhere else, and a link that shows one address and goes to another. Then Muse Spark weighs the evidence and writes the verdict, and every reason it gives cites a finding. The first advice never changes: do not pay until you have called the number in your own records."
4. Identity: "Businesses register who they really are: their trading names, their verified domains, and their logo, for SAM 3.1 to compare against the mail. They list the suppliers they pay, with bank details checked only as match or no match. And every check lands in the organisation's cases console, searchable by anyone on the team."
5. Monitor: "It works both ways. Every morning, the monitor watches over five hundred lookalikes of your domain. Here it caught a live fake Fynbos Freight portal, asking customers to sign in and confirm a new bank account. You see it the same day, so you can warn your customers before they pay."
6. How it works: "Under the hood, five Meta models work inside a strict safety contract. Untrusted content stays inside delimited blocks. Critical evidence sets a deterministic floor no model can lower, and every claim must cite an Evidence ID. Even voice notes are decoded in-Worker: a three-second Opus note in 14 ms, against FFmpeg's 66 ms."
7. Proof: "We hold our own models to the same standard. Loupe, our fine-tune of Muse Glimmer thirty B, caught 392 of 400 lures on held-out pages, with 34 of 600 benign false alarms, in 3.9 s. It names the lure type right only about sixty-three and a half percent of the time, and we publish every evaluation run, good or bad."
8. Close: "Your filter protects your inbox. We protect you from everyone else's. Is It Legit, at app.isitlegit.co.za."

## Voice decoder claim (scene 6)

For voice-note intake inside a Worker, our decoder finishes faster than calling FFmpeg on every input we benchmarked, mainly because it decodes Opus straight to 16 kHz and runs in-process.

On-screen source line: CI run 40606229380 (`bd81843`), medians of 3, FFmpeg 6.1.1-3ubuntu5; FFmpeg's times include starting its process; output quality is not compared.

## Sources

- SABRIC Annual Crime Statistics 2025, p. 7 (all digital banking fraud, not phishing alone).
- Hawarden v Edward Nathan Sonnenbergs Inc [2024] ZASCA 90, Supreme Court of Appeal of South Africa, 10 June 2024.
- Loupe figures: `media/data/loupe-facts.json`, proven by `media/tools/check-facts.py`.

## Rendered files (`media/out2/`, git-ignored)

- `demo-final.mp4`: the submission cut (`cd media && pnpm render:demo`).
- `x-teaser-45s.mp4`: the X teaser, the cold open's line then scenes 3 and 8 (`pnpm render:teaser`).
- `04-judge-getting-started.mp4`: the judge guide on the live service (`pnpm render:04`).

## Optional extended cut (after submission)

If time permits once the 3-minute cut is submitted, a longer cut for YouTube and Facebook can add the Outlook threaded reply, the Check a file upload, and a voice-note case as each is captured live.
