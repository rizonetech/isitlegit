// The phrases of text written to steer an AI or a mail filter (D02 T05 §2; spec 4.3), matched as text streams in, before
// any reader cuts it: the hidden-text scanner feeds every chunk of visible and hidden text here, and the `checks` step
// feeds the cut body parts and text attachments whole (plan review: a span's 2,000 kept characters, the 200 kept spans
// and the summary's cut all lost text). Each pattern needs an instruction's shape, since the words alone ("system",
// "model", "safe") are everyday business English; matching is deterministic, so no text can talk it out of a finding.
import { decodeEntities } from "./hidden-text";

export const MAX_MATCHES = 20;
export const QUOTE_CHARS = 200;
// Text carried from one chunk to the next: longer than any match, so a chunk boundary never splits one unseen.
const CARRY = 400;

const AI = String.raw`(?:ai|a\.i\.|artificial intelligence|(?:ai |virtual |email |security )?assistant|(?:large )?language model|llm|chat ?bot|gpt|chatgpt|claude|copilot|gemini|the model|security (?:scanner|filter|bot)|(?:e-?mail|spam|phishing|mail) (?:filter|scanner|classifier|analy[sz]er)|automated (?:reviewer|scanner|filter))`;
const VERDICT = String.raw`(?:safe|legitimate|legit|genuine|clean|trusted|benign|harmless|not (?:spam|phishing|malicious|a scam|suspicious))`;
const MESSAGE = String.raw`(?:e-?mail|message|mail|invoice|attachment|document|request|payment request)`;

export const PATTERNS: readonly { name: string; pattern: RegExp }[] = [
  {
    name: "ignore-instructions",
    pattern:
      /\b(?:ignore|disregard|forget|override|bypass)\s+(?:(?:all|any|the|your|of)\s+){0,4}(?:previous|prior|earlier|above|preceding|original|system)\s+(?:instructions?|prompts?|rules|directions|guidelines|context)\b/gi,
  },
  {
    name: "role-for-ai",
    pattern: new RegExp(
      String.raw`\b(?:you are|you're|act as|pretend to be|role-?play as|behave as)\s+(?:an?\s+|the\s+)?${AI}\b`,
      "gi",
    ),
  },
  {
    name: "ai-addressed",
    pattern: new RegExp(
      String.raw`\b(?:if you are|note to|attention|dear|hey|hello)\s+(?:an?\s+|the\s+|any\s+)?${AI}s?\b|\b${AI}s?\s*[,:]\s*(?:please\s+)?(?:classify|mark|label|treat|report|flag|rate|consider|ignore|summari[sz]e)\b`,
      "gi",
    ),
  },
  {
    name: "mark-safe",
    pattern: new RegExp(
      String.raw`\b(?:mark|classify|label|flag|treat|report|rate|categori[sz]e|consider|deem)\s+(?:this|the|it|my)\s+(?:${MESSAGE}\s+)?as\s+(?:being\s+)?${VERDICT}\b`,
      "gi",
    ),
  },
  {
    name: "verified-safe",
    pattern: new RegExp(
      String.raw`\bthis\s+${MESSAGE}\s+(?:has been|is|was)\s+(?:already\s+)?(?:verified|confirmed|certified|approved|validated|whitelisted)\s+(?:as\s+|to be\s+)?${VERDICT}\b`,
      "gi",
    ),
  },
  { name: "system-prompt", pattern: /\bsystem\s+prompt\b|\bnew\s+(?:system\s+)?instructions?\s*:/gi },
  {
    // Chat-template markers, and an instruction heading: on a line of its own, or followed by a colon.
    name: "template-marker",
    pattern:
      /<\|\s*(?:system|im_start|im_end|user|assistant|endoftext)\s*\|>|\[\/?(?:INST|SYS)\]|<<\/?SYS>>|(?:^|\n)[ \t]*#{2,}[ \t]*(?:instructions?|system|response)[ \t]*(?=\n)|#{2,}[ \t]*(?:instructions?|system)[ \t]*:/gi,
  },
];

export type PhraseMatch = { pattern: string; quote: string; location: string };

// The matches across every stream of a case, at most MAX_MATCHES kept and the rest counted. A match whose pattern and
// text a stream of the same source already gave is dropped: the summary's HTML is a prefix of its cut part, and postal-mime
// renders the plain text from the HTML when a message has none.
export class PhraseLog {
  readonly matches: PhraseMatch[] = [];
  more = 0;
  readonly notChecked: { location: string; why: string }[] = [];
  notCheckedMore = 0;
  private readonly seen = new Set<string>();

  add(match: PhraseMatch, source: string, text: string): void {
    const key = `${source}\u0000${match.pattern}\u0000${text.toLowerCase()}`;
    if (this.seen.has(key)) return;
    if (this.seen.size < 4 * MAX_MATCHES) this.seen.add(key);
    if (this.matches.length < MAX_MATCHES) this.matches.push(match);
    else this.more++;
  }

  unchecked(location: string, why: string): void {
    if (this.notChecked.length < MAX_MATCHES) this.notChecked.push({ location, why });
    else this.notCheckedMore++;
  }
}

// One stream of text (a body's visible or hidden text, a part, an attachment), fed in chunks of any size. HTML text has
// its character references decoded, a reference split across chunks held back until it is whole; whitespace runs
// collapse to one space, line breaks kept.
export class PhraseStream {
  private carry = "";
  // Where `carry` starts in the stream, and each pattern's last match start, so a match is reported once.
  private offset = 0;
  private readonly last = new Map<string, number>();
  private held = "";

  constructor(
    private readonly log: PhraseLog,
    private readonly location: string,
    private readonly source: string,
    private readonly html: boolean,
  ) {}

  feed(chunk: string): void {
    let text = this.held + chunk;
    this.held = "";
    if (this.html) {
      const partial = /&[#a-z0-9]{0,32}$/i.exec(text);
      if (partial) {
        this.held = partial[0];
        text = text.slice(0, partial.index);
      }
      text = decodeEntities(text);
    }
    this.scan(text.replace(/[^\S\n]+/g, " ").replace(/ ?\n[\s]*/g, "\n"));
  }

  // The end of the stream: what was held back, and a line break, so a heading on the last line ends its line.
  end(): void {
    const rest = this.held;
    this.held = "";
    this.scan(`${this.html ? decodeEntities(rest) : rest}\n`);
  }

  private scan(text: string): void {
    if (!text) return;
    const buffer = this.carry + text;
    for (const { name, pattern } of PATTERNS) {
      pattern.lastIndex = 0;
      for (const m of buffer.matchAll(pattern)) {
        const at = this.offset + m.index;
        if (at <= (this.last.get(name) ?? -1)) continue;
        this.last.set(name, at);
        const from = Math.max(0, m.index - 40);
        const quote = buffer
          .slice(from, from + QUOTE_CHARS)
          .replace(/\s+/g, " ")
          .trim();
        this.log.add({ pattern: name, quote, location: this.location }, this.source, m[0].replace(/\s+/g, " "));
      }
    }
    const keep = Math.min(CARRY, buffer.length);
    this.offset += buffer.length - keep;
    this.carry = buffer.slice(buffer.length - keep);
  }
}

// The matches in whole texts, for tests and small inputs.
export function findInstructions(texts: { text: string; location: string; html?: boolean }[]): PhraseMatch[] {
  const log = new PhraseLog();
  for (const { text, location, html } of texts) {
    const stream = new PhraseStream(log, location, location, html ?? false);
    stream.feed(text);
    stream.end();
  }
  return log.matches;
}
