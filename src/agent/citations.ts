import type { ValidationIssue } from "../meta/validation-diagnostics";

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
// Words that open a sentence rather than continue a name: after an initial chain or honorific (U.S.
// Bank, Dr. Smith) they still mark the boundary.
const OPENERS = new Set([
  "The",
  "A",
  "An",
  "It",
  "This",
  "That",
  "These",
  "Those",
  "He",
  "She",
  "They",
  "We",
  "You",
  "I",
  "But",
  "However",
  "Then",
  "There",
  "In",
  "On",
  "For",
  "If",
  "When",
  "After",
  "Before",
]);
// Compact chains that name a place or body, not a person: after one of these, mid-sentence, a
// capital followed by a lowercase word opens the next sentence. Any other compact chain is read
// as a person's initials (J.R. Smith), whose surname continues the name.
const PLACE_CHAINS = new Set(["u.s", "u.s.a", "u.k", "e.u", "u.n", "d.c", "u.a.e"]);
// Words that complete an institution's name after a place chain (U.S. Bank, U.S. Treasury), and
// the auxiliaries that mark a predicate after a subject phrase.
const NAME_COMPLETERS = new Set([
  "bank",
  "banks",
  "government",
  "congress",
  "senate",
  "court",
  "courts",
  "treasury",
  "department",
  "university",
  "postal",
  "reserve",
  "commission",
  "agency",
  "bureau",
  "council",
  "parliament",
  "administration",
  "institute",
  "airlines",
  "airways",
  "service",
  "services",
]);
const AUXILIARIES = new Set([
  "is",
  "are",
  "was",
  "were",
  "has",
  "have",
  "had",
  "will",
  "would",
  "can",
  "could",
  "shall",
  "should",
  "may",
  "might",
  "must",
  "be",
  "been",
  "being",
  "seems",
  "appears",
  "remains",
  "became",
  "becomes",
  "do",
  "does",
  "did",
]);

