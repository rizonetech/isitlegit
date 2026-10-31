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
  "invoice.closing": { text: "Add your suppliers once and every invoice is compared automatically.", owners: ["D06 T01 §4"] },
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
} as const satisfies Record<string, { text: string; owners: readonly string[] }>;

export type ClaimId = keyof typeof claims;
