// Lookalike domains (D02 T03 §2; spec 4.3 Domains): each domain the original's own headers name (the From's mailbox,
// every Reply-To, the topmost Return-Path) compared, as a registrable domain, with the organisation's verified domains,
// its suppliers' and the curated brand table's. A lookalike of a domain the organisation trusts is high, of a brand
// medium; a domain that is a target's own, the organisation's own or a brand's own is never one. Link and landing hosts
// follow when they are extracted (§7).
import { addressParser } from "postal-mime";
import { parse } from "tldts";
import { stripComments } from "../intake/sender";
import { asciiDomain, bounded, fittedDetail, fromDomain, plain } from "./auth";
import { registrable } from "./brand-schema";
import type { CaseView } from "./case-view";
import type { EvidenceDraft } from "./evidence";
import { addedWords, distance, labelSkeleton, MAX_LABEL_CHARACTERS, unicodeLabel } from "./lookalike";
import type { CheckRegistry } from "./registry";
import { mailbox } from "./sender";

type Header = CaseView["headers"][number];
type Field = "From" | "Reply-To" | "Return-Path";
export type TargetKind = "own" | "supplier" | "brand";
export type Technique = "skeleton" | "different-tld" | "added-word" | "edit";

// A registrable domain split as compared: its label (the registrable domain without its suffix) and its suffix.
type Split = { domain: string; label: string; suffix: string };
function split(host: string): Split | null {
  const domain = registrable(host);
  if (!domain) return null;
  const parts = parse(domain, { allowPrivateDomains: true });
  if (!parts.domainWithoutSuffix || !parts.publicSuffix) return null;
  return { domain, label: parts.domainWithoutSuffix, suffix: parts.publicSuffix };
}

const domainOf = (address: string) => {
  const box = mailbox(address.trim());
  return box ? box.slice(box.lastIndexOf("@") + 1) : null;
};
const named = (headers: readonly Header[], name: string) => headers.filter((h) => h.name.trim().toLowerCase() === name);

// The original's header domains, each registrable domain with the fields and header lines it was read from.
export function headerDomains(view: CaseView): { domain: string; fields: Field[]; headers: Header[] }[] {
  if (!view.tenant.headersAvailable) return [];
  const found = new Map<string, { domain: string; fields: Field[]; headers: Header[] }>();
  const add = (host: string | null, field: Field, header: Header) => {
    // One canonical form, the A-label, before anything is compared or merged: a From in Unicode and a Reply-To in its
    // A-label are one domain (completion review).
    const ascii = host ? asciiDomain(host) : null;
    const domain = ascii ? registrable(ascii) : null;
    if (!domain) return;
    const entry = found.get(domain) ?? { domain, fields: [], headers: [] };
    if (!entry.fields.includes(field)) entry.fields.push(field);
    if (!entry.headers.includes(header)) entry.headers.push(header);
    found.set(domain, entry);
  };
  const from = named(view.headers, "from");
  if (from.length === 1 && from[0]) add(fromDomain(view.headers), "From", from[0]);
  for (const header of named(view.headers, "reply-to"))
    for (const a of addressParser(header.value, { flatten: true }))
      add(a.address ? domainOf(a.address) : null, "Reply-To", header);
  const returnPath = named(view.headers, "return-path")[0];
  if (returnPath) {
    // Comments around the angle address are allowed (RFC 5322 3.6.7); they are set aside first (round 1).
    const path = stripComments(returnPath.value)
      .trim()
      .replace(/^<\s*|\s*>$/g, "")
      .trim();
    if (path) add(domainOf(path), "Return-Path", returnPath);
  }
  return [...found.values()];
}

