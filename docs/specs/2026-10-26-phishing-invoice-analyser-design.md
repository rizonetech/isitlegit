# Phishing and invoice-fraud analyser: design

Status: draft, 2026-10-26. Owner: Derick Payne (Rizonetech). Entry: Meta Global AI Developer Hackathon, Startup track, solo. Product name: **IsItLegit** (domain `isitlegit.co.za`, intake address `check@isitlegit.co.za`).

Sources: `sources/cerebralvalley/2026-10-26-digest.md` (rules, judging), `sources/discord/2026-10-26-rules-raw.md` (banned project types, demo rules), `sources/meta-api/2026-10-26-meta-model-api.md` (Meta Model API: models, API shape, pricing, data terms).

## 1. Problem

Rizonetech's clients receive phishing and business email compromise (BEC) mail that passes Microsoft 365 and other filters. Staff cannot tell whether a message is genuine, and the costliest case is an invoice from a "supplier" whose bank details were quietly changed. Today the client phones Rizonetech, a technician inspects headers by hand, and the answer takes hours.

## 2. What we build

A service where a client forwards any suspicious email (or uploads it) and within about a minute gets a verdict back by email and on a report page: **safe, suspicious or malicious**, with the evidence behind it and what to do next. It investigates the email, its links and its attachments, and treats invoices specially: it extracts the bank details and compares them with what that supplier used before.

Positioning against the banned "simple image analyser" and "basic integration" categories: the product is an investigator that combines deterministic checks, rendered visual inspection, logo segmentation and per-client supplier history, and it measures its own accuracy.

## 2a. The trust network (decided 2026-10-26 12:30)

Origin: a real case at a Rizonetech client, told here with a fictional name. An attacker impersonated a South African supplier (here Fynbos Freight, display name `debtors@fynbosfreight.example`, real sender a free webmail address) to **the supplier's courier**, asking for the supplier's statement. No filter at the supplier could catch it because the mail never reached the supplier. Email security products protect recipients; nothing protects a small business's identity towards its own suppliers and customers.

- **The core stays the core**: any member forwards any suspicious mail, from anyone, and gets the full investigation (headers, domains, links, rendered visuals, logos, Muse Wonder walkthrough, attachments, invoice checks). The trust network is an extra layer of evidence on top, used when the mail claims to be from a registered business; when it does not, the normal checks carry the verdict.
- **Protected identity**: a business registers and verifies its real domains, sending addresses, logo and bank account(s).
- **Counterparty checks**: anyone can forward mail claiming to be a protected business to `check@isitlegit.co.za`, with no account. The verdict compares the mail with the registered identity ("claims to be Fynbos Freight; Fynbos Freight never sends from gmail.com"). SAM 3.1 compares the logo in the mail with the **registered** logo.
- **Impersonation alerts**: the protected business is told when someone checks mail impersonating it, with the evidence, so it can warn its partners.
- **Closed-loop bank verification**: when an invoice's bank details differ from the supplier's registered account, the agent emails the supplier's registered finance contact asking for confirmation and attaches the answer to the case.
- **Impersonation monitor (paid, decided 15:10)**: we look for fake websites of a protected business before anyone receives the mail (section 4.11). Websites during the event; fake social profiles later.
- **Payment document check (paid, decided 15:10)**: members upload an invoice, proof of payment or bank confirmation letter on its own, without an email (section 4.5a).
- **Verifiable signature badge (decided 2026-10-26 21:10)**: a protected business adds the Protected seal to its email signature, linking to `isitlegit.co.za/v/<business>`. The badge proves nothing by itself (it can be copied); the proof is the message's own DKIM, SPF and DMARC alignment against the registered domains, checked when a recipient forwards it from the verify page. A copied badge in a fake mail therefore turns into an impersonation verdict and an alert to the business. The badge image is served live per business, so a lapsed protection shows "Not verified" even in old signatures. BIMI and DMARC enforcement guidance follows after the event. Built in D05 T02 §6 to §8.
- **Domain-locked website seal (decided 2026-10-26 21:15)**: the business embeds the Protected seal on its website as a frame served from `isitlegit.co.za`, whose `Content-Security-Policy: frame-ancestors` names only the business's verified domains, so the browser refuses to draw it on any counterfeit domain. The seal shows today's date and opens the verify page, so a screenshot copy gives itself away; a blocked embed attempt still reaches us with the counterfeit site's origin and alerts the business. Built in D05 T02 §9.
- **Privacy rules**: registered bank details are never revealed to a checker, only "matches" or "does not match the registered account"; checks are rate-limited per sender and per protected business to stop enumeration; POPIA notice on signup.

## 2b. Business model

Checking is free; protection is paid. Prices are starting hypotheses to test with pilot clients, not validated.

| Tier | Customer | Includes | Price hypothesis |
|---|---|---|---|
| Free check | Any counterparty | Verdicts on forwarded mail, "IsItLegit Verified" status of a business, 5 checks a day per sender (D05 T02 §1; **Corrected 2026-10-26:** said "monthly cap" with no figure) | Free |
| Protect | SMB | Verified identity, impersonation alerts, staff inbox checks, invoice bank-change detection, closed-loop verification, impersonation monitor (fake websites), payment document check | R499 to R999 per company per month |
| MSP | IT providers such as Rizonetech | Wholesale per client, MSP console, own branding | About R199 per client per month |
| Verification API (after the event) | Accounting and payment platforms, banks, cyber insurers | Payee identity and bank-detail check at payment time | Per call |

Plan gating: features carry a plan flag checked in code; during the event there is no billing and the 14-day trial unlocks everything, so the demo shows all of it.

