import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fold, refreshSearchText, scheduledSearchRefresh, searchText } from "../../src/db/case-search";
import { admitCase, createCase, setOriginalHeader } from "../../src/db/cases";
import { ulid } from "../../src/db/ulid";
import worker from "../../src/index";
import { MAIN_CRON } from "../../src/schedules";

// The Cases list's folded search text (D07 T04 §7; migration 0052): Unicode case and accent folding SQLite's lower()
// cannot do, written at every write of the fields it covers, refilled for older rows by the 15-minute schedule, and a
// refill failure never stops the schedule's other work.
const db = env.DB;
afterEach(() => vi.restoreAllMocks());

const stored = async (id: string) =>
  (await db.prepare("SELECT search_text FROM cases WHERE id = ?").bind(id).first<{ search_text: string | null }>())
    ?.search_text;
const org = () => `org-search-${crypto.randomUUID().slice(0, 8)}`;

describe("fold and searchText", () => {
  it("folds case and accents across Unicode, keeps % and _ as themselves, one field a line", () => {
    expect(fold("  CAFÉ   Zoë ")).toBe("cafe zoe");
    expect(fold("ΣΟΦΊΑ")).toBe("σοφια");
    expect(fold("50%_off")).toBe("50%_off");
    expect(searchText({ subject: "Invoice ÉTÉ", fromName: "Zoë", fromAddress: "Z@Ex.example", uploadName: null })).toBe(
      "invoice ete\nzoe\nz@ex.example",
    );
    expect(searchText({})).toBeNull();
    // Every field kept whole, even at its stored limit and Unicode's widest decomposition (U+FDFA is 18 characters).
    const widest = searchText({
      subject: "\uFDFA".repeat(300),
      fromName: "\uFDFA".repeat(300),
      fromAddress: `${"a".repeat(240)}@x.example`,
      uploadName: `${"b".repeat(243)}invoice.eml`,
    });
    expect(widest?.endsWith("invoice.eml")).toBe(true);
    expect(widest?.length).toBeLessThanOrEqual(20_000);
  });
});

describe("cases.search_text (migration 0052)", () => {
  it("is a nullable text column refusing more than 20,000 characters", async () => {
    const columns = (await db.prepare("PRAGMA table_info(cases)").all<{ name: string; notnull: number }>()).results;
    expect(columns.find((c) => c.name === "search_text")).toMatchObject({ notnull: 0 });
    const made = await createCase(db, { orgId: org(), channel: "email", headersAvailable: true });
    if (!made.ok) throw new Error(made.error.message);
    await expect(
      db.prepare("UPDATE cases SET search_text = ? WHERE id = ?").bind("x".repeat(20_001), made.value.id).run(),
    ).rejects.toThrow(/CHECK constraint/);
  });

  it("is written by both inserts from the upload's name, and null for an email with nothing yet", async () => {
    const uploaded = await admitCase(db, {
      orgId: org(),
      channel: "upload",
      headersAvailable: false,
      uploadedBy: "user-1",
      uploadName: "Proof of PAYMENT Café.pdf",
      sourceKind: "document",
    });
    if (!uploaded.ok) throw new Error(uploaded.error.message);
    expect(await stored(uploaded.value.id)).toBe("proof of payment cafe.pdf");
    const created = await createCase(db, {
      orgId: org(),
      channel: "upload",
      headersAvailable: false,
      uploadedBy: "user-2",
      uploadName: "Zoë.PNG",
      sourceKind: "image",
    });
    if (!created.ok) throw new Error(created.error.message);
    expect(await stored(created.value.id)).toBe("zoe.png");
    const email = await admitCase(db, { orgId: org(), channel: "email", headersAvailable: true });
    if (!email.ok) throw new Error(email.error.message);
    expect(await stored(email.value.id)).toBeNull();
  });

  it("is written by setOriginalHeader with the subject, sender and any upload name", async () => {
    const email = await createCase(db, { orgId: org(), channel: "email", headersAvailable: true });
    if (!email.ok) throw new Error(email.error.message);
    await setOriginalHeader(db, email.value.id, {
      subject: "Your ÉFILING notice",
      fromName: "SARS",
      fromAddress: "no-reply@sars.example",
    });
    expect(await stored(email.value.id)).toBe("your efiling notice\nsars\nno-reply@sars.example");
    const eml = await createCase(db, {
      orgId: org(),
      channel: "upload",
      headersAvailable: true,
      uploadedBy: "user-3",
      uploadName: "forwarded.eml",
    });
    if (!eml.ok) throw new Error(eml.error.message);
    await setOriginalHeader(db, eml.value.id, { subject: "Remittance", fromName: null, fromAddress: "a@b.example" });
    expect(await stored(eml.value.id)).toBe("remittance\na@b.example\nforwarded.eml");
  });
});