// The registrable domains the case's own context vouches for: the organisation's verified domains, its suppliers' and
// the brand table's (a check of a domain's age or likeness says nothing about these).
export function knownDomains(view: CaseView): Set<string> {
  const known = new Set<string>();
  const add = (domain: string) => {
    const ascii = asciiDomain(domain);
    const site = ascii ? registrable(ascii) : null;
    if (site) known.add(site);
  };
  for (const d of view.tenant.trusted.own) add(d);
  for (const d of view.tenant.trusted.suppliers) add(d);
  for (const brand of view.brands.brands) for (const d of brand.domains) add(d);
  return known;
}

// How `candidate` imitates `target`, strongest first, or null; the two are different registrable domains.
export function techniqueOf(candidate: Split, target: Split): Technique | null {
  const a = unicodeLabel(candidate.label);
  const b = unicodeLabel(target.label);
  if (a === null || b === null) return null;
  if (a === b) return candidate.suffix === target.suffix ? null : "different-tld";
  const skeletonA = labelSkeleton(a);
  if (skeletonA !== null && skeletonA === labelSkeleton(b)) return "skeleton";
  if (addedWords(a, b)) return "added-word";
  const [la, lb] = [Array.from(a).length, Array.from(b).length];
  if (la >= 6 && lb >= 6 && la <= MAX_LABEL_CHARACTERS && lb <= MAX_LABEL_CHARACTERS) {
    const d = distance(a, b);
    if (d >= 1 && d <= 2) return "edit";
  }
  return null;
}

const RANK: Record<Technique, number> = { skeleton: 0, "different-tld": 1, "added-word": 2, edit: 3 };
const KIND_RANK: Record<TargetKind, number> = { own: 0, supplier: 1, brand: 2 };

// At most this many lookalike items, the strongest first, and one counting the rest, so the check stays well under the
// runner's MAX_ITEMS_PER_CHECK and a message with many lookalike domains keeps its findings (plan review).
export const MAX_LOOKALIKES = 20;
// At most this many of a message's domains are compared (each against every target), so a message naming thousands
// stays within the check's time; the rest are counted as not compared (completion review). Its notes are bounded too,
// with one more accounting for every domain and target not compared that is not listed.
export const MAX_COMPARED = 100;
export const MAX_NOTES = 10;

// Whether a label can be compared: it has a skeleton (not right-to-left, not refused); §6 owns right-to-left labels.
const comparable = (s: Split) => labelSkeleton(s.label) !== null;

