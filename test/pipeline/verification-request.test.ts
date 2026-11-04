import { env, introspectWorkflowInstance } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { floorFor } from "../../src/agent/floor";
import { addEvidence, readEvidence } from "../../src/checks/evidence";
import { createCase } from "../../src/db/cases";
import { scheduledReconcile } from "../../src/index";
import { putAttachment, putRaw } from "../../src/intake/store";
import { ACTIVITY_URL, HEADER } from "../../src/mail/reconcile";
import { SMTP2GO_URL } from "../../src/mail/smtp2go";
import { refreshVerificationEvidence, verificationStep } from "../../src/pipeline/verification-request";
import { setIdentity } from "../../src/trust/identity";
import { requestVerification } from "../../src/trust/verify-request";
import { makeOrg, protectableOrg } from "../trust/helpers";

const db = env.DB;
afterEach(() => vi.restoreAllMocks());
async function scenario(channel: "email" | "upload" = "email") {
  const contact = `finance-${crypto.randomUUID()}@demo.isitlegit.co.za`;
  const orgId = await makeOrg();
  const supplierId = await protectableOrg(`supplier-${crypto.randomUUID()}.example`, contact);
  await setIdentity(db, supplierId, "owner", {
    displayNames: ["Fictional Supplier"],
    financeContact: contact,
    protected: true,
  });
  const made = await createCase(db, {
    orgId,
    channel,
    sourceKind: channel === "email" ? "mail" : "document",
    headersAvailable: false,
    ...(channel === "upload"
      ? { uploadedBy: "synthetic-uploader", uploadName: "invoice.pdf", uploadMediaType: "application/pdf" }
      : {}),
  });
  if (!made.ok) throw new Error(made.error.message);
  const caseId = made.value.id;
  if (channel === "email")
    await putRaw(
      { db, bucket: env.ARTEFACTS },
      caseId,
      new TextEncoder().encode(
        "From: sender@fictional.example\r\nTo: check@isitlegit.co.za\r\nSubject: Invoice\r\n\r\nPlease check the invoice.",
      ),
    );
  const stored = await putAttachment(
    { db, bucket: env.ARTEFACTS },
    caseId,
    "invoice.pdf",
    new TextEncoder().encode("%PDF synthetic"),
    "application/pdf",
  );
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
        attachment: stored.key,
      },
      artefacts: [stored.key],
    },
  ]);
  const calls: Record<string, unknown>[] = [];
  let mode: "sent" | "uncertain" = "sent";
  const real = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === SMTP2GO_URL) {
      calls.push(JSON.parse(String(init?.body)));
      if (mode === "uncertain") throw new Error("synthetic transport unavailable");
      return Response.json({ data: { succeeded: 1, failed: 0, email_id: "synthetic-verification" } });
    }
    if (url === ACTIVITY_URL)
      return Response.json({
        data: {
          events: [
            { email_id: "reconciled", event: "delivered", custom_headers: { [HEADER]: `verification:${caseId}` } },
          ],
        },
      });
    if (url.includes("/responses") || url.includes("/chat/completions"))
      return new Response("synthetic model unavailable", { status: 503 });
    return real(input, init);
  });
  return {
    orgId,
    supplierId,
    contact,
    caseId,
    channel,
    calls,
    mode: (value: typeof mode) => {
      mode = value;
    },
  };
}

async function queued(s: Awaited<ReturnType<typeof scenario>>) {
  const instance = await introspectWorkflowInstance(env.ANALYSIS, s.caseId);
  try {
    await instance.modify(async (m) => {
      await m.disableRetryDelays();
      await m.disableSleeps();
      // Replay completed upstream steps with their invoice evidence already persisted. The new
      // queued step and downstream verdict execute through the actual Workflow binding.
      for (const name of ["checks", "walkthrough", "vision", "invoice"]) await m.mockStepResult({ name }, {});
    });
    await env.ANALYSIS.create({ id: s.caseId, params: { caseId: s.caseId } });
    await instance.waitForStatus("complete");
    const output = await instance.getOutput();
    const completed = await db
      .prepare("SELECT 1 FROM case_events WHERE case_id = ? AND step = 'verification' AND status = 'done'")
      .bind(s.caseId)
      .first();
    return { output, verification: completed ? await instance.waitForStepResult({ name: "verification" }) : null };
  } finally {
    await instance.dispose();
  }
}

