import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { bundled } from "../../src/checks/brands";
import { type CaseView, caseViewOf, SummaryRefused } from "../../src/checks/case-view";
import {
  addEvidence,
  Evidence,
  type EvidenceDraft,
  EvidenceRefused,
  evidenceIn,
  readEvidence,
  StoredEvidence,
  SYSTEM_CHECKS,
  saveEvidence,
} from "../../src/checks/evidence";
import { allChecks, checks } from "../../src/checks/index";
import { forwardEvidence, truncatedEvidence, uploadEvidence } from "../../src/checks/intake";
import { CheckRegistry } from "../../src/checks/registry";
import { createCase } from "../../src/db/cases";
import { extractOriginal } from "../../src/intake/forward";
import { parseMessage, storeParsed } from "../../src/intake/parse";
import { parsedKey, putAttachment, rawKey, readArtefact, type Store } from "../../src/intake/store";
import { parse } from "../../src/pipeline/analysis-workflow";
import { forwards } from "../fixtures/forward/load";

// D02 T01 §1: the evidence every check produces, the view it reads, the registry and the store.
const db = env.DB;
const store: Store = { bucket: env.ARTEFACTS, db };
const enc = (text: string) => new TextEncoder().encode(text);
const b64 = (bytes: Uint8Array) => {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
};
const multipart = (parts: string[]) =>
  enc(
    [
      "From: billing@fictional-supplier.example",
      'Content-Type: multipart/mixed; boundary="b"',
      "",
      ...parts.flatMap((p) => ["--b", p]),
      "--b--",
      "",
    ].join("\r\n"),
  );

async function newCase(channel: "email" | "upload" = "email") {
  const made = await createCase(db, {
    orgId: "org-evidence",
    channel,
    headersAvailable: channel === "email",
    uploadedBy: channel === "upload" ? "user-evidence" : null,
  });
  if (!made.ok) throw new Error(made.error.message);
  return made.value.id;
}
async function summaryOf(caseId: string) {
  const read = await readArtefact(store, caseId, parsedKey(caseId));
  if (!read || !("body" in read)) throw new Error("no summary");
  return JSON.parse(new TextDecoder().decode(read.body)) as unknown;
}
async function forwardView(message: Uint8Array, channel: "email" | "upload" = "email"): Promise<CaseView> {
  const caseId = await newCase(channel);
  const forward = await extractOriginal(message);
  await storeParsed(store, caseId, await parseMessage(forward.original), forward);
  return caseViewOf(
    await summaryOf(caseId),
    { orgId: "org-evidence", channel, receivers: [], trusted: { own: [], suppliers: [] } },
    rawKey(caseId),
    bundled,
  );
}
const item = (n: number, check = "test.one"): EvidenceDraft => ({
  check,
  severity: "low",
  summary: `Item ${n} in plain words.`,
  detail: { n, nested: { list: [n, "x"] } },
  artefacts: [`raw/case/attachment-${n}`],
});
const registry = () => {
  const r = new CheckRegistry();
  r.register({ name: "test.one", needs: ["headers"], timeoutMs: 100, run: () => [item(1)] });
  r.register({ name: "test.two", needs: ["text"], timeoutMs: 100, run: () => [item(2, "test.two")] });
  return r;
};

