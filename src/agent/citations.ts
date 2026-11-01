// Citation validation for the verdict agent (D04 T01 §5; design spec 4.6, the evidence-or-nothing rule).
// The stored verdict's reasons are built from the answer's declared citations, so a citation list that is
// empty or names an ID the case does not have is refused here, as is an explanation whose sentences make
// claims without a marker, whose markers name no case ID, or whose markers disagree with the declared
// citations. Findings are plain, bounded strings built only from fixed wording and Evidence IDs: they
// are what the one retry shows the model, and what a refusal records.

const MARKER = /\[E[0-9]+\]/g;
const MAX_FINDINGS = 10;

// Words that close a sentence only when they are not what they usually are: known abbreviations never
// end one, and a quoted fragment followed by a joining word continues the sentence around it. Anything
// else after terminal punctuation, closing quotes included, starts a new sentence, capitals or not.
const ABBREVIATIONS = new Set([
  "e.g",
  "i.e",
  "etc",
  "vs",
  "dr",
  "mr",
  "mrs",
  "ms",
  "st",
  "approx",
  "dept",
  "fig",
  "no",
  "vol",
  "ed",
  "al",
  "inc",
  "ltd",
  "co",
  "u.s",
  "u.k",
  "e.u",
  "a.m",
  "p.m",
]);
const JOINING = new Set(["and", "or", "but", "nor", "yet", "so", "then", "which"]);

function sentences(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charAt(i);
    if (ch !== "." && ch !== "!" && ch !== "?") continue;
    if (ch === ".") {
      let p = i - 1;
      while (p >= 0 && /[A-Za-z.]/.test(text.charAt(p))) p--;
      const before = text.slice(p + 1, i).toLowerCase();
      if (before.length === 1 || ABBREVIATIONS.has(before)) continue;
    }
    let j = i + 1;
    while (j < text.length && "\"'”’)]".includes(text.charAt(j))) j++;
    let k = j;
    while (k < text.length && /\s/.test(text.charAt(k))) k++;
    if (k === j || k >= text.length) continue;
    let n = k;
    while (n < text.length && /[A-Za-z]/.test(text.charAt(n))) n++;
    if (JOINING.has(text.slice(k, n).toLowerCase())) continue;
    out.push(text.slice(start, j));
    start = k;
    i = k - 1;
  }
  out.push(text.slice(start));
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
  // Findings never copy the answer's text: the retry shows them to the model, and answer text can repeat
  // hostile mail, so every finding is fixed wording or an Evidence ID.
  for (const sentence of sentences(verdict.explanation)) {
    if (sentence.trim() && !/\[E[0-9]+\]/.test(sentence)) add("a sentence of the explanation has no citation marker");
  }
  return findings;
}
