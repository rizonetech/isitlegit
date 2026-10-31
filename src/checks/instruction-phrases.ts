// The phrases of text written to steer an AI or a mail filter (D02 T05 §2; spec 4.3), matched as text streams in, before
// any reader cuts it: the hidden-text scanner feeds every chunk of visible and hidden text here, and the `checks` step
// feeds the cut body parts and text attachments whole (plan review: a span's 2,000 kept characters, the 200 kept spans
// and the summary's cut all lost text). Each pattern needs an instruction's shape, since the words alone ("system",
// "model", "safe") are everyday business English; matching is deterministic, so no text can talk it out of a finding.
import { decodeEntities } from "./hidden-text";

export const MAX_MATCHES = 20;
export const QUOTE_CHARS = 200;
// Scanned text carried from one chunk to the next: longer than any match, so a chunk boundary never splits one unseen.
const CARRY = 400;
// An unfinished word at a chunk's end waits for the next chunk (completion review: "system prompt" was matched in
// "system promptly" split after "prompt"); past this much, the stream is scanned anyway.
const MAX_PENDING = 4_096;
const REMOVED = "[removed: text written to steer an AI]";

// Who an instruction is addressed to. `AI_NAMED` leaves out what also names a person ("assistant" alone, "Claude",
// "Gemini"), for the forms that would read as ordinary mail to one (completion review: "Dear assistant, please book
// the meeting room").
const AI_NAMED = String.raw`(?:ai (?:assistant|scanner|filter|model|system|agent|reviewer|classifier|tool)|(?:virtual|email|security) assistant|ai|a\.i\.|artificial intelligence|(?:large )?language model|llm|chat ?bot|chatgpt|gpt|copilot|the model|security (?:scanner|filter|bot)|(?:e-?mail|spam|phishing|mail) (?:filter|scanner|classifier|analy[sz]er)|automated (?:reviewer|scanner|filter))`;
const VERDICT = String.raw`(?:safe|legitimate|legit|genuine|clean|trusted|benign|harmless|not (?:spam|phishing|malicious|a scam|suspicious))`;
const MESSAGE = String.raw`(?:e-?mail|message|mail|invoice|attachment|document|request|payment request)`;
const VERB = String.raw`(?:classify|mark|label|flag|treat|rate|consider|ignore|approve|whitelist|summari[sz]e)`;

