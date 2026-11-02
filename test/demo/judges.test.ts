// The judge demo cases read back (D07 T07 §2, local half): five synthetic fixtures, each matched in the judge
// organisation's own cases by subject (mail) or upload name (voice note), done, with the manifest's verdict.
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import manifest from "../../data/demo/judge/fixtures.json";
import { checkJudges, type JudgeCaseSpec } from "../../src/demo/judges";

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