describe("Evidence", () => {
  const good = { id: "E1", ...item(1), check: "intake.forward" };

  it("accepts a registered producer's item, and a not_checked item the runner writes", () => {
    expect(Evidence.parse(good)).toEqual(good);
    expect(Evidence.safeParse({ ...good, check: SYSTEM_CHECKS[0] }).success).toBe(true);
  });

  it("refuses, in the schema itself, a well-spelt name no check registered", () => {
    const parsed = Evidence.safeParse({ ...good, check: "unknown.producer" });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toBe("names no registered check");
    // Against another registry, its own producers.
    expect(evidenceIn(registry()).safeParse({ ...good, check: "test.one" }).success).toBe(true);
    expect(evidenceIn(registry()).safeParse(good).success).toBe(false);
    // A stored item reads back by its name's form, whatever is registered now.
    expect(StoredEvidence.safeParse({ ...good, check: "renamed.later" }).success).toBe(true);
  });

  it("refuses an unknown severity, an over-long or unplain summary, a bad id and a non-object detail", () => {
    expect(Evidence.safeParse({ ...good, severity: "severe" }).success).toBe(false);
    expect(Evidence.safeParse({ ...good, summary: "x".repeat(201) }).success).toBe(false);
    // Characters, not UTF-16 units: 200 emoji are 400 units and still fit.
    expect(Evidence.safeParse({ ...good, summary: "😀".repeat(200) }).success).toBe(true);
    for (const summary of [
      "",
      "line one\nline two",
      "<b>bold</b>",
      "safe\u2028next line",
      "safe\u2029next paragraph",
      "safe\u0085next",
      "pay \u202Eevil",
      "zero\u200Bwidth",
      "tab\there",
    ])
      expect(Evidence.safeParse({ ...good, summary }).success, summary).toBe(false);
    for (const id of ["E0", "e1", "E", "1", "E01"]) expect(Evidence.safeParse({ ...good, id }).success, id).toBe(false);
    for (const detail of [[1], "x", null]) expect(Evidence.safeParse({ ...good, detail }).success).toBe(false);
    expect(Evidence.safeParse({ ...good, extra: 1 }).success).toBe(false);
    // A detail of at most 64 KiB of JSON, and at most 100 artefact keys (round 1 of D02 T01 §2).
    expect(Evidence.safeParse({ ...good, detail: { blob: "a".repeat(65_000) } }).success).toBe(true);
    expect(Evidence.safeParse({ ...good, detail: { blob: "a".repeat(66_000) } }).success).toBe(false);
    expect(Evidence.safeParse({ ...good, artefacts: Array.from({ length: 101 }, (_, i) => `k${i}`) }).success).toBe(
      false,
    );
  });
});

describe("the registry", () => {
  it("refuses a duplicate name, a runner name, a malformed name and a bad budget", () => {
    const r = registry();
    expect(() => r.register({ name: "test.one", needs: [], timeoutMs: 1, run: () => [] })).toThrow(
      /already registered/,
    );
    expect(() => r.register({ name: "not_checked", needs: [], timeoutMs: 1, run: () => [] })).toThrow(/runner/);
    expect(() => r.register({ name: "Test One", needs: [], timeoutMs: 1, run: () => [] })).toThrow(/name/);
    for (const timeoutMs of [0, 1.5, -1])
      expect(() => r.register({ name: "test.three", needs: [], timeoutMs, run: () => [] })).toThrow(RangeError);
    expect(r.names()).toEqual(["test.one", "test.two"]);
  });

  it("registers the intake checks first, in their order", () => {
    expect(
      allChecks()
        .slice(0, 3)
        .map((c) => c.name),
    ).toEqual(["intake.forward", "intake.upload", "intake.truncated"]);
    expect(() => checks.register({ name: "intake.forward", needs: [], timeoutMs: 1, run: () => [] })).toThrow();
  });

  it("stores two registered checks' evidence as E1 and E2", async () => {
    const r = registry();
    const caseId = await newCase();
    const items = (await Promise.all(r.all().map((c) => c.run({} as CaseView, new AbortController().signal)))).flat();
    await saveEvidence(db, caseId, items, r);
    expect((await readEvidence(db, caseId)).map((e) => [e.id, e.check])).toEqual([
      ["E1", "test.one"],
      ["E2", "test.two"],
    ]);
  });
});

