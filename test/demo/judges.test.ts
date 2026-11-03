// The judge demo cases read back (D07 T07 §2, local half): five synthetic fixtures, each matched in the judge
// organisation's own cases by subject (mail) or upload name (voice note), done, with the manifest's verdict.
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import manifest from "../../data/demo/judge/fixtures.json";
import { checkJudges, JUDGE_CODE_LABEL, type JudgeCaseSpec, markJudgeOrg } from "../../src/demo/judges";
import { call, stubSmtp2go } from "../auth/helpers";

const db = env.DB;
const ORG = "judge-org";
const OTHER = "other-org";
const specs = manifest.cases as JudgeCaseSpec[];

async function addCase(
  id: string,
  org: string,
  spec: JudgeCaseSpec,
  status = "done",
  verdict: string | null = spec.expectedVerdict,
) {
  const at = "2026-11-02T00:00:00.000Z";
  await db
    .prepare(
      "INSERT INTO cases (id, org_id, channel, status, verdict, original_subject, upload_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      id,
      org,
      spec.kind === "mail" ? "email" : "upload",
      status,
      verdict,
      spec.subject ?? null,
      spec.uploadName ?? null,
      at,
      at,
    )
    .run();
}

beforeEach(async () => {
  await db.prepare("DELETE FROM cases").run();
  await db.prepare('DELETE FROM "organization"').run();
});

describe("markJudgeOrg", () => {
  async function org(id: string, metadata: string | null) {
    await db
      .prepare('INSERT INTO "organization" (id, name, slug, "createdAt", metadata) VALUES (?, ?, ?, ?, ?)')
      .bind(id, "Judge Org", `org-${id}`, "2026-11-02T00:00:00.000Z", metadata)
      .run();
  }
  const read = (id: string) =>
    db.prepare('SELECT metadata FROM "organization" WHERE id = ?').bind(id).first<{ metadata: string | null }>();

  it("marks the organisation, keeping keys already in its metadata", async () => {
    expect(JUDGE_CODE_LABEL).toBe("meta-hackathon-2026");
    await org("o1", JSON.stringify({ demo: true }));
    expect(await markJudgeOrg(db, "o1")).toBe(true);
    const row = await read("o1");
    expect(JSON.parse(row?.metadata ?? "{}")).toEqual({ demo: true, judgeDemo: true });
  });

  it("names a missing organisation instead of marking nothing", async () => {
    expect(await markJudgeOrg(db, "absent")).toBe(false);
  });
});

describe("checkJudges", () => {
  it("passes five done cases, the voice note among them matched by upload name", async () => {
    for (const [i, spec] of specs.entries()) await addCase(`case-${i}`, ORG, spec);
    const checks = await checkJudges(db, ORG, specs);
    expect(checks).toHaveLength(5);
    expect(checks.every((c) => c.problems.length === 0)).toBe(true);
    expect(checks.find((c) => c.name === "director-voice-note")?.caseId).toBe("case-4");
  });

  it("names a missing, running, wrong-verdict and another organisation's case", async () => {
    await addCase("case-0", ORG, specs[0] as JudgeCaseSpec);
    await addCase("case-1", ORG, specs[1] as JudgeCaseSpec, "running", null);
    await addCase("case-2", ORG, specs[2] as JudgeCaseSpec, "done", "safe");
    await addCase("case-3", OTHER, specs[3] as JudgeCaseSpec);
    const checks = await checkJudges(db, ORG, specs);
    const problems = Object.fromEntries(checks.map((c) => [c.name, c.problems.join("; ")]));
    expect(problems["tampered-invoice"]).toContain("running");
    expect(problems["fynbos-impersonation"]).toContain("safe");
    expect(problems["genuine-supplier"]).toContain("missing");
    expect(problems["director-voice-note"]).toContain("missing");
  });
});

describe("judge signup hook and pack", () => {
  async function insertInviteCode(code: string, label: string) {
    const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(code)))]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 86_400_000).toISOString();
    await db
      .prepare(
        "INSERT INTO invite_codes (id, code_hash, label, max_uses, uses, expires_at, created_at) VALUES (?, ?, ?, 50, 0, ?, ?)",
      )
      .bind(crypto.randomUUID(), hash, label, expiresAt, now.toISOString())
      .run();
  }

  it("redeems a judge-labelled code and marks the fresh organisation with its five cases started, while an ordinary code leaves its organisation unmarked with none", async () => {
    const judgeCode = `JUDGE-${crypto.randomUUID().slice(0, 8)}`;
    const ordinaryCode = `ORDINARY-${crypto.randomUUID().slice(0, 8)}`;
    await insertInviteCode(judgeCode, JUDGE_CODE_LABEL);
    await insertInviteCode(ordinaryCode, "ordinary-pilot");

    const judgeEmail = `judge-${crypto.randomUUID().slice(0, 8)}@demo.isitlegit.co.za`;
    const ordinaryEmail = `member-${crypto.randomUUID().slice(0, 8)}@demo.isitlegit.co.za`;
    const smtp = stubSmtp2go();
    try {
      const judgeRes = await call("/api/auth/sign-up/invite-code", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: judgeEmail,
          code: judgeCode,
          organizationName: "Judge Panel Org",
          consent: true,
        }),
      });
      expect(judgeRes.status).toBe(201);

      const ordinaryRes = await call("/api/auth/sign-up/invite-code", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: ordinaryEmail,
          code: ordinaryCode,
          organizationName: "Ordinary Pilot Org",
          consent: true,
        }),
      });
      expect(ordinaryRes.status).toBe(201);
    } finally {
      smtp.restore();
    }

    const judgeOrg = await db
      .prepare(
        'SELECT o.id, o.metadata FROM "organization" o JOIN "member" m ON m."organizationId" = o.id JOIN "user" u ON u.id = m."userId" WHERE u.email = ?',
      )
      .bind(judgeEmail)
      .first<{ id: string; metadata: string | null }>();
    expect(judgeOrg).toBeTruthy();
    expect(JSON.parse(judgeOrg?.metadata ?? "{}")).toEqual({ judgeDemo: true });

    const judgeChecks = await checkJudges(db, judgeOrg?.id ?? "", specs);
    expect(judgeChecks).toHaveLength(5);
    for (const c of judgeChecks) {
      expect(c.caseId, c.name).toBeTruthy();
      expect(c.status, c.name).not.toBeNull();
    }

    const ordinaryOrg = await db
      .prepare(
        'SELECT o.id, o.metadata FROM "organization" o JOIN "member" m ON m."organizationId" = o.id JOIN "user" u ON u.id = m."userId" WHERE u.email = ?',
      )
      .bind(ordinaryEmail)
      .first<{ id: string; metadata: string | null }>();
    expect(ordinaryOrg).toBeTruthy();
    expect(ordinaryOrg?.metadata ?? null).toBeNull();
    const ordinaryCases = await db
      .prepare("SELECT id FROM cases WHERE org_id = ?")
      .bind(ordinaryOrg?.id ?? "")
      .all();
    expect(ordinaryCases.results).toHaveLength(0);
  });
});
