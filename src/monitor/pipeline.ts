// The full pipeline on a flagged page (D05 T04 §4; spec 4.11): each settled lure the second look did
// not decline becomes a case (an upload by the system uploader, its screenshot the source; the monitor
// origin lives on the investigation row, migration 0084, so `cases` is never rebuilt), and the page is
// read, its logo compared with the protected business's own registered logo, and walked through when
// the reading finds a login or payment form. Mail-only checks never run. One failed page never stops
// the next; every investigation settles confirmed, unconfirmed or partial for §5 to read.
import { addEvidence, type EvidenceDraft, saveEvidence } from "../checks/evidence";
import { createCase } from "../db/cases";
import { putAttachment, type Store } from "../intake/store";
import type { MetaContext } from "../meta/client";
import { getIdentity } from "../trust/identity";
import { compareLogo, type LogoImage, logoMatchItem, logoNotComparedItem } from "../vision/logo-compare";
import { coverageItem, notCheckedItem, type ReadingImage, readingItems, readMail } from "../vision/reading";
import { type Flagged, flaggedForWalkthrough } from "./flagged";

export type InvestigationState = "investigating" | "confirmed" | "unconfirmed" | "partial";

export type PipelineDeps = {
  db: D1Database;
  bucket: R2Bucket;
  store: Store;
  kv: KVNamespace;
  meta: Omit<MetaContext, "owner">;
  // The walkthrough for a case with a form trigger, under its own driver limits (production:
  // walkthroughStep with the case's deps; a test names its own).
  walk: (caseId: string) => Promise<unknown>;
  // The SAM logo crop of a page screenshot (production: segment plus a Browser Run crop, wired in
  // monitorDeps; a test names its own). Null when no logo box is found.
  cropLogo?: (screenshot: Uint8Array, dataUrl: string) => Promise<LogoImage | null>;
  now?: () => Date;
};

export type PipelineSummary = { investigated: number; skipped: number; failed: number };

const sha256Hex = async (bytes: Uint8Array) => {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
};

const toBase64 = (bytes: Uint8Array) => {
  let out = "";
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(out);
};

async function settle(
  db: D1Database,
  orgId: string,
  captureKey: string,
  state: InvestigationState,
  refs: string[],
  now: Date,
): Promise<void> {
  await db
    .prepare(
      "UPDATE monitor_investigations SET state = ?, evidence_refs = ?, updated_at = ? WHERE org_id = ? AND capture_key = ?",
    )
    .bind(state, JSON.stringify(refs), now.toISOString(), orgId, captureKey)
    .run();
}

