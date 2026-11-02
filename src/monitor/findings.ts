// Findings from settled investigations (D05 T04 §5): one finding per organisation and host, across
// captures. Only a confirmed investigation is presented as a fake site; an unconfirmed one lists
// without that claim, and a partial one lists as incomplete. A dismissal survives later captures
// and reopens only on a new confirmed capture after it; a host that stops resolving or stops
// flagging settles taken offline.
import { type MailDeps, type SendOutcome, sendMail } from "../mail/smtp2go";
import { identityContact } from "../trust/identity";

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

// Create or advance findings from settled investigations. Returns how many alerted.
export async function findingsFromInvestigations(
  db: D1Database,
  orgId: string,
  deps: AlertDeps,
  now: () => Date = () => new Date(),
): Promise<{ created: number; alerted: number; reopened: number }> {
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
      await db
        .prepare(
          `INSERT INTO monitor_findings (org_id, host, status, first_seen, capture_key, case_id, outcome, evidence_refs, created_at, updated_at)
           VALUES (?, ?, 'new', ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          orgId,
          host,
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
      // Reopen only on a confirmed capture made after the dismissal: replaying the settled
      // investigations includes captures from before it, and those never reopen the finding.
      if (
        inv.state === "confirmed" &&
        inv.capture_key !== existing.dismissed_capture_key &&
        inv.created_at > (existing.dismissed_at ?? "")
      ) {
        await db
          .prepare(
            "UPDATE monitor_findings SET status = 'new', capture_key = ?, case_id = ?, outcome = ?, evidence_refs = ?, alerted_at = NULL, alert_state = NULL, dismissed_reason = NULL, dismissed_at = NULL, updated_at = ? WHERE org_id = ? AND host = ?",
          )
          .bind(inv.capture_key, inv.case_id, inv.state, inv.evidence_refs, now().toISOString(), orgId, host)
          .run();
        reopened++;
      }
      continue;
    }
    // Taken offline: the host stops resolving, or its latest screened capture no longer flags.
    const latestScreen = await db
      .prepare("SELECT lure FROM monitor_screens WHERE org_id = ? AND domain = ? ORDER BY screened_at DESC LIMIT 1")
      .bind(orgId, host)
      .first<{ lure: number | null }>()
      .catch(() => null);
    const offline = inv.resolves === 0 || latestScreen?.lure === 0;
    await db
      .prepare(
        "UPDATE monitor_findings SET status = ?, capture_key = ?, case_id = ?, outcome = ?, evidence_refs = ?, updated_at = ? WHERE org_id = ? AND host = ?",
      )
      .bind(
        offline ? "offline" : existing.status === "new" ? "new" : "watching",
        inv.capture_key,
        inv.case_id,
        inv.state,
        inv.evidence_refs,
        now().toISOString(),
        orgId,
        host,
      )
      .run();
  }
  const alerted = await alertNewFindings(db, orgId, deps, now);
  return { created, alerted, reopened };
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
        `See the evidence and its screenshot: ${deps.appUrl}/monitor#${finding.host}`,
        `Download the takedown pack: ${deps.appUrl}/monitor/pack/${finding.host}?format=pdf`,
        "We have not contacted the registrar or host for you. The pack has what they need.",
      ].join("\n\n"),
      html: `<p>A fake site impersonating your business was found at <strong>${finding.host}</strong> (first seen ${finding.first_seen}).</p><p><a href="${deps.appUrl}/monitor/pack/${finding.host}?format=pdf" style="display:inline-block;padding:10px 18px;background:#FF4A14;color:#ffffff;text-decoration:none;border-radius:6px">Download the takedown pack</a></p><p>See the evidence and its screenshot: <a href="${deps.appUrl}/monitor#${finding.host}">${deps.appUrl}/monitor#${finding.host}</a></p><p>We have not contacted the registrar or host for you. The pack has what they need.</p>`,
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
    }
    // failed/retry: alerted_at stays null, so the next run retries with the same key.
  }
  return sent;
}

export async function dismissFinding(
  db: D1Database,
  orgId: string,
  host: string,
  reason: string,
  now: () => Date = () => new Date(),
): Promise<boolean> {
  const trimmed = reason.trim();
  if (!trimmed || trimmed.length > 500) return false;
  const finding = await db
    .prepare("SELECT capture_key FROM monitor_findings WHERE org_id = ? AND host = ?")
    .bind(orgId, host)
    .first<{ capture_key: string }>();
  if (!finding) return false;
  await db
    .prepare(
      "UPDATE monitor_findings SET status = 'dismissed', dismissed_reason = ?, dismissed_at = ?, dismissed_capture_key = ?, updated_at = ? WHERE org_id = ? AND host = ?",
    )
    .bind(trimmed, now().toISOString(), finding.capture_key, now().toISOString(), orgId, host)
    .run();
  return true;
}

export async function restoreFinding(
  db: D1Database,
  orgId: string,
  host: string,
  now: () => Date = () => new Date(),
): Promise<boolean> {
  const result = await db
    .prepare(
      "UPDATE monitor_findings SET status = 'watching', dismissed_reason = NULL, dismissed_at = NULL, updated_at = ? WHERE org_id = ? AND host = ? AND status = 'dismissed'",
    )
    .bind(now().toISOString(), orgId, host)
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

export async function listFindings(db: D1Database, orgId: string): Promise<Finding[]> {
  return (
    await db
      .prepare("SELECT * FROM monitor_findings WHERE org_id = ? ORDER BY first_seen DESC")
      .bind(orgId)
      .all<Finding>()
  ).results;
}
