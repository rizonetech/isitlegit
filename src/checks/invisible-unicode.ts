// Text hidden in characters no font draws (D02 T05 §3): the Unicode tag block (U+E0000 to U+E007F), which spells ASCII
// invisibly, and runs of default-ignorable characters. §1 decides what styles and markup hide; these hide in the text
// itself, and pass into what a model reads as if seen. The joining a script or an emoji sequence needs (a zero-width
// joiner between emoji or Indic letters, a variation selector after an emoji) never puts three default-ignorables in a
// row, so a run of three or more is hidden text; a tag run is decoded unless it is one of the subdivision flags Unicode
// recommends (England, Scotland, Wales; UTS #51 Annex C), since any other tag sequence is not drawn as a flag either
// (plan review: a black flag over tag-spelled `safe` passed as one).
//
// The phrase streams (./instruction-phrases) run every body and attachment text through `RunReader` as it streams, so
// a run beyond a reader's cut or split across chunks is found, and the text they match is the text without the runs.

export const MAX_INVISIBLE_RUNS = 20;
const MIN_RUN = 3;

export type InvisibleRun = {
  kind: "tag" | "ignorable";
  // A tag run's ASCII as it spells it; null for a run of other default-ignorables.
  decoded: string | null;
  // How many characters the run holds.
  length: number;
  // The whole run's identity (its length and a hash of every character), so two runs alike only in their kept excerpt
  // are two (round 3); set by `RunReader`.
  fingerprint?: string;
};

// Unicode's Default_Ignorable_Code_Point (DerivedCoreProperties.txt, Unicode 15.1).
const IGNORABLE: readonly [number, number][] = [
  [0x00ad, 0x00ad],
  [0x034f, 0x034f],
  [0x061c, 0x061c],
  [0x115f, 0x1160],
  [0x17b4, 0x17b5],
  [0x180b, 0x180f],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x206f],
  [0x3164, 0x3164],
  [0xfe00, 0xfe0f],
  [0xfeff, 0xfeff],
  [0xffa0, 0xffa0],
  [0xfff0, 0xfff8],
  [0x1bca0, 0x1bca3],
  [0x1d173, 0x1d17a],
  [0xe0000, 0xe0fff],
];
export function isIgnorable(code: number): boolean {
  for (const [from, to] of IGNORABLE) if (code >= from && code <= to) return true;
  return false;
}
const isTag = (code: number) => code >= 0xe0000 && code <= 0xe007f;
const BLACK_FLAG = 0x1f3f4;
const CANCEL_TAG = 0xe007f;
// The recommended subdivision flags' tag identifiers (UTS #51, emoji-sequences.txt: RGI_Emoji_Tag_Sequence).
const RGI_FLAGS = new Set(["gbeng", "gbsct", "gbwls"]);

// What a run of default-ignorables is, given the character before it: a recommended flag's tags or a run of one or two
// (kept as text, null), a tag run (decoded), or a run of three or more others.
// Whether a black flag's tags (`run` ends with its cancel tag) are a recommended flag; only a run of a flag's length is
// spelled out, so an attacker's run of any size costs nothing here (completion review: spreading 150,000 tags into one
// call overflowed the stack).
const isFlag = (run: readonly number[]) =>
  run.length >= 3 &&
  run.length <= 7 &&
  run[run.length - 1] === CANCEL_TAG &&
  RGI_FLAGS.has(
    run
      .slice(0, -1)
      .map((c) => String.fromCharCode(c - 0xe0000))
      .join(""),
  );

export function classify(run: readonly number[], before: number | undefined): InvisibleRun | null {
  const tags = run.filter(isTag);
  if (before === BLACK_FLAG && run.length === tags.length && isFlag(run)) return null;
  if (tags.length)
    return {
      kind: "tag",
      decoded: tags
        .filter((c) => c >= 0xe0020 && c <= 0xe007e)
        .map((c) => String.fromCharCode(c - 0xe0000))
        .join(""),
      length: run.length,
    };
  return run.length >= MIN_RUN ? { kind: "ignorable", decoded: null, length: run.length } : null;
}

// A run's first code points kept: enough to tell a recommended flag (seven at most) or a run of one or two kept as text.
const HEAD = 8;
// A tag run's decoded text kept for the evidence; the phrases are handed it all as it streams.
export const MAX_DECODED = 8_000;
const printable = (code: number) => code >= 0xe0020 && code <= 0xe007e;

