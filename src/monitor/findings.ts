// Findings from settled investigations (D05 T04 §5): one finding per organisation and host, across
// captures. Only a confirmed investigation is presented as a fake site; an unconfirmed one lists
// without that claim, and a partial one lists as incomplete. A dismissal survives later captures
// and reopens only on a new confirmed capture after it; a host that stops resolving or stops
// flagging settles taken offline.
import { type MailDeps, type SendOutcome, sendMail } from "../mail/smtp2go";
import { identityContact } from "../trust/identity";
import {
  copyForTraining,
  encodeFindingDecision,
  isBenignDismissalReason,
  latestDismissedCaptureKey,
  parseFindingDecisions,
  recoverPendingTrainingCopies,
  resolveCaptureUrl,
  retractTrainingCopy,
} from "./training";

export type FindingStatus = "new" | "watching" | "offline" | "dismissed";
export type Finding = {
  org_id: string;
  host: string;
  status: FindingStatus;
  first_seen: string;
  capture_key: string;
  case_id: string | null;
  outcome: string;
  evidence_refs: string | null;
  alerted_at: string | null;
  alert_state: string | null;
  dismissed_capture_key: string | null;
  dismissed_at: string | null;
  updated_at: string;
};

export type AlertDeps = { mail: MailDeps | null; appUrl: string };

const ALERTS_FROM = "alerts@isitlegit.co.za";

async function settledOffline(db: D1Database, orgId: string, host: string, resolves: number | null): Promise<boolean> {
  if (resolves === 0) return true;
  // A failed read is not benign evidence: it propagates, so the Workflow step retries and the
  // run can settle partial instead of advancing a finding on a guess.
  const latestScreen = await db
    .prepare(
      "SELECT lure, outcome FROM monitor_screens WHERE org_id = ? AND domain = ? ORDER BY screened_at DESC LIMIT 1",
    )
    .bind(orgId, host)
    .first<{ lure: number | null; outcome: string }>();
  return latestScreen?.lure === 0 || latestScreen?.outcome === "parked";
}