async function investigate(
  deps: PipelineDeps,
  orgId: string,
  page: Flagged,
  now: () => Date,
): Promise<InvestigationState> {
  const { db, bucket } = deps;
  const existing = await db
    .prepare("SELECT state, case_id FROM monitor_investigations WHERE org_id = ? AND capture_key = ?")
    .bind(orgId, page.capture_key)
    .first<{ state: string; case_id: string | null }>();
  if (existing && existing.state !== "investigating") return existing.state as InvestigationState;
  let caseId = existing?.case_id ?? null;
  if (!caseId) {
    const made = await createCase(db, {
      orgId,
      channel: "upload",
      headersAvailable: false,
      uploadedBy: "monitor",
      sourceKind: "image",
      uploadName: page.domain,
      uploadMediaType: "image/jpeg",
    });
    if (!made.ok) throw new Error(`monitor case refused: ${made.error.message}`);
    caseId = made.value.id;
    await db
      .prepare(
        `INSERT INTO monitor_investigations (org_id, domain, capture_key, case_id, state, evidence_refs, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'investigating', NULL, ?, ?)
         ON CONFLICT (org_id, capture_key) DO UPDATE SET case_id = excluded.case_id, updated_at = excluded.updated_at`,
      )
      .bind(orgId, page.domain, page.capture_key, caseId, now().toISOString(), now().toISOString())
      .run();
  }
  const refs: string[] = [];
  const finish = async (state: InvestigationState) => {
    await settle(db, orgId, page.capture_key, state, refs, now());
    return state;
  };
  const shot = await bucket.get(`${page.capture_key}screenshot.jpg`).catch(() => null);
  const textObj = await bucket.get(`${page.capture_key}text.txt`).catch(() => null);
  if (!shot) {
    await addEvidence(db, caseId, "vision", [notCheckedItem("the settled capture is missing")], now);
    return finish("partial");
  }
  const screenshot = new Uint8Array(await shot.arrayBuffer());
  const visibleText = textObj ? await textObj.text() : "";
  await putAttachment(deps.store, caseId, "screenshot.jpg", screenshot, "image/jpeg");
  const artefactKey = `cases/${caseId}/screenshot.jpg`;
  const image: ReadingImage = {
    id: "P1",
    promptLabel: "the flagged page's screenshot",
    key: artefactKey,
    name: "screenshot.jpg",
    sha256: await sha256Hex(screenshot),
    dataUrl: `data:image/jpeg;base64,${toBase64(screenshot)}`,
  };
  const ctx = {
    meta: { ...deps.meta, owner: { kind: "monitor" as const, run: caseId, host: page.domain, step: "pipeline" } },
    kv: deps.kv,
    owner: { kind: "monitor" as const, run: caseId, host: page.domain, step: "pipeline" },
    waitUntil: () => {},
  };
  let reading;
  try {
    reading = await readMail(ctx, [image], visibleText, true);
  } catch {
    await addEvidence(db, caseId, "vision", [notCheckedItem("the page could not be read")], now);
    return finish("partial");
  }
  const items: EvidenceDraft[] = [...readingItems(reading, [image])];
  refs.push(...items.map((i) => i.check));
  // The registered logo, resolved by organisation: the business's own identity logo, never a
  // shared brand index. Every state that cannot compare is stated, never a match.
  const brand = reading.readings[0]?.claimed_brand ?? page.domain;
  const identity = await getIdentity(db, orgId).catch(() => null);
  let logoCompared = false;
  if (!identity?.logo) {
    items.push(logoNotComparedItem(brand, artefactKey, "no-registered-logo"));
  } else if (identity.logo.mediaType === "image/svg+xml") {
    items.push(logoNotComparedItem(brand, artefactKey, "registered-logo-svg"));
  } else {
    const reference = await bucket.get(identity.logo.key).catch(() => null);
    if (!reference) {
      items.push(logoNotComparedItem(brand, artefactKey, "registered-logo-unreadable"));
    } else {
      try {
        const crop = deps.cropLogo ? await deps.cropLogo(screenshot, image.dataUrl) : null;
        if (!crop) {
          items.push(logoNotComparedItem(brand, artefactKey, "no-logo-found"));
        } else {
          const referenceImage: LogoImage = {
            bytes: new Uint8Array(await reference.arrayBuffer()),
            mediaType: identity.logo.mediaType,
            label: "the registered logo",
          };
          const cropImage: LogoImage = crop;
          const judgement = await compareLogo(ctx, cropImage, referenceImage);
          logoCompared = true;
          items.push(logoMatchItem(judgement, brand, artefactKey, "mismatch"));
          refs.push("vision.logo_match");
        }
      } catch {
        items.push(logoNotComparedItem(brand, artefactKey, "logo-comparison-failed"));
      }
    }
  }
  await addEvidence(db, caseId, "vision", items, now);
  // The walkthrough bridge: the reading's form becomes the trigger evidence walkTarget requires,
  // stored through the checks producer that owns link.* items.
  const action = reading.readings[0]?.requested_action;
  if (action === "log_in" || action === "pay") {
    await saveEvidence(
      db,
      caseId,
      [
        {
          check: action === "log_in" ? "link.credential_form" : "link.card_form",
          severity: "info",
          summary: `The flagged page asks a visitor to ${action === "log_in" ? "sign in" : "pay"}.`.slice(0, 200),
          detail: { page: `https://${page.domain}/`, source: "monitor-reading" },
          artefacts: [artefactKey],
        },
      ],
      undefined,
      now,
    );
    refs.push(action === "log_in" ? "link.credential_form" : "link.card_form");
  }
  if (action === "log_in" || action === "pay") {
    await deps.walk(caseId).catch(() => null);
    refs.push("walkthrough");
  }
  const confirmed = logoCompared && items.some((i) => i.check === "vision.logo_match" && i.severity === "high");
  return finish(confirmed ? "confirmed" : "unconfirmed");
}

// Every flagged page with no terminal investigation, investigated in order; a failure settles its
// own row partial where it can and never stops the next page.
export async function monitorPipeline(deps: PipelineDeps, orgId: string, since: string): Promise<PipelineSummary> {
  const now = deps.now ?? (() => new Date());
  const summary: PipelineSummary = { investigated: 0, skipped: 0, failed: 0 };
  for (const page of await flaggedForWalkthrough(deps.db, orgId, since)) {
    const existing = await deps.db
      .prepare("SELECT state FROM monitor_investigations WHERE org_id = ? AND capture_key = ?")
      .bind(orgId, page.capture_key)
      .first<{ state: string }>();
    if (existing && existing.state !== "investigating") {
      summary.skipped++;
      continue;
    }
    try {
      await investigate(deps, orgId, page, now);
      summary.investigated++;
    } catch (error) {
      summary.failed++;
      await settle(deps.db, orgId, page.capture_key, "partial", [], now()).catch(() => null);
    }
  }
  return summary;
}

export { coverageItem };