describe("the widest fields through the database", () => {
  it("stores and finds a sender and a file name behind two subjects at the widest decomposition", async () => {
    const made = await createCase(db, {
      orgId: org(),
      channel: "upload",
      headersAvailable: true,
      uploadedBy: "user-wide",
      uploadName: `${"b".repeat(243)}invoice.eml`,
    });
    if (!made.ok) throw new Error(made.error.message);
    const header = await setOriginalHeader(db, made.value.id, {
      subject: "\uFDFA".repeat(300),
      fromName: "\uFDFA".repeat(300),
      fromAddress: `${"a".repeat(240)}@x.example`,
    });
    expect(header.ok).toBe(true);
    const text = await stored(made.value.id);
    expect(text?.includes("@x.example")).toBe(true);
    expect(text?.endsWith("invoice.eml")).toBe(true);
  });
});

describe("refreshSearchText", () => {
  async function legacy(fields: { subject?: string; upload?: string }) {
    const id = ulid();
    const at = new Date().toISOString();
    await db
      .prepare(
        `INSERT INTO cases (id, org_id, channel, status, headers_available, created_at, updated_at, original_subject, upload_name)
         VALUES (?, ?, 'email', 'done', 1, ?, ?, ?, ?)`,
      )
      .bind(id, org(), at, at, fields.subject ?? null, fields.upload ?? null)
      .run();
    return id;
  }

  it("fills a row stored before the column, leaves a row with nothing to fold, and changes nothing a second time", async () => {
    await db.prepare("UPDATE cases SET search_text = '' WHERE search_text IS NULL").run();
    const old = await legacy({ subject: "CAFÉ invoice" });
    const marks = await legacy({ subject: "́́" });
    const bare = await legacy({});
    expect(await refreshSearchText(db)).toBe(2);
    expect(await stored(old)).toBe("cafe invoice");
    expect(await stored(marks)).toBe("");
    expect(await stored(bare)).toBeNull();
    expect(await refreshSearchText(db)).toBe(0);
  });

  it("fills at most the limit a pass", async () => {
    await db.prepare("UPDATE cases SET search_text = '' WHERE search_text IS NULL").run();
    for (let i = 0; i < 3; i++) await legacy({ subject: `Old ${i}` });
    expect(await refreshSearchText(db, 2)).toBe(2);
    expect(await refreshSearchText(db, 2)).toBe(1);
  });
});

describe("the schedule's refill", () => {
  it("runs on the 15-minute cron", async () => {
    await db.prepare("UPDATE cases SET search_text = '' WHERE search_text IS NULL").run();
    const id = ulid();
    const at = new Date().toISOString();
    await db
      .prepare(
        `INSERT INTO cases (id, org_id, channel, status, headers_available, created_at, updated_at, original_subject)
         VALUES (?, ?, 'email', 'done', 1, ?, ?, 'Ünïcode')`,
      )
      .bind(id, org(), at, at)
      .run();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ data: { events: [] } }));
    const waits: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => waits.push(p), passThroughOnException: () => {}, props: {} };
    await worker.scheduled(
      { scheduledTime: Date.now(), cron: MAIN_CRON, noRetry: () => {} },
      env,
      ctx as unknown as ExecutionContext,
    );
    await Promise.allSettled(waits);
    expect(await stored(id)).toBe("unicode");
  });

  it("logs a failed refill and resolves, so the schedule's other work goes on", async () => {
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((line: string) => errors.push(line));
    const broken = {
      prepare: () => {
        throw new TypeError("D1 down");
      },
    } as unknown as D1Database;
    await expect(scheduledSearchRefresh({ DB: broken })).resolves.toBe(0);
    expect(errors.map((e) => JSON.parse(e))).toContainEqual({
      event: "case-search",
      outcome: "refill-failed",
      error: "TypeError",
    });
  });

  it("is one waitUntil of its own beside the others, so its failure leaves them running", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ data: { events: [] } }));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const waits: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => waits.push(p), passThroughOnException: () => {}, props: {} };
    const real = env.DB;
    // A database whose case-search read fails and every other statement goes through.
    const DB = new Proxy(real, {
      get(target, key) {
        if (key === "prepare")
          return (sql: string) => {
            if (sql.includes("search_text IS NULL AND")) throw new TypeError("refill down");
            return target.prepare(sql);
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await worker.scheduled(
      { scheduledTime: Date.now(), cron: MAIN_CRON, noRetry: () => {} },
      { ...env, DB },
      ctx as unknown as ExecutionContext,
    );
    expect(waits.length).toBeGreaterThan(1);
    const settled = await Promise.allSettled(waits);
    // The refill's own promise resolves (it logs); the others ran to their own ends.
    expect(settled.every((s) => s.status === "fulfilled")).toBe(true);
  });
});