Growth loop: every counterparty verdict on a protected business shows "Protected by IsItLegit" and invites the checker to protect their own business. Unit cost per check is measured by the pipeline (model tokens, browser time) and shown on the dashboard.

## 3. How it scores against the judging criteria

| Criterion | Weight | How this design earns it |
|---|---|---|
| Impact | 30% | Real clients, real losses (invoice fraud), a product Rizonetech can sell after the event. Theme: Build for Your World |
| Use of Meta AI tooling | 25% | Every hosted Muse model plus Loupe, our own fine-tune of the open-weight Muse Glimmer, each doing a job only it can do (corrected 2026-10-28 20:45 SAST: Loupe, a Muse Glimmer 30B LoRA fine-tuned on Fireworks for this job (D03 T04, the glimmer lane), replaces base Glimmer on serverless, operator decisions 15:01 to 15:16 SAST; corrected 2026-10-28, operator decision: Glimmer restored on Fireworks; corrected 2026-10-27: was "plus the open-weight Glimmer", removed with the outside providers) (section 9): Muse Spark reads rendered emails, screenshots and PDFs and reasons with tool calls over evidence; SAM 3.1 segments logos; Muse Wonder walks the phishing site as a computer-use agent; Muse Voice Transcribe turns scam voice notes and voicemail lures into evidence; Loupe (Glimmer tuned on lure and benign pages) screens the impersonation monitor's daily volume of new or changed pages cheaply, with Muse Spark as its failover; Muse Image builds the doctored-document test set |
| Demo | 25% | Live forward of a phishing email, verdict arrives by reply; invoice bank-change catch; accuracy dashboard |
| Technical depth | 20% | Evidence-cited verdicts, deterministic overrides, sandboxed link detonation, eval harness with detection and false positive rates |

Startup track lens: "holds up in production". Hosting, tenancy, retention and abuse controls are in scope, not afterthoughts. Other Startup entrants bring live production assets, so we need real usage during the event, not only a scripted demo (section 4.10).

Pitch order: lead with what no one else does (the Muse Wonder walkthrough of the attack, the invoice bank-change catch and the money it saves). Evidence-cited verdicts support the story but are not the headline, because many entrants now pitch "verified agent output".

## 4. Architecture

All on Cloudflare, TypeScript. Concrete services, libraries and versions: `2026-10-26-tech-stack-design.md`.

```
client mailbox --forward as attachment--> check@isitlegit.co.za --Email Routing--> intake Worker
web upload (.eml/.msg, PDF, .docx/.xlsx/.pptx, image) --------------------------> intake Worker
web upload (voice note .ogg/.opus/.wav/.mp3, screenshot) ----------------> intake Worker
intake Worker --> R2 (raw message, attachments) + D1 (case row) --> Workflow instance
AnalysisWorkflow (durable steps):
  1. parse MIME            5. visual analysis (Browser Run + Meta vision + SAM)
  2. header checks         6. invoice extraction + supplier ledger check
  3. sender/domain checks  7. verdict agent (Muse Spark, tool calls, evidence-cited)
  4. link + QR checks      8. store result, send reply email
report page (Worker + static UI) <-- D1 / R2
eval runner (CLI + Worker route) --> metrics in D1 --> dashboard page
```

### 4.1 Intake

- **Forward as attachment is the supported path.** A normal Outlook forward strips the original headers, which kills the authentication checks. The intake Worker detects whether the forward carries an attached `message/rfc822` (or `.msg`). If it does not, it still analyses the inline content, marks header evidence as unavailable, lowers confidence, and the reply explains how to forward as attachment.
- **Only registered tenants, plus counterparty checks.** The sender's domain must belong to a tenant in D1; anything else gets no processing and no reply (prevents abuse and backscatter). The one exception is a counterparty check (section 2a): a non-member forward whose original claims a protected business is processed, limited to 5 per sender and 50 per protected business a day (D05 T02 §1). **Corrected 2026-10-26:** this bullet contradicted section 2a by saying no non-member mail is ever processed.
- **Web upload** of `.eml` and `.msg` for the same pipeline, behind tenant login.
- **Reply** by email with the verdict summary and a signed link to the report page.

### 4.1a WhatsApp intake (after the event)

**Removed from the hackathon scope 2026-10-26 19:30 by the operator.** Nothing below is built during the event; it stays as the post-event design. Voice notes still reach the product as web uploads (a WhatsApp voice note saved as `.ogg` or `.opus`) and as voicemail-lure attachments in email (4.2a), so Muse Voice Transcribe keeps its job. Cost of reversing: one intake route, the webhook signature check and the D99 T01 §5 operator steps.

In South Africa most scams that reach a small business arrive on WhatsApp, not email: fake supplier messages, screenshots of "proof of payment", voice notes from a "director" asking for an urgent transfer. Members send the suspicious item to the IsItLegit WhatsApp number.

- **Channel**: WhatsApp Business Platform Cloud API (Meta). Webhook to the Worker, signature checked with the app secret (`X-Hub-Signature-256`), media fetched through the Graph API media endpoint into R2, then the same Workflow as email.
- **Accepted**: forwarded text with links, screenshots (Muse Spark vision, SAM 3.1 logos, link and QR extraction), PDFs (invoice and payment document checks, 4.5 and 4.5a), voice notes (4.2a).
- **Who may use it**: phone numbers registered to a member organisation (verified with a one-time code), plus rate-limited counterparty checks for protected businesses, as for email.
- **Reply** in the same chat: verdict, top three reasons, signed report link.
- **During the event**: the Meta developer test number (messages to a small list of registered recipient numbers), enough for the demo and dogfooding. A production number and business verification follow after the event.

### 4.2a Voice notes and voicemail lures