describe("queued verification integration", () => {
  it.each(["email", "upload"] as const)(
    "publishes actual verification for %s after invoice evidence",
    async (channel) => {
      const s = await scenario(channel);
      const log = vi.spyOn(console, "log");
      const result = await queued(s);
      expect(result.verification).toEqual({ outcome: "requested", evidence: 1 });
      const publicData = JSON.stringify({ result, evidence: await readEvidence(db, s.caseId), logs: log.mock.calls });
      expect(publicData).not.toContain(s.contact);
      expect(publicData).not.toContain((env as unknown as Env).BETTER_AUTH_SECRET);
      const headers = s.calls[0]?.custom_headers as { header: string; value: string }[];
      const token = headers?.find((h) => h.header === "Reply-To")?.value;
      expect(token).toMatch(/^verify\+/);
      expect(publicData).not.toContain(token);
      expect(publicData).not.toContain(token?.match(/^verify\+([^@]+)@/)?.[1]);
      expect(floorFor(await readEvidence(db, s.caseId)).verdict).toBe("malicious");
      const order = (
        await db
          .prepare("SELECT step FROM case_events WHERE case_id = ? AND status = 'started' ORDER BY id")
          .bind(s.caseId)
          .all<{ step: string }>()
      ).results.map((r) => r.step);
      expect(order.indexOf("verification")).toBeLessThan(order.indexOf("verdict"));
      expect((await readEvidence(db, s.caseId)).find((e) => e.check === "invoice.bank_changed")?.severity).toBe(
        "critical",
      );
      expect((await readEvidence(db, s.caseId)).some((e) => e.check === "verification.requested")).toBe(true);
      expect(s.calls).toHaveLength(1);
    },
  );
});

const depsFor = (database = db) => ({
  db: database,
  secret: (env as unknown as Env).BETTER_AUTH_SECRET,
  mail: { apiKey: env.SMTP2GO_API_KEY, fetch: globalThis.fetch, pause: async () => {} },
});
const ackOf = async (caseId: string) =>
  (
    await db
      .prepare("SELECT delivery_evidence_run FROM verifications WHERE case_id = ?")
      .bind(caseId)
      .first<{ delivery_evidence_run: string | null }>()
  )?.delivery_evidence_run;
const interceptBatch = (action: () => Promise<void>, fail = false) => {
  let once = false;
  return new Proxy(db, {
    get(target, key) {
      if (key === "batch")
        return async (statements: D1PreparedStatement[]) => {
          if (!once) {
            once = true;
            await action();
            if (fail) throw new Error("synthetic publication failure");
          }
          return db.batch(statements);
        };
      return Reflect.get(target, key);
    },
  }) as D1Database;
};