// Create or advance findings from settled investigations. Returns how many alerted.
export async function findingsFromInvestigations(
  db: D1Database,
  orgId: string,
  deps: AlertDeps,
  now: () => Date = () => new Date(),
  bucket?: R2Bucket,
): Promise<{
  created: number;
  alerted: number;
  reopened: number;
  trainingRecoveryFailed?: number;
  trainingRecoveryErrors?: string[];
}> {
  const settled = (
    await db
      .prepare(
        `SELECT i.*, h.resolves FROM monitor_investigations i
         LEFT JOIN monitor_hosts h ON h.org_id = i.org_id AND h.domain = i.domain
         WHERE i.org_id = ? AND i.state != 'investigating' ORDER BY i.created_at`,
      )
      .bind(orgId)
      .all<{
        domain: string;
        capture_key: string;
        case_id: string | null;
        state: string;
        evidence_refs: string | null;
        created_at: string;
        resolves: number | null;
      }>()
  ).results;
  let created = 0;
  let reopened = 0;
  for (const inv of settled) {
    const host = inv.domain;
    const existing = await db
      .prepare("SELECT * FROM monitor_findings WHERE org_id = ? AND host = ?")
      .bind(orgId, host)
      .first<Finding & { dismissed_capture_key: string | null }>();
    if (!existing) {
      const offline = await settledOffline(db, orgId, host, inv.resolves);
      await db
        .prepare(
          `INSERT INTO monitor_findings (org_id, host, status, first_seen, capture_key, case_id, outcome, evidence_refs, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          orgId,
          host,
          offline ? "offline" : "new",
          inv.created_at,
          inv.capture_key,
          inv.case_id,
          inv.state,
          inv.evidence_refs,
          now().toISOString(),
          now().toISOString(),
        )
        .run();
      created++;
      continue;
    }
    if (existing.status === "dismissed") {
      // Reopen only on a capture actually made after the dismissal (the host row's capture
      // time for this capture, not the investigation's start): replaying settled investigations
      // includes captures from before it, and those never reopen the finding.
      // The capture's own moment is immutable in its key (`monitor/<org>/<host>/<ISO>/`);
      // the host row keeps only the latest capture, so its time is never used for an old one.
      const keyMoment = inv.capture_key.split("/").at(3) ?? "";
      const captureAt = /^\d{4}-\d{2}-\d{2}T/.test(keyMoment) ? keyMoment : inv.created_at;
      if (
        inv.state === "confirmed" &&
        inv.capture_key !== latestDismissedCaptureKey(existing.dismissed_capture_key) &&
        captureAt > (existing.dismissed_at ?? "")
      ) {
        // A reopen lands offline, never live, when current evidence already settles it there.
        // Preserve dismissed_reason alongside dismissed_capture_key so recovery still knows the
        // older capture was a qualifying dismissal, never an explicit business restore.
        const reopenOffline = await settledOffline(db, orgId, host, inv.resolves);
        const done = await db
          .prepare(
            "UPDATE monitor_findings SET status = ?, capture_key = ?, case_id = ?, outcome = ?, evidence_refs = ?, alerted_at = NULL, alert_state = NULL, dismissed_at = NULL, updated_at = ? WHERE org_id = ? AND host = ? AND status = 'dismissed' AND dismissed_at = ?",
          )
          .bind(
            reopenOffline ? "offline" : "new",
            inv.capture_key,
            inv.case_id,
            inv.state,
            inv.evidence_refs,
            now().toISOString(),
            orgId,
            host,
            existing.dismissed_at,
          )
          .run();
        if ((done.meta?.changes ?? 0) > 0) reopened++;
      }
      continue;
    }
    // Taken offline: the host stops resolving, or its latest screened capture no longer flags.
    const offline = await settledOffline(db, orgId, host, inv.resolves);
    await db
      .prepare(
        "UPDATE monitor_findings SET status = ?, capture_key = ?, case_id = ?, outcome = ?, evidence_refs = ?, updated_at = ? WHERE org_id = ? AND host = ? AND status = ?",
      )
      .bind(
        offline
          ? "offline"
          : existing.status === "new" || (existing.alerted_at === null && inv.state === "confirmed")
            ? // A confirmed finding that has never alerted is new again when it returns live.
              "new"
            : "watching",
        inv.capture_key,
        inv.case_id,
        inv.state,
        inv.evidence_refs,
        now().toISOString(),
        orgId,
        host,
        existing.status,
      )
      .run();
  }
  const alerted = await alertNewFindings(db, orgId, deps, now);
  let trainingRecoveryFailed = 0;
  let trainingRecoveryErrors: string[] | undefined;
  if (bucket) {
    const rec = await recoverPendingTrainingCopies(db, bucket, orgId, now).catch((err) => ({
      recovered: 0,
      failed: 1,
      errors: [`recovery-exception:${(err as Error).message || "failed"}`],
    }));
    trainingRecoveryFailed = rec.failed;
    trainingRecoveryErrors = rec.errors;
  }
  return {
    created,
    alerted,
    reopened,
    ...(trainingRecoveryFailed > 0
      ? {
          trainingRecoveryFailed,
          ...(trainingRecoveryErrors ? { trainingRecoveryErrors } : {}),
        }
      : {}),
  };
}

// One alert per new confirmed finding, keyed so a restart after delivery sends nothing twice.
// `alerted_at` is written only on a confirmed send; a definite failure retries next run, an
// uncertain outcome is stated on the finding, and a refusal is stated, never resent.
export async function alertNewFindings(
  db: D1Database,
  orgId: string,
  deps: AlertDeps,
  now: () => Date = () => new Date(),
): Promise<number> {
  if (!deps.mail) return 0;
  const contact = await identityContact(db, orgId);
  if (!contact) return 0;
  const pending = (
    await db
      .prepare(
        "SELECT * FROM monitor_findings WHERE org_id = ? AND status = 'new' AND outcome = 'confirmed' AND alerted_at IS NULL ORDER BY first_seen",
      )
      .bind(orgId)
      .all<Finding>()
  ).results;
  let sent = 0;
  for (const finding of pending) {
    const outcome: SendOutcome = await sendMail(deps.mail, {
      sendKey: `monitor-finding:${orgId}:${finding.host}`,
      kind: "alert",
      to: contact,
      from: ALERTS_FROM,
      subject: `Impersonation found: ${finding.host}`,
      text: [
        `A fake site impersonating your business was found at ${finding.host} (first seen ${finding.first_seen}).`,
        `See the evidence and its screenshot: ${deps.appUrl}/monitor?finding=${finding.host}`,
        `Download the takedown pack: ${deps.appUrl}/monitor/pack/${finding.host}?format=pdf`,
        "We have not contacted the registrar or host for you. The pack has what they need.",
      ].join("\n\n"),
      html: `<p>A fake site impersonating your business was found at <strong>${finding.host}</strong> (first seen ${finding.first_seen}).</p><p><a href="${deps.appUrl}/monitor/pack/${finding.host}?format=pdf" style="display:inline-block;padding:10px 18px;background:#FF4A14;color:#ffffff;text-decoration:none;border-radius:6px">Download the takedown pack</a></p><p>See the evidence and its screenshot: <a href="${deps.appUrl}/monitor?finding=${finding.host}">${deps.appUrl}/monitor?finding=${finding.host}</a></p><p>We have not contacted the registrar or host for you. The pack has what they need.</p>`,
    }).catch(() => ({ status: "failed", reason: "send threw", attempts: 0 }) as SendOutcome);
    // A duplicate outcome reconciles from the durable send record: a send that landed before
    // an earlier findings update failed is still a delivered alert, never a resend.
    const delivered = outcome.status === "sent" || (outcome.status === "duplicate" && outcome.previous === "sent");
    const uncertain =
      outcome.status === "uncertain" || (outcome.status === "duplicate" && outcome.previous === "uncertain");
    const refused = outcome.status === "refused" || (outcome.status === "duplicate" && outcome.previous === "refused");
    if (delivered) {
      await db
        .prepare(
          "UPDATE monitor_findings SET alerted_at = ?, alert_state = 'sent', updated_at = ? WHERE org_id = ? AND host = ?",
        )
        .bind(now().toISOString(), now().toISOString(), orgId, finding.host)
        .run();
      sent++;
    } else if (uncertain) {
      await db
        .prepare("UPDATE monitor_findings SET alert_state = 'uncertain', updated_at = ? WHERE org_id = ? AND host = ?")
        .bind(now().toISOString(), orgId, finding.host)
        .run();
    } else if (refused) {
      await db
        .prepare("UPDATE monitor_findings SET alert_state = 'refused', updated_at = ? WHERE org_id = ? AND host = ?")
        .bind(now().toISOString(), orgId, finding.host)
        .run();
    } else {
      // A definite failure is stated on the finding; alerted_at stays null, so the next run
      // retries with the same key.
      await db
        .prepare("UPDATE monitor_findings SET alert_state = 'failed', updated_at = ? WHERE org_id = ? AND host = ?")
        .bind(now().toISOString(), orgId, finding.host)
        .run();
    }
  }
  return sent;
}

export async function dismissFinding(
  db: D1Database,
  orgId: string,
  host: string,
  reason: string,
  now: () => Date = () => new Date(),
  bucket?: R2Bucket,
): Promise<boolean> {
  const trimmed = reason.trim();
  if (!trimmed || trimmed.length > 500) return false;
  const nowIso = now().toISOString();
  let capturedKey = "";
  let updated = false;
  for (let attempt = 0; attempt < 8; attempt++) {
    const finding = await db
      .prepare(
        "SELECT status, capture_key, dismissed_reason, dismissed_capture_key FROM monitor_findings WHERE org_id = ? AND host = ?",
      )
      .bind(orgId, host)
      .first<{
        status: string;
        capture_key: string;
        dismissed_reason: string | null;
        dismissed_capture_key: string | null;
      }>();
    if (!finding) return false;
    capturedKey = finding.capture_key;
    const encodedDecisions = encodeFindingDecision(finding, {
      captureKey: finding.capture_key,
      kind: "dismissal",
      reason: trimmed,
      at: nowIso,
    });
    const res = await db
      .prepare(
        `UPDATE monitor_findings
         SET status = 'dismissed', dismissed_reason = ?, dismissed_at = ?, dismissed_capture_key = ?, updated_at = ?
         WHERE org_id = ? AND host = ?
           AND status = ? AND capture_key = ?
           AND dismissed_reason IS ? AND dismissed_capture_key IS ?`,
      )
      .bind(
        trimmed,
        nowIso,
        encodedDecisions,
        nowIso,
        orgId,
        host,
        finding.status,
        finding.capture_key,
        finding.dismissed_reason,
        finding.dismissed_capture_key,
      )
      .run();
    if ((res.meta?.changes ?? 0) > 0) {
      updated = true;
      break;
    }
  }
  if (!updated || !capturedKey) return false;
  if (bucket && isBenignDismissalReason(trimmed)) {
    const current = await db
      .prepare(
        "SELECT status, capture_key, dismissed_reason, dismissed_capture_key FROM monitor_findings WHERE org_id = ? AND host = ?",
      )
      .bind(orgId, host)
      .first<{
        status: string;
        capture_key: string;
        dismissed_reason: string | null;
        dismissed_capture_key: string | null;
      }>();
    const activeDecision = current
      ? parseFindingDecisions(current).find((d) => d.captureKey === capturedKey)
      : undefined;
    if (!activeDecision || activeDecision.kind === "dismissal") {
      const captureUrl = await resolveCaptureUrl(db, bucket, orgId, host, capturedKey);
      await copyForTraining(
        bucket,
        {
          orgId,
          host,
          captureKey: capturedKey,
          captureUrl,
          label: "benign",
          why: `dismissed as not a fake: ${trimmed.slice(0, 120)}`,
          source: "dismissal",
          sourceRef: `finding:${orgId}:${host}:${capturedKey}`,
        },
        now,
      ).catch(() => "missing-source");
    }
  }
  return true;
}

export async function restoreFinding(
  db: D1Database,
  orgId: string,
  host: string,
  now: () => Date = () => new Date(),
  bucket?: R2Bucket,
): Promise<boolean> {
  const nowIso = now().toISOString();
  let targetKey = "";
  let changed = false;
  for (let attempt = 0; attempt < 8; attempt++) {
    const existing = await db
      .prepare(
        "SELECT status, capture_key, dismissed_reason, dismissed_capture_key FROM monitor_findings WHERE org_id = ? AND host = ? AND status = 'dismissed'",
      )
      .bind(orgId, host)
      .first<{
        status: string;
        capture_key: string;
        dismissed_reason: string | null;
        dismissed_capture_key: string | null;
      }>();
    if (!existing) return false;
    targetKey = latestDismissedCaptureKey(existing.dismissed_capture_key) ?? existing.capture_key;
    const encodedDecisions = encodeFindingDecision(existing, {
      captureKey: targetKey,
      kind: "restore",
      reason: "finding restored by business",
      at: nowIso,
    });
    const result = await db
      .prepare(
        `UPDATE monitor_findings
         SET status = 'watching', dismissed_reason = NULL, dismissed_at = NULL, dismissed_capture_key = ?, updated_at = ?
         WHERE org_id = ? AND host = ? AND status = 'dismissed'
           AND capture_key = ? AND dismissed_reason IS ? AND dismissed_capture_key IS ?`,
      )
      .bind(
        encodedDecisions,
        nowIso,
        orgId,
        host,
        existing.capture_key,
        existing.dismissed_reason,
        existing.dismissed_capture_key,
      )
      .run();
    if ((result.meta?.changes ?? 0) > 0) {
      changed = true;
      break;
    }
  }
  if (changed && bucket && targetKey) {
    await retractTrainingCopy(bucket, orgId, host, targetKey, "finding restored by business", now).catch(
      () => "missing",
    );
  }
  return changed;
}

export async function listFindings(db: D1Database, orgId: string): Promise<Finding[]> {
  return (
    await db
      .prepare("SELECT * FROM monitor_findings WHERE org_id = ? ORDER BY first_seen DESC")
      .bind(orgId)
      .all<Finding>()
  ).results;
}
