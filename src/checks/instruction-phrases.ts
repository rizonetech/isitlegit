// The phrases of text written to steer an AI or a mail filter (D02 T05 §2; spec 4.3), matched as text streams in, before
// any reader cuts it: the hidden-text scanner feeds every chunk of visible and hidden text here, and the `checks` step
// feeds the cut body parts and text attachments whole (plan review: a span's 2,000 kept characters, the 200 kept spans
// and the summary's cut all lost text). Each pattern needs an instruction's shape, since the words alone ("system",
// "model", "safe") are everyday business English; matching is deterministic, so no text can talk it out of a finding.
import { decodeEntities } from "./entities";
import { IgnorableStripper, kept } from "./ignorable";
import { hasInstruction, INSTRUCTION } from "./instruction-words";
import { type InvisibleRun, MAX_DECODED, MAX_INVISIBLE_RUNS, RunReader } from "./invisible-unicode";

// An invisible run as the log keeps it (D02 T05 §3): where it was read, and how strongly it weighs: high when its
// decoded text reads as an instruction, medium for other tag text, low for a run of other invisible characters.
// `instruction`: on a steering tag run, the instruction found in its decoded text (D02 T05 §6), where it starts and the
// text around it, however far into the run it sits.
export type RunInstruction = { text: string; offset: number };
export type LoggedRun = InvisibleRun & {
  location: string;
  severity: "high" | "medium" | "low";
  key?: string;
  instruction?: RunInstruction;
  // The run's whole decoded text as it streamed (D02 T05 §11), kept apart from the run record's bounded
  // excerpt above: up to MAX_RUN_TEXT characters, `runTextCut` when the run held more.
  runText?: string;
  runTextCut?: boolean;
};
// The decoded run text kept for the report's run detail (D02 T05 §11), a different quantity from the run
// record's MAX_DECODED excerpt (D02 T05 §3): the state stays bounded at each section's own bound.
export const MAX_RUN_TEXT = 8_000;
const RANK = { high: 0, medium: 1, low: 2 } as const;
// The runs the view carries: the strongest MAX_INVISIBLE_RUNS, then a count with the highest severity among the rest.
export type InvisibleText = { runs: LoggedRun[]; more: number; moreSeverity: LoggedRun["severity"] | null };
export const invisibleOf = (log: PhraseLog): InvisibleText => ({
  runs: log.invisible,
  more: log.invisibleMore,
  moreSeverity: log.invisibleMoreSeverity,
});

export const MAX_MATCHES = 20;
export const QUOTE_CHARS = 200;
// Scanned text carried from one chunk to the next: longer than any match, so a chunk boundary never splits one unseen.
const CARRY = 400;
// An unfinished word at a chunk's end waits for the next chunk (completion review: "system prompt" was matched in
// "system promptly" split after "prompt"); past this much, the stream is scanned anyway.
const MAX_PENDING = 4_096;
const REMOVED = "[removed: text written to steer an AI]";

// Who an instruction is addressed to. `AI_NAMED` leaves out what also names a person ("assistant" alone, "helpful
// assistant", "Claude", "Gemini"), for the forms that would read as ordinary mail to one (completion review: "Dear
// assistant, please book the meeting room").
const AI_NAMED = String.raw`(?:ai (?:assistant|scanner|filter|model|system|agent|reviewer|classifier|tool)|(?:virtual|email|security) assistant|ai|a\.i\.|artificial intelligence|(?:large )?language model|llm|chat\s*bot|chatgpt|gpt|copilot|the model|security (?:scanner|filter|bot)|(?:e-?mail|spam|phishing|mail) (?:filter|scanner|classifier|analy[sz]er)|automated (?:reviewer|scanner|filter))`;
const VERDICT = `(?:safe|legitimate|legit|genuine|clean|trusted|benign|harmless|not (?:spam|phishing|malicious|a scam|suspicious))`;
const MESSAGE = `(?:e-?mail|message|mail|invoice|attachment|document|request|payment request)`;
const VERB = `(?:classify|mark|label|flag|treat|rate|consider|ignore|approve|whitelist|summari[sz]e)`;

// A phrase's words may be separated by any whitespace, as a tab or a line break separates them in stored text (round
// 1: removal missed "AI\tassistants"), so every space in a pattern's source reads as `\s+`.
const phrase = (source: string) => new RegExp(source.replace(/ /g, String.raw`\s+`), "gi");

