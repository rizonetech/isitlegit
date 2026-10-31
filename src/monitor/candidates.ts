// Lookalike candidates of a business's verified domains (D05 T04 §1; spec 4.11): the domains an impersonator would
// register, which the monitor then watches. Every candidate is one the lookalike check itself recognises as imitating
// the domain (`techniqueOf`, D02 T03), so the monitor never watches a domain the check would not flag; each is a
// registrable domain written in its ASCII form (an A-label), as DNS and RDAP need it.
//
// Four kinds, in the order they are most often registered: the same label under another TLD, the label with an added
// word, one character swapped for a confusable (UTS #39, the check's own table), and one-character typos (omission,
// repetition, adjacent swap, adjacent key). A business's candidates are merged across its domains, its own domains
// never among them, and capped at MAX_CANDIDATES in that order.
import { getDomain, getPublicSuffix } from "tldts";
import MAP from "../checks/confusables-map.json";
import { type Technique, techniqueOf } from "../checks/domain-lookalike";
import { ADDED_WORDS } from "../checks/lookalike";

export const MAX_CANDIDATES = 300;
// Spec 4.11's TLDs.
export const OTHER_TLDS = ["com", "co", "africa", "net", "org"] as const;
const RANK: Record<Technique, number> = { "different-tld": 0, "added-word": 1, skeleton: 2, edit: 3 };

type Split = { domain: string; label: string; suffix: string };

// A host's registrable domain split as the lookalike check splits it: the label before the public suffix.
function splitOf(host: string): Split | null {
  const domain = getDomain(host, { allowPrivateDomains: false });
  const suffix = getPublicSuffix(host, { allowPrivateDomains: false });
  if (!domain || !suffix || !domain.endsWith(`.${suffix}`)) return null;
  return { domain, label: domain.slice(0, -(suffix.length + 1)), suffix };
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
  const target = splitOf(domain.trim().toLowerCase());
  if (!target) return [];
  const label = asciiLabel(target.label);
  if (!label) return [];
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
  const own = new Set(domains.map((d) => splitOf(d.trim().toLowerCase())?.domain).filter((d): d is string => !!d));
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
