import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  type Case,
  type CaseStatus,
  createCase,
  getCase,
  getCaseForPipeline,
  setStatus,
  setVerdict,
  type Verdict,
} from "../../src/db/cases";
import { isUlid, ulid } from "../../src/db/ulid";

// src/db/cases.ts (D01 T01 §1): typed, organisation-scoped case queries whose refusals change nothing.
const db = env.DB;
async function created(orgId = "org-a"): Promise<Case> {
  const result = await createCase(db, { orgId, channel: "email", headersAvailable: true });
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
const stored = async (c: Case) => {
  const read = await getCase(db, c.orgId, c.id);
  if (!read.ok) throw new Error(read.error.message);
  return read.value;
};

describe("the case store", () => {
  it("creates a case and reads it back", async () => {
    const c = await created();
    expect(c).toMatchObject({
      orgId: "org-a",
      channel: "email",
      status: "received",
      verdict: null,
      headersAvailable: true,
    });
    expect(await stored(c)).toEqual(c);
    expect(await createCase(db, { orgId: "", channel: "email", headersAvailable: false })).toMatchObject({
      ok: false,
      error: { code: "invalid" },
    });
    expect(await createCase(db, { orgId: "o", channel: "fax" as "email", headersAvailable: false })).toMatchObject({
      ok: false,
      error: { code: "invalid" },
    });
  });

  it("moves received to running to done or partial, storing each step", async () => {
    for (const end of ["done", "partial"] as const) {
      const c = await created();
      expect(await setStatus(db, c.orgId, c.id, "running")).toMatchObject({ ok: true, value: { status: "running" } });
      expect((await stored(c)).status).toBe("running");
      expect(await setStatus(db, c.orgId, c.id, end)).toMatchObject({ ok: true, value: { status: end } });
      expect((await stored(c)).status).toBe(end);
    }
  });

  it("refuses any other transition or value, leaving the case as it was", async () => {
    const c = await created();
    await setStatus(db, c.orgId, c.id, "running");
    await setStatus(db, c.orgId, c.id, "done");
    const before = await stored(c);
    expect(await setStatus(db, c.orgId, c.id, "running")).toMatchObject({ ok: false, error: { code: "transition" } });
    expect(await setStatus(db, c.orgId, c.id, "bogus" as CaseStatus)).toMatchObject({
      ok: false,
      error: { code: "invalid" },
    });
    expect(await stored(c)).toEqual(before);
    const fresh = await created();
    expect(await setStatus(db, fresh.orgId, fresh.id, "done")).toMatchObject({
      ok: false,
      error: { code: "transition" },
    });
    expect((await stored(fresh)).status).toBe("received");
  });

  it("writes a verdict and reads it back; refuses an invalid one, keeping the stored verdict", async () => {
    const c = await created();
    expect(await setVerdict(db, c.orgId, c.id, "suspicious")).toMatchObject({
      ok: true,
      value: { verdict: "suspicious" },
    });
    expect((await stored(c)).verdict).toBe("suspicious");
    expect(await setVerdict(db, c.orgId, c.id, "maybe" as Verdict)).toMatchObject({
      ok: false,
      error: { code: "invalid" },
    });
    expect((await stored(c)).verdict).toBe("suspicious");
  });

  it("answers not found for a missing case, from every read and change", async () => {
    expect(await getCase(db, "org-a", "nope")).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(await setStatus(db, "org-a", "nope", "running")).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(await setVerdict(db, "org-a", "nope", "safe")).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(await getCaseForPipeline(db, "nope")).toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  it("gives each case a ULID, the id the artefact store requires", async () => {
    const c = await created();
    expect(isUlid(c.id)).toBe(true);
    expect(ulid(1_000) < ulid(2_000)).toBe(true);
    expect(ulid(0).slice(0, 10)).toBe("0000000000");
    const many = new Set(Array.from({ length: 1_000 }, () => ulid()));
    expect(many.size).toBe(1_000);
    for (const id of many) expect(isUlid(id)).toBe(true);
    for (const bad of [
      "",
      "not-a-ulid",
      crypto.randomUUID(),
      `8${"0".repeat(25)}`,
      "0".repeat(25),
      `${"0".repeat(25)}I`,
    ])
      expect(isUlid(bad), bad).toBe(false);
  });

  it("answers each change with the row as stored, a change made meanwhile included", async () => {
    const c = await created();
    await setStatus(db, c.orgId, c.id, "running");
    // Another writer finishes the case between this caller's reads.
    await db.prepare("UPDATE cases SET status = 'done' WHERE id = ?").bind(c.id).run();
    const verdict = await setVerdict(db, c.orgId, c.id, "malicious");
    expect(verdict).toMatchObject({ ok: true, value: { status: "done", verdict: "malicious" } });
    const d = await created();
    await db.prepare("UPDATE cases SET verdict = 'safe' WHERE id = ?").bind(d.id).run();
    expect(await setStatus(db, d.orgId, d.id, "running")).toMatchObject({
      ok: true,
      value: { status: "running", verdict: "safe" },
    });
  });

  it("makes a successful change in one statement", async () => {
    const c = await created();
    let statements = 0;
    const counted = new Proxy(db, {
      get(target, key) {
        const value = Reflect.get(target, key);
        if (key === "prepare")
          return (sql: string) => {
            statements++;
            return target.prepare(sql);
          };
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await setVerdict(counted, c.orgId, c.id, "safe");
    expect(statements).toBe(1);
    statements = 0;
    await setStatus(counted, c.orgId, c.id, "running");
    expect(statements).toBe(1);
  });

  it("keeps organisations apart: another organisation cannot read or change a case", async () => {
    const c = await created("org-a");
    expect(await getCase(db, "org-b", c.id)).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(await setStatus(db, "org-b", c.id, "running")).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(await setVerdict(db, "org-b", c.id, "malicious")).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(await stored(c)).toEqual(c);
    // The pipeline's trusted lookup reads by id alone.
    expect(await getCaseForPipeline(db, c.id)).toMatchObject({ ok: true, value: { id: c.id, orgId: "org-a" } });
  });
});
