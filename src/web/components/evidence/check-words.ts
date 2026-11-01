// The plain words a reader sees for each check (D07 T03 §3), in a module of its own so the reply email (D07 T03 §7)
// names the same checks without loading the cards.
// Each check a renderer draws, by its exact name, with the plain words a reader sees for it. A registered check missing
// here fails test/web/evidence-cards; a stored name not here (a check retired since, even in a known family) draws the
// plain card, never a sibling's reading of its detail.
export const CHECK_WORDS: Record<string, string> = {
  "intake.forward": "How the message was forwarded",
  "intake.upload": "The uploaded file",
  "intake.truncated": "Reading very long message parts",
  "auth.results": "The receiving server's checks",
  "auth.spf": "The sending server check (SPF)",
  "auth.dkim": "The signature check (DKIM)",
  "auth.dmarc": "The domain policy check (DMARC)",
  "auth.alignment": "Whether the sender's domain matches its checks",
  "auth.arc": "The forwarding seal (ARC)",
  "sender.display_address": "A different address in the sender's name",
  "sender.display_brand": "A brand in the sender's name",
  "sender.reply_to": "Where replies go",
  "sender.return_path": "Where bounces go",
  "sender.first_time": "Whether this sender has written before",
  "domain.lookalike": "Lookalike domains",
  "domain.age": "How old the domain is",
  "attachment.type_mismatch": "Whether attachments are what they claim",
  "attachment.html": "Web pages sent as attachments",
  "attachment.executable": "Programs in attachments",
  "attachment.macro": "Macros in attachments",
  "attachment.encrypted_archive": "Encrypted archives",
  "content.hidden_text": "Hidden text",
  "content.ai_instructions": "Text written to steer an AI",
  not_checked: "Checks that did not run",
  "link.text_mismatch": "A link that shows one address and goes to another",
  "link.redirects": "Where a link goes after it is followed",
  "link.final_domain_changed": "A link that ends at a different site",
  "document.forensics.revisions": "Whether the file was changed after it was saved",
  "document.forensics.producer": "The program that made the file",
  "document.forensics.dates": "The dates the file records",
  "document.forensics.fonts": "The typefaces of its amounts",
  "document.forensics.overlay": "Images placed over its text",
};
