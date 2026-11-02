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
// no password and shows no failure word is accepted; a page asking again or saying no, or an authentication refusal
// (401: the credentials were judged and turned away), is rejected; a 403 is rejected only when a page seen after
// the whole answer corroborates a credential refusal (it asks again or says no), because an access policy or
// anti-bot rule can answer 403 before any credential is judged; a server failure (5xx) or an operational
// 4xx (400, 404, 413, 429: the request was never judged) is unknown, and anything else (no page after it, a blocked
// or failed request) is unknown, never accepted. A backend failure is never a credential rejection (D04 T02 §8).
// A walk that did not end well (an error, a budget refusal, an incomplete or refused answer) claims nothing: what
// followed the submission may not have been seen through.
const SETTLED = new Set(["finished", "limit"]);

export function acceptance(record: WalkRecord, submission: Submission, outcome = "finished"): Acceptance {
  if (!SETTLED.has(outcome)) return "unknown";
  if (submission.state !== "delivered") return "unknown";
  if (submission.status === 401) return "rejected";
  if ((submission.status ?? 0) >= 400 && submission.status !== 403) return "unknown";
  // The pages whose capture began after the whole answer reached the browser: an earlier page (a "signing in" screen
  // shot while the answer was on its way) says nothing about it. Every one of them must agree: any that asks again or
  // says no rejects, and accepted needs them all clear and at least one.
  const after = record.pages.filter((p) => p.seq > submission.seq && p.began >= (submission.deliveredAt ?? Infinity));
  if (!after.length) return "unknown";
  // A 403 needs a credential-specific refusal: a challenge or generic error page can ask again and say a failure
  // word without any credential being judged, so only the driver's refusal signal (words that refuse the
  // credentials themselves) corroborates it, on a page that still asks for a password.
  if (submission.status === 403) return after.some((p) => p.asksPassword && p.refusal) ? "rejected" : "unknown";
  if (after.some((p) => p.asksPassword || p.failure)) return "rejected";
  if (after.some((p) => p.asksPassword === null || p.failure === null)) return "unknown";
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
  const shotOf = (seq: number | null) => record.pages.find((p) => p.seq === seq)?.screenshotKey ?? undefined;
  const keys = (...k: (string | null | undefined)[]) => k.filter((x): x is string => !!x);
  // Each target, its severity and acceptance first, so the bound keeps the strongest (critical before high before
  // info; a delivered request before a blocked one), and says how many it left out.
  const RANK = { critical: 0, high: 1, info: 2 } as const;
  const targets = record.submissions
    .map((submission, at) => {
      const outcome = acceptance(record, submission, walk.outcome);
      const match = brandForUrl(table, submission.url);
      const own = !!brand && !!match && match.official && match.brand.name === brand.brand.name;
      const severity: "critical" | "high" | "info" = !brand ? "high" : own ? "info" : "critical";
      return { submission, outcome, own, severity, at };
    })
    .sort(
      (a, b) =>
        RANK[a.severity] - RANK[b.severity] ||
        Number(b.submission.state === "delivered") - Number(a.submission.state === "delivered") ||
        a.at - b.at,
    );
  const kept = targets.slice(0, MAX_TARGETS).sort((a, b) => a.at - b.at);
  const spans = record.hidden
    .map((span, at) => ({ span, at }))
    .sort((a, b) => Number(b.span.instruction) - Number(a.span.instruction) || a.at - b.at)
    .slice(0, MAX_HIDDEN)
    .sort((a, b) => a.at - b.at)
    .map((s) => s.span);
  const omitted = {
    targets: targets.length - kept.length + record.omitted.submissions,
    hidden: record.hidden.length - spans.length + record.omitted.hidden,
    pages: record.omitted.pages,
  };
  if (record.pages.length) {
    const last = record.pages.at(-1);
    // Pages, not screenshots: consecutive observations of one address are one page.
    const visited = record.pages.filter((p, i) => i === 0 || p.url !== record.pages[i - 1]?.url).length;
    const cut = omitted.targets || omitted.hidden || omitted.pages ? " Some findings are not listed one by one." : "";
    items.push({
      check: "walkthrough.chain",
      severity: "info",
      summary: plain(
        `The walk visited ${visited} page${visited === 1 ? "" : "s"}, ending at ${
          (last && domainOf(last.url)) ?? "an unknown address"
        }.${cut}`,
      ),
      detail: {
        pages: record.pages.map((p) => ({ seq: p.seq, url: p.url, withheld: p.withheld ?? false })),
        visited,
        outcome: walk.outcome,
        omitted,
        revision,
      },
      artefacts: keys(...record.pages.map((p) => p.screenshotKey)).slice(0, MAX_ARTEFACTS),
    });
  }
  for (const { submission, outcome, own, severity } of kept) {
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
      artefacts: keys(shot),
    });
    if (outcome === "accepted") {
      const after = record.pages.find((p) => p.seq > submission.seq && p.began >= (submission.deliveredAt ?? Infinity));
      items.push({
        check: "walkthrough.canary_accepted",
        severity: "high",
        summary: plain(`The page at ${where} took the test credentials and moved on.`),
        detail: { url: submission.url, nextPage: after?.url ?? null, revision },
        artefacts: keys(shot, after?.screenshotKey),
      });
    }
  }
  for (const span of spans) {
    const page = record.pages.find((p) => p.seq === span.page);
    items.push({
      check: "walkthrough.hidden_text",
      severity: span.instruction ? "high" : "medium",
      summary: plain(`Hidden text on a walked page: "${plain(span.text, 120)}"`),
      detail: { quote: span.text, reason: span.reason, page: page?.url ?? null, revision },
      artefacts: keys(span.key, page?.screenshotKey),
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
  options: { table: BrandTable; revision: string | null; extra?: EvidenceDraft[] },
): Promise<Evidence[]> {
  const brand = await impersonatedBrand(db, caseId, walk, options.table);
  return addEvidence(db, caseId, "walkthrough", [
    ...walkthroughEvidence(walk, brand, options.revision, options.table),
    ...(options.extra ?? []),
  ]);
}
