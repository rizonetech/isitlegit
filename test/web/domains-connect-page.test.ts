// The verification page's registrar hand-off (D07 T04 §5), against a stubbed registrar: the Connect control is
// offered only when the provider supports IsItLegit's template, the hand-off is signed and bound to the claim,
// the return runs the DNS check itself, and every refusal leaves the claim as it was.
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DOH_URL } from "../../src/auth/domains";
import { authEnv, call, signIn } from "../auth/helpers";

const db = (env as unknown as Env).DB;

const pair = (await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true,
  ["sign", "verify"],
)) as CryptoKeyPair;
const pk8 = new Uint8Array((await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer);
const TEST_PEM = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...Array.from(pk8)))
  .match(/.{1,64}/g)
  ?.join("\n")}\n-----END PRIVATE KEY-----`;
const workerEnv = { ...authEnv, DOMAIN_CONNECT_PRIVATE_KEY: TEST_PEM } as unknown as Env;

const SETTINGS = {
  providerName: "Registrar Example",
  urlSyncUX: "https://registrar.example/connect/sync",
  urlAsyncUX: "https://registrar.example/connect/async",
};
const world = {
  connect: "supported" as "supported" | "none" | "down",
  template: "yes" as "yes" | "no" | "down",
  dns: "absent" as "absent" | "found",
  token: "",
};
let spy: ReturnType<typeof vi.spyOn> | undefined;
function stubNetwork() {
  spy?.mockRestore();
  const real = globalThis.fetch;
  spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.startsWith(DOH_URL)) {
      const name = new URL(url).searchParams.get("name") ?? "";
      if (name.startsWith("_domainconnect.")) {
        if (world.connect === "down") return new Response("", { status: 500 });
        if (world.connect === "none") return Response.json({ Status: 3 });
        return Response.json({ Status: 0, Answer: [{ type: 16, data: '"domainconnect.registrar.example"' }] });
      }
      if (name.startsWith("_isitlegit.")) {
        if (world.dns === "absent") return Response.json({ Status: 3 });
        return Response.json({ Status: 0, Answer: [{ type: 16, data: `"isitlegit-verify=${world.token}"` }] });
      }
      return Response.json({ Status: 3 });
    }
    if (url === "https://domainconnect.registrar.example/v2/supported.example/settings" || url.includes("/settings"))
      return world.connect === "down" ? new Response("", { status: 500 }) : Response.json(SETTINGS);
    if (url.includes("/v2/domainTemplates?")) {
      if (world.template === "down") return new Response("", { status: 503 });
      return new Response("", { status: world.template === "yes" ? 200 : 404 });
    }
    return real(input as Request);
  });
}
beforeEach(() => {
  world.connect = "supported";
  world.template = "yes";
  world.dns = "absent";
  world.token = "";
  stubNetwork();
});
afterEach(() => {
  spy?.mockRestore();
  vi.restoreAllMocks();
});

let n = 0;
const tag = () => `${++n}${crypto.randomUUID().slice(0, 6)}`;
async function setup(role = "owner") {
  const orgId = `org-con-${tag()}`;
  await db
    .prepare(`INSERT INTO "organization" (id, name, slug, "createdAt") VALUES (?, ?, ?, ?)`)
    .bind(orgId, "Connect Org (fictional)", orgId, new Date().toISOString())
    .run();
  const email = `con-${tag()}@demo.isitlegit.co.za`;
  const { cookie } = await signIn(email);
  stubNetwork();
  const user = await db.prepare(`SELECT id FROM "user" WHERE lower(email) = ?`).bind(email).first<{ id: string }>();
  await db
    .prepare(`INSERT INTO "member" (id, "organizationId", "userId", role, "createdAt") VALUES (?, ?, ?, ?, ?)`)
    .bind(`m-${crypto.randomUUID()}`, orgId, user?.id, role, new Date().toISOString())
    .run();
  await db.prepare(`UPDATE "session" SET "activeOrganizationId" = ? WHERE "userId" = ?`).bind(orgId, user?.id).run();
  const token = `tok${tag()}`.padEnd(20, "x");
  await db
    .prepare("INSERT INTO org_domains (id, org_id, domain, token, state, created_at) VALUES (?, ?, ?, ?, 'pending', ?)")
    .bind(crypto.randomUUID(), orgId, "supported.example", token, new Date().toISOString())
    .run();
  world.token = token;
  return { orgId, cookie, email, token };
}
const get = (path: string, cookie?: string) =>
  call(path, { headers: { accept: "text/html", ...(cookie ? { cookie } : {}) } }, workerEnv);
const words = (html: string) => html.replace(/&amp;/g, "&");

describe("the registrar hand-off", () => {
  it("offers Connect on the pending claim and hands off signed to the registrar", async () => {
    const { cookie } = await setup();
    const page = await get("/settings/domains/supported.example", cookie);
    expect(page.status).toBe(200);
    const text = words(await page.text());
    expect(text).toContain("Connect with Registrar Example");
    const hand = await get("/settings/domains/supported.example/connect", cookie);
    expect(hand.status).toBe(302);
    const to = new URL(hand.headers.get("location") ?? "");
    expect(to.origin + to.pathname).toBe(
      "https://registrar.example/connect/sync/v2/domainTemplates/providers/isitlegit.co.za/services/verify/apply",
    );
    expect(to.searchParams.get("txtValue")).toBe(`isitlegit-verify=${world.token}`);
    expect(to.searchParams.get("redirect_uri")).toContain("connect=return");
    expect(to.searchParams.get("sig")).toBeTruthy();
  });

  it("verifies on return when DNS shows the record, and reads verified on a fresh GET", async () => {
    const { cookie, orgId } = await setup();
    world.dns = "found";
    const back = await get("/settings/domains/supported.example?connect=return", cookie);
    expect(back.status).toBe(303);
    const stored = await db
      .prepare("SELECT state FROM org_domains WHERE domain = 'supported.example' AND org_id = ?")
      .bind(orgId)
      .first<{ state: string }>();
    expect(stored?.state).toBe("verified");
    const fresh = words(await (await get("/settings/domains/supported.example", cookie)).text());
    expect(fresh).toContain("Verified");
    expect(fresh).not.toContain("Connect with");
  });

  it("shows the not-visible outcome when the registrar added nothing yet", async () => {
    const { cookie, orgId } = await setup();
    const back = await get("/settings/domains/supported.example?connect=return", cookie);
    expect(back.status).toBe(303);
    const landed = words(await (await get(back.headers.get("location") ?? "", cookie)).text());
    expect(landed).toContain("not visible yet");
    const stored = await db
      .prepare("SELECT state FROM org_domains WHERE domain = 'supported.example' AND org_id = ?")
      .bind(orgId)
      .first<{ state: string }>();
    expect(stored?.state).toBe("pending");
  });

  it("offers nothing when the template is unsupported or the registrar is unknown", async () => {
    const { cookie } = await setup();
    world.template = "no";
    expect(words(await (await get("/settings/domains/supported.example", cookie)).text())).not.toContain(
      "Connect with",
    );
    world.template = "yes";
    world.connect = "down";
    const unknown = words(await (await get("/settings/domains/supported.example", cookie)).text());
    expect(unknown).toContain("could not reach the registrar");
    expect(unknown).toContain("Try again");
    const hand = await get("/settings/domains/supported.example/connect", cookie);
    expect(hand.status).toBe(303);
  });

  it("refuses a plain member, and another organisation never reaches the hand-off", async () => {
    const member = await setup("member");
    expect((await get("/settings/domains/supported.example/connect", member.cookie)).status).toBe(403);
    // A second organisation whose owner asks for the first one's domain gets the page's refusal, not a hand-off.
    const orgId = `org-con-${tag()}`;
    await db
      .prepare(`INSERT INTO "organization" (id, name, slug, "createdAt") VALUES (?, ?, ?, ?)`)
      .bind(orgId, "Other Org (fictional)", orgId, new Date().toISOString())
      .run();
    const email = `con-${tag()}@demo.isitlegit.co.za`;
    const { cookie } = await signIn(email);
    stubNetwork();
    const user = await db.prepare(`SELECT id FROM "user" WHERE lower(email) = ?`).bind(email).first<{ id: string }>();
    await db
      .prepare(`INSERT INTO "member" (id, "organizationId", "userId", role, "createdAt") VALUES (?, ?, ?, ?, ?)`)
      .bind(`m-${crypto.randomUUID()}`, orgId, user?.id, "owner", new Date().toISOString())
      .run();
    await db.prepare(`UPDATE "session" SET "activeOrganizationId" = ? WHERE "userId" = ?`).bind(orgId, user?.id).run();
    const hand = await get("/settings/domains/supported.example/connect", cookie);
    expect(hand.status).toBe(303);
    expect(hand.headers.get("location") ?? "").not.toContain("registrar.example");
    const stored = await db
      .prepare("SELECT state FROM org_domains WHERE domain = 'supported.example' AND org_id = ?")
      .bind(member.orgId)
      .first<{ state: string }>();
    expect(stored?.state).toBe("pending");
  });
});