function splitText(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charAt(i);
    if (ch === "\n") {
      // A line break ends a statement that has no stop of its own; the stop's own scan handles the rest.
      let k = i + 1;
      while (k < text.length && /\s/.test(text.charAt(k))) k++;
      if (k < text.length && text.slice(start, i).trim()) {
        out.push(text.slice(start, i));
        start = k;
        i = k - 1;
      }
      continue;
    }
    if (ch !== "." && ch !== "!" && ch !== "?") continue;
    // The sentence runs through its closing quotes and any citation markers written just after the
    // stop, in either order, across a line break too.
    let j = i + 1;
    let absorbedMarker = false;
    for (;;) {
      let moved = false;
      while (j < text.length && "\"'”’)]*_`".includes(text.charAt(j))) {
        j++;
        moved = true;
      }
      const hit = /^\s*\[E[0-9]+\]/.exec(text.slice(j));
      if (hit) {
        j += hit[0].length;
        moved = true;
        absorbedMarker = true;
      }
      if (!moved) break;
    }
    // A decimal is digits directly against both sides of the stop; anything between (a space, a
    // marker) makes it a sentence end again.
    if (ch === "." && /[0-9]/.test(text.charAt(i - 1)) && /[0-9]/.test(text.charAt(i + 1))) continue;
    let k = j;
    while (k < text.length && /\s/.test(text.charAt(k))) k++;
    if (k >= text.length) continue;
    let n = k;
    while (n < text.length && /[A-Za-z]/.test(text.charAt(n))) n++;
    const next = text.slice(k, n);
    // A joining word continues only where the stop itself closes a quoted fragment ("Continue."
    // and ...): the sentence so far must hold an unclosed quote, and the absorbed span its close.
    // An earlier quoted word, a plain sentence, or a quote opening after the marker makes the
    // "but ..." a new sentence.
    const soFar = text.slice(start, i);
    const inQuote =
      ((soFar.match(/"/g)?.length ?? 0) % 2 === 1 ||
        (soFar.match(/“/g)?.length ?? 0) > (soFar.match(/”/g)?.length ?? 0)) &&
      /["”]/.test(text.slice(i + 1, j));
    if (/^[a-z]+$/.test(next) && JOINING.has(next) && inQuote) continue;
    // No whitespace is no boundary either, unless the next sentence starts right against the marker
    // (any word but a joining one) or against a closing quote (a capital, digit or opening quote).
    if (k === j && !absorbedMarker && !/[A-Z0-9"“]/.test(text.charAt(k))) continue;
    if (ch === ".") {
      let p = i - 1;
      while (p >= 0 && /[A-Za-z.]/.test(text.charAt(p))) p--;
      const before = text.slice(p + 1, i).toLowerCase();
      const initialChain = before.length === 1 || /^[a-z](?:\.[a-z])*$/.test(before);
      // The word after the stop, seen past any opening quote or bracket.
      let s = k;
      while (s < text.length && "\"'“‘([".includes(text.charAt(s))) s++;
      let e = s;
      while (e < text.length && /[A-Za-z]/.test(text.charAt(e))) e++;
      const following = text.slice(s, e);
      // A single letter ending in a stop is another initial (J. A. Smith), never the article "A".
      const followingInitial = following.length === 1 && text.charAt(e) === ".";
      // A chain or honorific continues a name (U.S. Bank, Dr. Smith). A marker absorbed at the stop
      // ends it whatever follows (a capital, a number, a domain), and so does an opener word.
      // Mid-sentence after a known place chain (U.S., U.K.), a capital followed by a lowercase word
      // is a new subject (the U.S. Payment clears ..., the U.S. Bank details are ...), not a name.
      // Other chains are a person's initials (J.R. Smith, J. A. Smith), and a chain opening its own
      // sentence keeps its name (U.S. Bank customers were ...). A digit after the chain is a new
      // sentence too, as it is after a marker.
      let f = e;
      while (f < text.length && /\s/.test(text.charAt(f))) f++;
      let g = f;
      while (g < text.length && /[A-Za-z]/.test(text.charAt(g))) g++;
      // An institution completer (Bank, Treasury) opens a new subject only when a predicate
      // follows it (Bank details are ...); a name phrase that ends the sentence stays whole
      // (impersonates U.S. Bank customers [E1]).
      let h = g;
      while (h < text.length && /\s/.test(text.charAt(h))) h++;
      let m = h;
      while (m < text.length && /[A-Za-z]/.test(text.charAt(m))) m++;
      const afterFollowing = text.slice(f, g).toLowerCase();
      const completer = NAME_COMPLETERS.has(following.toLowerCase());
      const newSubject =
        PLACE_CHAINS.has(before) &&
        text.slice(start, p + 1).trim().length > 0 &&
        /^[A-Z]/.test(following) &&
        /^[a-z]+$/.test(afterFollowing) &&
        (!completer || AUXILIARIES.has(afterFollowing) || AUXILIARIES.has(text.slice(h, m).toLowerCase()));
      const nameEnds =
        absorbedMarker || newSubject || /[0-9]/.test(text.charAt(s)) || (OPENERS.has(following) && !followingInitial);
      if ((initialChain || HONORIFICS.has(before)) && !nameEnds) continue;
      // An abbreviation continues only into a lowercase word, and never across an absorbed marker:
      // a capital, a quoted capital, a number, or anything after the sentence's marker starts the
      // next sentence.
      if (ABBREVIATIONS.has(before) && !absorbedMarker && /^[a-z]$/.test(text.charAt(s))) continue;
    }
    out.push(text.slice(start, j));
    start = k;
    i = k - 1;
  }
  out.push(text.slice(start));
  return out;
}

function sentences(text: string): string[] {
  const raw = splitText(text);
  const out: string[] = [];
  for (const part of raw) {
    const previous = out[out.length - 1];
    if (previous !== undefined && /^\s*(?:\[E[0-9]+\]\s*)+[.!?]?$/.test(part)) out[out.length - 1] = previous + part;
    else out.push(part);
  }
  return out;
}

export function citationValidation(
  verdict: { cited_evidence_ids: readonly string[]; explanation: string },
  evidenceIds: ReadonlySet<string>,
): { findings: string[]; issues: ValidationIssue[] } {
  const findings: string[] = [];
  const issues: ValidationIssue[] = [];
  const add = (category: ValidationIssue["category"], finding: string) => {
    if (issues.length < 4 && !issues.some((issue) => issue.category === category)) issues.push({ category, path: [] });
    if (findings.length < MAX_FINDINGS) findings.push(finding);
  };
  const cited = verdict.cited_evidence_ids;
  if (!cited.length) add("no_citations", "no evidence is cited");
  for (const id of cited) if (!evidenceIds.has(id)) add("unknown_evidence_id", `cited ${id} is not on the case`);
  const declared = new Set(cited);
  const marked = new Set<string>();
  for (const match of verdict.explanation.matchAll(MARKER)) {
    const id = match[0].slice(1, -1);
    marked.add(id);
    if (!evidenceIds.has(id)) add("unknown_evidence_id", `the explanation cites ${id}, which is not on the case`);
    else if (!declared.has(id))
      add("undeclared_marker", `the explanation cites ${id}, which is not among the declared citations`);
  }
  for (const id of declared)
    if (evidenceIds.has(id) && !marked.has(id))
      add("unused_declared_id", `cited ${id} is not cited in the explanation`);
  // Findings never copy the answer's text: the retry shows them to the model, and answer text can repeat
  // hostile mail, so every finding is fixed wording or an Evidence ID.
  for (const sentence of sentences(verdict.explanation)) {
    if (sentence.trim() && !/\[E[0-9]+\]/.test(sentence))
      add("sentence_without_marker", "a sentence of the explanation has no citation marker");
  }
  return { findings, issues };
}

export function validateCitations(
  verdict: { cited_evidence_ids: readonly string[]; explanation: string },
  evidenceIds: ReadonlySet<string>,
): string[] {
  return citationValidation(verdict, evidenceIds).findings;
}