describe("saveEvidence", () => {
  const r = registry();
  const ids = async (caseId: string) => (await readEvidence(db, caseId)).map((e) => e.id);

  it("reads twelve items back in numeric order, every field", async () => {
    const caseId = await newCase();
    const items = Array.from({ length: 12 }, (_, i) => item(i + 1));
    const saved = await saveEvidence(db, caseId, items, r);
    const read = await readEvidence(db, caseId);
    expect(read).toEqual(saved);
    expect(read.map((e) => e.id)).toEqual(Array.from({ length: 12 }, (_, i) => `E${i + 1}`));
    expect(read[9]).toEqual({ id: "E10", ...item(10) });
  });

  it("stores an identical retry once, and a shorter or empty list replaces a longer", async () => {
    const caseId = await newCase();
    const three = [item(1), item(2), item(3)];
    await saveEvidence(db, caseId, three, r);
    await saveEvidence(db, caseId, three, r);
    expect(await ids(caseId)).toEqual(["E1", "E2", "E3"]);
    await saveEvidence(db, caseId, [item(9)], r);
    expect(await readEvidence(db, caseId)).toEqual([{ id: "E1", ...item(9) }]);
    await saveEvidence(db, caseId, [], r);
    expect(await ids(caseId)).toEqual([]);
  });

  it("leaves another case's evidence alone", async () => {
    const one = await newCase();
    const other = await newCase();
    await saveEvidence(db, other, [item(1), item(2)], r);
    await saveEvidence(db, one, [item(3)], r);
    await saveEvidence(db, one, [], r);
    expect(await ids(other)).toEqual(["E1", "E2"]);
  });

  it("refuses a malformed list before writing, leaving the previous list whole", async () => {
    const caseId = await newCase();
    await saveEvidence(db, caseId, [item(1), item(2)], r);
    const before = await readEvidence(db, caseId);
    await expect(saveEvidence(db, caseId, [item(3), { ...item(4), summary: "x".repeat(201) }], r)).rejects.toThrow(
      EvidenceRefused,
    );
    await expect(saveEvidence(db, caseId, [item(3), item(4, "test.unknown")], r)).rejects.toThrow(
      /no registered check/,
    );
    expect(await readEvidence(db, caseId)).toEqual(before);
    // The runner's own name needs no registration.
    await saveEvidence(db, caseId, [{ ...item(5), check: "not_checked" }], r);
    expect((await readEvidence(db, caseId))[0]?.check).toBe("not_checked");
  });

  it("leaves the previous list whole when its batch fails partway", async () => {
    const caseId = await newCase();
    await saveEvidence(db, caseId, [item(1), item(2)], r);
    const before = await readEvidence(db, caseId);
    // The real database, with a statement that fails appended to the batch: the delete and inserts commit together.
    const failing = {
      prepare: (sql: string) => db.prepare(sql),
      batch: (statements: D1PreparedStatement[]) =>
        db.batch([...statements, db.prepare("INSERT INTO evidence (case_id) VALUES (NULL)")]),
    } as unknown as D1Database;
    await expect(saveEvidence(failing, caseId, [item(7)], r)).rejects.toThrow();
    expect(await readEvidence(db, caseId)).toEqual(before);
  });
});

