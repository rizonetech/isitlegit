import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  addEvidence,
  Evidence,
  type EvidenceDraft,
  EvidenceRefused,
  evidenceProducers,
  readEvidence,
  saveEvidence,
} from "../../src/checks/evidence";
import { CheckRegistry } from "../../src/checks/registry";
import { createCase, setStatus } from "../../src/db/cases";
import migration from "../../src/db/migrations/0057_evidence_producer.sql?raw";
import { retryCase } from "../../src/pipeline/retry";

// D02 T01 §5: evidence added by later pipeline steps (the walkthrough first), after the checks' items, per run.
const db = env.DB;
const ORG = "org-producers";

async function newCase() {
  const made = await createCase(db, { orgId: ORG, channel: "email", headersAvailable: false });
  if (!made.ok) throw new Error(made.error.message);
  return made.value.id;
}
const checksItems = (n: number, tag = "c"): EvidenceDraft[] =>
  Array.from({ length: n }, (_, i) => ({
    check: "not_checked",
    severity: "info",
    summary: `${tag} ${i + 1}`,
    detail: {},
    artefacts: [],
  }));
const walkItems = (n: number, tag = "w"): EvidenceDraft[] =>
  Array.from({ length: n }, (_, i) => ({
    check: "walkthrough.chain",
    severity: "info",
    summary: `${tag} ${i + 1}`,
    detail: { page: i + 1 },
    artefacts: [],
  }));
const listed = async (caseId: string, run: string | null = null) => {
  const items = await readEvidence(db, caseId, run);
  const producers = await evidenceProducers(db, caseId, run);
  return items.map((e, i) => [e.id, producers[i]?.producer, e.summary]);
};
// A D1 binding whose batch fails: nothing it was given commits.
const failing = new Proxy(db, {
  get(target, key) {
    if (key === "batch") return () => Promise.reject(new Error("D1 down"));
    return Reflect.get(target, key);
  },
}) as D1Database;

