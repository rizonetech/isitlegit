import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addEvidence, type EvidenceDraft, readEvidence } from "../../src/checks/evidence";
import { createCase } from "../../src/db/cases";
import { putAttachment } from "../../src/intake/store";
import { recipientHash } from "../../src/mail/smtp2go";
import { setIdentity } from "../../src/trust/identity";
import {
  acknowledgeVerificationDelivery,
  refreshVerificationDeliveries,
  requestVerification,
} from "../../src/trust/verify-request";
import { addAddress, makeOrg, protectableOrg } from "./helpers";

const db = env.DB;
const secret = "verification-test-secret-with-at-least-32-bytes";
type Payload = {
  to: string[];
  sender: string;
  subject: string;
  text_body: string;
  custom_headers: { header: string; value: string }[];
};
const required = <T>(value: T | undefined): T => {
  if (value === undefined) throw new Error("expected fixture value");
  return value;
};
const hash = async (value: string) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

afterEach(() => vi.restoreAllMocks());
beforeEach(async () => {
  await db.prepare("DELETE FROM cases").run();
});

async function scenario() {
  const contact = `finance-${crypto.randomUUID()}@demo.isitlegit.co.za`;
  const orgId = await makeOrg();
  const supplierId = await protectableOrg(`supplier-${crypto.randomUUID()}.example`, contact);
  await setIdentity(db, supplierId, "owner", {
    displayNames: ["Fictional Supplier"],
    financeContact: contact,
    protected: true,
  });
  const made = await createCase(db, { orgId, channel: "email", headersAvailable: false });
  if (!made.ok) throw new Error(made.error.message);
  const caseId = made.value.id;
  const stored = await putAttachment(
    { db, bucket: env.ARTEFACTS },
    caseId,
    "invoice.pdf",
    new TextEncoder().encode("%PDF synthetic invoice"),
    "application/pdf",
  );
  const attachment = stored.key;
  await addEvidence(db, caseId, "invoice", [
    {
      check: "invoice.bank_changed",
      severity: "critical",
      summary: "Invoice bank details differ from the registered account.",
      detail: {
        against: "registry",
        registry_match: false,
        protected_org_id: supplierId,
        amount_cents: 123456,
        currency: "ZAR",
        account_last3: "773",
        attachment,
        invoice_contact: "attacker@outside.example",
      },
      artefacts: [attachment],
    },
  ]);
  const calls: Payload[] = [];
  let mode: "sent" | "failed" | "uncertain" = "sent";
  const transport = vi.fn(async (_url: unknown, init?: RequestInit) => {
    calls.push(JSON.parse(String(init?.body)));
    if (mode === "uncertain") throw new Error("network unavailable");
    if (mode === "failed") return new Response(JSON.stringify({ data: { error: "refused" } }), { status: 400 });
    return new Response(JSON.stringify({ data: { succeeded: 1, failed: 0, email_id: "provider-id" } }));
  });
  const now = new Date();
  const deps = {
    db,
    secret,
    now: () => now,
    mail: { apiKey: "test-key", fetch: transport as typeof fetch, pause: async () => {} },
  };
  return {
    contact,
    orgId,
    supplierId,
    caseId,
    attachment,
    calls,
    deps,
    transport,
    mode: (value: typeof mode) => {
      mode = value;
    },
  };
}

async function changeEvidence(caseId: string, patch: EvidenceDraft["detail"]) {
  const [source] = await readEvidence(db, caseId);
  if (!source) throw new Error("missing source");
  await addEvidence(db, caseId, "invoice", [{ ...source, detail: { ...source.detail, ...patch } }]);
}

const replyToken = (payload: Payload) =>
  String(payload.custom_headers.find((h) => h.header === "Reply-To")?.value).match(
    /^verify\+([A-Za-z0-9_-]{43})@isitlegit\.co\.za$/,
  )?.[1] as string;

