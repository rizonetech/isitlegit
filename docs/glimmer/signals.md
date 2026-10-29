# Phishing signals for Loupe

The cues that tell a lure page from a genuine one, drawn from authoritative public guidance, cited and written in our own words (D03 T04 §24). The screener sees only a page's host, its screenshot and its visible text (`buildScreenRequest` in `src/vision/page-screen.ts`), so each cue says what it needs from those, and what the screener must not infer when the evidence is not there: missing evidence is never evidence of fraud. Each cue names its false-positive risk and a paired genuine and lure South African case, described in words, synthetic and brand-neutral (never a working page). The rubric changes no answer field's meaning: the four lure types, the two form flags and confidence keep the definitions in `SCREENER_SYSTEM_PROMPT`. Putting it into the screener's and the teacher's prompts, and measuring it, is D03 T04 §25's.

Researched 2026-10-29 by Claude for IsItLegit; review again by 2027-10-29.

## Sources

A source is accepted only when it is current (published or reviewed within five years, or still served as current advice), applies to judging a web page (not only email or calls), and allows what we do with it: citing it and paraphrasing it with attribution. No accepted source's text is copied here beyond short attributed quotes.

| Id | Title | Publisher | URL | Date | Decision | Reason |
| -- | ----- | --------- | --- | ---- | -------- | ------ |
| S1 | Shopping and paying safely online | UK National Cyber Security Centre | https://www.ncsc.gov.uk/guidance/shopping-online-securely | 2019-01-17, reviewed 2024-07-15 | accepted | Current; its signs are about scam shops and payment pages; Crown copyright under the Open Government Licence v3.0, which allows reuse with acknowledgement (https://www.ncsc.gov.uk/section/about-this-website/terms-and-conditions). |
| S2 | How to spot a scam email, text message or call | UK National Cyber Security Centre | https://www.ncsc.gov.uk/collection/phishing-scams/spot-scams | 2021-11-26, reviewed 2022-09-05 | accepted | Current; its five persuasion signs (authority, urgency, emotion, scarcity, current events) apply to a page's wording as to a message's; Open Government Licence v3.0. |
| S3 | How To Recognize and Avoid Phishing Scams | US Federal Trade Commission | https://consumer.ftc.gov/articles/how-recognize-and-avoid-phishing-scams | 2022-09 | accepted | Current; its signs about requests to confirm or update personal or payment details ("legitimate companies won't email or text with a link to update your payment information"), refund bait and logos that prove nothing apply to the pages such messages lead to; a work of the US federal government, not subject to copyright (17 U.S.C. 105). |
| S4 | Scams and Phishing | South African Revenue Service | https://www.sars.gov.za/targeting-tax-crime/scams-and-phishing/ | updated 2026-08-04 | rejected | Current and applicable, but SARS's terms (https://www.sars.gov.za/terms-and-conditions/) grant only viewing, downloading and printing, not reuse in a commercial product. |
| S5 | How to Stay Safe | South African Banking Risk Information Centre (SABRIC) | https://www.sabric.co.za/how-to-stay-safe/ | 2024-10-05, modified 2026-08-24 | rejected | SABRIC's terms (https://www.sabric.co.za/terms-and-conditions/) forbid copying, reproducing or making commercial use of the site's material without prior written permission. |
| S6 | Recognize and Report Phishing | US Cybersecurity and Infrastructure Security Agency | https://www.cisa.gov/secure-our-world/recognize-and-report-phishing | none shown | rejected | The page is marked "Archived Content", so it is not current advice; its signs (lookalike addresses, urgency, requests for information) are covered by S1 to S3. |
| S7 | How to Avoid Phishing Scams | Anti-Phishing Working Group | https://education.apwg.org/resources/overview/avoid-phishing-scams | not verified | rejected | The page itself could not be read and verified on 2026-10-29; its advice as reported is covered by S1 to S3. |
| S8 | SARS warns public against new scam | South African Government News Agency (SAnews) | https://www.sanews.gov.za/south-africa/sars-warns-public-against-new-scam | 2026-07-30 | rejected | Current and applicable, but SAnews's user policy (https://www.sanews.gov.za/content/user-policy) grants attributed reuse to media; use in a commercial product is not shown to be covered. |
| S9 | Digital fraud | First National Bank (FNB) | https://www.fnb.co.za/security-centre/digital-fraud.html | none shown | rejected | No date is shown, and no reuse terms permitting use in a commercial product were found; what it says FNB never asks for (login details, one-time PINs) is covered by S3. |
| S10 | Security guidance | Standard Bank | https://www.standardbank.co.za/southafrica/personal/about-us/legal/conditions-of-access | not read | rejected | Standard Bank's conditions of access keep all copyright in its website content and require its consent to reproduce it. |
| S11 | Security guidance | Absa | https://www.absa.co.za/ | not read | rejected | Absa's guidance and its website terms could not be read and verified on 2026-10-29. |