- Sources: voice notes uploaded on the web (a WhatsApp voice note saved as Ogg Opus `.ogg` or `.opus`, or `.wav`, `.mp3`), and email attachments posing as voicemail (`.wav`, `.mp3`, or an HTML "play message" lure). WhatsApp intake itself is after the event (4.1a). **Corrected 2026-10-28** (D01 T03 §8; the list also named `.m4a`): AAC, the audio in an `.m4a`, is still licensed through a patent pool, and whether decoding it on a server needs that licence is an open business decision, so an `.m4a` upload is refused with a message naming the formats taken; decoding it with libxaac (Apache-2.0) is D01 T03 §10, waiting on that decision.
- Audio is decoded in the Worker (libopus through `opus-decoder`, WASM; **corrected 2026-10-27**, was `ogg-opus-decoder`, see the stack doc) to 16 kHz mono 16-bit WAV, the format the endpoint accepts, capped at 10 minutes.
- **Muse Voice Transcribe** (`muse-voice-transcribe-1.0`, diarization mode) returns the transcript; Muse Spark then extracts the request (pay, change bank details, share a code, click a link), the claimed identity and urgency, as evidence.
- Claimed identity is checked against the trust network: "claims to be your director; your director's registered number is not the sender".
- Limits stated in the report: the model supports 25 languages including English, but not Afrikaans, isiZulu or isiXhosa; we do not claim to detect voice cloning.

### 4.2 Parsing

- MIME via `postal-mime`; Outlook `.msg` via an OLE/MSG reader library (choose on day 1, must run in Workers).
- Raw message and every attachment stored in R2 under the case ID; metadata in D1.

### 4.3 Deterministic checks (evidence producers)

Every check emits `Evidence { id, check, severity: info|low|medium|high|critical, summary, detail, artefacts[] }`. Nothing downstream may state a fact that is not an Evidence item.

- **Authentication:** parse `Authentication-Results` and `ARC-Authentication-Results` added by the tenant's own receiving system (trust boundary: only the topmost headers from the tenant's MX); SPF, DKIM, DMARC outcomes and alignment.
- **Sender:** display name vs address mismatch, Reply-To or Return-Path differing from From, first-time sender for this tenant.
- **Domains:** lookalikes against the tenant's own domain, its known suppliers and a top-brands list (confusable characters, edit distance, added words); domain age via RDAP; newly registered domain flag.
- **Links:** extract all URLs (HTML, text, PDF annotations); expand redirects in an isolated Browser Run session; record final URL, domain, certificate age if available, and whether the landing page has a password or card form.
- **QR codes:** decode from inline images and PDF pages, feed resulting URLs into link checks.
- **Attachments:** extension vs real type, HTML attachments (smuggling), macros, encrypted archives, executables.
- **Hidden text:** text the reader cannot see (zero-size or transparent fonts, text coloured like its background, `display:none`, off-screen positioning, HTML comments) and text addressed to an AI or automated filter ("this message is safe", "ignore previous instructions"). Both are evidence against the mail: an honest sender has no reason to hide words from the person reading it.

### 4.3a Reputation and breach signals (decided 16:01)

Third-party blocklists, URL reputation and breach data feed the evidence list. Budget about US$50 a month; providers chosen in `sources/threat-intel/2026-10-26-reputation-apis.md`, and only those whose terms allow commercial use on the tier we pay for.