export const PATTERNS: readonly { name: string; pattern: RegExp }[] = [
  {
    name: "ignore-instructions",
    pattern:
      /\b(?:ignore|disregard|forget|override|bypass)\s+(?:(?:all|any|the|your|of)\s+){0,4}(?:previous|prior|earlier|above|preceding|original|system)\s+(?:instructions?|prompts?|rules|directions|guidelines|context)\b/gi,
  },
  {
    // Role assignment: an unambiguous AI name, or an ambiguous assistant role ("helpful/harmless/obedient/compliant
    // assistant") when paired with a persona switch ("you are now", "act as", ...) and a steering directive (`VERB`),
    // so ordinary human-assistant mail ("You are a helpful assistant to our warehouse manager") stays unflagged.
    name: "role-for-ai",
    pattern: phrase(
      String.raw`\b(?:from now on[, ]+)?(?:you are|you're|act as|pretend to be|role-?play as|behave as)(?:\s+now)?\s+(?:an?\s+|the\s+)?${AI_NAMED}\b|\b(?:(?:from now on[, ]+)?(?:you are|you're)\s+now|(?:from now on[, ]+)?(?:act|behave|role-?play)\s+as|pretend to be)\s+(?:an?\s+|the\s+)?(?:helpful|harmless|obedient|compliant)\s+assistant(?:\s*[.!;:,]\s*(?:(?:you\s+)?(?:must|should|will|shall|always|never)\s+|(?:please\s+)?)?${VERB}\b|\s+(?:that|who|and)\s+(?:(?:must|should|always|never)\s+)?${VERB}\b)`,
    ),
  },
  {
    // An AI greeted, or told what to do (completion review: "AI assistants should mark it safe").
    name: "ai-addressed",
    pattern: phrase(
      String.raw`\b(?:if you are|note to|attention|dear|hey|hello)\s+(?:an?\s+|the\s+|any\s+)?${AI_NAMED}s?\b|\b${AI_NAMED}s?(?:\s*[,:]\s*(?:please\s+)?|\s+(?:should|must|need to|are to|is to)\s+)${VERB}\b`,
    ),
  },
  {
    // Told to mark the message safe: "as" may be left out after a labelling verb, when what is marked is the message
    // or "it" (completion review: "mark this email safe"; "mark the safe" is a strongbox).
    name: "mark-safe",
    pattern: phrase(
      String.raw`\b(?:(?:mark|classify|label|flag|categori[sz]e|tag|whitelist)\s+(?:it|(?:this|the|my)\s+${MESSAGE})\s+(?:as\s+)?(?:being\s+)?${VERDICT}|(?:mark|classify|label|flag|treat|report|rate|categori[sz]e|consider|deem)\s+(?:this|the|it|my)\s+(?:${MESSAGE}\s+)?as\s+(?:being\s+)?${VERDICT})\b`,
    ),
  },
  {
    name: "verified-safe",
    pattern: phrase(
      String.raw`\bthis\s+${MESSAGE}\s+(?:has been|is|was)\s+(?:already\s+)?(?:verified|confirmed|certified|approved|validated|whitelisted)\s+(?:as\s+|to be\s+)?${VERDICT}\b`,
    ),
  },
  // "New instructions:" alone is ordinary mail (completion review); a new system prompt is not.
  { name: "system-prompt", pattern: /\bsystem\s+prompt\b|\bnew\s+system\s+(?:prompt|instructions?)\s*:/gi },
  {
    // Chat-template markers, and an instruction heading: on a line of its own, or followed by a colon. A run of hashes
    // is tried from its first only (`(?<!#)`), so a long run is read once, not once per hash (round 1).
    name: "template-marker",
    pattern:
      /<\|\s*(?:system|im_start|im_end|user|assistant|endoftext)\s*\|>|\[\/?(?:INST|SYS|SYSTEM)\]|<<\/?SYS>>|(?:^|\n)[ \t]*#{2,}[ \t]*(?:instructions?|system|response)[ \t]*(?=\n)|(?<!#)#{2,}[ \t]*(?:instructions?|system)[ \t]*:/gi,
  },
];

