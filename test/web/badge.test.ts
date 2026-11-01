// The live signature badge (D05 T02 §7; design/SPEC.md T3) through the Worker: the Protected badge exactly while the
// business is protected, the Not verified one for a lapsed business (protection off, its last domain lost, its plan
// lapsed), an unknown address and a failed read, each as a real image of its type with status 200, a short cache and no
// redirect, back to Protected when the business recovers; and the day's count, which keeps nothing else.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { setPlan } from "../../src/auth/plans";
import { sastDay } from "../../src/monitor/run";
import { setIdentity } from "../../src/trust/identity";
import { publicSlug } from "../../src/trust/public-slug";
import { BADGE_SIZE } from "../../src/web/badges";
import { authEnv, call } from "../auth/helpers";
import { protectableOrg } from "../trust/helpers";

const db = env.DB;
let n = 0;
async function business() {
  const tag = `${++n}${crypto.randomUUID().slice(0, 6)}`;
  const domain = `bd${tag}.example`;
  const contact = `accounts@${domain}`;
  const orgId = await protectableOrg(domain, contact, "Hadeda Couriers (Pty) Ltd");
  const protect = (on: boolean) =>
    setIdentity(db, orgId, "owner", { displayNames: ["Hadeda Couriers"], financeContact: contact, protected: on });
  await protect(true);
  const slug = (await publicSlug(db, orgId)).slug as string;
  return { orgId, domain, slug, protect };
}

type Badge = { status: number; type: string | null; cache: string | null; location: string | null; body: Uint8Array };
async function badge(slug: string, ext: "png" | "svg", workerEnv: Env = authEnv): Promise<Badge> {
  const res = await call(`/b/${slug}.${ext}`, {}, workerEnv);
  return {
    status: res.status,
    type: res.headers.get("content-type"),
    cache: res.headers.get("cache-control"),
    location: res.headers.get("location"),
    body: new Uint8Array(await res.arrayBuffer()),
  };
}
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
// Which badge an image is: the PNG's own pixels differ, so it is told by comparing with the two served for known
// states; the SVG by its title.
function pngOk(b: Badge) {
  expect(b.status).toBe(200);
  expect(b.location).toBeNull();
  expect(b.type).toBe("image/png");
  expect(b.cache).toBe("public, max-age=3600");
  expect([...b.body.subarray(0, 8)]).toEqual(PNG_SIGNATURE);
  expect(new TextDecoder("latin1").decode(b.body.subarray(12, 16))).toBe("IHDR");
  const view = new DataView(b.body.buffer, b.body.byteOffset);
  expect({ width: view.getUint32(16), height: view.getUint32(20) }).toEqual(BADGE_SIZE);
  expect(BADGE_SIZE.height).toBe(104);
}
function svgTitle(b: Badge): string {
  expect(b.status).toBe(200);
  expect(b.location).toBeNull();
  expect(b.type).toBe("image/svg+xml");
  expect(b.cache).toBe("public, max-age=3600");
  const text = new TextDecoder().decode(b.body);
  expect(text.startsWith("<svg")).toBe(true);
  expect(text.trimEnd().endsWith("</svg>")).toBe(true);
  return /<title>([^<]+)<\/title>/.exec(text)?.[1] ?? "";
}
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

describe("the badge's two variants", () => {
  it("serves the Protected badge for a protected business and the Not verified one for an unknown address", async () => {
    const b = await business();
    const protectedPng = await badge(b.slug, "png");
    const unknownPng = await badge("no-such-business-anywhere", "png");
    pngOk(protectedPng);
    pngOk(unknownPng);
    expect(same(protectedPng.body, unknownPng.body)).toBe(false);
    expect(svgTitle(await badge(b.slug, "svg"))).toBe("Protected by IsItLegit");
    expect(svgTitle(await badge("no-such-business-anywhere", "svg"))).toBe("Not verified by IsItLegit");
  });

  it("turns Not verified when protection is switched off, the last domain is lost or the plan lapses, and back on recovery", async () => {
    for (const lapse of ["protection", "domain", "plan"] as const) {
      const b = await business();
      const protectedPng = (await badge(b.slug, "png")).body;
      const notVerifiedPng = (await badge("no-such-business-anywhere", "png")).body;
      if (lapse === "protection") await b.protect(false);
      if (lapse === "domain")
        await db.prepare("UPDATE org_domains SET state = 'pending' WHERE org_id = ?").bind(b.orgId).run();
      if (lapse === "plan") await setPlan(db, b.orgId, "free");
      const lapsed = await badge(b.slug, "png");
      pngOk(lapsed);
      expect(same(lapsed.body, notVerifiedPng), lapse).toBe(true);
      expect(svgTitle(await badge(b.slug, "svg")), lapse).toBe("Not verified by IsItLegit");
      if (lapse === "protection") await b.protect(true);
      if (lapse === "domain")
        await db.prepare("UPDATE org_domains SET state = 'verified' WHERE org_id = ?").bind(b.orgId).run();
      if (lapse === "plan") await setPlan(db, b.orgId, "protect");
      const back = await badge(b.slug, "png");
      expect(same(back.body, protectedPng), lapse).toBe(true);
      expect(svgTitle(await badge(b.slug, "svg")), lapse).toBe("Protected by IsItLegit");
    }
  });

  it("vouches for no one when the read fails: the Not verified badge, still an image", async () => {
    const b = await business();
    const failing = new Proxy(db, {
      get(target, key) {
        if (key === "prepare")
          return (sql: string) => {
            if (sql.includes("identities")) throw new Error("D1_ERROR: overloaded");
            return target.prepare(sql);
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const broken = { ...authEnv, DB: failing } as Env;
    const png = await badge(b.slug, "png", broken);
    pngOk(png);
    expect(same(png.body, (await badge("no-such-business-anywhere", "png")).body)).toBe(true);
    expect(svgTitle(await badge(b.slug, "svg", broken))).toBe("Not verified by IsItLegit");
  });

  it("answers 404 to a path that names no badge image", async () => {
    for (const path of ["/b/x.gif", "/b/x", "/b/UPPER.png", "/b/a.png.svg"])
      expect((await call(path, {}, authEnv)).status, path).toBe(404);
  });
});

describe("the day's count", () => {
  it("adds one per request for a known business, keyed by the SAST day, and stores nothing about who asked", async () => {
    const b = await business();
    const count = async () =>
      (
        await db
          .prepare("SELECT count FROM badge_requests WHERE org_id = ? AND day = ?")
          .bind(b.orgId, sastDay(new Date()))
          .first<{ count: number }>()
      )?.count ?? 0;
    for (let i = 0; i < 3; i++) await badge(b.slug, i % 2 ? "svg" : "png");
    await expect.poll(count).toBe(3);
    const columns = (
      await db.prepare("SELECT name FROM pragma_table_info('badge_requests') ORDER BY cid").all<{ name: string }>()
    ).results.map((r) => r.name);
    expect(columns).toEqual(["org_id", "day", "count"]);
    // An unknown address counts nowhere.
    const before = (await db.prepare("SELECT COUNT(*) AS n FROM badge_requests").first<{ n: number }>())?.n;
    await badge("no-such-business-anywhere", "png");
    expect((await db.prepare("SELECT COUNT(*) AS n FROM badge_requests").first<{ n: number }>())?.n).toBe(before);
  });
});
