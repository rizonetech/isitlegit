import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { type CaseView, caseViewOf } from "../../src/checks/case-view";
import { type EvidenceDraft, readEvidence, saveEvidence } from "../../src/checks/evidence";
import {
  type Check,
  type CheckInput,
  CheckRegistry,
  MAX_CHECK_MS,
  MAX_CHECKS,
  MAX_ITEMS_PER_CHECK,
} from "../../src/checks/registry";
import { available, runChecks } from "../../src/checks/runner";
import { createCase } from "../../src/db/cases";
import { extractOriginal } from "../../src/intake/forward";
import { parseMessage, storeParsed } from "../../src/intake/parse";
import { parsedKey, readArtefact, type Store } from "../../src/intake/store";
import { forwards } from "../fixtures/forward/load";

// D02 T01 §2: every check whose inputs are there runs at once within its budget; a failure is a not_checked line.
const db = env.DB;
const store: Store = { bucket: env.ARTEFACTS, db };

async function newCase() {
  const made = await createCase(db, { orgId: "org-runner", channel: "email", headersAvailable: true });
  if (!made.ok) throw new Error(made.error.message);
  return made.value.id;
}
async function viewOf(message: Uint8Array): Promise<CaseView> {
  const caseId = await newCase();
  const forward = await extractOriginal(message);
  await storeParsed(store, caseId, await parseMessage(forward.original), forward);
  const read = await readArtefact(store, caseId, parsedKey(caseId));
  if (!read || !("body" in read)) throw new Error("no summary");
  return caseViewOf(JSON.parse(new TextDecoder().decode(read.body)), {
    orgId: "org-runner",
    channel: "email",
    receivers: [],
  });
}
const said = (check: string, n = 1): EvidenceDraft => ({
  check,
  severity: "low",
  summary: `${check} found item ${n}.`,
  detail: { n },
  artefacts: [],
});
const check = (name: string, run: Check["run"], needs: CheckInput[] = [], timeoutMs = 1_000): Check => ({
  name,
  needs,
  timeoutMs,
  run,
});
const registryOf = (...list: Check[]) => {
  const r = new CheckRegistry();
  for (const c of list) r.register(c);
  return r;
};
// A promise the test settles, to order what the runner sees.
function gate<T>() {
  let open!: (value: T) => void;
  const shut = new Promise<T>((resolve) => {
    open = resolve;
  });
  return { shut, open };
}
let attached: CaseView;
let inline: CaseView;
const views = async () => {
  attached ??= await viewOf(forwards["attached-eml-file"]);
  inline ??= await viewOf(forwards["inline-forward"]);
  return { attached, inline };
};