describe("caseViewOf", () => {
  it("loads a forward's summary, keeping each cut part's media type and charset", async () => {
    const utf16 = (text: string) => {
      const out = new Uint8Array(text.length * 2);
      for (let i = 0; i < text.length; i++) {
        out[i * 2] = text.charCodeAt(i) & 0xff;
        out[i * 2 + 1] = text.charCodeAt(i) >> 8;
      }
      return out;
    };
    const body = `${"padding line\r\n".repeat(60_000)}https://fictional-lure.example/pay\r\n`;
    const view = await forwardView(
      multipart([
        `Content-Type: text/plain; charset=UTF-16LE\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64(utf16(body))}`,
      ]),
    );
    expect(view.tenant).toEqual({
      orgId: "org-evidence",
      channel: "email",
      receivers: [],
      trusted: { own: [], suppliers: [] },
      headersAvailable: false,
    });
    expect(view.source).toEqual({ kind: "message", path: "inline", otherOriginals: 0 });
    expect(view.truncated).toHaveLength(1);
    const [part] = view.truncated;
    expect(part?.mediaType).toBe("text/plain");
    expect(part?.charset).toBe("utf-16le");
    expect(part?.fullBytes).toBe(utf16(body).byteLength);
    expect(part?.keptBytes).toBeLessThan(part?.fullBytes as number);
    expect(part?.key).toMatch(/^raw\//);
  });

  it("keeps the headers, both bodies and every attachment's metadata exactly as stored", async () => {
    const message = enc(
      [
        "From: Fictional Supplier <billing@fictional-supplier.example>",
        "Subject: Invoice 42",
        'Content-Type: multipart/mixed; boundary="m"',
        "",
        "--m",
        'Content-Type: multipart/alternative; boundary="a"',
        "",
        "--a",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "Please pay invoice 42.",
        "--a",
        "Content-Type: text/html; charset=utf-8",
        "",
        "<p>Please pay <b>invoice 42</b>.</p>",
        "--a--",
        "--m",
        'Content-Type: application/pdf; name="invoice.pdf"',
        'Content-Disposition: attachment; filename="invoice.pdf"',
        "Content-Transfer-Encoding: base64",
        "",
        b64(enc("%PDF-1.4\n% fictional invoice\n%%EOF\n")),
        "--m--",
        "",
      ].join("\r\n"),
    );
    const caseId = await newCase("upload");
    const forward = await extractOriginal(message);
    await storeParsed(store, caseId, await parseMessage(forward.original), forward);
    const summary = (await summaryOf(caseId)) as Record<string, unknown>;
    const view = caseViewOf(
      summary,
      { orgId: "org-evidence", channel: "upload", receivers: [], trusted: { own: [], suppliers: [] } },
      rawKey(caseId),
      bundled,
    );
    expect(view.headers).toEqual(summary.headers);
    expect(view.text).toBe(summary.text);
    expect(view.html).toBe(summary.html);
    expect(view.text).toContain("Please pay invoice 42.");
    expect(view.html).toContain("<b>invoice 42</b>");
    expect(view.attachments).toEqual(summary.attachments);
    expect(view.attachments).toEqual([
      expect.objectContaining({ filename: "invoice.pdf", mediaType: "application/pdf", disposition: "attachment" }),
    ]);
    expect(view.attachments[0]?.bytes).toBeGreaterThan(0);
  });

  it("loads an attached forward's path and headers", async () => {
    const view = await forwardView(forwards["attached-rfc822"]);
    expect(view.source).toEqual({ kind: "message", path: "rfc822", otherOriginals: 0 });
    expect(view.headers.some((h) => h.name.toLowerCase() === "from")).toBe(true);
  });

  it("loads an uploaded file's summary as parse writes it", async () => {
    const caseId = await newCase("upload");
    const pdf = enc("%PDF-1.4\n% fictional invoice\n%%EOF\n");
    await putAttachment(store, caseId, "invoice.pdf", pdf, "application/pdf");
    await parse(store, caseId, { channel: "upload", sourceKind: "document", headersAvailable: false });
    const view = caseViewOf(
      await summaryOf(caseId),
      { orgId: "org-evidence", channel: "upload", receivers: [], trusted: { own: [], suppliers: [] } },
      rawKey(caseId),
      bundled,
    );
    expect(view.source).toMatchObject({ kind: "upload", fileKind: "document", mediaType: "application/pdf" });
    expect(view.tenant.headersAvailable).toBe(false);
    expect([view.headers, view.attachments, view.truncated, view.text]).toEqual([[], [], [], null]);
  });

  it("refuses a summary of neither shape", () => {
    for (const summary of [
      null,
      {},
      { forward: {} },
      { source: { kind: "mail" }, forward: { headersAvailable: false } },
    ])
      expect(() =>
        caseViewOf(
          summary,
          { orgId: "o", channel: "email", receivers: [], trusted: { own: [], suppliers: [] } },
          "raw/x/message.eml",
          bundled,
        ),
      ).toThrow(SummaryRefused);
  });
});

describe("the intake items", () => {
  it("makes intake.forward E1 with its path, attached and inline", async () => {
    for (const [fixture, path] of [
      ["attached-rfc822", "rfc822"],
      ["inline-forward", "inline"],
    ] as const) {
      const caseId = await newCase();
      const view = await forwardView(forwards[fixture]);
      const items = (await Promise.all(allChecks().map((c) => c.run(view, new AbortController().signal)))).flat();
      const [first] = await saveEvidence(db, caseId, items);
      expect(first).toMatchObject({ id: "E1", check: "intake.forward", severity: "info", detail: { path } });
    }
  });

  it("counts the further originals a forward carried, unchecked", async () => {
    const view = await forwardView(forwards["two-originals"]);
    const [forward] = forwardEvidence(view);
    expect(forward?.detail).toMatchObject({ otherOriginals: 1 });
    expect(forward?.summary).toMatch(/1 further attached message was not checked/);
  });

  it("makes intake.upload E1 for an uploaded file", async () => {
    const caseId = await newCase("upload");
    await putAttachment(store, caseId, "photo.png", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2]), "image/png");
    await parse(store, caseId, { channel: "upload", sourceKind: "image", headersAvailable: false });
    const view = caseViewOf(
      await summaryOf(caseId),
      { orgId: "org-evidence", channel: "upload", receivers: [], trusted: { own: [], suppliers: [] } },
      rawKey(caseId),
      bundled,
    );
    const items = (await Promise.all(allChecks().map((c) => c.run(view, new AbortController().signal)))).flat();
    const [first, ...rest] = await saveEvidence(db, caseId, items);
    expect(first).toMatchObject({
      id: "E1",
      check: "intake.upload",
      detail: { kind: "image", mediaType: "image/png" },
    });
    expect(first?.artefacts).toHaveLength(1);
    // A file without headers: the authentication item says they did not come (D02 T02 §1).
    expect(rest).toMatchObject([{ id: "E2", check: "auth.results", detail: { trusted: false, reason: "no-headers" } }]);
    expect(forwardEvidence(view)).toEqual([]);
  });

  it("lists every cut part of the twenty-part message in one item, and claims no check's coverage", async () => {
    const part = `${"x".repeat(78)}\r\n`.repeat(10_000);
    const view = await forwardView(
      multipart([
        ...Array.from({ length: 20 }, () => `Content-Type: text/plain\r\n\r\n${part}`),
        "Content-Type: text/html\r\n\r\n<p>last</p>",
      ]),
    );
    const items = truncatedEvidence(view);
    expect(items).toHaveLength(1);
    const [cut] = items;
    expect(view.truncated.length).toBeGreaterThan(0);
    const parts = cut?.detail.parts as unknown[] | undefined;
    expect(parts?.length).toBe(view.truncated.length);
    expect(cut?.artefacts).toEqual(view.truncated.map((p) => p.key));
    expect(cut?.summary).not.toMatch(/check|scan|read in full|link|hidden/i);
    expect(Evidence.safeParse({ id: "E2", ...cut }).success).toBe(true);
  });

  it("says further cut parts past the 50 kept were kept only to the cut, and an uncut message gets no item", async () => {
    const uncut = await forwardView(forwards["attached-rfc822"]);
    expect(truncatedEvidence(uncut)).toEqual([]);
    const cutParts = Array.from({ length: 50 }, (_, i) => ({
      mediaType: "text/plain",
      charset: null,
      key: `raw/c/body-${i + 1}.txt`,
      fullBytes: 2_000_000,
      keptBytes: 1_000,
    }));
    const [cut] = truncatedEvidence({ ...uncut, truncated: cutParts, omitted: 3 });
    expect(cut?.summary).toMatch(/^50 body parts were longer than the reading limit/);
    expect(cut?.summary).toMatch(/3 further cut parts were kept only up to the cut\.$/);
    expect(cut?.detail.omitted).toBe(3);
    expect(Evidence.safeParse({ id: "E2", ...cut }).success).toBe(true);
    expect(uploadEvidence(uncut)).toEqual([]);
  });
});

