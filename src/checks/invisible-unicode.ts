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
export function classify(run: readonly number[], before: number | undefined): InvisibleRun | null {
  const tags = run.filter(isTag);
  if (
    before === BLACK_FLAG &&
    run.length === tags.length &&
    run[run.length - 1] === CANCEL_TAG &&
    RGI_FLAGS.has(String.fromCharCode(...run.slice(0, -1).map((c) => c - 0xe0000)))
  )
    return null;
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

// Reads text chunk by chunk, taking out the runs it finds (each handed to `found`) and giving back the rest; a run or a
// surrogate pair cut by a chunk's end waits for the next chunk.
export class RunReader {
  private run: number[] = [];
  private before: number | undefined;
  private highSurrogate = "";
  private readonly found: (run: InvisibleRun) => void;

  constructor(found: (run: InvisibleRun) => void) {
    this.found = found;
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
    for (const ch of text) {
      const code = ch.codePointAt(0) as number;
      if (isIgnorable(code)) {
        this.run.push(code);
        continue;
      }
      out += this.flush();
      out += ch;
      this.before = code;
    }
    return out;
  }

  // The stream's end: a run still open is settled.
  end(): string {
    const rest = this.highSurrogate;
    this.highSurrogate = "";
    return this.flush() + rest;
  }

  private flush(): string {
    if (!this.run.length) return "";
    const run = this.run;
    this.run = [];
    const found = classify(run, this.before);
    if (found) {
      this.found(found);
      return "";
    }
    return String.fromCodePoint(...run);
  }
}

// The runs in a whole text, and the text without them (for `visible.txt`).
export function invisibleRuns(text: string): { runs: InvisibleRun[]; cleaned: string } {
  const runs: InvisibleRun[] = [];
  const reader = new RunReader((run) => runs.push(run));
  const cleaned = reader.feed(text) + reader.end();
  return { runs, cleaned };
}
