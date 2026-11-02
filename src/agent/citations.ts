// Citation validation for the verdict agent (D04 T01 §5; design spec 4.6, the evidence-or-nothing rule).
// The stored verdict's reasons are built from the answer's declared citations, so a citation list that is
// empty or names an ID the case does not have is refused here, as is an explanation whose sentences make
// claims without a marker, whose markers name no case ID, or whose markers disagree with the declared
// citations. Findings are plain, bounded strings built only from fixed wording and Evidence IDs: they
// are what the one retry shows the model, and what a refusal records.

const MARKER = /\[E[0-9]+\]/g;
const MAX_FINDINGS = 10;

// Sentence boundaries need the words around the stop. Initial chains and honorifics (U.S., e.g., Dr.)
// do not end a sentence. Other abbreviations (Ltd., etc.) end one before a capital and continue one
// before a lowercase word. A quoted fragment continues only into an exactly lowercase joining word;
// a capitalised But starts the next sentence. A line break is a boundary too, and a segment holding
// only a citation marker belongs to the sentence before it.
const HONORIFICS = new Set(["dr", "mr", "mrs", "ms", "st"]);
const ABBREVIATIONS = new Set(["etc", "vs", "approx", "dept", "fig", "no", "vol", "ed", "al", "inc", "ltd", "co"]);
const JOINING = new Set(["and", "or", "but", "nor", "yet", "so", "then", "which"]);

function splitLine(line: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < line.length; i++) {
    const ch = line.charAt(i);
    if (ch !== "." && ch !== "!" && ch !== "?") continue;
    let j = i + 1;
    while (j < line.length && "\"'”’)]".includes(line.charAt(j))) j++;
    let k = j;
    while (k < line.length && /\s/.test(line.charAt(k))) k++;
    if (k === j || k >= line.length) continue;
    let n = k;
    while (n < line.length && /[A-Za-z]/.test(line.charAt(n))) n++;
    const next = line.slice(k, n);
    if (/^[a-z]+$/.test(next) && JOINING.has(next)) continue;
    if (ch === ".") {
      let p = i - 1;
      while (p >= 0 && /[A-Za-z.]/.test(line.charAt(p))) p--;
      const before = line.slice(p + 1, i).toLowerCase();
      const initialChain = before.length === 1 || /^[a-z](?:\.[a-z])*$/.test(before);
      if (initialChain || HONORIFICS.has(before)) continue;
      if (ABBREVIATIONS.has(before) && !/^[A-Z]/.test(next)) continue;
    }
    out.push(line.slice(start, j));
    start = k;
    i = k - 1;
  }
  out.push(line.slice(start));
  return out;
}

function sentences(text: string): string[] {
  const raw = text.split(/\n+/).flatMap(splitLine);
  const out: string[] = [];
  for (const part of raw) {
    const previous = out[out.length - 1];
    if (previous !== undefined && /^\s*(?:\[E[0-9]+\]\s*)+[.!?]?$/.test(part)) out[out.length - 1] = previous + part;
    else out.push(part);
  }
  return out;
}

export function validateCitations(
  verdict: { cited_evidence_ids: readonly string[]; explanation: string },
  evidenceIds: ReadonlySet<string>,
): string[] {
  const findings: string[] = [];
  const add = (finding: string) => {
    if (findings.length < MAX_FINDINGS) findings.push(finding);
  };
  const cited = verdict.cited_evidence_ids;
  if (!cited.length) add("no evidence is cited");
  for (const id of cited) if (!evidenceIds.has(id)) add(`cited ${id} is not on the case`);
  const declared = new Set(cited);
  const marked = new Set<string>();
  for (const match of verdict.explanation.matchAll(MARKER)) {
    const id = match[0].slice(1, -1);
    marked.add(id);
    if (!evidenceIds.has(id)) add(`the explanation cites ${id}, which is not on the case`);
    else if (!declared.has(id)) add(`the explanation cites ${id}, which is not among the declared citations`);
  }
  for (const id of declared)
    if (evidenceIds.has(id) && !marked.has(id)) add(`cited ${id} is not cited in the explanation`);
  // Findings never copy the answer's text: the retry shows them to the model, and answer text can repeat
  // hostile mail, so every finding is fixed wording or an Evidence ID.
  for (const sentence of sentences(verdict.explanation)) {
    if (sentence.trim() && !/\[E[0-9]+\]/.test(sentence)) add("a sentence of the explanation has no citation marker");
  }
  return findings;
}