export function lookalikeEvidence(view: CaseView): EvidenceDraft[] {
  const targets: { split: Split; kind: TargetKind; name: string }[] = [];
  const exempt = new Set<string>();
  const uncomparable: string[] = [];
  const push = (domain: string, kind: TargetKind, name: string) => {
    const ascii = asciiDomain(domain);
    const s = ascii ? split(ascii) : null;
    if (!s) return;
    exempt.add(s.domain);
    if (comparable(s)) targets.push({ split: s, kind, name });
    else if (kind !== "brand") uncomparable.push(s.domain);
  };
  for (const d of view.tenant.trusted.own) push(d, "own", d);
  for (const d of view.tenant.trusted.suppliers) push(d, "supplier", d);
  for (const brand of view.brands.brands) for (const d of brand.domains) push(d, "brand", brand.name);
  const all = headerDomains(view);
  const found = all.slice(0, MAX_COMPARED);
  const unread = all.slice(MAX_COMPARED).map((d) => d.domain);
  const notes: EvidenceDraft[] = [];
  const skipped: string[] = [];
  const lookalikes: { severity: "high" | "medium"; item: EvidenceDraft }[] = [];
  const cite = (headers: Header[]) => headers.map((h) => `${h.name}: ${h.value}`);
  for (const entry of found) {
    if (exempt.has(entry.domain)) continue;
    const candidate = split(entry.domain);
    if (!candidate) continue;
    if (!comparable(candidate)) {
      skipped.push(entry.domain);
      if (notes.length < MAX_NOTES)
        notes.push({
          check: "domain.lookalike",
          severity: "info",
          summary: bounded(
            `${plain(entry.domain, 80)} (${entry.fields.join(", ")}) was not compared for lookalikes: its name is written right to left or could not be read.`,
          ),
          detail: fittedDetail({
            domain: entry.domain,
            compared: false,
            fields: entry.fields,
            headers: cite(entry.headers),
          }) as EvidenceDraft["detail"],
          artefacts: [view.raw],
        });
      continue;
    }
    let best: { target: (typeof targets)[number]; technique: Technique } | null = null;
    for (const target of targets) {
      const technique = techniqueOf(candidate, target.split);
      if (!technique) continue;
      if (
        !best ||
        KIND_RANK[target.kind] < KIND_RANK[best.target.kind] ||
        (KIND_RANK[target.kind] === KIND_RANK[best.target.kind] && RANK[technique] < RANK[best.technique])
      )
        best = { target, technique };
    }
    if (!best) continue;
    const { target, technique } = best;
    const whose =
      target.kind === "brand"
        ? `${plain(target.name, 40)}'s ${target.split.domain}`
        : target.kind === "own"
          ? `your own ${target.split.domain}`
          : `your supplier's ${target.split.domain}`;
    const severity = target.kind === "brand" ? "medium" : "high";
    lookalikes.push({
      severity,
      item: {
        check: "domain.lookalike",
        severity,
        summary: bounded(
          `${plain(entry.domain, 60)} (${entry.fields.join(", ")}) looks like ${whose}: ${DESCRIBED[technique]}.`,
        ),
        detail: fittedDetail({
          domain: entry.domain,
          target: target.split.domain,
          targetKind: target.kind,
          ...(target.kind === "brand" ? { brand: target.name } : {}),
          technique,
          fields: entry.fields,
          headers: cite(entry.headers),
        }) as EvidenceDraft["detail"],
        artefacts: [view.raw],
      },
    });
  }
  // Every domain and trusted domain not compared is accounted for: those not listed one by one, and those past
  // MAX_COMPARED, in one item.
  const unlisted = skipped.slice(MAX_NOTES);
  if (unlisted.length || unread.length)
    notes.push({
      check: "domain.lookalike",
      severity: "info",
      summary: bounded(
        `${unlisted.length + unread.length} more domains in this message were not compared for lookalikes.`,
      ),
      detail: fittedDetail({
        compared: false,
        unlistedCount: unlisted.length,
        unreadCount: unread.length,
        unlisted,
        unread,
      }) as EvidenceDraft["detail"],
      artefacts: [view.raw],
    });
  if (uncomparable.length && all.length)
    notes.push({
      check: "domain.lookalike",
      severity: "info",
      summary: bounded(
        `${uncomparable.length} of your trusted domains could not be compared for lookalikes: written right to left or unreadable.`,
      ),
      detail: fittedDetail({ targets: uncomparable, compared: false }) as EvidenceDraft["detail"],
      artefacts: [view.raw],
    });
  const ranked = [
    ...lookalikes.filter((l) => l.severity === "high"),
    ...lookalikes.filter((l) => l.severity === "medium"),
  ];
  const kept = ranked.slice(0, MAX_LOOKALIKES).map((l) => l.item);
  const rest = ranked.slice(MAX_LOOKALIKES);
  if (rest.length)
    kept.push({
      check: "domain.lookalike",
      severity: rest[0]?.severity ?? "medium",
      summary: bounded(`${rest.length} more lookalike domains in this message are not listed one by one.`),
      detail: fittedDetail({
        more: rest.length,
        domains: rest.map((l) => l.item.detail.domain),
      }) as EvidenceDraft["detail"],
      artefacts: [view.raw],
    });
  return [...kept, ...notes];
}

const DESCRIBED: Record<Technique, string> = {
  skeleton: "characters that look the same",
  "different-tld": "the same name under another ending",
  "added-word": "the name with a word added",
  edit: "one or two characters changed",
};

export function registerLookalikeCheck(registry: CheckRegistry): void {
  registry.register({ name: "domain.lookalike", needs: [], timeoutMs: 1_000, run: lookalikeEvidence });
}
