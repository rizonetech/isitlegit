// The walkthrough's evidence (D04 T02 §5; design spec 4.4a): the chain of pages it walked, where the test credentials
// would have gone (from the request the page sent, never its HTML), whether the page took them, and the hidden text it
// carried. Built from the walk's record alone (the driver removed every canary value from it) and written as the
// later producer `walkthrough` (D02 T01 §5), after the case's checks items in its current run.

import type { BrandTable } from "../checks/brand-schema";
import { type Brand, brandForUrl, getBrand, registrable } from "../checks/brands";
import { addEvidence, type Evidence, type EvidenceDraft, readEvidence } from "../checks/evidence";
import type { Submission, WalkRecord } from "./driver";

export type WalkForEvidence = { startUrl: string; outcome: string; record: WalkRecord };
export type Acceptance = "accepted" | "rejected" | "unknown";
export type KnownBrand = { brand: Brand; evidenceId: string };

const MAX_TARGETS = 10;
const MAX_HIDDEN = 20;
const MAX_ARTEFACTS = 100;
const SUMMARY = 200;

// A summary's text: plain words on one line, at most 200 characters (the evidence's own rule).
const plain = (text: string, max = SUMMARY) =>
  Array.from(
    text
      .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}<>]/gu, " ")
      .replace(/\s+/g, " ")
      .trim(),
  )
    .slice(0, max)
    .join("");
const domainOf = (url: string) => {
  try {
    return registrable(new URL(url).hostname);
  } catch {
    return null;
  }
};

// The brand the walked link impersonates: the one named by the current run's lookalike item for the walk's own domain
// (its start URL or a page it reached), with that item's id. Unknown (null) with no such item, or with two naming
// different brands, so an unrelated finding never decides the severity.
export async function impersonatedBrand(
  db: D1Database,
  caseId: string,
  walk: WalkForEvidence,
  table: BrandTable,
): Promise<KnownBrand | null> {
  const walked = new Set(
    [walk.startUrl, ...walk.record.pages.map((p) => p.url)].map(domainOf).filter((d): d is string => !!d),
  );
  const items = (await readEvidence(db, caseId)).filter((e) => {
    if (e.check !== "domain.lookalike" || e.detail.targetKind !== "brand") return false;
    const domain = typeof e.detail.domain === "string" ? registrable(e.detail.domain) : null;
    return domain !== null && walked.has(domain) && typeof e.detail.brand === "string";
  });
  const names = new Set(items.map((e) => e.detail.brand as string));
  if (names.size !== 1) return null;
  const [name] = names;
  const brand = name ? getBrand(table, name) : null;
  const item = items[0] as Evidence;
  return brand ? { brand, evidenceId: item.id } : null;
}

// Whether the page took the credentials, from what was seen: a delivered submission followed by a page that asks for
// no password and shows no failure word is accepted; a 4xx or 5xx answer, or a page asking again or saying no, is
// rejected; anything else (no page after it, a blocked or failed request) is unknown, never accepted.
export function acceptance(record: WalkRecord, submission: Submission): Acceptance {
  if (submission.state !== "delivered") return "unknown";
  if ((submission.status ?? 0) >= 400) return "rejected";
  const next = record.pages.find((p) => p.seq > submission.seq);
  if (!next) return "unknown";
  if (next.asksPassword || next.failure) return "rejected";
  if (next.asksPassword === null || next.failure === null) return "unknown";
  return "accepted";
}

export function walkthroughEvidence(
  walk: WalkForEvidence,
  brand: KnownBrand | null,
  revision: string | null,
  table: BrandTable,
): EvidenceDraft[] {
  const { record } = walk;
  const items: EvidenceDraft[] = [];
  const shotOf = (seq: number | null) => record.pages.find((p) => p.seq === seq)?.screenshotKey;
  if (record.pages.length) {
    const last = record.pages.at(-1);
    items.push({
      check: "walkthrough.chain",
      severity: "info",
      summary: plain(
        `The walk visited ${record.pages.length} page${record.pages.length === 1 ? "" : "s"}, ending at ${
          (last && domainOf(last.url)) ?? "an unknown address"
        }.`,
      ),
      detail: {
        pages: record.pages.map((p) => ({ seq: p.seq, url: p.url })),
        outcome: walk.outcome,
        revision,
      },
      artefacts: record.pages.map((p) => p.screenshotKey).slice(0, MAX_ARTEFACTS),
    });
  }
  for (const submission of record.submissions.slice(0, MAX_TARGETS)) {
    const outcome = acceptance(record, submission);
    const match = brandForUrl(table, submission.url);
    const own = !!brand && !!match && match.official && match.brand.name === brand.brand.name;
    const severity = !brand ? "high" : own ? "info" : "critical";
    const where = submission.domain ?? "an unknown address";
    const shot = shotOf(submission.fromPage);
    items.push({
      check: "walkthrough.credential_target",
      severity,
      summary: plain(
        own
          ? `The sign-in form sends the test credentials to ${brand?.brand.name}'s own ${where}.`
          : brand
            ? `The test credentials would go to ${where}, not ${brand.brand.name}.`
            : `The test credentials would go to ${where}.`,
      ),
      detail: {
        url: submission.url,
        domain: submission.domain,
        method: submission.method,
        fields: submission.fields,
        state: submission.state,
        status: submission.status ?? null,
        outcome,
        brand: brand?.brand.name ?? null,
        brandEvidence: brand?.evidenceId ?? null,
        revision,
      },
      artefacts: shot ? [shot] : [],
    });
    if (outcome === "accepted") {
      const after = record.pages.find((p) => p.seq > submission.seq);
      items.push({
        check: "walkthrough.canary_accepted",
        severity: "high",
        summary: plain(`The page at ${where} took the test credentials and moved on.`),
        detail: { url: submission.url, nextPage: after?.url ?? null, revision },
        artefacts: [shot, after?.screenshotKey].filter((k): k is string => !!k),
      });
    }
  }
  for (const span of record.hidden.slice(0, MAX_HIDDEN)) {
    const page = record.pages.find((p) => p.seq === span.page);
    items.push({
      check: "walkthrough.hidden_text",
      severity: span.instruction ? "high" : "medium",
      summary: plain(`Hidden text on a walked page: "${plain(span.text, 120)}"`),
      detail: { quote: span.text, reason: span.reason, page: page?.url ?? null, revision },
      artefacts: [span.key, page?.screenshotKey].filter((k): k is string => !!k),
    });
  }
  return items;
}

// Writes the walk's evidence to the case's current run, replacing an earlier walk's: an empty list removes it. A write
// that fails rejects.
export async function recordWalk(
  db: D1Database,
  caseId: string,
  walk: WalkForEvidence,
  options: { table: BrandTable; revision: string | null },
): Promise<Evidence[]> {
  const brand = await impersonatedBrand(db, caseId, walk, options.table);
  return addEvidence(db, caseId, "walkthrough", walkthroughEvidence(walk, brand, options.revision, options.table));
}
