import { z } from "zod";
import { randomNonce, stripDelimiters, UNTRUSTED_WARNING, untrustedBlock } from "../meta/untrusted.ts";

// The page screener's contract (D03 T04 §3), shared by training and production so Loupe is trained on exactly the
// request it is later sent: what the model answers (`PageAnswer`), what the caller records (`PageScreen`), the system
// prompt, the request builder, the Fireworks training line and the per-line token limit.

export const LURE_TYPES = ["credential", "payment", "fake_shop", "impersonation", "none"] as const;

// The model's answer. Strict, so an answer that tries to name its own screener, or anything else, is refused.
export const PageAnswer = z
  .strictObject({
    brand: z.string().min(1).max(200).nullable(),
    has_login_form: z.boolean(),
    has_payment_form: z.boolean(),
    lure: z.boolean(),
    lure_type: z.enum(LURE_TYPES),
    confidence: z.number().min(0).max(1),
  })
  .refine((answer) => (answer.lure_type === "none") === !answer.lure, {
    message: "lure_type is none exactly when lure is false",
    path: ["lure_type"],
  });
export type PageAnswer = z.infer<typeof PageAnswer>;

export type Screener = "glimmer" | "spark";
// The caller's record of a judgement: the answer plus which screener gave it, set here and never by the model.
export type PageScreen = PageAnswer & { screener: Screener };
export function screened(answer: PageAnswer, screener: Screener): PageScreen {
  return { ...PageAnswer.parse(answer), screener };
}

// D03 T01 §6's sentence and stripper, from the one implementation every model call uses (re-exported for this file's
// callers), so the screener reads untrusted blocks as every other model call does.
export { stripDelimiters, UNTRUSTED_WARNING };

export const SCREENER_SYSTEM_PROMPT = `You are Loupe, IsItLegit's page screener. You are shown one web page: its host, a screenshot when there is one, and its visible text. Decide whether the page is a fake, and which kind:

- credential: it imitates a brand to collect a sign-in (a copied bank, email, social network or government login);
- payment: it imitates a brand to collect card or payment details;
- fake_shop: a shop that is not what it claims, under a copied or an invented brand (too-good prices, no real company behind it);
- impersonation: a lookalike company, supplier or social page with no form, built to pass as a real one (for example changed banking details on a copied supplier site);
- none: the page is not a fake.

${UNTRUSTED_WARNING}

Answer with one JSON object and nothing else, with exactly these fields:
- brand: the brand or organisation the page presents itself as, at most 200 characters, or null when it presents none;
- has_login_form: true when the page asks for a username, email or password;
- has_payment_form: true when the page asks for card or payment details;
- lure: true when the page is a fake of any kind;
- lure_type: one of credential, payment, fake_shop, impersonation or none, and none exactly when lure is false;
- confidence: your confidence in lure, from 0 to 1.

Do not add a screener field or any other field.`;

export const MAX_TEXT_CHARACTERS = 6_000;
const NONCE = /^[0-9a-f]{32}$/;

export type ScreenMode = "image" | "text-only";

// The unsure band (D03 T04 §45): confidence is P(lure), so an answer inside the band is settled by neither side and
// escalates. One constant, read by the screening route, its tests and the offline capture queue.
export const ESCALATION_BAND = { low: 0.35, high: 0.65 } as const;
export const inEscalationBand = (confidence: number) =>
  confidence >= ESCALATION_BAND.low && confidence <= ESCALATION_BAND.high;
export type TextPart = { type: "text"; text: string };
export type ImagePart = { type: "image_url"; image_url: { url: string } };
export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: (TextPart | ImagePart)[] }
  | { role: "assistant"; content: string };
export type ScreenRequest = { messages: ChatMessage[] };

// A page's host as the request states it outside the untrusted block: a lowercase DNS name (punycode for IDNs), so
// nothing from an imported dataset can add a line there.
export const HOST = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;

export function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