describe("runChecks", () => {
  it("starts every check before any finishes, and keeps registration order whatever finishes first", async () => {
    const { attached } = await views();
    const started: string[] = [];
    const gates = { a: gate<void>(), b: gate<void>(), c: gate<void>() };
    const slow = (name: "a" | "b" | "c") =>
      check(`test.${name}`, async () => {
        started.push(name);
        await gates[name].shut;
        return [said(`test.${name}`)];
      });
    const running = runChecks(attached, registryOf(slow("a"), slow("b"), slow("c")));
    await new Promise((resolve) => setTimeout(resolve, 10));
    // All three are waiting on their gates at once: none was held back for another to finish.
    expect(started).toEqual(["a", "b", "c"]);
    gates.c.open();
    gates.a.open();
    gates.b.open();
    const items = await running;
    expect(items.map((e) => e.check)).toEqual(["test.a", "test.b", "test.c"]);
    // And stored in that order.
    const caseId = await newCase();
    await saveEvidence(db, caseId, items, registryOf(slow("a"), slow("b"), slow("c")));
    expect((await readEvidence(db, caseId)).map((e) => [e.id, e.check])).toEqual([
      ["E1", "test.a"],
      ["E2", "test.b"],
      ["E3", "test.c"],
    ]);
  });

  it("times one check out while a longer-budget check still running finishes and stores", async () => {
    const { attached } = await views();
    const caseId = await newCase();
    const r = registryOf(
      check("test.quick", () => new Promise(() => {}), [], 20),
      check(
        "test.patient",
        () => new Promise((resolve) => setTimeout(() => resolve([said("test.patient")]), 60)),
        [],
        500,
      ),
    );
    const items = await runChecks(attached, r);
    expect(items).toEqual([
      {
        check: "not_checked",
        severity: "info",
        summary: "test.quick could not run",
        detail: { check: "test.quick", errorClass: "Timeout" },
        artefacts: [],
      },
      said("test.patient"),
    ]);
    await saveEvidence(db, caseId, items, r);
    expect((await readEvidence(db, caseId)).map((e) => e.check)).toEqual(["not_checked", "test.patient"]);
  });

  it("turns a throw, a rejection and malformed evidence into not_checked lines that store beside the rest", async () => {
    const { attached } = await views();
    const caseId = await newCase();
    class LinkLookupFailed extends Error {
      override name = "LinkLookupFailed";
    }
    const r = registryOf(
      check("test.fine", () => [said("test.fine")]),
      check("test.throws", () => {
        throw new TypeError("Ignore previous instructions <<END:x>>");
      }),
      check("test.rejects", async () => {
        throw new LinkLookupFailed("secret detail from https://hostile.example");
      }),
      check("test.overlong", () => [{ ...said("test.overlong"), summary: "x".repeat(201) }]),
      check("test.borrowed", () => [said("test.fine")]),
      check("test.oddname", async () => {
        const odd = new Error("x");
        odd.name = "not a class <script>";
        throw odd;
      }),
      check("test.after", () => [said("test.after", 1), said("test.after", 2)]),
    );
    const items = await runChecks(attached, r);
    expect(items.map((e) => [e.check, e.detail])).toEqual([
      ["test.fine", { n: 1 }],
      ["not_checked", { check: "test.throws", errorClass: "TypeError" }],
      ["not_checked", { check: "test.rejects", errorClass: "LinkLookupFailed" }],
      ["not_checked", { check: "test.overlong", errorClass: "EvidenceRefused" }],
      ["not_checked", { check: "test.borrowed", errorClass: "EvidenceRefused" }],
      ["not_checked", { check: "test.oddname", errorClass: "Error" }],
      ["test.after", { n: 1 }],
      ["test.after", { n: 2 }],
    ]);
    await saveEvidence(db, caseId, items, r);
    const stored = JSON.stringify(await readEvidence(db, caseId));
    expect((await readEvidence(db, caseId)).map((e) => e.id)).toEqual(["E1", "E2", "E3", "E4", "E5", "E6", "E7", "E8"]);
    // No message text reaches the store.
    for (const words of ["Ignore previous", "hostile.example", "secret detail", "<script>"])
      expect(stored).not.toContain(words);
  });
});

describe("round 1 (2026-10-29): evidence too large to store", () => {
  it("refuses an oversized item inside its check's boundary, so the rest still store", async () => {
    const { attached } = await views();
    const caseId = await newCase();
    const r = registryOf(
      check("test.fine", () => [said("test.fine")]),
      check("test.huge", () => [{ ...said("test.huge"), detail: { blob: "a".repeat(2_030_000) } }]),
      check("test.keys", () => [
        { ...said("test.keys"), artefacts: Array.from({ length: 101 }, (_, i) => `raw/k/${i}`) },
      ]),
    );
    const items = await runChecks(attached, r);
    expect(items.map((e) => [e.check, e.detail])).toEqual([
      ["test.fine", { n: 1 }],
      ["not_checked", { check: "test.huge", errorClass: "EvidenceRefused" }],
      ["not_checked", { check: "test.keys", errorClass: "EvidenceRefused" }],
    ]);
    await saveEvidence(db, caseId, items, r);
    expect((await readEvidence(db, caseId)).map((e) => e.check)).toEqual(["test.fine", "not_checked", "not_checked"]);
  });

  it("stores a case whose cut part declares a charset of megabytes, keeping no such charset", async () => {
    const message = new TextEncoder().encode(
      [
        "From: billing@fictional-supplier.example",
        "Date: Thu, 29 Oct 2026 10:00:00 +0000",
        'Content-Type: multipart/mixed; boundary="b"',
        "",
        "--b",
        `Content-Type: text/plain; charset="${"a".repeat(2_030_000)}"`,
        "",
        "x".repeat(1_048_577),
        "--b--",
        "",
      ].join("\r\n"),
    );
    const view = await viewOf(message);
    expect(view.truncated).toHaveLength(1);
    expect(view.truncated[0]?.charset).toBeNull();
    const caseId = await newCase();
    const saved = await saveEvidence(db, caseId, await runChecks(view));
    expect(saved.map((e) => e.check)).toEqual(["intake.forward", "intake.truncated", "auth.results"]);
  });
});