// Reads text chunk by chunk, taking out the runs it finds and giving back the rest, in bounded state whatever a run's
// length (round 1: a 24 MiB run of tags, held whole, exhausted memory): a run keeps its first HEAD code points, its
// length, its tag count and the first MAX_DECODED decoded characters. A tag run's decoded text goes to `tagText` as it
// arrives (once the run is too long to be a flag, or when it ends), then `found` names the run; a recommended flag is
// kept as text the moment its cancel tag arrives, so what follows it starts a run of its own. A surrogate pair cut by a
// chunk's end waits for the next chunk.
export class RunReader {
  private head: number[] = [];
  private length = 0;
  private tags = 0;
  private decoded = "";
  private streaming = false;
  // FNV-1a over the run's code points.
  private hash = 0x811c9dc5;
  private before: number | undefined;
  private highSurrogate = "";
  private readonly found: (run: InvisibleRun) => void;
  private readonly tagText: (text: string) => void;

  constructor(found: (run: InvisibleRun) => void, tagText: (text: string) => void = () => {}) {
    this.found = found;
    this.tagText = tagText;
  }

  feed(chunk: string): string {
    let text = this.highSurrogate + chunk;
    this.highSurrogate = "";
    const last = text.charCodeAt(text.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) {
      this.highSurrogate = text.slice(-1);
      text = text.slice(0, -1);
    }
    let out = "";
    let streamed = "";
    for (const ch of text) {
      const code = ch.codePointAt(0) as number;
      if (!isIgnorable(code)) {
        if (streamed) this.tagText(streamed);
        streamed = "";
        out += this.flush();
        out += ch;
        this.before = code;
        continue;
      }
      // A recommended flag complete: kept as text, and what follows starts afresh.
      if (
        code === CANCEL_TAG &&
        this.before === BLACK_FLAG &&
        !this.streaming &&
        this.length === this.tags &&
        isFlag([...this.head, code])
      ) {
        out += codePoints([...this.head, code]);
        this.reset();
        this.before = CANCEL_TAG;
        continue;
      }
      this.length++;
      this.hash = Math.imul(this.hash ^ code, 0x01000193) >>> 0;
      if (isTag(code)) {
        this.tags++;
        if (printable(code) && this.decoded.length < MAX_DECODED) this.decoded += String.fromCharCode(code - 0xe0000);
      }
      if (this.head.length < HEAD) {
        this.head.push(code);
        continue;
      }
      if (!this.streaming) {
        // Too long to be a flag: its decoded text goes to the phrases from here on.
        this.streaming = true;
        streamed += decodeTags(this.head);
      }
      if (printable(code)) streamed += String.fromCharCode(code - 0xe0000);
      if (streamed.length >= 4_096) {
        this.tagText(streamed);
        streamed = "";
      }
    }
    if (streamed) this.tagText(streamed);
    return out;
  }

  // The stream's end: a run still open is settled.
  end(): string {
    const rest = this.highSurrogate;
    this.highSurrogate = "";
    return this.flush() + rest;
  }

  private reset() {
    this.head = [];
    this.length = 0;
    this.tags = 0;
    this.decoded = "";
    this.streaming = false;
    this.hash = 0x811c9dc5;
  }

  private flush(): string {
    if (!this.length) return "";
    const head = this.head;
    const streaming = this.streaming;
    const fingerprint = `${this.length}:${this.hash.toString(16)}`;
    const classified: InvisibleRun | null = streaming
      ? this.tags
        ? { kind: "tag", decoded: this.decoded, length: this.length }
        : { kind: "ignorable", decoded: null, length: this.length }
      : classify(head, this.before);
    const found = classified ? { ...classified, fingerprint } : null;
    this.reset();
    if (!found) return codePoints(head);
    if (!streaming && found.decoded) this.tagText(found.decoded);
    this.found(found);
    return "";
  }
}

const decodeTags = (codes: readonly number[]) =>
  codes
    .filter(printable)
    .map((c) => String.fromCharCode(c - 0xe0000))
    .join("");

// Code points to text without spreading them into one call; the runs kept as text are short, but this never assumes so.
function codePoints(codes: readonly number[]): string {
  let out = "";
  for (const code of codes) out += String.fromCodePoint(code);
  return out;
}

// The runs in a whole text, and the text without them (for `visible.txt`).
export function invisibleRuns(text: string): { runs: InvisibleRun[]; cleaned: string } {
  const runs: InvisibleRun[] = [];
  const reader = new RunReader(({ fingerprint: _, ...run }) => runs.push(run));
  const cleaned = reader.feed(text) + reader.end();
  return { runs, cleaned };
}
