// Lookalike candidates of a business's verified domains (D05 T04 §1; spec 4.11): the domains an impersonator would
// register, which the monitor then watches. Every candidate is one the lookalike check itself recognises as imitating
// the domain (`techniqueOf`, D02 T03), so the monitor never watches a domain the check would not flag; each is a
// registrable domain written in its ASCII form (an A-label), as DNS and RDAP need it.
//
// Four kinds, in the order they are most often registered: the same label under another TLD, the label with an added
// word, one character swapped for a confusable (UTS #39, the check's own table), and one-character typos (omission,
// repetition, adjacent swap, adjacent key). A business's candidates are merged across its domains, its own domains
// never among them, and capped at MAX_CANDIDATES in that order.
import MAP from "../checks/confusables-map.json";
import { split as checkSplit, type Technique, techniqueOf } from "../checks/domain-lookalike";
import { ADDED_WORDS, unicodeLabel } from "../checks/lookalike";

export const MAX_CANDIDATES = 300;
// Spec 4.11's TLDs, and South Africa's own `co.za`, the one a South African business's lookalike most often uses
// (completion review: `fynbosfreight.com`'s `.co.za` twin was not watched).
export const OTHER_TLDS = ["com", "co", "africa", "net", "org", "co.za"] as const;
const RANK: Record<Technique, number> = { "different-tld": 0, "added-word": 1, skeleton: 2, edit: 3, "accent-fold": 4 };

// A whole host in its ASCII form (every label an A-label where it needs one), or null.
function asciiHost(host: string): string | null {
  try {
    const ascii = new URL(`http://${host.trim().toLowerCase().replace(/\.$/, "")}/`).hostname;
    return /^[a-z0-9.-]+$/.test(ascii) ? ascii : null;
  } catch {
    return null;
  }
}

// A host's registrable domain split exactly as the lookalike check splits it (its own `split`), so a candidate the
// check cannot read as a registrable domain is never produced (round 1), the host first made ASCII throughout.
function splitOf(host: string) {
  const ascii = asciiHost(host);
  return ascii ? checkSplit(ascii) : null;
}

// A label in its ASCII form (the URL parser applies IDNA), or null when it is not a valid DNS label.
function asciiLabel(label: string): string | null {
  try {
    const host = new URL(`http://${label}.example/`).hostname;
    const ascii = host.slice(0, -".example".length);
    return /^[a-z0-9-]{1,63}$/.test(ascii) && !ascii.startsWith("-") && !ascii.endsWith("-") ? ascii : null;
  } catch {
    return null;
  }
}

// The vendored table maps each confusable to its prototype; reversed, it gives the characters that look like a given
// ASCII letter or digit, kept to those a DNS label can hold.
const LOOKALIKES: Map<string, string[]> = (() => {
  const reversed = new Map<string, string[]>();
  for (const [character, prototype] of Object.entries(MAP.prototypes as Record<string, string>)) {
    if (!/^[a-z0-9]$/.test(prototype) || character === prototype) continue;
    if (character.toLowerCase() !== character || asciiLabel(`x${character}x`) === null) continue;
    const list = reversed.get(prototype) ?? [];
    list.push(character);
    reversed.set(prototype, list);
  }
  return reversed;
})();

// The QWERTY neighbours of each key, for adjacent-key typos.
const ROWS = ["1234567890", "qwertyuiop", "asdfghjkl", "zxcvbnm"];
const NEIGHBOURS: Map<string, string[]> = (() => {
  const near = new Map<string, string[]>();
  ROWS.forEach((row, r) => {
    for (let c = 0; c < row.length; c++) {
      const keys: string[] = [];
      for (const [dr, dc] of [
        [0, -1],
        [0, 1],
        [-1, 0],
        [1, 0],
        [-1, 1],
        [1, -1],
      ] as const) {
        const key = ROWS[r + dr]?.[c + dc];
        if (key) keys.push(key);
      }
      near.set(row[c] as string, keys);
    }
  });
  return near;
})();

function* labelsOf(label: string): Generator<string> {
  // Added words, after and before, joined by "-" and by nothing.
  for (const word of ADDED_WORDS)
    for (const join of ["-", ""]) {
      yield `${label}${join}${word}`;
      yield `${word}${join}${label}`;
    }
  const chars = Array.from(label);
  // One confusable substitution.
  for (let i = 0; i < chars.length; i++)
    for (const lookalike of LOOKALIKES.get(chars[i] as string) ?? [])
      yield [...chars.slice(0, i), lookalike, ...chars.slice(i + 1)].join("");
  // Typos: omission, repetition, adjacent swap, adjacent key.
  for (let i = 0; i < chars.length; i++) {
    yield [...chars.slice(0, i), ...chars.slice(i + 1)].join("");
    yield [...chars.slice(0, i + 1), chars[i], ...chars.slice(i + 1)].join("");
    if (i + 1 < chars.length) yield [...chars.slice(0, i), chars[i + 1], chars[i], ...chars.slice(i + 2)].join("");
    for (const key of NEIGHBOURS.get(chars[i] as string) ?? [])
      yield [...chars.slice(0, i), key, ...chars.slice(i + 1)].join("");
  }
}

type Candidate = { domain: string; technique: Technique; order: number };

// Every candidate of one domain the check recognises, each once, with the technique it would name.
function ranked(domain: string): Candidate[] {
  const target = splitOf(domain);
  if (!target) return [];
  // The label as people read it: an internationalised domain is varied in Unicode (`bücher`, not `xn--bcher-kva`), each
  // variant encoded afterwards, so its words and characters are the ones a reader sees (completion review).
  const label = unicodeLabel(target.label);
  if (!label || !asciiLabel(label)) return [];
  const found = new Map<string, Candidate>();
  let order = 0;
  const add = (candidateLabel: string, suffix: string) => {
    const ascii = asciiLabel(candidateLabel);
    if (!ascii) return;
    const split = splitOf(`${ascii}.${suffix}`);
    if (!split || split.domain === target.domain || found.has(split.domain)) return;
    const technique = techniqueOf(split, target);
    if (technique) found.set(split.domain, { domain: split.domain, technique, order: order++ });
  };
  for (const tld of OTHER_TLDS) if (tld !== target.suffix) add(label, tld);
  for (const candidate of labelsOf(label)) add(candidate, target.suffix);
  return [...found.values()];
}

const byRank = (a: Candidate, b: Candidate) => RANK[a.technique] - RANK[b.technique] || a.order - b.order;

// One domain's candidates, the likeliest first, at most MAX_CANDIDATES.
export function candidatesFor(domain: string): string[] {
  return ranked(domain)
    .sort(byRank)
    .slice(0, MAX_CANDIDATES)
    .map((c) => c.domain);
}

// A business's candidates across all its verified domains: merged, its own domains never among them, each once, the
// likeliest first across the domains, at most MAX_CANDIDATES in all.
export function candidatesForBusiness(domains: readonly string[]): string[] {
  const own = new Set(domains.map((d) => splitOf(d)?.domain).filter((d): d is string => !!d));
  const merged = new Map<string, Candidate>();
  domains.forEach((domain, index) => {
    for (const c of ranked(domain)) {
      if (own.has(c.domain)) continue;
      const known = merged.get(c.domain);
      const placed = { ...c, order: c.order * domains.length + index };
      if (!known || byRank(placed, known) < 0) merged.set(c.domain, placed);
    }
  });
  return [...merged.values()]
    .sort(byRank)
    .slice(0, MAX_CANDIDATES)
    .map((c) => c.domain);
}