## Missing inputs

The screener receives a host (or none), a screenshot (or none, in a text-only request) and the page's visible text (possibly empty or cut off at its limit). When an input is missing, every cue that needs it is unavailable, and its absence counts for nothing either way:

- No host (the request's host is null): C1 and C2 are unavailable; a brand on the page says nothing about its host.
- No screenshot: evidence only a screenshot shows (a logo, the layout, form fields drawn without text) is unavailable; cues that can also read the text still may.
- Empty or cut-off text: wording the text does not hold is unavailable; a cut-off is not a defect of the page.

## Cues

### C1. A brand shown on a host that is not the brand's

- Sources: S1, S3
- Evidence: the host, and the brand the screenshot or text shows (its name or logo); the cue holds only when the host plainly cannot be the brand's: the brand's name inside an unrelated domain, or a free hosting or site-builder subdomain.
- Unavailable: whether an unfamiliar host belongs to the brand, and the whole cue when the request has no host. A host the screener cannot place is not evidence either way; it must not be read as fraud.
- False-positive risk: genuine third-party hosts that show a brand: a payment gateway's own domain naming the shop as the merchant, an identity provider's sign-in page for an employer, a bank's sign-in hosted on its group's domain, a booking engine for a hotel.
- Genuine case: a South African retailer's checkout continues on a payment gateway's domain, which shows the retailer's name as the merchant and the order total.
- Lure case: a page on a free site-builder subdomain shows a South African bank's logo and asks for its online banking username and password.
- Genuine case (new business): a South African catering business opened last month shows its own name and logo on its own new domain, with a contact form for quotes.
- Lure case (new business): a domain made last week shows a South African courier's name and logo and asks for a "redelivery fee" by card.

### C2. A host that imitates a known brand's address

- Sources: S1
- Evidence: the host alone: a known brand's name with letters swapped, doubled or replaced by look-alike characters, or with an added word ("secure", "verify", "update", a country) around it.
- Unavailable: the brand's full list of real domains, and the whole cue when the request has no host. Only an imitation the screener can see in the host counts; a host that is merely unfamiliar does not.
- False-positive risk: genuine variants: a brand's country domains (`.co.za`, `.com`), its campaign domains, abbreviations and group names.
- Genuine case: a South African insurer's sign-in page on its own `.co.za` domain whose name is an abbreviation of the insurer's full name.
- Lure case: a sign-in page whose host spells a South African bank's name with a digit in place of a letter and adds "secure" in front.

### C3. Credentials, card details or one-time PINs asked for where the brand would not ask

- Sources: S3
- Evidence: the form fields the screenshot and text show (username, password, card number, CVV, PIN, one-time PIN), together with C1 or C2, or with wording that ties the form to a message ("confirm your details to keep your account").
- Unavailable: how the visitor reached the page (a link in an email or SMS) and whether they asked to sign in. A sign-in form on its own is never a lure: that is every genuine sign-in page.
- False-positive risk: the brand's own sign-in and payment pages, including a genuine one-time PIN step during a real payment.
- Genuine case: a South African bank's online banking sign-in on its own domain asks for a username and password, then a one-time PIN sent to the registered number.
- Lure case: a page with a bank's branding on an unrelated host asks for the card number, CVV, the card PIN and the one-time PIN together "to keep your account active".
- Genuine case (plain form): an unbranded form on an unfamiliar host collects a name and email address for a school's newsletter, and nothing more.
- Lure case (plain form): an unbranded page on an unfamiliar host asks for an email address and that address's password "to view a shared document".

### C4. Account or payment details to "confirm" or "update" off the organisation's own site

- Sources: S3
- Evidence: the host and the text and form fields: a page that is not the organisation's own (C1 or C2) asking the visitor to confirm, update or verify account, card or payment details, or one-time PINs, for an organisation it names (S3: legitimate companies do not send a link to update payment information).
- Unavailable: whether the page is the organisation's own when the host cannot be placed, and how the visitor reached it. On the organisation's own site, these requests are its normal sign-in, registration and payment steps, not this cue.
- False-positive risk: the organisation's own pages where it does ask: a revenue service's own eFiling registration (which sends a one-time PIN to the registered phone and asks for it), a bank's own sign-in, a payment step at a genuine checkout, an account settings page.
- Genuine case: a national revenue service's own eFiling registration page sends a one-time PIN to the taxpayer's registered phone and asks for it to finish registering.
- Lure case: a page with a national revenue service's branding on an unrelated host says a refund is waiting and asks for the taxpayer's bank card number, banking PIN and one-time PIN to "release" it.

### C5. Pressure: urgency, threats, fines or suspension

- Sources: S2
- Evidence: the text: a short deadline, a threat (an account closed, a fine, legal action, a service cut), or a demand for action now.
- Unavailable: whether the threat is true. Pressure alone is never decisive: it raises the weight of C1 to C4, it does not stand in for them.
- False-positive risk: genuine notices: a municipality's overdue-account page, a bank's real fraud-alert page, a licence renewal reminder.
- Genuine case: a metropolitan municipality's e-services page on its own domain shows an overdue rates balance and the date after which interest is added.
- Lure case: a page with a bank's branding on an unrelated host says the account "will be suspended within 24 hours" unless the visitor signs in now.

### C6. Offers too good to be true, and scarcity

- Sources: S1, S2
- Evidence: the text and screenshot: prices the page itself shows as far below the usual, prizes, free money, or stock or time said to be about to run out. No discount threshold is sourced; how deep a discount must be is left to the page's other cues.
- Unavailable: what the item usually costs, when the page does not show it; a low price on its own is weak evidence.
- False-positive risk: genuine sales, including deep clearance discounts, genuine competitions on a brand's own domain, genuine vouchers.
- Genuine case: a South African clothing retailer's own domain clears end-of-season stock at 70 percent off, through its usual checkout with card payment.
- Lure case: an online shop on an unfamiliar host sells current-model phones at 85 percent off, "only 3 left", payable only by bank transfer.

### C7. Payment outside a shop's own payment gateway

- Sources: S1
- Evidence: the text: payment only by direct bank transfer, by voucher, gift card or cryptocurrency, or "pay the courier or agent first", in place of the shop's own checkout.
- Unavailable: whether the account belongs to the seller. A bank transfer, even the only option and even to a person's own name, is not evidence on its own.
- False-positive risk: genuine small South African businesses and sole traders that take EFT only, often to the owner's own account, which is common.
- Genuine case: a sole trader's craft page takes EFT only, into an account in the owner's own name that the page shows with the owner's contact details, for handmade items at their usual prices.
- Lure case: a page selling furniture at a fraction of the usual price accepts payment only by EFT to an unrelated individual's account, with the order released "once proof of payment is sent on WhatsApp".

### C8. Refund, prize or government payment bait

- Sources: S3
- Evidence: the text: an unexpected refund, grant, prize or "unclaimed funds" to be released once the visitor enters personal, banking or card details.
- Unavailable: whether the visitor is due a payment. A page about refunds is not a lure on that alone.
- False-positive risk: the revenue service's own pages explaining refunds, a social grant agency's own application pages, a genuine competition's claim page on the brand's domain.
- Genuine case: a social grant agency's own application page on its own domain asks for the applicant's ID number and bank account details, so the grant can be paid into that account.
- Lure case: a page with the revenue service's branding on an unrelated host says a refund is waiting and asks for card details and a one-time PIN to pay it.

### C9. Poor spelling, grammar or design (weak)

- Sources: S2
- Evidence: the text and screenshot: misspelled brand names, broken grammar, blurred or misplaced logos.
- Unavailable: the logo and layout part with no screenshot, and the spelling part where the text is empty or cut off (a cut-off is not a defect). S2 notes these clues are less reliable now, and polished lures are common: this cue is never decisive and never a reason on its own, and its absence is not evidence of a genuine page.
- False-positive risk: genuine small businesses' and municipalities' pages with typos or dated design.
- Genuine case: a small town municipality's own site with dated design and a typo in a notice, showing its rates contact details.
- Lure case: a bank-branded sign-in page with a misspelled bank name, combined with C1 and C3.

## Out of reach

Cues the guidance gives that need what the screener never receives; the screener must not infer them, and their absence is not evidence:

- How the visitor reached the page (a link in an email, SMS, WhatsApp or QR code; S2, S3).
- An organisation's own statements of what it never asks for (S4, S8 and S9 state them for SARS and FNB), until a source whose terms allow our use states them.
- The sender of a message and its address (S2, S3).
- A domain's age, registrant or ownership.
- The browser's padlock and certificate details (the screenshot holds the page, not the browser).
- Where a link on the page would lead (no hover, no clicks).
- A host given as an IP address: the request carries only a host name or none (`buildScreenRequest`), so this cue the guidance gives is out of reach here.