describe("later producers", () => {
  it("accepts a later producer's family and refuses other names; no check may take the family", () => {
    const item = { id: "E1", severity: "info", summary: "s", detail: {}, artefacts: [] };
    expect(Evidence.safeParse({ ...item, check: "walkthrough.chain" }).success).toBe(true);
    expect(Evidence.safeParse({ ...item, check: "walkthrough_chain" }).success).toBe(false);
    expect(Evidence.safeParse({ ...item, check: "nonsense.thing" }).success).toBe(false);
    expect(() =>
      new CheckRegistry().register({ name: "walkthrough.x", needs: [], timeoutMs: 1000, run: async () => [] }),
    ).toThrow(/later step/);
  });

  it("migration 0057 adds the column in place: every existing row is untouched, its producer null", async () => {
    // A table built as `evidence` was before 0057 (0051's columns and keys), holding rows.
    await db.prepare("DROP TABLE IF EXISTS evidence_pre").run();
    await db
      .prepare(
        `CREATE TABLE evidence_pre (case_id TEXT NOT NULL, run_id TEXT NOT NULL, id TEXT NOT NULL, seq INTEGER NOT NULL,
          "check" TEXT NOT NULL, severity TEXT NOT NULL, summary TEXT NOT NULL, detail_json TEXT NOT NULL DEFAULT '{}',
          artefact_keys_json TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, PRIMARY KEY (case_id, run_id, id),
          UNIQUE (case_id, run_id, seq), CHECK (id = 'E' || seq))`,
      )
      .run();
    await db
      .prepare(
        `INSERT INTO evidence_pre VALUES ('c1', 'c1', 'E1', 1, 'auth.spf', 'high', 'one', '{"a":1}', '["k"]', '2026-10-31T00:00:00Z'),
          ('c1', 'r2', 'E1', 1, 'not_checked', 'info', 'two', '{}', '[]', '2026-10-31T00:00:01Z')`,
      )
      .run();
    const before = (await db.prepare("SELECT * FROM evidence_pre ORDER BY run_id").all()).results;
    const statement = migration
      .split("\n")
      .filter((line) => !line.startsWith("--"))
      .join("\n")
      .replace(/ALTER TABLE evidence /, "ALTER TABLE evidence_pre ");
    expect(statement).not.toMatch(/\b(UPDATE|DELETE|DROP|CREATE)\b/i);
    await db.prepare(statement).run();
    const after = (await db.prepare("SELECT * FROM evidence_pre ORDER BY run_id").all()).results;
    expect(after).toEqual(before.map((row) => ({ ...row, producer: null })));
    await db.prepare("DROP TABLE evidence_pre").run();
    // The applied schema refuses a producer that is not a family name.
    const id = await newCase();
    await expect(
      db
        .prepare(
          `INSERT INTO evidence (case_id, run_id, id, seq, "check", severity, summary, created_at, producer)
           VALUES (?, ?, 'E1', 1, 'walkthrough.chain', 'info', 's', 'now', 'Walk!')`,
        )
        .bind(id, id)
        .run(),
    ).rejects.toThrow(/CHECK/);
  });

  it("adds a producer's items after the checks', numbered on, and replaces only its own on a retry", async () => {
    const id = await newCase();
    const other = await newCase();
    await saveEvidence(db, id, checksItems(12));
    await saveEvidence(db, other, checksItems(2, "o"));
    const added = await addEvidence(db, id, "walkthrough", walkItems(3));
    expect(added.map((e) => e.id)).toEqual(["E13", "E14", "E15"]);
    const first = await listed(id);
    expect(first.slice(12)).toEqual([
      ["E13", "walkthrough", "w 1"],
      ["E14", "walkthrough", "w 2"],
      ["E15", "walkthrough", "w 3"],
    ]);
    // An identical retry keeps one copy with the same ids.
    await addEvidence(db, id, "walkthrough", walkItems(3));
    expect(await listed(id)).toEqual(first);
    // A shorter retry replaces only its own items; an empty one removes them.
    await addEvidence(db, id, "walkthrough", walkItems(1, "x"));
    expect((await listed(id)).slice(11)).toEqual([
      ["E12", "checks", "c 12"],
      ["E13", "walkthrough", "x 1"],
    ]);
    await addEvidence(db, id, "walkthrough", []);
    expect((await listed(id)).map((r) => r[1])).toEqual(Array(12).fill("checks"));
    // A first write of nothing stores nothing; another case is untouched throughout.
    const empty = await newCase();
    await addEvidence(db, empty, "walkthrough", []);
    expect(await listed(empty)).toEqual([]);
    expect(await listed(other)).toEqual([
      ["E1", "checks", "o 1"],
      ["E2", "checks", "o 2"],
    ]);
  });

  it("refuses an unknown producer, an item outside its family and a malformed item before writing anything", async () => {
    const id = await newCase();
    await saveEvidence(db, id, checksItems(2));
    await addEvidence(db, id, "walkthrough", walkItems(2));
    const kept = await listed(id);
    const refusals: [string, EvidenceDraft[]][] = [
      ["vision", walkItems(1)],
      ["walkthrough", [...walkItems(1), { ...walkItems(1)[0], check: "not_checked" } as EvidenceDraft]],
      ["walkthrough", [{ ...walkItems(1)[0], summary: "x".repeat(300) } as EvidenceDraft]],
    ];
    for (const [producer, items] of refusals) {
      await expect(addEvidence(db, id, producer as "walkthrough", items)).rejects.toBeInstanceOf(EvidenceRefused);
      expect(await listed(id)).toEqual(kept);
    }
    await expect(addEvidence(failing, id, "walkthrough", walkItems(1, "z"))).rejects.toThrow(/D1 down/);
    expect(await listed(id)).toEqual(kept);
  });

  it("keeps a run's walkthrough items when its checks write again, moved after the new list in their order", async () => {
    const id = await newCase();
    await saveEvidence(db, id, checksItems(12));
    await addEvidence(db, id, "walkthrough", walkItems(3));
    await saveEvidence(db, id, checksItems(15, "d"));
    const longer = await listed(id);
    expect(longer.slice(15)).toEqual([
      ["E16", "walkthrough", "w 1"],
      ["E17", "walkthrough", "w 2"],
      ["E18", "walkthrough", "w 3"],
    ]);
    expect(longer.slice(0, 15).every((r) => r[1] === "checks")).toBe(true);
    await saveEvidence(db, id, checksItems(5, "e"));
    const shorter = await listed(id);
    expect(shorter.slice(5)).toEqual([
      ["E6", "walkthrough", "w 1"],
      ["E7", "walkthrough", "w 2"],
      ["E8", "walkthrough", "w 3"],
    ]);
    await expect(saveEvidence(failing, id, checksItems(20, "f"))).rejects.toThrow(/D1 down/);
    expect(await listed(id)).toEqual(shorter);
  });

  it("rolls back a batch that fails partway: a producer's replace and the checks' renumbering commit whole or not at all", async () => {
    // The real database, with a statement that fails appended to each batch: everything before it in the batch (the
    // producer's delete and inserts, the lift and the renumbering) must be undone with it.
    // Only a batch that writes rows fails: code that split its delete (or its lift) into a batch of its own would see
    // that batch commit, and the test would find a row gone.
    const writing = new WeakSet<object>();
    const partway = {
      prepare: (sql: string) => {
        const statement = db.prepare(sql);
        return new Proxy(statement, {
          get(target, key) {
            if (key !== "bind") return Reflect.get(target, key);
            return (...values: unknown[]) => {
              const bound = target.bind(...values);
              if (/^\s*INSERT/i.test(sql)) writing.add(bound);
              return bound;
            };
          },
        });
      },
      batch: (statements: D1PreparedStatement[]) =>
        statements.some((s) => writing.has(s))
          ? db.batch([...statements, db.prepare("INSERT INTO evidence (case_id) VALUES (NULL)")])
          : db.batch(statements),
    } as unknown as D1Database;
    const id = await newCase();
    await saveEvidence(db, id, checksItems(3));
    await addEvidence(db, id, "walkthrough", walkItems(2));
    const kept = await listed(id);
    await expect(addEvidence(partway, id, "walkthrough", walkItems(4, "y"))).rejects.toThrow();
    expect(await listed(id)).toEqual(kept);
    await expect(saveEvidence(partway, id, checksItems(6, "g"))).rejects.toThrow();
    expect(await listed(id)).toEqual(kept);
    await expect(saveEvidence(partway, id, checksItems(1, "h"))).rejects.toThrow();
    expect(await listed(id)).toEqual(kept);
  });

  it("keeps runs apart: a retry's run starts empty and the first run's items, ids and producers stay as they were", async () => {
    const id = await newCase();
    for (const status of ["running", "partial"] as const) {
      const moved = await setStatus(db, ORG, id, status);
      if (!moved.ok) throw new Error(moved.error.message);
    }
    await saveEvidence(db, id, checksItems(2));
    await addEvidence(db, id, "walkthrough", walkItems(2));
    const firstRun = id;
    const before = await listed(id, firstRun);
    const fakeEnv = {
      ANALYSIS: {
        create: async () => {},
        get: async () => ({ status: async () => ({ status: "errored" }) }),
      },
    } as unknown as Env;
    const retried = await retryCase(db, fakeEnv, ORG, id, "member-producers", undefined, () => `${id}Rproducers`);
    expect(retried.ok).toBe(true);
    expect(await listed(id)).toEqual([]);
    await saveEvidence(db, id, checksItems(1, "n"));
    await addEvidence(db, id, "walkthrough", walkItems(1, "m"));
    expect(await listed(id)).toEqual([
      ["E1", "checks", "n 1"],
      ["E2", "walkthrough", "m 1"],
    ]);
    expect(await listed(id, firstRun)).toEqual(before);
  });

  it("reads a row from before the column (null) as the checks'", async () => {
    const id = await newCase();
    await saveEvidence(db, id, checksItems(1));
    await db.prepare("UPDATE evidence SET producer = NULL WHERE case_id = ?").bind(id).run();
    expect(await evidenceProducers(db, id)).toEqual([{ id: "E1", producer: "checks" }]);
    await addEvidence(db, id, "walkthrough", walkItems(1));
    expect((await evidenceProducers(db, id)).map((p) => p.producer)).toEqual(["checks", "walkthrough"]);
  });
});

