// The Cases list's search text (D07 T04 §7): what a member can find a case by (the original's subject, its sender's
// name and address, an upload's file name), folded once by the Worker so the search is case- and accent-insensitive
// across Unicode. SQLite's `lower()` folds ASCII only and D1 has no ICU, so the folding cannot live in the query: it is
// stored on the case (`cases.search_text`) at every write of the fields it covers, and the query folds the search words
// with the same function and looks for them as a plain substring. No database here, so the page's browser test folds
// exactly as the Worker does.

// The longest folded text kept: the four covered fields at their stored limits (300 + 300 + 254 + 255) and separators.
export const SEARCH_TEXT_LIMIT = 1_100;

// Unicode compatibility decomposition, combining marks dropped, lower case, runs of space made one: "CAFÉ  Zoë" reads
// "cafe zoe". Characters with no decomposition (ß, ø, Chinese) stay themselves, lower-cased.
export function fold(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

export type SearchFields = {
  subject?: string | null | undefined;
  fromName?: string | null | undefined;
  fromAddress?: string | null | undefined;
  uploadName?: string | null | undefined;
};

// The stored search text of a case: its covered fields folded, one per line so a search never matches across two of
// them; null when none is stored.
export function searchText(fields: SearchFields): string | null {
  const parts = [fields.subject, fields.fromName, fields.fromAddress, fields.uploadName]
    .map((part) => (part ? fold(part) : ""))
    .filter(Boolean);
  return parts.length ? parts.join("\n").slice(0, SEARCH_TEXT_LIMIT) : null;
}