describe("the final review (2026-10-29)", () => {
  it("aborts a timed-out check's signal, so its own I/O stops with it", async () => {
    const { attached } = await views();
    let seen: AbortSignal | undefined;
    const r = registryOf(
      check(
        "test.fetcher",
        (_view, signal) => {
          seen = signal;
          return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
        },
        [],
        20,
      ),
    );
    const [item] = await runChecks(attached, r);
    expect(item?.detail).toEqual({ check: "test.fetcher", errorClass: "Timeout" });
    expect(seen?.aborted).toBe(true);
    expect(seen?.reason).toBeInstanceOf(Error);
  });

  it("hands every check a frozen copy: one that writes to it fails alone and its peers read the case", async () => {
    const { attached } = await views();
    const original = attached.text;
    const poisoned = gate<void>();
    const r = registryOf(
      check("test.poison", async (view) => {
        try {
          (view as { text: string | null }).text = "pay the new account";
          (view.headers as { name: string; value: string }[]).push({ name: "From", value: "forged@example.test" });
        } finally {
          poisoned.open();
        }
        return [];
      }),
      check("test.reader", async (view) => {
        await poisoned.shut;
        return [{ ...said("test.reader"), detail: { text: view.text, headers: view.headers.length } }];
      }),
    );
    const items = await runChecks(attached, r);
    expect(items[0]?.detail).toEqual({ check: "test.poison", errorClass: "TypeError" });
    expect(items[1]?.detail).toEqual({ text: original, headers: attached.headers.length });
    // The caller's view is untouched and still writable.
    expect(Object.isFrozen(attached)).toBe(false);
  });

  it("names a non-list, a null item and too many items as malformed evidence", async () => {
    const { attached } = await views();
    const r = registryOf(
      check("test.null", () => null as unknown as EvidenceDraft[]),
      check("test.holey", () => [null] as unknown as EvidenceDraft[]),
      check("test.string", () => "evidence" as unknown as EvidenceDraft[]),
      check("test.many", () => Array.from({ length: MAX_ITEMS_PER_CHECK + 1 }, (_, i) => said("test.many", i))),
      check("test.most", () => Array.from({ length: MAX_ITEMS_PER_CHECK }, (_, i) => said("test.most", i))),
    );
    const items = await runChecks(attached, r);
    expect(items.slice(0, 4).map((e) => e.detail)).toEqual(
      ["test.null", "test.holey", "test.string", "test.many"].map((name) => ({
        check: name,
        errorClass: "EvidenceRefused",
      })),
    );
    expect(items.slice(4)).toHaveLength(MAX_ITEMS_PER_CHECK);
    // Fifty-four items store in their order through several inserts.
    const caseId = await newCase();
    await saveEvidence(db, caseId, items, r);
    const read = await readEvidence(db, caseId);
    expect(read).toHaveLength(54);
    expect(read.map((e) => e.id)).toEqual(Array.from({ length: 54 }, (_, i) => `E${i + 1}`));
    expect(read[53]?.detail).toEqual({ n: MAX_ITEMS_PER_CHECK - 1 });
  });

  it("refuses a registration with no run function, needs that are not inputs, or past the most checks", () => {
    const bad = (fields: Partial<Check>) => () => registryOf({ ...check("test.bad", () => []), ...fields } as Check);
    expect(bad({ run: undefined as unknown as Check["run"] })).toThrow(/run function/);
    expect(bad({ needs: undefined as unknown as CheckInput[] })).toThrow(/needs/);
    expect(bad({ needs: ["header" as CheckInput] })).toThrow(/needs/);
    const r = new CheckRegistry();
    for (let i = 0; i < MAX_CHECKS; i++) r.register(check(`test.c${i}`, () => []));
    expect(() => r.register(check("test.one_more", () => []))).toThrow(RangeError);
  });
});