describe("guarded verification drafts", () => {
  const draft: EvidenceDraft = {
    check: "verification.not_requested",
    severity: "info",
    summary: "Delivery is unconfirmed.",
    detail: { reason: "plan-required" },
    artefacts: [],
  };
  it("publishes a refusal without a request row and rejects mismatched guard/draft context", async () => {
    const made = await createCase(db, { orgId: "guard-owner", channel: "email", headersAvailable: false });
    if (!made.ok) throw new Error(made.error.message);
    const id = made.value.id;
    const context = { orgId: "guard-owner", runId: id, state: "unavailable" as const };
    expect(await addEvidence(db, id, "verification", [draft], undefined, undefined, undefined, context)).toHaveLength(
      1,
    );
    expect((await readEvidence(db, id))[0]?.detail.reason).toBe("plan-required");
    await expect(
      addEvidence(db, id, "verification", [draft], undefined, undefined, undefined, { ...context, state: "requested" }),
    ).rejects.toThrow(EvidenceRefused);
    expect((await readEvidence(db, id))[0]?.check).toBe("verification.not_requested");
  });
  it.each(["rerun", "answer"])("preserves evidence when a %s wins immediately before publication", async (race) => {
    const made = await createCase(db, { orgId: "guard-owner", channel: "email", headersAvailable: false });
    if (!made.ok) throw new Error(made.error.message);
    const id = made.value.id;
    await addEvidence(db, id, "verification", [draft]);
    let once = false;
    const racing = new Proxy(db, {
      get(target, key) {
        if (key === "batch")
          return async (statements: D1PreparedStatement[]) => {
            if (!once) {
              once = true;
              if (race === "rerun")
                await db.prepare("UPDATE cases SET run_id = ? WHERE id = ?").bind(`rerun-${id}`, id).run();
              else
                await addEvidence(db, id, "verification", [
                  { ...draft, check: "verification.answered", summary: "The supplier answered." },
                ]);
            }
            return db.batch(statements);
          };
        return Reflect.get(target, key);
      },
    }) as D1Database;
    expect(
      await addEvidence(racing, id, "verification", [draft], undefined, undefined, undefined, {
        orgId: "guard-owner",
        runId: id,
        state: "unavailable",
      }),
    ).toEqual([]);
    if (race === "rerun") {
      expect(await readEvidence(db, id)).toEqual([]);
      expect((await readEvidence(db, id, id))[0]?.summary).toBe(draft.summary);
    } else expect((await readEvidence(db, id))[0]?.check).toBe("verification.answered");
  });
});
