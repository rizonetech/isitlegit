# IsItLegit brand kit

Approved: 2026-10-26 by the operator, in session, from the brand exploration canvas (directions A to E, then A refined).

IsItLegit is a Rizonetech product with its own identity. The logo is a question mark whose dot has become an orange tick: you ask, IsItLegit answers. The mark is engineered to match the Exo 800 wordmark (chosen 2026-10-26 21:46 SAST, option A3): one constant-width stroke at Exo's stem weight, flat cuts, mitred corners and a squared tick, and every tick in the family (seal, app icon, favicons, verdict frames) is drawn the same way. The badge is a round seal reading PROTECTED, shown by businesses registered in the trust network. In the product, the question's dot becomes the verdict.

Everything here was designed and built during the Meta Global AI Developer Hackathon, except `rizonetech/` (Rizonetech's own logo, used for the "by Rizonetech" credit). Regenerate every file with `python3 design/tools/build-brand.py` (requirements in `design/tools/requirements.txt`, plus `rsvg-convert`); never edit the outputs by hand.

## The parts

| Part | Files | Use |
| ---- | ----- | --- |
| Logo | `logo-svg/isitlegit-logo.svg`, `-on-dark.svg`; PNG at 480, 960, 1920 px wide | Site header, README, documents, the video |
| Mark | `logo-svg/isitlegit-mark.svg`, `-on-dark.svg`; PNG at 256, 512, 1024 px | Where the logo does not fit; social avatars |
| Protected seal | `logo-svg/isitlegit-seal-protected.svg`, `-on-dark.svg`; PNG at 256, 512, 1024 px | Trust-network members: websites, invoices, the counterparty reply |
| Protected badge | `logo-svg/isitlegit-badge-protected.svg`; PNG at 480, 960, 1920 px wide, and 104 px tall for the live badge | Email signatures and website footers of protected businesses |
| Not verified badge | `logo-svg/isitlegit-badge-not-verified.svg`; PNG at 480, 960, 1920 px wide, and 104 px tall for the live badge | Served in place of the Protected badge once a business's protection lapses, or for an address no business holds (D05 T02 §7); grey, never red |
| App icon | `web/app-icon.svg`, `web/app-icon-maskable.svg`, `web/apple-touch-icon.png`, `web/icon-192.png`, `web/icon-512.png`, `web/icon-maskable-512.png` | Home-screen and PWA icons |
| Favicon | `web/favicon.svg`, `web/favicon.ico` (16, 32, 48), `web/favicon-16.png`, `-32.png`, `-48.png` | Browser tabs |
| Banners | `web/github-banner.png` (1280 × 640), `web/social-card.png` (1200 × 630), with SVG sources | GitHub social preview, link previews |
| Motion | `motion/question.svg`, `checking.svg`, `checking-animated.svg`, `deciding.svg`, `safe.svg`, `suspicious.svg`, `malicious.svg` | The dot becomes the answer: report page, reply header, demo video |
| Rizonetech | `rizonetech/rizonetech-logo.svg`, `-reversed.svg`, `rizonetech-icon-circle.svg` | The "by Rizonetech" credit only |

The app icon and favicons use the seal's form (orange disc, white centre, ink tick) because it stays legible at 16 px; the logo and mark use the question mark.

## Colour

| Name | Hex | Role |
| ---- | --- | ---- |
| Orange | `#FF4A14` | The brand colour: the tick, "Legit", the seal, accents. Large text and graphics only on white (3.3:1) |
| Orange text | `#CC2E00` | Orange for text and links under 24 px, on white and on the light tints (at least 4.5:1) |
| Ink | `#181519` | Text, the question mark, dark backgrounds |
| Light | `#F1F1F2` | Light backgrounds |
| White | `#FFFFFF` | Backgrounds, reversed marks |

Verdict colours belong to verdicts, never to the brand: safe `#0E7C5B`, suspicious `#B26A00`, malicious `#C8102E`. Each verdict also changes shape (tick, bar, cross), so colour is never the only signal.

## Type

- Exo 800 (ExtraBold) for the logo, converted to outlines in every logo file. Exo 700 for the seal and badge lettering.
- Exo for headings (600 to 800), Exo 2 for body and interface text (400 to 600).
- Both are under the SIL Open Font License 1.1; the fonts and licences are in `design/fonts/`.

## Use it well

- Keep clear space of at least the mark's width around the logo; the logo is never narrower than 120 px, the mark never smaller than 16 px.
- Use the files as they are: no recolouring, stretching, outlines, shadows or rearranged parts.
- On photographs or busy backgrounds, use the logo on a solid Ink or White panel.
- The seal and badge are for registered, verified businesses only; IsItLegit never shows them for a business it has not verified.
- Write the name as IsItLegit in text; isitlegit.co.za for the address.
