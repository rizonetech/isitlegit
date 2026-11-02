// The full pipeline on a flagged page (D05 T04 §4; spec 4.11): each settled lure the second look did
// not decline becomes a case (an upload by the system uploader, its screenshot the source; the monitor
// origin lives on the investigation row, migration 0084, so `cases` is never rebuilt), and the page is
// read, its logo compared with the protected business's own registered logo, and walked through when
// the reading finds a login or payment form. Mail-only checks never run. One failed page never stops
// the next; every investigation settles confirmed, unconfirmed or partial for §5 to read.
import { addEvidence, type EvidenceDraft, saveEvidence } from "../checks/evidence";
import { createCase, setStatus, setVerdict } from "../db/cases";
import { putAttachment, type Store } from "../intake/store";
import type { MetaContext } from "../meta/client";
import { getIdentity } from "../trust/identity";
import { compareLogo, type LogoImage, logoMatchItem, logoNotComparedItem } from "../vision/logo-compare";
import { coverageItem, notCheckedItem, type ReadingImage, readingItems, readMail } from "../vision/reading";
import { type Flagged, flaggedForWalkthrough } from "./flagged";
import { protectedOrgs } from "./run";
import { copyForTraining } from "./training";

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
  // The row lands before the case, so an interruption at any later point is recoverable and
  // settleable (completion review gaps 4 and 8).
  const urlAtStart = await db
    .prepare("SELECT capture_url FROM monitor_hosts WHERE org_id = ? AND domain = ?")
    .bind(orgId, page.domain)
    .first<{ capture_url: string | null }>();
  await db
    .prepare(
      `INSERT INTO monitor_investigations (org_id, domain, capture_key, case_id, capture_url, state, evidence_refs, created_at, updated_at)
       VALUES (?, ?, ?, NULL, ?, 'investigating', NULL, ?, ?)
       ON CONFLICT (org_id, capture_key) DO NOTHING`,
    )
    .bind(
      orgId,
      page.domain,
      page.capture_key,
      urlAtStart?.capture_url ?? null,
      now().toISOString(),
      now().toISOString(),
    )
    .run();
  let caseId = existing?.case_id ?? null;
  if (!caseId) {
    // A prior run may have created the case and stopped before recording it: adopt that case
    // (the system uploader's, for this host, made after the investigation row) instead of
    // creating an orphan beside it.
    const orphan = await db
      .prepare(
        `SELECT id FROM cases WHERE org_id = ? AND uploaded_by = 'monitor' AND upload_name = ?
         ORDER BY created_at LIMIT 1`,
      )
      .bind(orgId, `${page.domain}@${page.capture_key.replace(/\/$/, "").split("/").at(-1) ?? ""}`)
      .first<{ id: string }>();
    if (orphan) {
      caseId = orphan.id;
      await db
        .prepare("UPDATE monitor_investigations SET case_id = ?, updated_at = ? WHERE org_id = ? AND capture_key = ?")
        .bind(caseId, now().toISOString(), orgId, page.capture_key)
        .run();
    }
  }
  if (!caseId) {
    const made = await createCase(db, {
      orgId,
      channel: "upload",
      headersAvailable: false,
      uploadedBy: "monitor",
      sourceKind: "image",
      uploadName: `${page.domain}@${page.capture_key.replace(/\/$/, "").split("/").at(-1) ?? ""}`,
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
    // A confirmed page is labelled the moment it settles (D05 T04 §10): its fetched page is
    // copied for Loupe's training before anything can delete the case's artefacts. A failed
    // copy states itself in the log and is retried by the next settlement read, never
    // changing the investigation's outcome.
    if (state === "confirmed")
      await copyForTraining(bucket, {
        orgId,
        host: page.domain,
        captureKey: page.capture_key,
        captureUrl: await db
          .prepare("SELECT capture_url FROM monitor_hosts WHERE org_id = ? AND domain = ? AND capture_key = ?")
          .bind(orgId, page.domain, page.capture_key)
          .first<{ capture_url: string | null }>()
          .then((row) => row?.capture_url ?? null)
          .catch(() => null),
        label: "lure",
        why: "the full pipeline confirmed this page as a lure",
        source: "pipeline",
      }).catch((error: Error) =>
        console.log(JSON.stringify({ event: "monitor-training", outcome: "copy-failed", error: error.name })),
      );
    // The shared case leaves `received` with the investigation (round 4): confirmed carries a
    // malicious verdict and finishes; anything else finishes partial, never a clean verdict.
    if (state === "confirmed") {
      await setVerdict(db, orgId, caseId, "malicious").catch(() => null);
      await setStatus(db, orgId, caseId, "done").catch(() => null);
    } else {
      await setStatus(db, orgId, caseId, "partial").catch(() => null);
    }
    return state;
  };
  const shot = await bucket.get(`${page.capture_key}screenshot.jpg`).catch(() => null);
  const textObj = await bucket.get(`${page.capture_key}text.txt`).catch(() => null);
  if (!shot) {
    refs.push(
      ...(await addEvidence(db, caseId, "vision", [notCheckedItem("the settled capture is missing")], now)).map(
        (e) => e.id,
      ),
    );
    return finish("partial");
  }
  const screenshot = new Uint8Array(await shot.arrayBuffer());
  const visibleText = textObj ? await textObj.text() : "";
  const stored = await putAttachment(deps.store, caseId, "screenshot.jpg", screenshot, "image/jpeg");
  const artefactKey = stored.key;
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
  let reading: Awaited<ReturnType<typeof readMail>>;
  try {
    reading = await readMail(ctx, [image], visibleText, true);
  } catch {
    refs.push(
      ...(await addEvidence(db, caseId, "vision", [notCheckedItem("the page could not be read")], now)).map(
        (e) => e.id,
      ),
    );
    return finish("partial");
  }
  const items: EvidenceDraft[] = [...readingItems(reading, [image])];
  // The registered logo, resolved by organisation: the business's own identity logo, never a
  // shared brand index. Every state that cannot compare is stated, never a match.
  const brand = reading.readings[0]?.claimed_brand ?? page.domain;
  // The captured final URL's host, assessed against the business's own verified domains before
  // any impersonation claim (completion review gap 2): its own host is official, anything else
  // is a mismatch.
  const hostRow = await db
    .prepare("SELECT capture_url FROM monitor_investigations WHERE org_id = ? AND capture_key = ?")
    .bind(orgId, page.capture_key)
    .first<{ capture_url: string | null }>()
    .catch(() => null);
  const hostCurrent = await db
    .prepare("SELECT capture_url, captured_at FROM monitor_hosts WHERE org_id = ? AND domain = ?")
    .bind(orgId, page.domain)
    .first<{ capture_url: string | null; captured_at: string | null }>();
  // The destination persisted with this capture wins; the host row's current URL is used only
  // when it is this capture's moment, never another capture's redirect (round 3).
  const moment = page.capture_key.replace(/\/$/, "").split("/").at(-1);
  const storedUrl = (hostRow as { capture_url: string | null } | null)?.capture_url;
  const finalUrl =
    storedUrl ??
    (hostCurrent?.capture_url && hostCurrent.captured_at === moment
      ? hostCurrent.capture_url
      : `https://${page.domain}/`);
  const finalHost = new URL(finalUrl).hostname;
  const ownDomains = (
    await db
      .prepare("SELECT domain FROM org_domains WHERE org_id = ? AND state = 'verified'")
      .bind(orgId)
      .all<{ domain: string }>()
  ).results.map((r) => r.domain);
  const domainJudgement: "official" | "mismatch" = ownDomains.some(
    (d) => finalHost === d || finalHost.endsWith(`.${d}`),
  )
    ? "official"
    : "mismatch";
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
          items.push(logoMatchItem(judgement, brand, artefactKey, domainJudgement));
        }
      } catch {
        items.push(logoNotComparedItem(brand, artefactKey, "logo-comparison-failed"));
      }
    }
  }
  refs.push(...(await addEvidence(db, caseId, "vision", items, now)).map((e) => e.id));
  // The walkthrough bridge: the reading's form becomes the trigger evidence walkTarget requires,
  // stored through the checks producer that owns link.* items.
  let action = reading.readings[0]?.requested_action;
  if (action !== "log_in" && action !== "pay") {
    // The capture's own form signals are an observation too (completion review gap 3): a page
    // with password or form fields walks even when the reading named no action.
    const signalsObj = await bucket.get(`${page.capture_key}signals.json`).catch(() => null);
    const signals = signalsObj
      ? ((await signalsObj.json().catch(() => null)) as { passwords?: number; forms?: number } | null)
      : null;
    if ((signals?.passwords ?? 0) > 0) action = "log_in";
    else if ((signals?.forms ?? 0) > 0) action = "pay";
  }
  if (action === "log_in" || action === "pay") {
    const savedTrigger = await saveEvidence(
      db,
      caseId,
      [
        {
          check: action === "log_in" ? "link.credential_form" : "link.card_form",
          severity: "info",
          summary: `The flagged page asks a visitor to ${action === "log_in" ? "sign in" : "pay"}.`.slice(0, 200),
          detail: { page: finalUrl, source: "monitor-reading" },
          artefacts: [artefactKey],
        },
      ],
      undefined,
      now,
    );
    refs.push(...savedTrigger.map((e) => e.id));
  }
  let walkFailed = false;
  if (action === "log_in" || action === "pay") {
    const walked = await deps.walk(caseId).catch(() => {
      walkFailed = true;
      return null;
    });
    if ((walked as { outcome?: string } | null)?.outcome === "not-run") walkFailed = true;
  }
  // Settlement reads the whole case (round 1): the walkthrough's own findings beside the logo,
  // and every final Evidence ID, collected after all producers have written.
  const { readEvidence } = await import("../checks/evidence");
  const final = await readEvidence(db, caseId);
  refs.length = 0;
  refs.push(...final.map((e) => e.id));
  const confirmed =
    final.some((e) => e.check === "vision.logo_match" && (e.severity === "high" || e.severity === "critical")) ||
    final.some((e) => e.check.startsWith("walkthrough.") && (e.severity === "high" || e.severity === "critical"));
  const failed =
    walkFailed || !logoCompared || final.some((e) => (e.detail as { checked?: boolean }).checked === false);
  return finish(confirmed ? "confirmed" : failed ? "partial" : "unconfirmed");
}

