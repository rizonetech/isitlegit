import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAuth } from "../../src/auth/auth";
import { authEnv, call, signIn } from "../auth/helpers";

// The journey from a Protect page the plan lacks to the Plan page and back (D07 T08 §12): the real buttons carry where the
// member came from, the Plan page offers Back to it only when it is a path on this site, and the origin survives an
// outage and its Try again.
const db = (env as unknown as Env).DB;
afterEach(() => vi.restoreAllMocks());

const tag = () => crypto.randomUUID().slice(0, 8);
async function freeOrganisation() {
  const email = `refusal-${tag()}@demo.isitlegit.co.za`;
  const { cookie } = await signIn(email);
  const id = (await db.prepare(`SELECT id FROM "user" WHERE lower(email) = ?`).bind(email).first<{ id: string }>())
    ?.id as string;
  const made = (await createAuth(authEnv).api.createOrganization({
    body: { name: "Lapsed Ltd", slug: `lapsed-${tag()}`, userId: id },
  })) as { id: string };
  // The trial lapsed three weeks ago: a free organisation.
  await db
    .prepare(`UPDATE "organization" SET "createdAt" = ? WHERE id = ?`)
    .bind(new Date(Date.now() - 21 * 86_400_000).toISOString(), made.id)
    .run();
  await db.prepare(`UPDATE "session" SET "activeOrganizationId" = ? WHERE "userId" = ?`).bind(made.id, id).run();
  return { cookie };
}
const get = async (cookie: string, path: string) => {
  const res = await call(path, { headers: { cookie, accept: "text/html" } });
  return { res, html: await res.text() };
};
const text = (h: string) =>
  h
    .replace(/<[^>]+>/g, " ")
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ");
const hrefOf = (html: string, label: string) =>
  new RegExp(`<a[^>]*href="([^"]+)"[^>]*>\\s*${label}\\s*</a>`).exec(html)?.[1]?.replace(/&amp;/g, "&");

describe("from a Protect page the plan lacks, to the Plan page and back", () => {
  for (const origin of ["/protect", "/suppliers"]) {
    it(`follows ${origin}'s See plans button to the free plan and Back to ${origin}`, async () => {
      const { cookie } = await freeOrganisation();
      const refusal = await get(cookie, origin);
      expect(refusal.res.status).toBe(403);
      const plans = hrefOf(refusal.html, "See plans");
      expect(plans).toBe(`/settings/plan?from=${origin}`);
      const plan = await get(cookie, plans as string);
      expect(plan.res.status).toBe(200);
      expect(text(plan.html)).toContain("You are on the free plan");
      const back = hrefOf(plan.html, "Back");
      expect(back).toBe(origin);
      expect((await get(cookie, back as string)).res.status).toBe(403);
    });
  }

  it("offers Back only to a path on this site, else Back to cases", async () => {
    const { cookie } = await freeOrganisation();
    const bad = [
      "//evil.example",
      "https://evil.example/x",
      "/\\evil.example",
      "javascript:alert(1)",
      `/${"a".repeat(2100)}`,
    ];
    for (const from of bad) {
      const { res, html } = await get(cookie, `/settings/plan?from=${encodeURIComponent(from)}`);
      expect(res.status).toBe(200);
      expect(hrefOf(html, "Back to cases"), from).toBe("/cases");
      expect(html).not.toContain("evil.example");
    }
  });

  it("keeps the origin through the outage: Try again carries it, and Back works once the read does", async () => {
    const { cookie } = await freeOrganisation();
    vi.spyOn(console, "log").mockImplementation(() => {});
    const prepare = db.prepare.bind(db);
    vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
      if (/o\."createdAt" AS createdAt/.test(sql)) throw new Error("D1_ERROR: down");
      return prepare(sql);
    });
    const down = await get(cookie, "/settings/plan?from=/protect");
    vi.restoreAllMocks();
    expect(down.res.status).toBe(503);
    const retry = hrefOf(down.html, "Try again");
    expect(retry).toBe("/settings/plan?from=%2Fprotect");
    // A hostile origin is not carried by the outage page either.
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
      if (/o\."createdAt" AS createdAt/.test(sql)) throw new Error("D1_ERROR: down");
      return prepare(sql);
    });
    const hostile = await get(cookie, `/settings/plan?from=${encodeURIComponent("//evil.example")}`);
    vi.restoreAllMocks();
    expect(hrefOf(hostile.html, "Try again")).toBe("/settings/plan");
    const again = await get(cookie, retry as string);
    expect(again.res.status).toBe(200);
    expect(hrefOf(again.html, "Back")).toBe("/protect");
  });
});