export const PATTERNS: readonly { name: string; pattern: RegExp }[] = [
  {
    name: "ignore-instructions",
    pattern:
      /\b(?:ignore|disregard|forget|override|bypass)\s+(?:(?:all|any|the|your|of)\s+){0,4}(?:previous|prior|earlier|above|preceding|original|system)\s+(?:instructions?|prompts?|rules|directions|guidelines|context)\b/gi,
  },
  {
    name: "role-for-ai",
    pattern: new RegExp(
      String.raw`\b(?:you are|you're|act as|pretend to be|role-?play as|behave as)\s+(?:an?\s+|the\s+)?${AI_NAMED}\b`,
      "gi",
    ),
  },
  {
    // An AI greeted, or told what to do (completion review: "AI assistants should mark it safe").
    name: "ai-addressed",
    pattern: new RegExp(
      String.raw`\b(?:if you are|note to|attention|dear|hey|hello)\s+(?:an?\s+|the\s+|any\s+)?${AI_NAMED}s?\b|\b${AI_NAMED}s?(?:\s*[,:]\s*(?:please\s+)?|\s+(?:should|must|will|shall|need to|are to|is to)\s+)${VERB}\b`,
      "gi",
    ),
  },
  {
    // Told to mark the message safe: "as" may be left out after a labelling verb, when what is marked is the message
    // or "it" (completion review: "mark this email safe"; "mark the safe" is a strongbox).
    name: "mark-safe",
    pattern: new RegExp(
      String.raw`\b(?:(?:mark|classify|label|flag|categori[sz]e|tag|whitelist)\s+(?:it|(?:this|the|my)\s+${MESSAGE})\s+(?:as\s+)?(?:being\s+)?${VERDICT}|(?:mark|classify|label|flag|treat|report|rate|categori[sz]e|consider|deem)\s+(?:this|the|it|my)\s+(?:${MESSAGE}\s+)?as\s+(?:being\s+)?${VERDICT})\b`,
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
  // "New instructions:" alone is ordinary mail (completion review); a new system prompt is not.
  { name: "system-prompt", pattern: /\bsystem\s+prompt\b|\bnew\s+system\s+(?:prompt|instructions?)\s*:/gi },
  {
    // Chat-template markers, and an instruction heading: on a line of its own, or followed by a colon.
    name: "template-marker",
    pattern:
      /<\|\s*(?:system|im_start|im_end|user|assistant|endoftext)\s*\|>|\[\/?(?:INST|SYS)\]|<<\/?SYS>>|(?:^|\n)[ \t]*#{2,}[ \t]*(?:instructions?|system|response)[ \t]*(?=\n)|#{2,}[ \t]*(?:instructions?|system)[ \t]*:/gi,
  },
];

// Whitespace as the phrases read it: runs collapse to one space, line breaks kept.
const normal = (text: string) => text.replace(/[^\S\n]+/g, " ").replace(/ ?\n\s*/g, "\n");

// The text with every phrase replaced by a marker, for what a model reads (the file's Goal; completion review): the
// visible text stored as `visible.txt`. The original stays in R2, and each phrase is evidence.
export function withoutInstructions(text: string): string {
  let out = text;
  for (const { pattern } of PATTERNS) out = out.replace(pattern, REMOVED);
  return out;
}

export type PhraseMatch = { pattern: string; quote: string; location: string; artefact?: string };

// The matches across every stream of a case, at most MAX_MATCHES kept and the rest counted. A source is one body or one
// stored attachment; within it, a match a reading of the same location already gave is dropped (the summary's HTML is a
// prefix of its cut part), and so is a plain-text match any location gave (postal-mime renders the plain text from the
// HTML when a message has none); visible and hidden text, and two attachments of one name, stay apart (completion
// review).
export class PhraseLog {
  readonly matches: PhraseMatch[] = [];
  more = 0;
  readonly notChecked: { location: string; why: string; artefact?: string }[] = [];
  notCheckedMore = 0;
  private readonly seen = new Set<string>();
  private readonly anywhere = new Set<string>();

  add(match: PhraseMatch, source: string, text: string): void {
    const phrase = `${source}\u0000${match.pattern}\u0000${text.toLowerCase()}`;
    const here = `${match.location}\u0000${phrase}`;
    if (this.seen.has(here) || (match.location === "text" && this.anywhere.has(phrase))) return;
    if (this.seen.size < 4 * MAX_MATCHES) {
      this.seen.add(here);
      this.anywhere.add(phrase);
    }
    if (this.matches.length < MAX_MATCHES) this.matches.push(match);
    else this.more++;
  }

  unchecked(location: string, why: string, artefact?: string): void {
    if (this.notChecked.length < MAX_MATCHES)
      this.notChecked.push(artefact ? { location, why, artefact } : { location, why });
    else this.notCheckedMore++;
  }
}

// One stream of text (a body's visible or hidden text, a part, an attachment), fed in chunks of any size; what it
// finds does not depend on where the chunks break. HTML text has its character references decoded, a reference split
// across chunks held back until it is whole; whitespace is read as `normal` gives it, across chunk joins too.
export class PhraseStream {
  // Scanned text kept for context, then text not scanned yet (an unfinished word); `offset` is where `carry` starts.
  private carry = "";
  private pending = "";
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
    this.scan(text, false);
  }

  // The end of the stream: what was held back, and a line break, so a heading on the last line ends its line.
  end(): void {
    const rest = this.held;
    this.held = "";
    this.scan(`${this.html ? decodeEntities(rest) : rest}\n`, true);
  }

  private scan(text: string, final: boolean): void {
    const joined = normal(this.carry + this.pending + text);
    let cut = joined.length;
    if (!final) {
      const word = /\w*$/.exec(joined.slice(this.carry.length));
      cut = joined.length - (word?.[0].length ?? 0);
      if (joined.length - cut > MAX_PENDING) cut = joined.length - 64;
    }
    const region = joined.slice(0, cut);
    for (const { name, pattern } of PATTERNS) {
      pattern.lastIndex = 0;
      for (const m of region.matchAll(pattern)) {
        const at = this.offset + m.index;
        if (at <= (this.last.get(name) ?? -1)) continue;
        this.last.set(name, at);
        const from = Math.max(0, m.index - 40);
        const quote = region
          .slice(from, from + QUOTE_CHARS)
          .replace(/\s+/g, " ")
          .trim();
        const match: PhraseMatch = { pattern: name, quote, location: this.location };
        if (this.source !== "body") match.artefact = this.source;
        this.log.add(match, this.source, m[0].replace(/\s+/g, " "));
      }
    }
    const keepFrom = Math.max(0, cut - CARRY);
    this.offset += keepFrom;
    this.carry = joined.slice(keepFrom, cut);
    this.pending = joined.slice(cut);
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
