// Every product claim the marketing site makes, with every section needed to back it (D07 T06 §3). Pages render claims only
// through `Claim.astro`, by id, so a claim cannot reach a page without its entry here; `site/test/claims.test.ts`
// checks every rendered claim and every entry, and §6's deploy refuses while an owner is unstamped.
export const claims = {
  // Home (D07 T06 §2)
  "home.phishing": {
    text: "Muse Wonder opens the link in a sealed browser and shows you exactly where your password would have gone.",
    owners: ["D04 T02 §4"],
  },
  "home.invoice": {
    text: "We compare it with what that supplier really uses and tell you to phone first.",
    owners: ["D06 T01 §3"],
  },
  "home.impersonation": { text: "Protected businesses hear about it the moment someone checks a fake.", owners: ["D05 T02 §4"] },
  "home.model.spark": {
    text: "Reads the email, the invoice and the landing page, then weighs the evidence and writes the cited verdict.",
    owners: ["D04 T01 §4", "D04 T01 §5"],
  },
  "home.model.wonder": { text: "Walks the suspicious link in a contained browser, typing only harmless test values.", owners: ["D04 T02 §4"] },
  "home.model.sam": { text: "Finds logos, stamps and signatures and compares them with the real ones.", owners: ["D03 T03 §3"] },
  "home.model.voice": { text: 'Turns a voice note from a "director" into words we can check.', owners: ["D01 T03 §4"] },
  "home.protect": {
    text: "When someone forwards mail that claims to be you, we compare it with the truth, tell them, and alert you. Your website seal only shows on your own domain.",
    owners: ["D05 T02 §9"],
  },
  // How it works (D07 T06 §3)
  "how.check.sender": {
    text: "SPF, DKIM and DMARC as recorded by your own mail server, display name tricks, a different Reply-To, and whether anyone at your business has checked mail from this sender with us before.",
    owners: ["D02 T02 §5"],
  },
  "how.check.links": {
    text: "Swapped letters and added words, how old the domain is, where every link really lands, QR codes in images, and whether Google Web Risk lists the exact link.",
    owners: ["D02 T03 §2", "D02 T03 §4", "D02 T07 §1", "D02 T07 §2", "D02 T07 §4", "D02 T06 §1"],
  },
  "how.check.attachments": {
    text: "Files pretending to be something else, HTML smuggling, macros, and words hidden from you but aimed at AI filters. An honest sender has no reason to hide words from the reader.",
    owners: ["D02 T04 §2"],
  },
  "how.spark": {
    text: "The email, its PDFs and its landing pages are rendered as pictures. Muse Spark says which brand it claims to be, what it wants you to do and how hard it pushes.",
    owners: ["D03 T02 §3"],
  },
  "how.sam": {
    text: "SAM 3.1 cuts out every logo, stamp and signature. Each crop is compared with the real brand's logo, or with the logo a protected business registered.",
    owners: ["D03 T03 §3"],
  },
  "how.wonder": {
    text: "In a sealed browser, Muse Wonder clicks through the lure the way a victim would and types made-up test values, never real ones, to show where a password would have gone.",
    owners: ["D04 T02 §4"],
  },
  "how.voice": {
    text: "Muse Voice Transcribe turns a voice note into text, then Muse Spark pulls out the request and who the caller claims to be. It supports English but not Afrikaans, isiZulu or isiXhosa yet, and we do not claim to detect voice cloning.",
    owners: ["D01 T03 §4"],
  },
  "how.verdict": {
    text: "Muse Spark weighs all the evidence and writes the verdict. A changed bank account or a password form on a lookalike domain sets a floor the model cannot talk down.",
    owners: ["D04 T01 §1", "D04 T01 §4", "D04 T01 §5"],
  },
  "how.reply": {
    text: "A reply to your forward with the verdict, the top three reasons and what to do now, plus a link to the full report. Report links are signed and expire after 7 days.",
    owners: ["D01 T01 §8"],
  },
  "how.retention": {
    text: "The email and its attachments are deleted after 30 days. The case summary and evidence stay so your history keeps working.",
    owners: ["D01 T01 §2"],
  },
  "how.meta": {
    text: "We call Meta's Model API with standard model IDs and store: false on every request, and never in the mode that allows training on what we send.",
    owners: ["D03 T01 §1"],
  },
  "how.inline": {
    text: "A normal forward is still checked, but without the original's headers the sender checks cannot run, and the reply tells you so.",
    owners: ["D01 T01 §4"],
  },
  // Invoice fraud (D07 T06 §3)
  "invoice.read": {
    text: "Muse Spark reads every page of the PDF and extracts the supplier, bank, account holder, account number, branch code, amount and due date.",
    owners: ["D06 T01 §1"],
  },
  "invoice.ledger": {
    text: 'Your supplier ledger holds each supplier\'s domains and verified account. A different account, a new domain or "we have changed banks" wording all raise the alarm.',
    owners: ["D06 T01 §3"],
  },
  "invoice.phone": {
    text: "The report always gives the same instruction: confirm on the number in your own records. Protect members can also have us ask the supplier's registered finance contact.",
    owners: ["D05 T03 §1"],
  },
  "invoice.pop": {
    text: "Upload the PDF or screenshot on its own and we look for the signs of editing.",
    owners: ["D06 T02 §2"],
  },
  "invoice.limit": {
    text: "A check can show a document is likely doctored. It cannot prove that money was paid, so the report always says: confirm the money has cleared in your own banking app before you release goods.",
    owners: ["D06 T02 §2"],
  },
  "invoice.closing": {
    text: "Add your suppliers once and every invoice is compared automatically.",
    owners: ["D06 T01 §1", "D06 T01 §3", "D06 T01 §4"],
  },
  "how.cites": { text: "the verdict may only cite evidence that exists", owners: ["D04 T01 §5"] },
  "home.step3": {
    text: "Safe, suspicious or malicious, the top three reasons, and what to do now. Every reason links to its evidence.",
    owners: ["D04 T01 §5", "D07 T03 §1"],
  },
  "how.intro": { text: "We run checks and four Meta models over it", owners: ["D04 T01 §4"] },
  "how.strip": { text: "We investigate the sender, links, attachments and pictures", owners: ["D02 T02 §2", "D02 T07 §2", "D02 T04 §2", "D03 T02 §3"] },
  "how.size": {
    text: "We can check a message of up to 25 MB, by mail or upload. A bigger one is refused with \"Message too large\" and no verdict.",
    owners: ["D01 T01 §3", "D01 T03 §1"],
  },
  "invoice.catch": {
    text: "It reads the invoice, pulls out the bank details and compares them with the account your supplier really uses. A mismatch is critical evidence, whatever else the email gets right.",
    owners: ["D06 T01 §1", "D06 T01 §3"],
  },
  "invoice.sign.edits": { text: "Edits saved after the document was created", owners: ["D06 T02 §1"] },
  "invoice.sign.fonts": { text: "Mixed fonts in the amount or account fields", owners: ["D06 T02 §1"] },
  "invoice.sign.dates": { text: "Dates in the file that disagree with the page", owners: ["D06 T02 §1"] },
  "invoice.sign.layout": { text: "A layout that differs from that bank's real notices", owners: ["D06 T02 §2"] },
  // Pricing (D07 T06 §4)
  "pricing.free.verdicts": {
    text: "Verdicts on mail your team forwards from its verified address or domain, with the evidence",
    owners: ["D01 T01 §3"],
  },
  "pricing.free.cap": { text: "Up to 5 checks a day per organisation", owners: ["D07 T02 §4", "D07 T08 §8"] },
  "pricing.protect.team": { text: "Everything in Free check, for your whole team", owners: ["D07 T02 §3"] },
  "pricing.protect.identity": {
    text: "Protected identity, website seal and signature badge",
    owners: ["D05 T01 §1", "D05 T02 §7", "D05 T02 §9"],
  },
  "pricing.protect.alerts": {
    text: "Impersonation alerts and the daily website monitor",
    owners: ["D05 T02 §4", "D05 T04 §2", "D05 T04 §5"],
  },
  "pricing.protect.bank": { text: "Invoice bank-change detection with your supplier ledger", owners: ["D06 T01 §3", "D06 T01 §4"] },
  "pricing.protect.verify": { text: "Bank verification with your finance contact", owners: ["D05 T03 §1"] },
  "pricing.protect.pop": { text: "Payment document check for invoices and proofs of payment", owners: ["D06 T02 §1", "D06 T02 §2"] },
  "pricing.trial.after": { text: "After the trial your organisation keeps Free check until billing starts.", owners: ["D07 T02 §8"] },
  "pricing.trial.join": { text: "New organisations get a 14-day trial with every feature unlocked.", owners: ["D07 T02 §8"] },
  // Privacy and POPIA (D07 T06 §5)
  "privacy.summary": {
    text: "We use it to investigate it for you and, with your address and name removed, to improve our screening models. The email and its attachments are deleted after 30 days; the pictures and text we derive from it stay with the case. The service providers that help us are named below, and Meta's models are called with store: false.",
    owners: ["D00 T01 §5", "D01 T01 §2", "D03 T01 §1"],
  },
  "privacy.what.mail": {
    text: "Mail you forward or upload, with its attachments, links and any voice note: to investigate it and give you a verdict.",
    owners: ["D01 T01 §3", "D01 T03 §1"],
  },
  "privacy.what.account": {
    text: "Your account: your name, work email, organisation and role, so you can sign in and see your cases.",
    owners: ["D07 T02 §3"],
  },
  "privacy.closure": {
    text: "When an owner closes an organisation, it refuses new cases at once, and its stored mail, cases and history are deleted within 30 days of closing.",
    owners: ["D07 T02 §9"],
  },
  "privacy.what.ledger": {
    text: "Your supplier ledger: supplier names, domains and bank details you add, to catch changed bank accounts.",
    owners: ["D06 T01 §1", "D06 T01 §3", "D06 T01 §4"],
  },
  "privacy.what.feedback": {
    text: "Feedback when you tell us a verdict was wrong, to measure and improve accuracy.",
    owners: ["D07 T03 §6"],
  },
  "privacy.what.security": { text: "Sign-in and security records, to keep accounts safe.", owners: ["D07 T02 §6"] },
  "privacy.what.members": { text: "We accept mail only from members' verified addresses and domains.", owners: ["D01 T01 §3"] },
  "privacy.training": {
    text: "Forwarded mail may be kept and used to improve IsItLegit's screening models. Your address and name are removed, and other genuine mail is redacted. It is never sold or published. That training copy is not deleted after 30 days, and closing your account does not remove it; we have not set a fixed period for it. Loupe, the model that screens lookalike websites, is also trained on public web pages, and public lookalike pages the monitor finds are kept to train Loupe with no fixed expiry; a business can ask for its findings' pages to be removed.",
    owners: ["D03 T04 §11", "D03 T04 §7"],
  },
  "privacy.screening": { text: "When Loupe screens a website for you, it receives that public page only.", owners: ["D05 T04 §3"] },
  "privacy.keep.raw": { text: "30 days, then deleted automatically", owners: ["D00 T01 §5", "D01 T01 §2"] },
  "privacy.keep.derived": { text: "Kept with the case, not deleted at 30 days", owners: ["D01 T01 §2"] },
  "privacy.keep.case": {
    text: "While your organisation has an account, then deleted within 30 days of closing it",
    owners: ["D01 T01 §2", "D07 T02 §9"],
  },
  "privacy.keep.links": { text: "Expire after 7 days", owners: ["D01 T01 §8"] },
  "privacy.keep.security": { text: "365 days", owners: ["D07 T02 §6"] },
  "privacy.keep.account": { text: "Until you delete them or close the account", owners: ["D07 T02 §9", "D06 T01 §4"] },
  "privacy.p.cloudflare": { text: "All case data, stored in our account", owners: ["D01 T01 §2"] },
  "privacy.p.meta": {
    text: "Rendered pages, extracted text and audio. Standard model IDs only, store: false on every call",
    owners: ["D03 T01 §1"],
  },
  "privacy.p.smtp2go": { text: "Your address and the verdict summary", owners: ["D01 T02 §1"] },
  "privacy.p.webrisk": { text: "Links with the query string removed", owners: ["D02 T06 §1"] },
  "privacy.p.fireworks": {
    text: "Public web pages when screening a site; in training, public web pages and forwarded mail with your address and name removed and other genuine mail redacted",
    owners: ["D03 T04 §11", "D03 T04 §7"],
  },
  "privacy.protected": {
    text: "A protected business's registered bank account is never shown to anyone who checks mail. A checker only learns whether an invoice matches or does not match the registered account, and checks are rate-limited so the details cannot be guessed.",
    owners: ["D05 T01 §2", "D05 T02 §1"],
  },
  // Protect your business (D07 T06 §7)
  "protect.answer": {
    text: "IsItLegit Protect checks mail that claims to be you against what you registered, when someone forwards it, and finds lookalike websites every day.",
    owners: ["D05 T01 §1", "D05 T02 §2", "D05 T02 §3", "D05 T02 §4", "D05 T04 §2"],
  },
  "protect.identity": {
    text: "Verify your domains and sending addresses, upload your logo and register your bank account. When anyone forwards mail that claims to be you, we compare it with this record and tell them, and you, what does not match. Your bank account is never shown to anyone.",
    owners: ["D05 T01 §1", "D05 T01 §2", "D05 T01 §3", "D05 T02 §2", "D05 T02 §3", "D05 T02 §4"],
  },
  "protect.seal": {
    text: "The seal is served from isitlegit.co.za, and the browser only draws it on the domains you verified. On a copycat site it does not appear, and the attempt reaches us so we can alert you. It shows today's date and opens your verify page, so a screenshot copy gives itself away.",
    owners: ["D05 T02 §6", "D05 T02 §9"],
  },
  "protect.badge": {
    text: "Add the badge to your email signature. Anyone can copy a picture, so the badge is not the proof: your mail's own SPF, DKIM and DMARC are, checked against your registered domains when a recipient forwards it. A fake that copies your badge becomes an impersonation verdict and an alert to you. If your protection lapses, the badge shows Not verified, even in old emails.",
    owners: ["D05 T02 §7", "D05 T02 §8"],
  },
  "protect.monitor": {
    text: "Every day we try lookalikes of your domains. Loupe screens each live page cheaply, and only suspect pages get the full check. You get the evidence and a takedown pack with the registrar, host and abuse contacts.",
    owners: ["D05 T04 §1", "D05 T04 §2", "D05 T04 §3", "D05 T04 §5"],
  },
  "protect.bank": {
    text: "When a customer checks an invoice in your name with different bank details, we ask your registered finance contact to confirm. Your account number is never revealed: a checker only learns that it matches or does not match the registered account. Checks are rate-limited so nobody can guess their way to your details.",
    owners: ["D05 T03 §1", "D05 T01 §2", "D05 T02 §1"],
  },
  // Terms of use (D07 T06 §8)
  "terms.service": {
    text: "Members forward or upload a suspicious email, invoice, proof of payment, screenshot or voice note, and receive a verdict with the evidence we found. Protected businesses also register their domains, senders and bank details so mail in their name can be checked against their real identity.",
    owners: ["D01 T01 §3", "D01 T03 §1", "D01 T03 §4", "D04 T01 §4", "D05 T01 §1", "D05 T01 §2", "D05 T01 §3"],
  },
  "terms.you.mail": {
    text: "Forward or upload only mail your organisation received or was asked to act on, from an address or domain you have verified with us.",
    owners: ["D01 T01 §3", "D01 T03 §1", "D07 T02 §5"],
  },
  "terms.you.authority": {
    text: "If you register a Protected business, register only domains, addresses and bank accounts your organisation owns and is authorised to verify.",
    owners: ["D05 T01 §1", "D05 T01 §2", "D05 T01 §3"],
  },
  "terms.you.limits": {
    text: "Keep within your plan's fair-use limits (up to 5 checks a day per organisation on Free check, and 50 during the 14-day trial) so the service stays responsive for everyone.",
    owners: ["D07 T02 §4", "D07 T08 §8"],
  },
  "terms.protect.bank": {
    text: "When you register bank details for closed-loop verification, we store the account number encrypted with AES-256-GCM and a blind index for matching, and we never show the registered account number to anyone who checks mail.",
    owners: ["D05 T01 §2", "D05 T02 §1", "D05 T03 §1"],
  },
  "terms.limits.partial": {
    text: "When a model is unavailable or a model spend cap is reached, you receive a report marked partial rather than a guess; when your organisation reaches its daily check limit (5 checks a day on Free check, 50 during the 14-day trial), further checks are refused until midnight South African time.",
    owners: ["D03 T01 §2", "D04 T01 §5", "D07 T02 §4", "D07 T08 §8"],
  },
  // Security and disclosure (D07 T06 §8)
  "security.safeguards.untrusted": {
    text: "Email bodies, PDF text, page text and voice transcripts reach a model only inside delimited untrusted blocks, after hidden text has been pulled out as evidence of its own. A model never decides who receives mail: recipients, subjects and templates come from code.",
    owners: ["D01 T02 §2", "D02 T05 §1", "D03 T01 §6"],
  },
  "security.safeguards.floor": {
    text: "When deterministic checks find critical evidence, such as changed bank details, a login form on a lookalike domain or a dangerous attachment type, the verdict cannot be Clean whatever a model says. A model can raise severity, never lower it below the floor.",
    owners: ["D04 T01 §1"],
  },
  "security.safeguards.citations": {
    text: "Every sentence in a verdict must cite an Evidence ID from the checks that ran on that case. If a model cites a missing ID, the verdict is rejected, retried once, and then replaced by the rule-based verdict.",
    owners: ["D04 T01 §2", "D04 T01 §5"],
  },
  "security.safeguards.walkthrough": {
    text: "When Muse Wonder walks a suspicious link, the driver, not the prompt, enforces the limits: http and https only, at most 8 steps and 60 seconds, no file downloads, and only per-case canary details typed into forms. Every action is logged.",
    owners: ["D04 T02 §2", "D04 T02 §3", "D04 T02 §4"],
  },
  "security.safeguards.zod": {
    text: "Every model output and tool argument is checked against a strict schema before it is used, and tool calls run in auto mode only.",
    owners: ["D03 T01 §5", "D04 T01 §3", "D04 T01 §4"],
  },
  "security.safeguards.store": {
    text: "Every call to Meta's Model API uses a Standard model ID with store: false, which asks Meta not to keep the request. Meta's API terms allow Meta to train on content only in Contributor mode, which we never use, and they publish no fixed retention period for requests.",
    owners: ["D03 T01 §1"],
  },
  "security.intro": {
    text: "Every message you send us may be an attack. We treat its text, attachments and links as untrusted data, open links only inside a short-lived browser with strict limits, and let rules cap what a model can say.",
    owners: ["D03 T01 §6", "D04 T01 §1", "D04 T02 §2"],
  },
  "security.data.bank": {
    text: "Registered bank account numbers are encrypted with AES-256-GCM; checkers receive only match or no match, never the account number, and checks are rate-limited.",
    owners: ["D05 T01 §2", "D05 T02 §1"],
  },
  "security.data.reports": {
    text: "Report links in email replies are signed with HMAC-SHA256 and expire after 7 days.",
    owners: ["D01 T01 §8"],
  },
  "security.data.tenancy": {
    text: "Each organisation's cases, reports, suppliers and identity records are scoped to that tenant.",
    owners: ["D01 T01 §2", "D05 T01 §1", "D06 T01 §4", "D07 T02 §3"],
  },
  "security.data.retention": {
    text: "Raw emails and attachments in R2 expire after 30 days.",
    owners: ["D00 T01 §5", "D01 T01 §2"],
  },
  "security.data.auth": {
    text: "Sign-in uses magic links by email, with passkeys (WebAuthn) available once you are signed in.",
    owners: ["D07 T02 §1", "D07 T02 §2"],
  },
  // About and contact (D07 T06 §8)
  // The error pages (D07 T08 §9)
  "errors.mail": {
    text: "Checking email still works while the site is down.",
    owners: ["D01 T01 §3"],
  },
  "about.purpose": {
    text: "IsItLegit gives that inbox a place to check before paying, and gives South African suppliers a way to make their real identity and bank details verifiable.",
    owners: ["D05 T01 §2", "D05 T02 §2", "D01 T03 §1"],
  },
  "about.built.models": {
    text: "Each check uses the Meta model that fits the job: Muse Spark for reading rendered mail and invoices and weighing the evidence, Muse Wonder for walking suspicious links in a sealed browser, SAM 3.1 for finding brand logos on pages, and Muse Voice Transcribe for voice notes, alongside Loupe, our tuned page screener, a LoRA of Muse Glimmer 30B on Fireworks AI.",
    owners: ["D01 T03 §4", "D03 T02 §3", "D03 T03 §3", "D03 T04 §11", "D04 T01 §4", "D04 T02 §4", "D05 T04 §3"],
  },
} as const satisfies Record<string, { text: string; owners: readonly string[] }>;

export type ClaimId = keyof typeof claims;
