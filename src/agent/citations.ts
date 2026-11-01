// Citation validation for the verdict agent (D04 T01 §5; design spec 4.6, the evidence-or-nothing rule).
// The stored verdict's reasons are built from the answer's declared citations, so a citation list that is
// empty or names an ID the case does not have is refused here, as is an explanation whose sentences make
// claims without a marker, whose markers name no case ID, or whose markers disagree with the declared
// citations. Findings are plain, bounded strings built only from fixed wording and Evidence IDs: they
// are what the one retry shows the model, and what a refusal records.

const MARKER = /\[E[0-9]+\]/g;
const MAX_FINDINGS = 10;

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
  for (const sentence of verdict.explanation.split(/(?<=[.!?])["'”’)\]]*\s+/)) {
    if (sentence.trim() && !/\[E[0-9]+\]/.test(sentence)) add("a sentence of the explanation has no citation marker");
  }
  return findings;
}
