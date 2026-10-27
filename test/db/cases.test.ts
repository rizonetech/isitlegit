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

// src/db/cases.ts (D01 T01 §1): typed, organisation-scoped case queries whose refusals change nothing, with status and
// verdict tied together.
const db = env.DB;
async function created(orgId = "org-a"): Promise<Case> {
  const result = await createCase(db, { orgId, channel: "email", headersAvailable: true });
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
async function running(orgId = "org-a"): Promise<Case> {
  const c = await created(orgId);
  await setStatus(db, c.orgId, c.id, "running");
  return { ...c, status: "running" };
}
const stored = async (c: Case) => {
  const read = await getCase(db, c.orgId, c.id);
  if (!read.ok) throw new Error(read.error.message);
  return read.value;
};
// A D1 binding that counts the statements prepared, and can run something just before one of them executes.
function watched(before?: (sql: string) => Promise<unknown>) {
  const seen = { statements: 0 };
  const proxy = new Proxy(db, {
    get(target, key) {
      if (key === "prepare")
        return (sql: string) => {
          seen.statements++;
          const statement = target.prepare(sql);
          if (!before) return statement;
          return new Proxy(statement, {
            get(s, k) {
              const value = Reflect.get(s, k);
              if (k === "bind")
                return (...args: unknown[]) => {
                  const bound = s.bind(...args);
                  return new Proxy(bound, {
                    get(b, m) {
                      const v = Reflect.get(b, m);
                      if (m === "first" || m === "run")
                        return async (...a: unknown[]) => {
                          await before(sql);
                          return (v as (...x: unknown[]) => unknown).apply(b, a);
                        };
                      return typeof v === "function" ? v.bind(b) : v;
                    },
                  });
                };
              return typeof value === "function" ? value.bind(s) : value;
            },
          });
        };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { db: proxy, seen };
}

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

  it("finishes a case: running, a verdict, then done; or partial with or without one", async () => {
    const c = await created();
    expect(await setStatus(db, c.orgId, c.id, "running")).toMatchObject({ ok: true, value: { status: "running" } });
    expect((await stored(c)).status).toBe("running");
    expect(await setVerdict(db, c.orgId, c.id, "suspicious")).toMatchObject({
      ok: true,
      value: { verdict: "suspicious" },
    });
    expect(await setStatus(db, c.orgId, c.id, "done")).toMatchObject({
      ok: true,
      value: { status: "done", verdict: "suspicious" },
    });
    expect(await stored(c)).toMatchObject({ status: "done", verdict: "suspicious" });
    const p = await running();
    expect(await setStatus(db, p.orgId, p.id, "partial")).toMatchObject({
      ok: true,
      value: { status: "partial", verdict: null },
    });
    expect((await stored(p)).status).toBe("partial");
  });

  it("ties status to verdict: no done without a verdict, no verdict outside running", async () => {
    const r = await running();
    expect(await setStatus(db, r.orgId, r.id, "done")).toMatchObject({
      ok: false,
      error: { code: "transition", message: expect.stringMatching(/without a verdict/) },
    });
    expect((await stored(r)).status).toBe("running");
    const fresh = await created();
    expect(await setVerdict(db, fresh.orgId, fresh.id, "safe")).toMatchObject({
      ok: false,
      error: { code: "transition" },
    });
    expect((await stored(fresh)).verdict).toBeNull();
    await setVerdict(db, r.orgId, r.id, "malicious");
    await setStatus(db, r.orgId, r.id, "done");
    expect(await setVerdict(db, r.orgId, r.id, "safe")).toMatchObject({
      ok: false,
      error: { code: "transition", message: expect.stringMatching(/finished with verdict malicious/) },
    });
    expect((await stored(r)).verdict).toBe("malicious");
  });

  it("answers a repeated finish with the stored row, so a retried step is safe", async () => {
    const r = await running();
    await setVerdict(db, r.orgId, r.id, "safe");
    const first = await setStatus(db, r.orgId, r.id, "done");
    expect(await setVerdict(db, r.orgId, r.id, "safe")).toEqual(first);
    expect(await setStatus(db, r.orgId, r.id, "done")).toEqual(first);
    expect(await stored(r)).toEqual(first.ok && first.value);
  });

  it("refuses any other transition or value, leaving the case as it was", async () => {
    const r = await running();
    await setVerdict(db, r.orgId, r.id, "safe");
    await setStatus(db, r.orgId, r.id, "done");
    const before = await stored(r);
    expect(await setStatus(db, r.orgId, r.id, "running")).toMatchObject({ ok: false, error: { code: "transition" } });
    expect(await setStatus(db, r.orgId, r.id, "partial")).toMatchObject({ ok: false, error: { code: "transition" } });
    expect(await setStatus(db, r.orgId, r.id, "bogus" as CaseStatus)).toMatchObject({
      ok: false,
      error: { code: "invalid" },
    });
    expect(await setVerdict(db, r.orgId, r.id, "maybe" as Verdict)).toMatchObject({
      ok: false,
      error: { code: "invalid" },
    });
    expect(await stored(r)).toEqual(before);
    const fresh = await created();
    expect(await setStatus(db, fresh.orgId, fresh.id, "done")).toMatchObject({
      ok: false,
      error: { code: "transition" },
    });
    expect((await stored(fresh)).status).toBe("received");
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

  it("answers each change with the row as stored, including a change made during the call", async () => {
    // Another writer changes the case after this call is prepared and before its statement runs.
    const r = await running();
    const meanwhile = watched(async (sql) => {
      if (sql.startsWith("UPDATE"))
        await db.prepare("UPDATE cases SET headers_available = 0 WHERE id = ?").bind(r.id).run();
    });
    expect(await setVerdict(meanwhile.db, r.orgId, r.id, "malicious")).toMatchObject({
      ok: true,
      value: { verdict: "malicious", headersAvailable: false },
    });
    const s = await running();
    const meanwhile2 = watched(async (sql) => {
      if (sql.startsWith("UPDATE"))
        await db.prepare("UPDATE cases SET headers_available = 0 WHERE id = ?").bind(s.id).run();
    });
    expect(await setStatus(meanwhile2.db, s.orgId, s.id, "partial")).toMatchObject({
      ok: true,
      value: { status: "partial", headersAvailable: false },
    });
  });

  it("makes a successful change in one statement", async () => {
    const r = await running();
    const counted = watched();
    await setVerdict(counted.db, r.orgId, r.id, "safe");
    expect(counted.seen.statements).toBe(1);
    counted.seen.statements = 0;
    await setStatus(counted.db, r.orgId, r.id, "done");
    expect(counted.seen.statements).toBe(1);
  });

  it("refuses a malformed organisation or case id in every read and change, before any SQL", async () => {
    const counted = watched();
    const missing = undefined as unknown as string;
    for (const [orgId, id] of [
      [missing, "x"],
      ["org-a", missing],
      ["", "x"],
      ["org-a", ""],
    ] as const) {
      expect(await getCase(counted.db, orgId, id)).toMatchObject({ ok: false, error: { code: "invalid" } });
      expect(await setStatus(counted.db, orgId, id, "running")).toMatchObject({
        ok: false,
        error: { code: "invalid" },
      });
      expect(await setVerdict(counted.db, orgId, id, "safe")).toMatchObject({ ok: false, error: { code: "invalid" } });
    }
    for (const id of [missing, ""])
      expect(await getCaseForPipeline(counted.db, id)).toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(await createCase(counted.db, { orgId: missing, channel: "email", headersAvailable: true })).toMatchObject({
      ok: false,
      error: { code: "invalid" },
    });
    expect(counted.seen.statements).toBe(0);
  });

  it("answers a database failure with a typed refusal, not an exception", async () => {
    const broken = new Proxy(db, {
      get(target, key) {
        if (key === "prepare")
          return () => {
            throw new Error("D1_ERROR: no such table: cases");
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const failure = { ok: false, error: { code: "database", message: expect.stringMatching(/no such table/) } };
    expect(await createCase(broken, { orgId: "o", channel: "email", headersAvailable: true })).toMatchObject(failure);
    expect(await getCase(broken, "o", "x")).toMatchObject(failure);
    expect(await getCaseForPipeline(broken, "x")).toMatchObject(failure);
    expect(await setStatus(broken, "o", "x", "running")).toMatchObject(failure);
    expect(await setVerdict(broken, "o", "x", "safe")).toMatchObject(failure);
  });

  it("keeps organisations apart: another organisation cannot read or change a case", async () => {
    const c = await running("org-a");
    expect(await getCase(db, "org-b", c.id)).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(await setStatus(db, "org-b", c.id, "partial")).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(await setVerdict(db, "org-b", c.id, "malicious")).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(await stored(c)).toMatchObject({ status: "running", verdict: null });
    // The pipeline's trusted lookup reads by id alone.
    expect(await getCaseForPipeline(db, c.id)).toMatchObject({ ok: true, value: { id: c.id, orgId: "org-a" } });
  });
});