describe("verification publication", () => {
  it("validates verification evidence and reserves the family for the queued producer", async () => {
    const item = {
      check: "verification.not_requested",
      severity: "info" as const,
      summary: "Delivery is unconfirmed.",
      detail: { reason: "plan-required" },
      artefacts: [],
    };
    expect(Evidence.safeParse({ ...item, id: "E1" }).success).toBe(true);
    expect(() =>
      new CheckRegistry().register({ name: "verification.requested", needs: [], timeoutMs: 1000, run: async () => [] }),
    ).toThrow(/later step/);
  });
});

it("rejects a verification publication when ownership changes inside the batch boundary", async () => {
  const caseId = await newCase();
  const draft = {
    check: "verification.not_requested",
    severity: "info" as const,
    summary: "Delivery is unconfirmed.",
    detail: {},
    artefacts: [],
  };
  await addEvidence(db, caseId, "verification", [draft]);
  let raced = false;
  const racing = new Proxy(db, {
    get(target, key) {
      if (key === "batch")
        return async (statements: D1PreparedStatement[]) => {
          if (!raced) {
            raced = true;
            await db.prepare("UPDATE cases SET org_id = 'new-owner' WHERE id = ?").bind(caseId).run();
          }
          return db.batch(statements);
        };
      return Reflect.get(target, key);
    },
  }) as D1Database;
  const result = await addEvidence(
    racing,
    caseId,
    "verification",
    [{ ...draft, summary: "Stale replacement." }],
    undefined,
    undefined,
    undefined,
    { orgId: ORG, runId: caseId, state: "unavailable" },
  );
  expect(result).toEqual([]);
  expect((await readEvidence(db, caseId)).map((item) => item.summary)).toEqual([draft.summary]);
});