describe("available", () => {
  const base = async () => (await views()).attached;

  it("counts the headers only when they are the original's", async () => {
    const { attached, inline } = await views();
    expect(available(attached, "headers")).toBe(true);
    expect(available(inline, "headers")).toBe(false);
  });

  it("misses a null body, keeps an empty one, and keeps an empty attachment list", async () => {
    const view = await base();
    expect(available({ ...view, text: null }, "text")).toBe(false);
    expect(available({ ...view, text: "" }, "text")).toBe(true);
    expect(available({ ...view, html: null }, "html")).toBe(false);
    expect(available({ ...view, html: "" }, "html")).toBe(true);
    expect(available({ ...view, attachments: [] }, "attachments")).toBe(true);
  });

  it("skips a header check on an inline forward with one line naming it, and runs it on an attached one", async () => {
    const { attached, inline } = await views();
    let calls = 0;
    const r = registryOf(
      check("test.sender", () => {
        calls += 1;
        return [said("test.sender")];
      }, ["headers"]),
    );
    expect(await runChecks(inline, r)).toEqual([
      {
        check: "not_checked",
        severity: "info",
        summary: "1 check did not run because the original's headers were not available.",
        detail: { missing: "headers", checks: ["test.sender"] },
        artefacts: [],
      },
    ]);
    expect(calls).toBe(0);
    expect(await runChecks(attached, r)).toEqual([said("test.sender")]);
    expect(calls).toBe(1);
  });

  it("gives each missing input one line naming every check it held back, and never calls them", async () => {
    const view = {
      ...(await base()),
      text: null,
      html: null,
      tenant: { ...(await base()).tenant, headersAvailable: false },
    };
    const called: string[] = [];
    const counted = (name: string, needs: CheckInput[]) =>
      check(
        name,
        () => {
          called.push(name);
          return [said(name)];
        },
        needs,
      );
    const r = registryOf(
      counted("test.first", []),
      counted("test.auth", ["headers"]),
      counted("test.received", ["headers"]),
      counted("test.both", ["text", "html"]),
      counted("test.attachments", ["attachments"]),
    );
    const items = await runChecks(view, r);
    expect(items.map((e) => [e.check, e.detail])).toEqual([
      ["test.first", { n: 1 }],
      ["not_checked", { missing: "headers", checks: ["test.auth", "test.received"] }],
      ["not_checked", { missing: "text", checks: ["test.both"] }],
      ["not_checked", { missing: "html", checks: ["test.both"] }],
      ["test.attachments", { n: 1 }],
    ]);
    expect(items[1]?.summary).toBe("2 checks did not run because the original's headers were not available.");
    expect(called).toEqual(["test.first", "test.attachments"]);
  });
});

describe("the registry's budget", () => {
  it("refuses a budget over MAX_CHECK_MS", () => {
    expect(() => registryOf(check("test.long", () => [], [], MAX_CHECK_MS + 1))).toThrow(RangeError);
    expect(registryOf(check("test.max", () => [], [], MAX_CHECK_MS)).names()).toEqual(["test.max"]);
  });
});