// Whitespace as the phrases read it: runs collapse to one space, line breaks kept.
const normal = (text: string) => text.replace(/[^\S\n]+/g, " ").replace(/ ?\n\s*/g, "\n");

// The text with every phrase replaced by a marker, for what a model reads (the file's Goal; completion review): the
// visible text stored as `visible.txt`. The original stays in R2, and each phrase is evidence.
export function withoutInstructions(text: string): string {
  // What the second reading finds (D02 T05 §5) goes too: each pattern is matched against the text with its ignorable
  // characters taken out, and the original span it covers is removed, invisible characters and all.
  const positions = kept(text);
  let stripped = "";
  for (const at of positions) stripped += String.fromCodePoint(text.codePointAt(at) ?? 0);
  // Each stripped code unit's character index, so a match's ends map back to `positions` in constant time
  // (completion review: a linear search per match was quadratic on a long body).
  const indexAt: number[] = [];
  let index = 0;
  for (const ch of stripped) {
    for (let k = 0; k < ch.length; k++) indexAt.push(index);
    index++;
  }
  // Matched as the phrase streams read text (round 1): every whitespace character but a line break read as a space,
  // one character for one so positions hold (a `\r` before a line break no longer hides a heading's end), and the
  // text ended by a line break, as `PhraseStream.end` ends it, so a heading on the last line ends its line.
  const read = `${stripped.replace(/[^\S\n]/g, " ")}\n`;
  const spans: [number, number][] = [];
  for (const { pattern } of PATTERNS) {
    pattern.lastIndex = 0;
    for (const m of read.matchAll(pattern)) {
      // A line break or blanks a pattern takes at its edges (a heading's own line) stay: only the phrase goes.
      let start = m.index;
      let end = Math.min(m.index + m[0].length, stripped.length);
      while (start < end && (read[start] === "\n" || read[start] === " ")) start++;
      while (end > start && (read[end - 1] === "\n" || read[end - 1] === " ")) end--;
      if (end <= start) continue;
      const from = positions[indexAt[start] ?? 0] ?? 0;
      const endAt = positions[indexAt[end - 1] ?? 0] ?? from;
      spans.push([from, endAt + ((text.codePointAt(endAt) ?? 0) > 0xffff ? 2 : 1)]);
    }
  }
  spans.sort((a, b) => a[0] - b[0]);
  let out = "";
  let cursor = 0;
  for (const [from, to] of spans) {
    if (to <= cursor) continue;
    out += text.slice(cursor, Math.max(cursor, from)) + REMOVED;
    cursor = to;
  }
  out += text.slice(cursor);
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
  // Streams that carried any text, so a case with none read is told from one read clean (D02 T01 §3's round 1).
  texts = 0;
  // Invisible runs (D02 T05 §3), the strongest kept first (plan review: twenty low runs hid an encoded instruction),
  // the rest counted with the highest severity among them.
  readonly invisible: LoggedRun[] = [];
  invisibleMore = 0;
  invisibleMoreSeverity: LoggedRun["severity"] | null = null;
  private readonly runsSeen = new Set<string>();
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

  // `nth`: which of its stream's runs of this kind and content it is, so the same run read twice (the summary's HTML and
  // its cut part, which read their runs in the same order) is one, while two alike in one text stay two.
  // `steering`: whether the run's decoded text reads as an instruction, judged by the stream that read it whole.
  addRun(
    run: InvisibleRun,
    location: string,
    source: string,
    nth: number,
    steering: boolean,
    instruction: RunInstruction | null = null,
    runText: string | null = null,
    runTextCut = false,
  ): void {
    const key = `${source}\u0000${location}\u0000${run.kind}\u0000${run.fingerprint ?? run.decoded ?? run.length}\u0000${nth}`;
    if (this.runsSeen.has(key)) {
      // The same run read again: a stronger judgement of it is kept (round 3).
      const kept = this.invisible.find((r) => r.key === key);
      if (kept && steering && kept.severity === "medium") {
        kept.severity = "high";
        if (instruction) kept.instruction = instruction;
        this.invisible.sort((a, b) => RANK[a.severity] - RANK[b.severity]);
      }
      if (kept && runText !== null && kept.runText === undefined) {
        kept.runText = runText;
        if (runTextCut) kept.runTextCut = true;
      }
      return;
    }
    if (this.runsSeen.size < 64 * MAX_INVISIBLE_RUNS) this.runsSeen.add(key);
    // The decoded words kept for the view are bounded; the phrases have read them whole.
    const logged: LoggedRun = {
      ...run,
      decoded: run.decoded === null ? null : run.decoded.slice(0, MAX_DECODED),
      location,
      key,
      severity: run.decoded === null ? "low" : steering ? "high" : "medium",
    };
    if (steering && instruction) logged.instruction = instruction;
    if (runText !== null) {
      logged.runText = runText;
      if (runTextCut) logged.runTextCut = true;
    }
    let dropped: LoggedRun | null = logged;
    if (this.invisible.length < MAX_INVISIBLE_RUNS) {
      this.invisible.push(logged);
      dropped = null;
    } else {
      const weakest = this.invisible.reduce(
        (w, r, i) => (RANK[r.severity] > RANK[(this.invisible[w] as LoggedRun).severity] ? i : w),
        0,
      );
      if (RANK[logged.severity] < RANK[(this.invisible[weakest] as LoggedRun).severity]) {
        dropped = this.invisible[weakest] as LoggedRun;
        this.invisible[weakest] = logged;
      }
    }
    if (dropped) {
      this.invisibleMore++;
      if (!this.invisibleMoreSeverity || RANK[dropped.severity] < RANK[this.invisibleMoreSeverity])
        this.invisibleMoreSeverity = dropped.severity;
    }
    this.invisible.sort((a, b) => RANK[a.severity] - RANK[b.severity]);
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
  private counted = false;
  // Invisible runs taken out of the text as it streams (D02 T05 §3), so the phrases match what is left.
  private readonly runs = new RunReader(
    (run) => this.foundRun(run),
    (text) => this.tagText(text),
  );
  // The open tag run's decoded text, read as hidden text as it streams (round 1: never held whole), and where in it the
  // instruction is (D02 T05 §6).
  private nested: PhraseStream | null = null;
  private spot: InstructionSpot | null = null;
  // The open run's decoded text kept for the report (D02 T05 §11), bounded at MAX_RUN_TEXT as it streams.
  private runText = "";
  private runTextCut = false;
  // Matches this stream found, counted before the log's de-duplication, and whether §1's instruction words appeared
  // anywhere in what it read (round 2: words past a decoded run's bounded excerpt were missed).
  matched = 0;
  words = false;
  private readonly runCounts = new Map<string, number>();

  private readonly log: PhraseLog;
  private readonly location: string;
  private readonly source: string;
  private readonly html: boolean;
  // A second reading of the same text with its ignorable characters taken out (D02 T05 §5), matching only: its matches
  // go to the same location, and the log keeps one of a match both readings found. A shadow has no shadow of its own
  // and counts no text.
  private readonly shadow: PhraseStream | null;
  private readonly stripper: IgnorableStripper | null;

  constructor(log: PhraseLog, location: string, source: string, html: boolean, shadow = false) {
    this.log = log;
    this.location = location;
    this.source = source;
    this.html = html;
    this.shadow = shadow ? null : new PhraseStream(log, location, source, false, true);
    this.stripper = shadow ? null : new IgnorableStripper();
    if (shadow) this.counted = true;
  }

  feed(chunk: string): void {
    if (!this.counted && chunk.trim()) {
      this.counted = true;
      this.log.texts++;
    }
    let text = this.held + chunk;
    this.held = "";
    if (this.html) {
      // A reference cut at the chunk's end waits for its rest. Leading zeros do not change a numeric reference's
      // value, so they collapse to one while it waits, and a reference padded to any length is still held whole
      // (round 3: `&#` and forty zeros, then `105;`, was decoded before its digits arrived).
      const at = text.lastIndexOf("&");
      const tail = at >= 0 ? text.slice(at) : "";
      if (at >= 0 && /^&(?:#x?[0-9a-f]*|[a-z][a-z0-9]*)?$/i.test(tail)) {
        const held = tail.replace(/^(&#x?)0+/i, "$10");
        if (held.length <= 64) {
          this.held = held;
          text = text.slice(0, at);
        }
      }
      text = decodeEntities(text);
    }
    const read = this.runs.feed(text);
    this.scan(read, false);
    if (this.shadow && this.stripper) this.shadow.feed(this.stripper.feed(read));
  }

  // The end of the stream: what was held back, and a line break, so a heading on the last line ends its line.
  end(): void {
    const rest = this.held;
    this.held = "";
    const tail = this.runs.feed(this.html ? decodeEntities(rest) : rest) + this.runs.end();
    this.scan(`${tail}\n`, true);
    if (this.shadow && this.stripper) {
      this.shadow.feed(this.stripper.feed(tail) + this.stripper.end());
      this.shadow.end();
    }
  }

  // A run found in this stream: logged, and its decoded text read by the phrases as hidden text.
  private tagText(text: string): void {
    if (!this.nested) {
      const hidden = this.location.startsWith("attachment:")
        ? `attachment-hidden:${this.location.slice(11)}`
        : this.location.startsWith("upload:")
          ? `upload-hidden:${this.location.slice(7)}`
          : this.location.startsWith("attachment-hidden:") || this.location.startsWith("upload-hidden:")
            ? this.location
            : this.location === "subject" || this.location === "subject-hidden"
              ? "subject-hidden"
              : "hidden";
      this.nested = new PhraseStream(this.log, hidden, this.source, false);
      this.spot = new InstructionSpot();
    }
    if (this.runText.length + text.length > MAX_RUN_TEXT) this.runTextCut = true;
    if (this.runText.length < MAX_RUN_TEXT) this.runText += text.slice(0, MAX_RUN_TEXT - this.runText.length);
    this.nested.feed(text);
    this.spot?.feed(text);
  }

  private foundRun(run: InvisibleRun): void {
    const nested = this.nested;
    const spot = this.spot;
    const runText = this.runText;
    const runTextCut = this.runTextCut;
    this.nested = null;
    this.spot = null;
    this.runText = "";
    this.runTextCut = false;
    nested?.end();
    const steering =
      run.decoded !== null && ((nested?.matched ?? 0) > 0 || (nested?.words ?? false) || hasInstruction(run.decoded));
    // A run decoded whole in one piece (not streamed) reaches `tagText` too, so its spot has read it.
    const instruction = steering ? (spot?.end() ?? null) : null;
    const which = `${run.kind}\u0000${run.fingerprint ?? run.decoded ?? run.length}`;
    const nth = (this.runCounts.get(which) ?? 0) + 1;
    this.runCounts.set(which, nth);
    this.log.addRun(run, this.location, this.source, nth, steering, instruction, runText || null, runTextCut);
  }

  private scan(text: string, final: boolean): void {
    const joined = normal(this.carry + this.pending + text);
    let cut = joined.length;
    if (!final) {
      // The unfinished word, read backwards from the end, never past the carry: a suffix search tried from every
      // position was quadratic on a long word before punctuation (round 2).
      cut = joined.length;
      while (cut > this.carry.length && /\w/.test(joined[cut - 1] as string)) cut--;
      if (joined.length - cut > MAX_PENDING) cut = joined.length - 64;
    }
    const region = joined.slice(0, cut);
    if (!this.words && hasInstruction(region)) this.words = true;
    for (const { name, pattern } of PATTERNS) {
      pattern.lastIndex = 0;
      for (const m of region.matchAll(pattern)) {
        const at = this.offset + m.index;
        // A match at the very start of carried text has lost what stood before it: its `\b` or `(?<!#)` holds only
        // because the carry was cut there (round 1: a run of hashes matched again from the carry's first hash).
        if ((m.index === 0 && this.offset > 0) || at <= (this.last.get(name) ?? -1)) continue;
        this.last.set(name, at);
        this.matched++;
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

// Where a tag run's instruction is (D02 T05 §6): fed the run's decoded text in chunks of any size, it keeps the earliest
// phrase match (`PATTERNS`) and the earliest §1 instruction word (`INSTRUCTION`), each with the text around it, and
// gives the phrase, else the word. The decoded text is printable ASCII (tags U+E0020 to U+E007E), so a position in it is
// a character and a code unit alike, and its only whitespace is the space: a run of spaces is read as one, as `normal`
// reads it, and a run of hashes as at most SPOT_HASHES (completion review: a heading of 500 hashes outran the window, so
// where it started depended on the chunks, and filled the excerpt; the heading pattern's `#{2,}` reads the same either
// way), each character read mapped back to where it stands in the run. It holds a bounded window, never the run.
// Up to SPOT_BEFORE characters before the instruction and the rest after it, SPOT_TEXT in all: within the 255 a detail
// string is stored to (`fittedDetail`), so the excerpt is never cut there.
const SPOT_BEFORE = 80;
const SPOT_AFTER = 80;
const SPOT_TEXT = 250;
const SPOT_HASHES = 6;
const SPOT_KEEP = 400;
type Spot = { offset: number; text: string; owed: number };
export class InstructionSpot {
  private window = "";
  private at: number[] = [];
  private raw = 0;
  private space = false;
  private hashes = 0;
  // Whether characters before the window were dropped: a match at its first character has lost what stood before it.
  private trimmed = false;
  private phrase: Spot | null = null;
  private word: Spot | null = null;
  private readonly wordPattern = new RegExp(INSTRUCTION.source, "gi");

  feed(chunk: string): void {
    this.append(chunk);
    this.scan(false);
  }

  // The instruction found, the phrase before the word; null when the run held neither.
  end(): RunInstruction | null {
    // The line break the phrase stream reads at its end, so a heading that ends the run ends its line (completion
    // review: `## response` at the run's end was found by the detector and not here).
    this.window += "\n";
    this.at.push(this.raw);
    this.scan(true);
    const found = this.phrase ?? this.word;
    return found ? { text: found.text.replace(/ +/g, " ").trim().slice(0, SPOT_TEXT), offset: found.offset } : null;
  }

  private append(chunk: string): void {
    for (const ch of chunk) {
      const isSpace = /\s/.test(ch);
      this.hashes = ch === "#" ? this.hashes + 1 : 0;
      if (!(isSpace && this.space) && this.hashes <= SPOT_HASHES) {
        this.window += isSpace ? " " : ch;
        this.at.push(this.raw);
        // The text after a spot already found, until it has its context.
        for (const spot of [this.phrase, this.word])
          if (spot && spot.owed > 0) {
            spot.text += isSpace ? " " : ch;
            spot.owed--;
          }
      }
      this.space = isSpace;
      this.raw += ch.length;
    }
  }

  private scan(final: boolean): void {
    const text = this.window;
    // An unfinished word at the end waits for its rest ("ai" may become "aim"), unless the run has ended.
    let cut = text.length;
    if (!final) {
      while (cut > 0 && /\w/.test(text[cut - 1] as string)) cut--;
      // A word longer than any the patterns name is read without waiting (the window stays bounded).
      if (text.length - cut > MAX_PENDING) cut = text.length - 64;
    }
    const region = text.slice(0, cut);
    const take = (start: number, matched: string, current: Spot | null): Spot | null => {
      // The instruction starts at its first visible character, not the space a heading's pattern may begin with.
      const lead = matched.length - matched.trimStart().length;
      const index = start + lead;
      const length = matched.length - lead;
      const offset = this.at[index] as number;
      if (current && current.offset <= offset) return current;
      // A match too long for the excerpt keeps its end and what follows it.
      const from = Math.max(0, index - SPOT_BEFORE, index + length + SPOT_AFTER - SPOT_TEXT);
      const to = Math.min(text.length, Math.max(from + SPOT_TEXT, index + length));
      return { offset, text: text.slice(from, to), owed: Math.max(from + SPOT_TEXT, index + length) - to };
    };
    // The first match a pattern has here that stands on what was read before it.
    const first = (pattern: RegExp) => {
      for (const m of region.matchAll(pattern)) if (m.index > 0 || !this.trimmed) return m;
      return null;
    };
    for (const { pattern } of PATTERNS) {
      const m = first(pattern);
      if (m) this.phrase = take(m.index, m[0], this.phrase);
    }
    if (!this.word) {
      const m = first(this.wordPattern);
      if (m) this.word = take(m.index, m[0], this.word);
    }
    // Keep the end of what was read, for a match that crosses into the next chunk, and the unfinished word.
    const keepFrom = Math.max(0, cut - SPOT_KEEP);
    if (keepFrom > 0) {
      this.window = text.slice(keepFrom);
      this.at = this.at.slice(keepFrom);
      this.trimmed = true;
    }
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