// Every flagged page with no terminal investigation, investigated in order; a failure settles its
// own row partial where it can and never stops the next page.
export async function monitorPipeline(deps: PipelineDeps, orgId: string, since: string): Promise<PipelineSummary> {
  const now = deps.now ?? (() => new Date());
  const summary: PipelineSummary = { investigated: 0, skipped: 0, failed: 0 };
  // The monitor's own eligibility gate (round 4): no protection on, no investigation, whatever
  // outstanding rows an earlier run left.
  if (!(await protectedOrgs(deps.db)).includes(orgId)) return summary;
  // Outstanding investigations are recovered whatever their age or whether a newer capture
  // replaced them (completion review gap 5): their rows, not the run's window, name the work.
  const outstanding = (
    await deps.db
      .prepare("SELECT domain, capture_key FROM monitor_investigations WHERE org_id = ? AND state = 'investigating'")
      .bind(orgId)
      .all<{ domain: string; capture_key: string }>()
  ).results;
  const pages: Flagged[] = [...(await flaggedForWalkthrough(deps.db, orgId, since))];
  for (const row of outstanding)
    if (!pages.some((p) => p.capture_key === row.capture_key))
      pages.push({
        domain: row.domain,
        capture_key: row.capture_key,
        lure_type: "credential",
        confidence: 0,
        screener: "glimmer",
        second_look: null,
        screened_at: "",
      });
  for (const page of pages) {
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
    } catch {
      summary.failed++;
      await settle(deps.db, orgId, page.capture_key, "partial", [], now()).catch(() => null);
    }
  }
  return summary;
}

export { coverageItem };