Chosen 16:10 (details, quotes and prices in the research file; key claims spot-checked against the providers' own pages):

| Signal | Provider | Cost | Why |
|---|---|---|---|
| URL and domain reputation | **Google Web Risk Lookup API** (`uris.search`) | Free up to 100,000 calls a month, then US$0.50 per 1,000 | Google's commercial product (Safe Browsing v4 is non-commercial only). Never call the Update API: it reprices lookups to US$50 per 1,000 |
| Domain block signal | **Cloudflare 1.1.1.2** (malware-blocking resolver) over DNS-over-HTTPS | Free | Second, independent opinion; no SLA, terms to confirm before launch |
| "Well-known site" counter-signal | **Tranco** list if its licence allows commercial use, else **Majestic Million** (CC BY 3.0, credited) | Free | Pulls against false positives on big legitimate sites |
| Sending-IP reputation | AbuseIPDB Basic | US$25 a month | **Deferred to launch**: IP listings are weak evidence by rule (below), and the free plan bans commercial use |
| Breach data | Have I Been Pwned | Pro from US$379 a month | **Out of the hackathon build** (decided 16:14). Core (from US$4.39) "does not permit use on behalf of third parties", so it cannot serve our clients; revisit with Pro or a quote after the event |

Rejected for commercial-use terms: Google Safe Browsing v4, VirusTotal public API, abuse.ch free tier, OpenPhish community feed, Spamhaus and SURBL free use, AlienVault OTX, Cloudflare Radar data (CC BY-NC). PhishTank is allowed but closed to new registrations; re-check before launch. Spend during the event: US$0; the US$50 budget is held for AbuseIPDB and a commercial blocklist quote (abuse.ch via Spamhaus, or Spamhaus DQS) after the event.

Because legitimate businesses do get listed, the rules for using these signals matter more than the list of providers:

- **Granularity sets the weight.** A listing of the exact URL in the mail is strong. A listing of the whole registrable domain is medium. A listing of an IP address is weak: shared hosting and mail relays (Microsoft 365, Google, SMTP2GO) put thousands of honest senders on one IP. IP listings never raise severity on their own.
- **Never the only reason.** A blocklist hit alone cannot make a verdict malicious. It must agree with our own evidence (lookalike domain, credential form, authentication failure, bank change). Without that, the report shows it as "listed by X" at low or medium severity and the verdict stays at suspicious at most.
- **Counter-signals pull the other way.** A domain that is verified in the trust network, appears in a top-sites list, has years of registration history and passes DMARC alignment outweighs a single domain listing; the report shows both sides.
- **Show the source and the date.** Each listing in the report names the provider, what was listed (URL, domain or IP), when it was listed if the provider says so, and the provider's delisting page. A business that was listed by mistake sees why and how to fix it.
- **After the event, breach data means account takeover risk, not phishing.** If the claimed sender's mailbox, or many mailboxes at a supplier's domain, appear in a recent breach, that supports "the real supplier's mailbox may be compromised", the case where the mailbox is genuine but the person sending from it is not. It never makes a mail malicious on its own. Breach lookups for a whole domain need proof of domain control, so domain-wide breach monitoring is offered only for a protected business's own verified domains (a paid Protect feature).
- **Cache and budget.** Results are cached in KV by URL or domain: a listing for 24 hours or until the `expireTime` Web Risk returns with it, whichever is earlier (Google's terms forbid keeping a listing past it), "not listed" for 6 hours; a per-tenant and global daily cap keeps us inside the monthly budget, and a provider outage leaves a "not checked" line, never a guess.
- **False positives feed back.** A "this was wrong" report on a verdict that leaned on a listing records the provider, so the eval can show each provider's false-positive rate on our own data.

### 4.4 Visual analysis (Meta models)

- Render the email HTML to a screenshot with Browser Run (remote images allowed inside the sandbox, scripts off). Render each PDF page and each landing page to images.
- **Muse Spark** (`muse-spark-1.3`, image input, JSON-schema structured output) returns per image: claimed brand, requested action (log in, pay, open file, call), urgency cues, visible sender identity.
- **SAM 3.1** (`sam-3.1`, text prompt "logo") returns boxes and masks; crops go back to Muse Spark with the brand's reference logo for a same/different judgement. Output parsed with `@meta-sam/parser`. Logo-detection quality is undocumented: test on day 1, and fall back to Muse Spark perception grounding (boxes from the vision model) if SAM misses logos. (Measured 2026-11-02, D03 T03 §4: on 20 synthetic branded pages SAM returned no logo box at all, grounding found 20 of 20, so grounding holds the logo concept and SAM keeps stamp and signature; docs/frontier-log.md.)
- **Brand's real domains** come from a curated table first, then Muse Spark **search grounding** with citations for brands not in the table. Evidence: "Shows Standard Bank branding; sent from a domain Standard Bank does not use (source: standardbank.co.za)."
- Reference logos: a small curated set (South African banks, Microsoft, DocuSign, SARS, couriers) with licence-safe sources, stored in R2.

### 4.4a Phishing-site walkthrough (computer-use agent)

- **Muse Wonder** (`muse-wonder-1.0`) with the native computer tool drives a Cloudflare Browser Run session (Puppeteer as the driver) on the email's link: it clicks through "view document" and similar lures to reach the real credential page, and types **canary credentials** (generated per case, never real) to observe where the form posts.
- Evidence produced: the chain of pages with screenshots, the final credential-harvest domain, the form target, and whether the canary was accepted.
- Hard limits enforced by our driver, not the model: max 8 steps, 60 seconds, no file downloads, no navigation outside http(s), only canary values may be typed, and every action logged.
- Cost guard: runs only when the deterministic link checks find a page with a form or a lure button, and results are cached by final URL.

### 4.5 Invoice fraud

- Detect invoices and payment requests (vision model on PDF pages plus text).
- Extract `supplier name, supplier domain, bank, account holder, account number, branch code, amount, reference, due date` as structured JSON.
- **Supplier ledger per tenant** in D1: known suppliers, their domains and verified bank details. Seeded by the tenant admin (CSV upload) and grown from invoices the tenant marks as verified.
- Rules: bank details differ from the ledger, supplier domain differs from the ledger, or "we have changed banks" language → **critical** evidence and a fixed instruction: confirm by phoning the supplier on the number in the ledger, never the one in the email.
- Out of scope for the hackathon: live bank account verification (AVS) with SA banks.

### 4.5a Payment document check (paid)

Standalone upload (web page, or mail to `check@` with only a PDF or image attached) of three document types: **invoices, proofs of payment (POP), bank confirmation letters**. Fake POPs are a common small-business fraud in South Africa: goods are released against a doctored PDF or screenshot.

- **File forensics** (deterministic): PDF producer and creator against the claimed issuer, incremental updates (edits saved after the original), mixed or substituted fonts in the amount and account fields, creation and modification dates against the document date, images pasted over text.
- **Muse Spark** (native PDF and image input, JSON-schema output): document type, issuer, amounts, dates, reference and bank fields; for a POP, whether layout and wording match a genuine sample from the same bank (curated, synthetic or licence-safe references in R2).
- **Ledger and registry match**: bank details against the supplier ledger and, for a protected business, its registered account (match or no match only).
- Verdict and report as in 4.6 and 4.7, with the fixed action for POPs: confirm the money has cleared in your own banking app before releasing goods.
- Limit: a POP check can show a document is likely doctored; it cannot prove payment. The report says so.

### 4.6 Verdict agent

- **Muse Spark** (`muse-spark-1.3`, Responses API, tool calling) receives the case summary and evidence list. Tools it may call: `expand_link`, `screenshot_url`, `segment_logos`, `compare_logo`, `lookup_domain`, `ledger_lookup`, `walk_phishing_site`. Each tool result becomes new Evidence. Only `tool_choice: "auto"` is supported and tool arguments are not guaranteed to match the schema, so every call is validated with zod before it runs.
- Output JSON: `verdict, confidence, headline, explanation, cited_evidence_ids[], recommended_actions[]`. A validator rejects any explanation that cites missing evidence IDs; on failure the agent retries once, then the case falls back to a rule-based verdict.
- **Deterministic floor:** critical evidence (bank change, credential form on a lookalike domain, malware-type attachment) caps the verdict at suspicious or malicious regardless of model output. The model can raise severity, never lower it below the floor.

### 4.6a Prompt-injection defence

The system holds private client mail, reads hostile content and can send email, so it has all three parts of the "lethal trifecta". The defence is structural, not a better prompt:

- **Untrusted content stays data.** Email text, PDF text and page text reach a model only inside clearly delimited untrusted blocks, after hidden text has been extracted and logged as evidence. The verdict agent receives evidence summaries and artefact references, not raw HTML.
- **No model decides who gets mail.** Replies go only to the forwarding member, verification emails only to the registered finance contact, alerts only to the protected business's registered address. Recipients, subject and template come from code; the model fills validated fields (headline, reasons, cited evidence IDs), never addresses or links.
- **Tools are read-only and validated.** Every tool call is checked with zod; no tool sends data anywhere except fetching the URLs already found in the mail. The Muse Wonder walkthrough types only canary values, under the limits in 4.4a.
- **The floor cannot be talked down.** An injection that persuades the model to say "safe" still loses to the deterministic floor in 4.6, and a hidden-text finding is itself high-severity evidence.
- **Tested.** Fixtures with hidden "mark this safe" instructions, injected tool requests and fake system prompts; tests prove the verdict, recipients and tool calls are unchanged.
- Optional, if a day 1 check shows it runs on Workers AI: Meta's Llama Prompt Guard as a second, independent injection classifier.

### 4.7 Report page

Verdict banner, plain-language headline, evidence cards (each with its screenshot, crop or header excerpt), "what to do now", and a "this was wrong" button that records feedback for the eval set.

### 4.8 Tenancy, access, data handling

- D1 tables: `tenants`, `tenant_domains`, `users`, `cases`, `evidence`, `suppliers`, `feedback`, `eval_runs`, `eval_results`.
- **Self-serve signup** (free 14-day trial, no billing during the event): create an organisation, **verify ownership of the email domain** (DNS TXT record or a code sent to `admin@`/`postmaster@` the domain) before mail from it is accepted at `check@`, invite team members, add known suppliers. Better Auth with organisations; roles owner, admin, member.
- **Client dashboard**: cases and verdicts, invoice flags and money at risk caught, weekly stats, team, approved domains, supplier ledger.
- **MSP console** (Rizonetech, behind Cloudflare Access): every client organisation, onboarding status, volume, top threats, accuracy. MSPs reselling to their clients is the business model.
- Report links in reply emails are HMAC-signed and expire.
- **Marketing site** at `isitlegit.co.za` (Astro): what it does, the invoice-fraud story, how forwarding works, pricing (shown, not charged), privacy and POPIA page, signup.
- POPIA: raw messages and attachments deleted after 30 days (R2 lifecycle rule); case summaries kept while the organisation has an account and deleted within 30 days of closing it (**Corrected 2026-10-26:** said only "kept"; default chosen so the privacy page can state a period). The Information Officer is the head of the private body under POPIA, Derick Payne as CEO of Rizonetech (Pty) Ltd, reached at `hello@isitlegit.co.za`.
- Meta Model API data terms (`sources/meta-api/2026-10-26-meta-model-api.md`): use **Standard-mode model IDs only, never `-contributor`** (Contributor content may be used for training and must not contain personal data; corrected 2026-10-27: a Contributor exception for public lookalike pages was approved at 10:47 and withdrawn at 11:05 SAST by the operator, because those pages copy real people's names, addresses and numbers, which is personal data even when public); send `store: false` on every request; no fixed retention period is published and Zero Data Retention is not available to us, so real client mail needs the client's consent and a Meta data-processing review before production use. Defensive phishing analysis is not prohibited by the Acceptable Use Policy as read, but abuse systems may flag phishing content; if that happens, ask `aup_exceptions@meta.com`.
- **Hackathon constraint:** no real client email in the public repo, demo or Discord. Demo and eval data are public corpora with compatible licences plus synthetic emails we write.

### 4.9 Evaluation harness

- Dataset: labelled phishing, BEC and invoice-fraud samples plus genuine mail. Sources to choose on day 1 with licences recorded in `eval/DATASETS.md`; synthetic South African samples written by us (fake banks and suppliers where needed).
- Runner: CLI that submits each sample through the real pipeline and stores results; metrics: detection rate, false positive rate, per-category breakdown, median time to verdict.
- Dashboard page shows the latest run. Shown in the demo.
- **Doctored-document test set**: **Muse Image** (`muse-image-1.0`, image editing) edits our own synthetic invoices and proofs of payment from fictional companies and fictional banks (changed amounts, account numbers, dates), each stamped SYNTHETIC, to give the payment document check genuine and doctored pairs. No real bank or business branding is used; if the AUP filter refuses an edit, that pair is made in code instead and the refusal is recorded.
- **Numeric targets**, so every optimisation pass works toward a number and not "make it better" (first estimates, revised after the day 0 smoke test gives real token counts): detection rate at least 95% on attacks; false positive rate at most 2% on genuine mail; time from forward to reply under 60 s median and under 3 minutes at the 95th percentile, walkthrough included; model cost under US$0.05 median per case and under US$0.25 for a case with a walkthrough. A run that misses a target names the cause in `eval/RESULTS.md`.
- **Model ablation** (added 2026-10-26, `docs/manifesto.md`, first priority): the runner repeats the eval with each Meta model switched off in turn (Muse Spark reasoning replaced by the rule-based verdict, no Muse Wonder walkthrough, no SAM 3.1 comparison, no Voice Transcribe, no Spark page screening; corrected 2026-10-27, was Glimmer) and records what each removal costs in detection rate, false positive rate, time and cost per check. The table goes in `eval/RESULTS.md`, on the dashboard and in the demo, so every model's contribution is measured, not claimed. A model whose removal costs nothing is cut or reworked.
- **Frontier log** (added 2026-10-26, same source): one experiment per build day at the edge of what the Meta models can do, recorded in `docs/frontier-log.md` with the prompt, the inputs (synthetic only), the result and what it means for the product. What works becomes a feature through the TODO system; what fails stays in the log with its evidence.

### 4.11 Impersonation monitor (paid)

Looks for fake websites of each protected business, so the business hears about a lookalike before its customers receive mail from it.

- **Candidates**: lookalike variants of each verified domain (confusable characters, typos, added words such as `-payments` or `-invoice`, other TLDs such as `.com`, `.co`, `.africa`), generated by the same confusables module as 4.3; plus certificate-transparency search for new certificates whose names contain the business's brand tokens.
- **Daily run** on a Cron Trigger: the run wakes Loupe's deployment first, so its warm-up overlaps the DNS lookups over DNS-over-HTTPS for each candidate; **Loupe** (a Muse Glimmer 30B LoRA tuned on Fireworks AI, on a dedicated deployment that scales to zero after 5 idle minutes and runs at most 30 minutes a day), with **Muse Spark** (Standard mode, about US$0.005 a page) on the Meta Model API taking over while Loupe warms past its limit, is out of minutes, fails, times out or reaches its cap, screens every live page's screenshot and text cheaply (corrected 2026-10-28 20:45 SAST: Loupe, a Muse Glimmer 30B LoRA fine-tuned on Fireworks for this job (D03 T04, the glimmer lane), replaces base Glimmer on serverless, operator decisions 15:01 to 15:16 SAST; corrected 2026-10-28, operator decision 09:05 SAST: Glimmer on Fireworks restored as the screener, Spark the failover; corrected 2026-10-27, was Muse Glimmer through a hosted provider, then Spark alone) for "brand lure with a login or payment form"; only pages it flags go to the full 4.4 pipeline (Browser Run screenshot, SAM 3.1 logo crop compared with the registered logo, Muse Spark on the page) and, when a login or payment form is found, the 4.4a walkthrough.
- **Alert** to the business's registered address with the evidence, and a takedown pack: domain, registrar and hosting provider from RDAP, screenshots, and the abuse contacts to send it to. We never contact registrars or hosts on the business's behalf during the event.
- Mail checked through `check@` that uses a monitored lookalike links straight to the monitor finding.
- **Later, not during the event:** fake social profiles. Facebook, Instagram and LinkedIn offer no search for impersonating pages and scraping breaks their terms, so this will be search-grounded discovery (Muse Spark search with cited links, then screenshot and logo check), reported by the business through each platform's own impersonation form.
- Cost guard: candidate lists capped per business; screenshots only for new or changed hosts; results cached.

### 4.10 Real usage during the event

- **Dogfood from day 2:** Rizonetech's own mailboxes are the first tenant. Derick and staff forward every suspicious email they receive. This is Rizonetech's own data, so no client consent is needed, and it gives real cases from day 2.
- **Pilot clients from day 6** (when verdicts are complete): one to three clients who opt in in writing. The consent covers processing by the Meta Model API in Standard mode. Their content never leaves the product: the demo and README show only counts (cases checked, verdict mix, median time to verdict, invoice flags), never message content.
- The dashboard shows these production counts next to the eval metrics.

## 5. Demo (3 minutes, draft)

1. 0:00 Problem in one line with a real-looking phishing email that "got past Microsoft 365".
2. 0:20 Forward it as attachment from Outlook. Reply lands within a minute: malicious, with the lookalike domain, SPF fail and the SAM logo crop. Replay of the Muse Wonder walkthrough: it clicks "View invoice", reaches a fake login page of a fictional mail provider (hosted by us on `fixtures.isitlegit.co.za`), types the canary password and shows the domain that would have received it. The same mail hides white-on-white text telling AI scanners it is safe; the report lists that as evidence against it.
3. 1:10 Invoice case: genuine-looking PDF, bank details changed. Critical flag, "phone the supplier on 011 ... from your records".
4. 1:50 Genuine email: verdict safe, showing it does not cry wolf.
5. 2:15 Dashboard: accuracy on N labelled samples, plus real usage since 27 Oct (Rizonetech and pilot clients, counts only).
6. 2:40 What is new (built 26 Oct to 4 Nov), how Meta's models are used, Rizonetech rollout to clients.

## 6. Rules compliance

- New work only: repository created after the 26 Oct kickoff; first commit after 19:00 SAST. No product code copied from earlier Rizonetech projects. **Corrected 2026-10-26:** the development tooling (`.claude/`, `.conclave/`, `scripts/`, `tests/scripts/`) comes from Rizonetech's Conclave-SDK kits and is declared in `CONTRIBUTIONS.md`; before, this line said no code at all was copied. The full rule set is in `docs/hackathon-criteria.md`.
- Public repo from day 1, so no secrets in it (Wrangler secrets and 1Password only).
- Every third-party library and dataset listed with its licence in `NOTICE.md` or `eval/DATASETS.md` (corrected 2026-10-26: was "in the README"); the demo states what was built during the event.
- Not a banned category: not medical, not basic RAG, not a simple image analyser.

## 7. Milestones (detail in the plan)

| Date | Milestone |
|---|---|
| Mon 26 Oct | Spec, plan, repo, Cloudflare resources, Meta API smoke test after kickoff |
| Tue 27 Oct | Intake (email + upload), parsing, R2/D1, case pipeline end to end with a stub verdict |
| Wed 28 Oct | Deterministic checks: auth, sender, domains, attachments |
| Thu 29 Oct | Links, Browser Run, QR; vision model on rendered email |
| Fri 30 Oct | SAM logo segmentation and brand comparison; Muse Wonder phishing-site walkthrough |
| Sat 31 Oct | Invoice extraction and supplier ledger |
| Sun 1 Nov | Verdict agent with tools, evidence validator, reply email, report page |
| Mon 2 Nov | Eval harness, dataset, dashboard; fix the worst misses |
| Tue 3 Nov | Hardening, tenancy, retention; record demo video |
| Wed 4 Nov | Buffer, README, submission by 18:00 SAST |

## 8. Risks

| Risk | Mitigation |
|---|---|
| SAM 3.1 does not find logos reliably | Day 1 test on 20 branded emails; fallback is Muse Spark perception grounding (measured 2026-11-02, D03 T03 §4: SAM 0 of 20, grounding 20 of 20, so grounding holds logos and SAM keeps stamp and signature) |
| Meta abuse systems flag phishing content | Standard mode, `store: false`, synthetic demo data; AUP exception request ready |
| $150 credit runs out | Credit needs a payment method on file and a claim before 4 Nov 21:00 ET; Muse Spark for bulk work ($1.25 / $4.25 per M tokens), Wonder only for site walkthroughs; cache by artefact hash; eval set sized to budget |
| Forwarded emails lose headers | Forward-as-attachment path, clear reply guidance, confidence lowered when headers missing |
| Link detonation hits live malware or tracking | Browser Run sandbox, no downloads executed, only URL and screenshot kept |
| Phishing mail carries prompt injection aimed at our models | Section 4.6a: hidden text becomes evidence, recipients come from code, read-only validated tools, deterministic floor, injection fixtures in the test suite |
| Solo, 10 days | Milestones ordered so a working end-to-end slice exists from day 2; cut list below |

Cut list, in order, if time runs short (updated for the trust network): QR decoding, web upload of `.msg`, landing-page screenshots for links without a form (the Wonder walkthrough keeps its own), ledger CSV import (seed by hand), search grounding (curated table only). The payment document check and the impersonation monitor come after the core and the trust network: if time runs short, cut the monitor's certificate-transparency search first, then the POP layout comparison, then the monitor itself. The trust network and the computer-use walkthrough are headline features and are cut last.

Stretch if ahead: Muse Spark video input for scam screen recordings (corrected 2026-10-27: the Glimmer LoRA fine-tune left the plan with Glimmer; corrected 2026-10-28 20:45 SAST: it is back as Loupe, the monitor's screener, D03 T04, no longer a stretch).

Cut order for the broader Meta layer (15:30), if time runs short: Muse Image test set (fall back to code-made pairs), Spark page screening (screen a smaller candidate list; corrected 2026-10-27, was Glimmer fine-tune and Glimmer screening), voice-note upload (keep email voicemail lures). WhatsApp intake is out of the event scope (4.1a).

## 9. Meta model map

| Role | Model ID | Why |
|---|---|---|
| Read rendered emails, PDFs, landing pages; verdict agent with tools | `muse-spark-1.3` | Vision + PDF input, tool calling, structured output, cheap enough for bulk |
| Phishing-site walkthrough | `muse-wonder-1.0` | Native computer-use tool |
| Impersonation monitor (scheduled) and payment document check | `muse-spark-1.3`, `sam-3.1`, `muse-wonder-1.0` | Same models run on a daily schedule against lookalike sites, and on uploaded POPs and invoices |
| Voice notes and voicemail lures | `muse-voice-transcribe-1.0` | Diarized transcript of the audio, then Muse Spark extracts the request and claimed identity |
| Bulk screening for the impersonation monitor | Loupe (Muse Glimmer 30B LoRA tuned on Fireworks AI, dedicated deployment), Muse Spark (Standard mode) as failover | First pass over the new or changed candidate pages each day; only flagged pages go through the full pipeline. Glimmer is Meta's open model distilled from Muse Spark, cheap enough for the volume, and Loupe tunes it on public lure pages, real benign pages, redacted sample mail and synthetic South African lures (free Glimmer training until 2026-11-30); Spark takes over when Loupe is warming, out of its 30 daily minutes, failing or at its cap. Corrected 2026-10-28 20:45 SAST: Loupe, a Muse Glimmer 30B LoRA fine-tuned on Fireworks for this job (D03 T04, the glimmer lane), replaces base Glimmer on serverless, operator decisions 15:01 to 15:16 SAST. Corrected 2026-10-28 by operator decision (09:05 SAST): Glimmer on Fireworks restored with Fireworks' US$100 partner credit, Spark kept as failover. Corrected 2026-10-27 by operator decision: was Muse Glimmer via a hosted provider, then briefly Muse Spark 1.3 Contributor, withdrawn because lure pages carry personal data |
| Doctored-document test set | `muse-image-1.0` | Edits synthetic invoices and POPs of fictional companies into tampered versions for the eval |
| Optional injection classifier | Llama Prompt Guard | Second, independent injection check if it runs on Workers AI (4.6a) |
| Logo segmentation | `sam-3.1` | Text-prompt segmentation, boxes and masks |
| Brand domain lookup | `muse-spark-1.3` with search grounding | Cited live answers |
| Building the product | Not claimed | We do not build with Muse Code, so we do not list it as Meta tooling |

All calls go to the Meta Model API (`https://api.meta.ai/v1`, Responses API) through AI Gateway `isitlegit`'s `custom-meta` route (corrected 2026-10-27, D00 T01 §6: they no longer go to Meta directly).

## 10. Open decisions

1. Decided 2026-10-26: product name IsItLegit, own domain `isitlegit.co.za` (registration pending), intake `check@isitlegit.co.za`.
2. Eval datasets and their licences (day 2).
3. Repository licence. The repo must be public; "all rights reserved" keeps the product commercial, an open licence (MIT, AGPL) invites contributions. Default if undecided: all rights reserved.
4. Decided 2026-10-26 19:00: repository licence `FSL-1.1-ALv2` (see `README.md`).

## 11. Decisions for the unattended build (2026-10-26 19:30)

Answered by the operator in session so the build can run through `process-plan` without stopping. Each decision names where it is enforced.

| Topic | Decision | Enforced in |
| ----- | -------- | ----------- |
| Authority | The run may deploy the `isitlegit` Worker, create and migrate its own D1, R2, KV, Workflow and AI Gateway, change DNS and Email Routing on the `isitlegit.co.za` zone only, configure the Access app for `/admin`, and set GitHub Actions secrets in `rizonetech/isitlegit`. Never another zone, Worker or account | `AGENTS.md` Safety |
| Budget | Code-enforced caps: Meta Model API US$250 in total for build, experiments and eval, at most US$50 a day, US$30 held back outside the SAST judging dates 3 to 9 November 2026 inclusive (operator-authorized coordinator increase, 4 November 2026: prior US$120 total/US$15 daily; maximum cumulative exposure rises by US$130, recorded usage and liabilities remain unchanged; rollback reduces only unused future headroom); page screening on Fireworks capped at US$250 in total, US$50 a day and 60 cumulative GPU runtime minutes of Loupe's deployment a day (operator-authorized coordinator increase, 4 November 2026: prior US$90 total/US$5 daily/30 minutes; current configured US$8/hour implies at most US$8 per 60-minute average allowance, a planning bound, not measured usage; individual request, warm-up, burst and walkthrough timeouts are unchanged; history and liabilities retained), both as an average since 2026-10-31 with one day borrowed ahead (operator, 2026-10-31 22:16 SAST, D03 T04 §34), and on the Meta failover inside the Meta caps (corrected 2026-10-28 20:45 SAST: the 30 minutes come with Loupe's dedicated deployment, held in `src/vision/glimmer-caps.ts`, D03 T04 §14; corrected 2026-10-28, operator decision: Glimmer on Fireworks restored; corrected 2026-10-27: the separate US$10 cap for Glimmer left with the outside providers); Browser Run inside Workers Paid. On a cap the model is switched off for the day, the case gets a marked partial report, and the run carries on | Model client budget guard (`src/meta/`); Loupe's minutes and Fireworks caps in `src/vision/glimmer-caps.ts` (D03 T04 §14) |
| Outbound | Replies only to registered members (Rizonetech, pilots) and Rizonetech-controlled test mailboxes, with one exception: a counterparty check (2a) is answered once to the forwarder who sent it, after the forwarder proved its own mailbox, for that case's reply only (corrected 2026-10-31, D05 T02 §1, its round 1). Closed-loop verification and impersonation alerts go only to the fictional demo businesses, whose registered contacts are aliases on `isitlegit.co.za` forwarding to the operator's Rizonetech mailbox | Mail sender allowlist (`src/mail/`) |
| Signup | Invite codes during the event (Rizonetech, pilots), daily case caps per organisation, and a ready judge demo organisation with sample cases whose code goes in the submission. Open signup after the event | 4.8, `src/auth/` |
| WhatsApp | Out of the event scope (4.1a); voice notes arrive by web upload and email | 4.1a, 4.2a |
| Design | An attended design session (Tue 27 Oct morning) produces `design/SPEC.md`, the tokens and mockups before any surface section; backend sections run first | `todo/07-app` |
| Brand | IsItLegit is its own sub-brand with Rizonetech DNA: its own wordmark and verdict colours (safe, suspicious, malicious) on Rizonetech orange `#FF4A14` and Exo / Exo 2, "by Rizonetech" in the footer | `design/SPEC.md` |
| Fixtures | Phishing fixture sites imitate fictional brands only (a made-up mail provider and bank) on `fixtures.isitlegit.co.za`, `noindex`, behind random paths. Real brands appear only as reference logos in R2 for detection, never imitated on our pages. The demo's "fake Microsoft login" becomes the fictional provider | 4.4a, 5 |
| Pricing | "Free during launch" on the site; Free check, Protect from R499 per month, MSP from R199 per client per month shown as launch prices; no billing | Marketing site |
| Mailbox | The operator's Rizonetech address receives the test-mailbox and demo-alert aliases and is the only identity Access admits to `/admin` | D99 T01, Access policy |
| Eval data | A synthetic South African set (fictional banks, suppliers and couriers; Muse Spark text, Muse Image documents) plus public corpora whose licences allow our use, each recorded in `eval/DATASETS.md`. Real mail is only ever counted | 4.9 |
| Reviews | Every section keeps the full review (plan review, completion review, rounds until the first with no P1 or P2; cap stays 33). If Codex hits a usage limit, the run keeps implementing and committing ready sections, queues their reviews, retries Codex every 30 minutes and stamps each section when its review returns; nothing is stamped unreviewed | `AGENTS.md`, `.conclave/reviewers.toml` |
| Deploys | The run deploys with the local Wrangler login after typecheck, lint, tests and `scripts/check-publication.py` pass; GitHub Actions runs the same gates on every push and never deploys, so no Cloudflare API token is stored in GitHub | `AGENTS.md`, D00 T01 §4 and §5 |
| Blockers | An unattended run parks a section it cannot finish with a dated note, records the reason in `todo/findings.md`, sends the operator a push notification for real blockers only, and carries on with other ready work | `AGENTS.md` |
