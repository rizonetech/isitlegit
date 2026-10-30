# 02 IsItLegit in 60 seconds

One suspicious email followed through the system. 1920 × 1080, 30 fps, on-screen text, no voiceover unless the operator records one.

The architecture is drawn as a diagram, labelled as one; it shows no product screens, so it never stands in for the live demo.

## Scenes

| Scene | Seconds | On screen | Visual |
| ----- | ------- | --------- | ------ |
| 1 Title | 4 | IsItLegit in 60 seconds. Forward a suspicious email. Get a verdict with the evidence. | Logo on Ink |
| 2 The problem | 7 | An invoice from a real supplier. The bank details quietly changed. | An invoice card whose account number flickers to a new one |
| 3 Intake | 7 | Forward it to check@isitlegit.co.za. | The email flies into a Cloudflare Email Routing box |
| 4 The investigation | 8 | One Cloudflare Worker runs the investigation as Workflows steps. | Steps light up in turn: headers, domains, links, attachments |
| 5 Meta's models | 16 | Each Meta model does one job. Muse Spark reads the mail and evidence and writes the cited verdict. Muse Wonder walks the landing page in a contained browser, with canary values only. SAM 3.1 compares logos, stamps and signatures. Muse Voice Transcribe turns voice notes into text. All through AI Gateway, with store: false. | Four model cards, each linked to the step it serves |
| 6 Evidence | 6 | Every claim cites evidence, kept in D1, R2 and KV. Pages render in Browser Run. | Evidence chips (header, domain, screenshot, logo crop, invoice field) drop into storage |
| 7 The verdict | 8 | A plain-language verdict in minutes: the top three reasons and what to do now. | The motion marks: question, checking, deciding, then safe, suspicious, malicious |
| 8 Close | 4 | Built at the Meta Global AI Developer Hackathon. github.com/rizonetech/isitlegit | Logo, link, "by Rizonetech" |

## Sources

Model roles: `README.md` "How it uses Meta's models". Services: `README.md` "How it is built" and `docs/specs/2026-10-26-tech-stack-design.md`. Verdict marks: `design/brand/motion/`.

## Open questions for the operator

- Include Muse Image (the synthetic doctored-document test set), or keep to the four models a user's email touches?
- Voiceover or text only?