// The one request both training and production send. The page text sits in an untrusted block in D03 T01 §6's format;
// the nonce is passed in by tests and §1's equality check, and is random otherwise.
export function buildScreenRequest(input: {
  image?: Uint8Array;
  host: string | null;
  text: string;
  mode: ScreenMode;
  nonce?: string;
}): ScreenRequest {
  const nonce = input.nonce ?? randomNonce();
  if (!NONCE.test(nonce)) throw new TypeError("nonce must be 32 lowercase hex digits (128 bits)");
  if (input.mode === "image" && !input.image) throw new TypeError("image mode needs the screenshot");
  if (input.host !== null && !HOST.test(input.host)) throw new TypeError("host must be a lowercase DNS name or null");
  if (input.mode === "image" && input.image && !jpegSize(input.image))
    throw new TypeError("the screenshot is not a whole JPEG");
  // D03 T01 §6's block: the text stripped of delimiters, then cut at a whole character, with no truncation marker.
  const block = untrustedBlock("page-text", input.text, { nonce, limit: MAX_TEXT_CHARACTERS, marker: false });
  const parts: (TextPart | ImagePart)[] = [
    {
      type: "text",
      text: `Host: ${input.host ?? "none"}\n\n${block}`,
    },
  ];
  if (input.mode === "image" && input.image)
    parts.push({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64(input.image)}` } });
  return {
    messages: [
      { role: "system", content: SCREENER_SYSTEM_PROMPT },
      { role: "user", content: parts },
    ],
  };
}

// One Fireworks JSONL line: the request's messages unchanged, then the answer (https://docs.fireworks.ai/fine-tuning/
// fine-tuning-models#vision-training).
export function buildTrainingLine(request: ScreenRequest, answer: PageAnswer): string {
  const checked = PageAnswer.parse(answer);
  return JSON.stringify({
    messages: [...request.messages, { role: "assistant", content: JSON.stringify(checked) }],
  });
}

// A whole JPEG's width and height, or null when the bytes are not one: every header segment must be complete, a frame
// must come before the scan, and the file must end with the end-of-image marker, so a truncated or damaged screenshot
// is refused here rather than at Fireworks.
export function jpegSize(bytes: Uint8Array): { width: number; height: number } | null {
  const n = bytes.length;
  if (n < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[n - 2] !== 0xff || bytes[n - 1] !== 0xd9) return null;
  let size: { width: number; height: number } | null = null;
  let at = 2;
  while (at + 4 <= n) {
    if (bytes[at] !== 0xff) return null;
    const marker = bytes[at + 1] as number;
    if (marker === 0xff) {
      at += 1; // fill byte
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2;
      continue;
    }
    if (marker === 0xd8 || marker === 0xd9) return null; // a second start, or an end before any scan
    const length = ((bytes[at + 2] as number) << 8) | (bytes[at + 3] as number);
    if (length < 2 || at + 2 + length > n) return null; // a segment cut short
    // SOF0 to SOF15, except DHT (C4), JPG (C8) and DAC (CC), carry the frame size.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (length < 8) return null;
      const height = ((bytes[at + 5] as number) << 8) | (bytes[at + 6] as number);
      const width = ((bytes[at + 7] as number) << 8) | (bytes[at + 8] as number);
      if (width === 0 || height === 0) return null;
      size = { width, height };
    }
    at += 2 + length;
    if (marker === 0xda) {
      // A scan: entropy-coded data runs to the next marker. Stuffed FF00, restart markers and fill bytes are data;
      // anything else ends the scan, and the walk goes on (a progressive JPEG has several scans) until the end marker.
      if (!size) return null;
      const dataStart = at;
      while (at < n - 1) {
        if (bytes[at] !== 0xff) {
          at += 1;
          continue;
        }
        const next = bytes[at + 1] as number;
        if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) at += 2;
        else if (next === 0xff) at += 1;
        else break;
      }
      if (at === dataStart) return null; // a scan header with no data
      if (at >= n - 1) return null; // data running off the end with no marker
      if (bytes[at + 1] === 0xd9) return at === n - 2 ? size : null; // the end marker, and nothing after it
    }
  }
  return null;
}

// Fireworks cuts training lines at 32,768 tokens by default; 30,000 leaves room for the chat template.
export const MAX_LINE_TOKENS = 30_000;
const CHARACTERS_PER_TOKEN = 3;
const PATCH = 14; // Muse Glimmer's ViT-G/14 perception encoder

// A deliberate overestimate until a training job reports real counts: text at 3 characters a token, and in image mode
// one token per 14 by 14 pixel patch of each screenshot.
export function estimateTokens(line: string, mode: ScreenMode): number {
  const parsed = JSON.parse(line) as { messages: { content: string | (TextPart | ImagePart)[] }[] };
  let characters = 0;
  let imageTokens = 0;
  for (const message of parsed.messages) {
    const parts =
      typeof message.content === "string" ? [{ type: "text", text: message.content } as TextPart] : message.content;
    for (const part of parts) {
      if (part.type === "text") characters += Array.from(part.text).length;
      else if (mode === "image") {
        const data = part.image_url.url.split(",", 2)[1] ?? "";
        const size = jpegSize(Uint8Array.from(atob(data), (c) => c.charCodeAt(0)));
        if (!size) throw new TypeError("an image part is not a readable JPEG");
        imageTokens += Math.ceil(size.width / PATCH) * Math.ceil(size.height / PATCH);
      }
    }
  }
  return Math.ceil(characters / CHARACTERS_PER_TOKEN) + imageTokens;
}

export function assertLineFits(line: string, mode: ScreenMode): void {
  const tokens = estimateTokens(line, mode);
  if (tokens > MAX_LINE_TOKENS)
    throw new RangeError(`training line of about ${tokens} tokens is over the ${MAX_LINE_TOKENS}-token limit`);
}