describe("verification publication integration", () => {
  it.each(["plan", "contact", "signing"])("persists the %s refusal before any request exists", async (reason) => {
    const s = await scenario();
    if (reason === "plan")
      await db
        .prepare('UPDATE organization SET "createdAt" = ? WHERE id = ?')
        .bind("2020-01-01T00:00:00Z", s.orgId)
        .run();
    if (reason === "contact")
      await db.prepare("UPDATE identities SET protected = 0 WHERE org_id = ?").bind(s.supplierId).run();
    const deps = {
      ...depsFor(),
      secret: reason === "signing" ? undefined : (env as unknown as Env).BETTER_AUTH_SECRET,
    };
    const result = reason === "plan" ? (await queued(s)).verification : await verificationStep(deps, s.caseId, s.orgId);
    expect(result).toEqual({ outcome: "unavailable", evidence: 1 });
    const evidence = (await readEvidence(db, s.caseId)).find((e) => e.check === "verification.not_requested");
    expect(evidence?.detail.reason).toBe(
      { plan: "plan-required", contact: "contact-unavailable", signing: "signing-unavailable" }[reason],
    );
    expect(await db.prepare("SELECT 1 FROM verifications WHERE case_id = ?").bind(s.caseId).first()).toBeNull();
    expect(s.calls).toHaveLength(0);
  });

  it("serialises concurrent queued retries and keeps one delivery and one evidence item", async () => {
    const s = await scenario();
    await Promise.all([verificationStep(depsFor(), s.caseId, s.orgId), verificationStep(depsFor(), s.caseId, s.orgId)]);
    expect(s.calls).toHaveLength(1);
    expect((await readEvidence(db, s.caseId)).filter((e) => e.check === "verification.requested")).toHaveLength(1);
    expect(await ackOf(s.caseId)).toBe(s.caseId);
    expect(await verificationStep(depsFor(), s.caseId, "foreign-owner")).toEqual({ outcome: "none", evidence: 0 });
  });

  it("rejects a queued mail claim storage failure and recovers the same request exactly once", async () => {
    const s = await scenario();
    await db.exec(
      "CREATE TRIGGER fail_verification_claim BEFORE INSERT ON mail_sends WHEN NEW.kind = 'verify' BEGIN SELECT RAISE(ABORT, 'synthetic claim storage failure'); END",
    );
    try {
      await expect(verificationStep(depsFor(), s.caseId, s.orgId)).rejects.toThrow(
        "verification mail claim storage failed",
      );
      expect(s.calls).toHaveLength(0);
      expect((await readEvidence(db, s.caseId)).some((e) => e.check.startsWith("verification."))).toBe(false);
    } finally {
      await db.exec("DROP TRIGGER fail_verification_claim");
    }
    const before = await db.prepare("SELECT * FROM verifications WHERE case_id = ?").bind(s.caseId).first();
    expect(before).not.toBeNull();
    expect(await verificationStep(depsFor(), s.caseId, s.orgId)).toEqual({ outcome: "requested", evidence: 1 });
    expect(await verificationStep(depsFor(), s.caseId, s.orgId)).toEqual({ outcome: "requested", evidence: 1 });
    const after = await db.prepare("SELECT * FROM verifications WHERE case_id = ?").bind(s.caseId).first();
    expect(after).toMatchObject({
      token_hash: before?.token_hash,
      recipient_hash: before?.recipient_hash,
      expires_at: before?.expires_at,
    });
    expect(s.calls).toHaveLength(1);
    expect((await readEvidence(db, s.caseId)).filter((e) => e.check === "verification.requested")).toHaveLength(1);
  });

  it("propagates queued publication failure, then retries without sending twice", async () => {
    const s = await scenario();
    const failed = interceptBatch(async () => {}, true);
    await expect(verificationStep(depsFor(failed), s.caseId, s.orgId)).rejects.toThrow("publication failure");
    expect(await ackOf(s.caseId)).toBeNull();
    expect((await readEvidence(db, s.caseId)).some((e) => e.check === "verification.requested")).toBe(false);
    expect(await verificationStep(depsFor(), s.caseId, s.orgId)).toEqual({ outcome: "requested", evidence: 1 });
    expect(s.calls).toHaveLength(1);
  });

  it("reconciles uncertain delivery, refreshes evidence and acknowledges through the real scheduled caller", async () => {
    const s = await scenario();
    s.mode("uncertain");
    expect(await verificationStep(depsFor(), s.caseId, s.orgId)).toEqual({ outcome: "unavailable", evidence: 1 });
    await db
      .prepare("UPDATE mail_sends SET claimed_at = ?, updated_at = ? WHERE case_id = ? AND kind = 'verify'")
      .bind(
        new Date(Date.now() - 45 * 60_000).toISOString(),
        new Date(Date.now() - 45 * 60_000).toISOString(),
        s.caseId,
      )
      .run();
    const lines: string[] = [];
    await scheduledReconcile(env, (line) => lines.push(line));
    expect((await readEvidence(db, s.caseId)).find((e) => e.check.startsWith("verification."))?.check).toBe(
      "verification.requested",
    );
    expect(await ackOf(s.caseId)).toBe(s.caseId);
    expect(lines.map((line) => JSON.parse(line))).toContainEqual(
      expect.objectContaining({ event: "verification-refresh", state: "ok", published: 1 }),
    );
    expect(s.calls).toHaveLength(1);
    expect(JSON.stringify(lines)).not.toContain(s.contact);
  });

  it("leaves failed scheduled publication eligible and never resends mail", async () => {
    const s = await scenario();
    await requestVerification(depsFor(), s.caseId, s.orgId);
    const failed = interceptBatch(async () => {}, true);
    expect(await refreshVerificationEvidence(failed)).toMatchObject({ selected: 1, failed: 1, published: 0 });
    expect(await ackOf(s.caseId)).toBeNull();
    expect(await refreshVerificationEvidence(db)).toMatchObject({ selected: 1, published: 1, failed: 0 });
    expect(await refreshVerificationEvidence(db)).toMatchObject({ selected: 0, published: 0 });
    expect(s.calls).toHaveLength(1);
  });

  it("cannot regress confirmed scheduled evidence with a delayed queued unavailable result", async () => {
    const s = await scenario();
    s.mode("uncertain");
    const racing = interceptBatch(async () => {
      await db
        .prepare("UPDATE mail_sends SET status = 'sent' WHERE case_id = ? AND kind = 'verify'")
        .bind(s.caseId)
        .run();
      const { SMTP2GO_API_KEY: _key, ...keyless } = env;
      await scheduledReconcile(keyless as unknown as Env, () => {});
      expect(await ackOf(s.caseId)).toBe(s.caseId);
    });
    expect(await verificationStep(depsFor(racing), s.caseId, s.orgId)).toEqual({ outcome: "superseded", evidence: 0 });
    expect((await readEvidence(db, s.caseId)).find((e) => e.check.startsWith("verification."))?.check).toBe(
      "verification.requested",
    );
    expect(await ackOf(s.caseId)).toBe(s.caseId);
    expect(s.calls).toHaveLength(1);
  });

  it.each(["owner", "run", "answer"])(
    "does not acknowledge a scheduled publication when %s changes at its batch",
    async (race) => {
      const s = await scenario();
      await requestVerification(depsFor(), s.caseId, s.orgId);
      const racing = interceptBatch(async () => {
        if (race === "owner")
          await db.prepare("UPDATE cases SET org_id = 'other-owner' WHERE id = ?").bind(s.caseId).run();
        if (race === "run")
          await db.prepare("UPDATE cases SET run_id = ? WHERE id = ?").bind(`new-${s.caseId}`, s.caseId).run();
        if (race === "answer") {
          await db
            .prepare("UPDATE verifications SET answer = 'confirmed', answered_at = ? WHERE case_id = ?")
            .bind(new Date().toISOString(), s.caseId)
            .run();
          await addEvidence(db, s.caseId, "verification", [
            {
              check: "verification.answered",
              severity: "info",
              summary: "The supplier answered.",
              detail: {},
              artefacts: [],
            },
          ]);
        }
      });
      expect(await refreshVerificationEvidence(racing)).toMatchObject({ selected: 1, skipped: 1, published: 0 });
      expect(await ackOf(s.caseId)).toBeNull();
      expect((await readEvidence(db, s.caseId)).some((e) => e.check === "verification.requested")).toBe(false);
      if (race === "answer")
        expect((await readEvidence(db, s.caseId)).some((e) => e.check === "verification.answered")).toBe(true);
    },
  );
});
