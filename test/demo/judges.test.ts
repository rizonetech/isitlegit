// The judge demo cases read back (D07 T07 §2, local half): five synthetic fixtures, each matched in the judge
// organisation's own cases by subject (mail) or upload name (voice note), done, with the manifest's verdict.
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import manifest from "../../data/demo/judge/fixtures.json";
import { checkJudges, JUDGE_CODE_LABEL, type JudgeCaseSpec, markJudgeOrg } from "../../src/demo/judges";

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