describe("registered-contact verification requests", () => {
  it("sends only the registered contact, snapshots the invoice amount and last three, and returns safe evidence", async () => {
    const s = await scenario();
    const log = vi.spyOn(console, "log");
    const result = await requestVerification(s.deps, s.caseId, s.orgId);
    expect(result.outcome).toBe("requested");
    expect(s.calls).toHaveLength(1);
    const mail = required(s.calls[0]);
    expect(mail.to).toEqual([s.contact]);
    expect(mail.sender).toBe("verify@isitlegit.co.za");
    expect(mail.subject).toBe("Please confirm these invoice payment details");
    const deadline = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Africa/Johannesburg",
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date(s.deps.now().getTime() + 72 * 3600_000));
    expect(mail.text_body).toBe(
      `An invoice claims to be from your business and asks for ZAR 1234.56 to an account ending 773. These details do not match the account registered with IsItLegit.\n\nAre these the payment details your business authorised for this invoice? Reply yes or no by ${deadline} SAST. Do not send your bank account number.\n\nThis request does not confirm that the invoice is genuine. The checker should still phone you on a known number before paying.`,
    );
    const token = replyToken(mail);
    expect(token).toHaveLength(43);
    expect(`verify+${token}`).toHaveLength(50);
    const row = await db.prepare("SELECT * FROM verifications WHERE case_id = ?").bind(s.caseId).first();
    expect(row?.token_hash).toBe(await hash(token));
    expect(row?.recipient_hash).toBe(await recipientHash(s.contact));
    expect(Date.parse(String(row?.expires_at)) - Date.parse(String(row?.created_at))).toBe(72 * 3600_000);
    expect(result.evidence[0]?.check).toBe("verification.requested");
    const stored = JSON.stringify({ row, result, logs: log.mock.calls });
    for (const privateValue of [token, secret, s.contact, "attacker@outside.example"])
      expect(stored).not.toContain(privateValue);
  });

  it("serialises concurrent and replayed requests through the mail send claim", async () => {
    const s = await scenario();
    await Promise.all([requestVerification(s.deps, s.caseId, s.orgId), requestVerification(s.deps, s.caseId, s.orgId)]);
    expect((await requestVerification(s.deps, s.caseId, s.orgId)).outcome).toBe("requested");
    expect(s.calls).toHaveLength(1);
    expect(
      (await db.prepare("SELECT count(*) AS n FROM verifications WHERE case_id = ?").bind(s.caseId).first())?.n,
    ).toBe(1);
  });

  it("refuses a foreign tenant and a caller that lapses before queued execution", async () => {
    const s = await scenario();
    expect((await requestVerification(s.deps, s.caseId, await makeOrg())).outcome).toBe("none");
    await db
      .prepare('UPDATE organization SET "createdAt" = ? WHERE id = ?')
      .bind("2020-01-01T00:00:00Z", s.orgId)
      .run();
    const result = await requestVerification(s.deps, s.caseId, s.orgId);
    expect(result.outcome).toBe("unavailable");
    expect(result.evidence[0]?.detail.reason).toBe("plan-required");
    expect(s.calls).toHaveLength(0);
  });

  it.each(["unverified", "unprotected", "outside-allowlist"])("does not mail a %s finance contact", async (state) => {
    const s = await scenario();
    if (state === "unverified")
      await db.prepare("UPDATE org_addresses SET state = 'pending' WHERE org_id = ?").bind(s.supplierId).run();
    if (state === "unprotected")
      await db.prepare("UPDATE identities SET protected = 0 WHERE org_id = ?").bind(s.supplierId).run();
    if (state === "outside-allowlist") {
      await addAddress(s.supplierId, "finance@outside.example");
      await setIdentity(db, s.supplierId, "owner", {
        displayNames: ["Fictional Supplier"],
        financeContact: "finance@outside.example",
        protected: true,
      });
    }
    expect((await requestVerification(s.deps, s.caseId, s.orgId)).outcome).toBe("unavailable");
    expect(s.calls).toHaveLength(0);
  });

  it("ignores ledger-only and refuses incomplete or foreign attachment evidence", async () => {
    const s = await scenario();
    await changeEvidence(s.caseId, { against: "ledger" });
    expect((await requestVerification(s.deps, s.caseId, s.orgId)).outcome).toBe("none");
    await changeEvidence(s.caseId, { against: "registry", amount_cents: null });
    expect((await requestVerification(s.deps, s.caseId, s.orgId)).outcome).toBe("unavailable");
    await changeEvidence(s.caseId, { amount_cents: 100, attachment: "art/foreign/invoice.pdf" });
    expect((await requestVerification(s.deps, s.caseId, s.orgId)).outcome).toBe("unavailable");
    expect(s.calls).toHaveLength(0);
  });

  it.each(["contact", "amount", "source", "token", "expiry"])(
    "refuses changed %s on a failed-send retry",
    async (change) => {
      const s = await scenario();
      s.mode("failed");
      expect((await requestVerification(s.deps, s.caseId, s.orgId)).outcome).toBe("unavailable");
      expect(s.calls).toHaveLength(1);
      if (change === "contact") {
        await addAddress(s.supplierId, "new@demo.isitlegit.co.za");
        await setIdentity(db, s.supplierId, "owner", {
          displayNames: ["Fictional Supplier"],
          financeContact: "new@demo.isitlegit.co.za",
          protected: true,
        });
      } else if (change === "amount") await changeEvidence(s.caseId, { amount_cents: 99999 });
      else if (change === "source") await changeEvidence(s.caseId, { phone: "012 555 0100" });
      else if (change === "token")
        await db.prepare("UPDATE verifications SET nonce = 'changed' WHERE case_id = ?").bind(s.caseId).run();
      else s.deps.now = () => new Date(Date.now() + 73 * 3600_000);
      s.mode("sent");
      expect((await requestVerification(s.deps, s.caseId, s.orgId)).outcome).toBe("unavailable");
      expect(s.calls).toHaveLength(1);
    },
  );

  it("retries confirmed failure with identical token, and separates different requests", async () => {
    const s = await scenario();
    s.mode("failed");
    await requestVerification(s.deps, s.caseId, s.orgId);
    s.mode("sent");
    s.deps.now = () => new Date(Date.now() + 24 * 3600_000);
    expect((await requestVerification(s.deps, s.caseId, s.orgId)).outcome).toBe("requested");
    expect(required(s.calls[1]).text_body).toBe(required(s.calls[0]).text_body);
    expect(replyToken(required(s.calls[1]))).toBe(replyToken(required(s.calls[0])));
    const other = await scenario();
    await requestVerification(other.deps, other.caseId, other.orgId);
    expect(replyToken(required(other.calls[0]))).not.toBe(replyToken(required(s.calls[0])));
  });

  it("never resends uncertain delivery and offers bounded reconciliation read-back until acknowledged", async () => {
    const s = await scenario();
    s.mode("uncertain");
    expect((await requestVerification(s.deps, s.caseId, s.orgId)).outcome).toBe("unavailable");
    s.mode("sent");
    await requestVerification(s.deps, s.caseId, s.orgId);
    expect(s.calls).toHaveLength(1);
    expect(await refreshVerificationDeliveries(db, { limit: 25 })).toEqual([]);
    await db
      .prepare("UPDATE mail_sends SET status = 'sent', provider_id = 'reconciled' WHERE send_key = ?")
      .bind(`verification:${s.caseId}`)
      .run();
    const refresh = await refreshVerificationDeliveries(db, { limit: 25 });
    expect(refresh).toHaveLength(1);
    expect(refresh[0]?.evidence[0]?.check).toBe("verification.requested");
    expect(refresh[0]?.caseId).toBe(s.caseId);
    expect(await refreshVerificationDeliveries(db, { limit: 25 })).toEqual(refresh);
    await acknowledgeVerificationDelivery(db, s.caseId, required(refresh[0]).runId);
    expect(await refreshVerificationDeliveries(db, { limit: 25 })).toEqual([]);
    expect(s.calls).toHaveLength(1);
  });

  it("refuses ambiguous multiple invoice requests and missing signing configuration", async () => {
    const s = await scenario();
    const [one] = await readEvidence(db, s.caseId);
    if (!one) throw new Error("missing evidence");
    await addEvidence(db, s.caseId, "invoice", [one, { ...one, detail: { ...one.detail, amount_cents: 123 } }]);
    expect((await requestVerification(s.deps, s.caseId, s.orgId)).outcome).toBe("unavailable");
    await addEvidence(db, s.caseId, "invoice", [one]);
    expect((await requestVerification({ ...s.deps, secret: undefined }, s.caseId, s.orgId)).outcome).toBe(
      "unavailable",
    );
    expect(s.calls).toHaveLength(0);
  });
  it("recovers a failed delivery read-back without resubmitting mail or lowering the invoice floor", async () => {
    const s = await scenario();
    let fail = true;
    const broken = new Proxy(db, {
      get(target, property) {
        if (property === "prepare")
          return (sql: string) => {
            if (fail && sql.startsWith("UPDATE verifications SET sent_at")) {
              fail = false;
              throw new Error("simulated storage outage");
            }
            return target.prepare(sql);
          };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await expect(requestVerification({ ...s.deps, db: broken }, s.caseId, s.orgId)).rejects.toThrow(
      "simulated storage outage",
    );
    expect(s.calls).toHaveLength(1);
    expect((await requestVerification(s.deps, s.caseId, s.orgId)).outcome).toBe("requested");
    expect(s.calls).toHaveLength(1);
    expect((await readEvidence(db, s.caseId))[0]?.severity).toBe("critical");
  });

  it("does not recover a prior run into a reanalysed case or overwrite an answered request", async () => {
    const s = await scenario();
    await requestVerification(s.deps, s.caseId, s.orgId);
    await db.prepare("UPDATE cases SET run_id = 'new-run' WHERE id = ?").bind(s.caseId).run();
    expect(await refreshVerificationDeliveries(db, { limit: 25 })).toEqual([]);
    await acknowledgeVerificationDelivery(db, s.caseId, "new-run");
    expect(
      (await db.prepare("SELECT delivery_evidence_run FROM verifications WHERE case_id = ?").bind(s.caseId).first())
        ?.delivery_evidence_run,
    ).toBeNull();
    await db.prepare("UPDATE cases SET run_id = NULL WHERE id = ?").bind(s.caseId).run();
    await db
      .prepare("UPDATE verifications SET answer = 'denied', answered_at = ? WHERE case_id = ?")
      .bind(new Date().toISOString(), s.caseId)
      .run();
    expect(await refreshVerificationDeliveries(db, { limit: 25 })).toEqual([]);
    await expect(refreshVerificationDeliveries(db, { limit: 26 })).rejects.toThrow();
    expect(s.calls).toHaveLength(1);
  });
});
