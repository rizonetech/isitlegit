import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { ulid } from "../../src/db/ulid";
import { canaryFor, isCanary, traceCanary } from "../../src/walkthrough/canary";

// Per-case canary credentials (D04 T02 §2; migration 0046): the only values the walkthrough may type.
const db = env.DB;

async function newCase(org = "org-canary") {
  const id = ulid();
  const now = new Date().toISOString();
  await db
    .prepare("INSERT INTO cases (id, org_id, channel, created_at, updated_at) VALUES (?, ?, 'email', ?, ?)")
    .bind(id, org, now, now)
    .run();
  return id;
}

async function issue(caseId: string) {
  const result = await canaryFor(db, caseId);
  if (!result.ok) throw new Error(`no canary: ${result.reason}`);
  return result;
}

async function sha256Hex(text: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const rows = (caseId: string) =>
  db
    .prepare("SELECT username, password_hash FROM canaries WHERE case_id = ? ORDER BY id")
    .bind(caseId)
    .all<{ username: string; password_hash: string }>()
    .then((r) => r.results);

const count = () =>
  db
    .prepare("SELECT count(*) AS n FROM canaries")
    .first<{ n: number }>()
    .then((r) => r?.n);

// A D1 binding whose every statement fails, as a D1 outage would.
const failing = {
  prepare: () => ({
    bind: () => ({
      run: () => Promise.reject(new Error("D1 unavailable")),
      all: () => Promise.reject(new Error("D1 unavailable")),
      first: () => Promise.reject(new Error("D1 unavailable")),
    }),
  }),
} as unknown as D1Database;

describe("isCanary", () => {
  it("accepts the two canary forms", async () => {
    const c = await issue(await newCase());
    expect(c.username).toMatch(/^canary-[0-9a-hjkmnp-tv-z]{12}@canary\.isitlegit\.co\.za$/);
    expect(c.password).toMatch(/^IsItLegit-Canary-[0-9A-HJKMNP-TV-Z]{20}$/);
    expect(isCanary(c.username)).toBe(true);
    expect(isCanary(c.password)).toBe(true);
  });

  it("refuses real-looking values and near misses", async () => {
    const c = await issue(await newCase());
    for (const value of [
      "john@company.co.za",
      "Password123!",
      "",
      `${c.username} `,
      ` ${c.password}`,
      c.username.toUpperCase(),
      c.password.toLowerCase(),
      `${c.username}.evil.example`,
      c.username.replace("@canary.isitlegit.co.za", "@canary.isitlegit.co.za.evil.example"),
      c.username.replace("canary-", "canary--"),
      `${c.password}A`,
      c.password.slice(0, -1),
      "canary-0123456789ab@isitlegit.co.za",
      "canary-0123456789ai@canary.isitlegit.co.za",
    ]) {
      expect(isCanary(value), value).toBe(false);
    }
  });
});

describe("canaryFor", () => {
  it("gives each case its own values and stores only the password's hash", async () => {
    const a = await newCase();
    const b = await newCase();
    const ca = await issue(a);
    const cb = await issue(b);
    expect(ca.username).not.toBe(cb.username);
    expect(ca.password).not.toBe(cb.password);
    expect(ca.username).toBe(`canary-${a.slice(-12).toLowerCase()}@canary.isitlegit.co.za`);
    const stored = await rows(a);
    expect(stored).toEqual([{ username: ca.username, password_hash: await sha256Hex(ca.password) }]);
    const all = JSON.stringify(await db.prepare("SELECT * FROM canaries").all());
    expect(all).not.toContain(ca.password);
    expect(all).not.toContain(cb.password);
  });

  it("keeps the username and mints a new password on a second issue", async () => {
    const a = await newCase();
    const first = await issue(a);
    const second = await issue(a);
    expect(second.username).toBe(first.username);
    expect(second.password).not.toBe(first.password);
    const stored = await rows(a);
    expect(stored.map((r) => r.password_hash).sort()).toEqual(
      [await sha256Hex(first.password), await sha256Hex(second.password)].sort(),
    );
  });

  it("refuses a case id that is not a ULID, and one that names no case, storing nothing", async () => {
    const before = await count();
    expect(await canaryFor(db, "case-1")).toEqual({ ok: false, reason: "invalid_case_id" });
    expect(await canaryFor(db, "")).toEqual({ ok: false, reason: "invalid_case_id" });
    expect(await canaryFor(db, ulid())).toEqual({ ok: false, reason: "no_case" });
    expect(await count()).toBe(before);
  });

  it("rejects when D1 fails, answering no credentials", async () => {
    await expect(canaryFor(failing, ulid())).rejects.toThrow("D1 unavailable");
  });
});

describe("the canaries table", () => {
  it("refuses a malformed username or hash", async () => {
    const a = await newCase();
    const insert = (username: string, hash: string) =>
      db
        .prepare("INSERT INTO canaries (id, case_id, username, password_hash, created_at) VALUES (?, ?, ?, ?, ?)")
        .bind(ulid(), a, username, hash, new Date().toISOString())
        .run();
    const good = `canary-${a.slice(-12).toLowerCase()}@canary.isitlegit.co.za`;
    const hash = "a".repeat(64);
    await expect(insert("john@company.co.za", hash)).rejects.toThrow(/CHECK/);
    await expect(insert(good.toUpperCase(), hash)).rejects.toThrow(/CHECK/);
    await expect(insert(good.replace(/-(.)/, "-i"), hash)).rejects.toThrow(/CHECK/);
    await expect(insert(good, "IsItLegit-Canary-0123456789ABCDEFGHJK")).rejects.toThrow(/CHECK/);
    await expect(insert(good, "A".repeat(64))).rejects.toThrow(/CHECK/);
    await expect(insert(good, "a".repeat(63))).rejects.toThrow(/CHECK/);
    await insert(good, hash);
    await expect(insert(good, hash)).rejects.toThrow(/UNIQUE/);
  });
});

describe("traceCanary", () => {
  it("answers each of its four outcomes", async () => {
    const a = await newCase();
    const b = await newCase();
    const a1 = await issue(a);
    const a2 = await issue(a);
    const b1 = await issue(b);
    expect(await traceCanary(db, a1.username, a1.password)).toEqual({ kind: "match", caseId: a });
    expect(await traceCanary(db, a2.username, a2.password)).toEqual({ kind: "match", caseId: a });
    expect(await traceCanary(db, b1.username, b1.password)).toEqual({ kind: "match", caseId: b });
    expect(await traceCanary(db, a1.username, b1.password)).toEqual({ kind: "wrong_password", caseId: a });
    expect(await traceCanary(db, a1.username, "IsItLegit-Canary-0000000000000000000Z")).toEqual({
      kind: "wrong_password",
      caseId: a,
    });
    expect(await traceCanary(db, "canary-000000000000@canary.isitlegit.co.za", a1.password)).toEqual({
      kind: "unknown_username",
    });
    expect(await traceCanary(db, "john@company.co.za", a1.password)).toEqual({ kind: "not_canary" });
    expect(await traceCanary(db, a1.username, "Password123!")).toEqual({ kind: "not_canary" });
  });

  it("makes no read for a value that is not a canary", async () => {
    expect(await traceCanary(failing, "john@company.co.za", "hunter2")).toEqual({ kind: "not_canary" });
  });

  it("rejects when D1 fails, never answering unknown_username", async () => {
    const c = await issue(await newCase());
    await expect(traceCanary(failing, c.username, c.password)).rejects.toThrow("D1 unavailable");
  });
});

describe("deleting a case", () => {
  it("deletes its canaries, so its pairs no longer trace, and leaves another case's", async () => {
    const a = await newCase();
    const b = await newCase();
    const a1 = await issue(a);
    const a2 = await issue(a);
    const b1 = await issue(b);
    await db.prepare("DELETE FROM cases WHERE id = ?").bind(a).run();
    expect(await rows(a)).toEqual([]);
    expect(await traceCanary(db, a1.username, a1.password)).toEqual({ kind: "unknown_username" });
    expect(await traceCanary(db, a2.username, a2.password)).toEqual({ kind: "unknown_username" });
    expect(await traceCanary(db, b1.username, b1.password)).toEqual({ kind: "match", caseId: b });
  });
});
