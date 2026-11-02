// The Impersonation monitor page (D05 T04 §5; SPEC M6): the findings list, the takedown pack
// downloads, dismiss and restore, each scoped to the signed-in organisation.
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { authEnv, call, signIn } from "../auth/helpers";
import { fakeJpeg } from "../fixtures/jpeg";
import { makeOrg } from "../trust/helpers";

const db = (env as unknown as Env).DB;
let n = 0;
const tag = () => `${++n}${crypto.randomUUID().slice(0, 6)}`;

const userId = async (email: string) =>
  (await db.prepare(`SELECT id FROM "user" WHERE lower(email) = ?`).bind(email).first<{ id: string }>())?.id;

async function person(orgId: string) {
  const email = `mon-${tag()}@demo.isitlegit.co.za`;
  const { cookie } = await signIn(email);
  vi.restoreAllMocks();
  const id = await userId(email);
  await db
    .prepare(`INSERT INTO "member" (id, "organizationId", "userId", role, "createdAt") VALUES (?, ?, ?, ?, ?)`)
    .bind(`m-${crypto.randomUUID()}`, orgId, id, "owner", new Date().toISOString())
    .run();
  await db.prepare(`UPDATE "session" SET "activeOrganizationId" = ? WHERE "userId" = ?`).bind(orgId, id).run();
  return { cookie, email };
}

async function finding(orgId: string, host: string, outcome = "confirmed") {
  await db
    .prepare(
      `INSERT INTO monitor_findings (org_id, host, status, first_seen, capture_key, case_id, outcome, evidence_refs, created_at, updated_at)
       VALUES (?, ?, 'new', '2026-11-02T03:04:00Z', ?, NULL, ?, '["E1"]', '2026-11-02T03:04:00Z', '2026-11-02T03:04:00Z')`,
    )
    .bind(orgId, host, `monitor/${host}/`, outcome)
    .run();
  await (env as unknown as Env).ARTEFACTS.put(`monitor/${host}/screenshot.jpg`, fakeJpeg(1280, 800, 30_000));
}

const get = (cookie: string | undefined, path: string) =>
  call(path, { headers: { accept: "text/html", ...(cookie ? { cookie } : {}) } }, authEnv);
const post = (cookie: string, path: string, fields: Record<string, string>) =>
  call(
    path,
    {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields).toString(),
    },
    authEnv,
  );

const RDAP_DOMAIN = {
  entities: [
    {
      roles: ["registrar"],
      vcardArray: [
        "vcard",
        [
          ["fn", {}, "text", "Example Registrar"],
          ["email", {}, "text", "abuse@registrar.example"],
        ],
      ],
    },
  ],
};
function stubRdap() {
  const real = globalThis.fetch;
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("data.iana.org")) return Response.json({ services: [[["example"], ["https://rdap.example/"]]] });
    if (url.includes("cloudflare-dns.com"))
      return Response.json({ Status: 0, Answer: [{ type: 1, data: "192.0.2.5" }] });
    if (url.includes("rdap.org")) return Response.json({ name: "EXAMPLE-NET", entities: [] });
    if (url.includes("rdap.example")) return Response.json(RDAP_DOMAIN);
    return real(input as never);
  });
}
afterEach(() => vi.restoreAllMocks());

describe("the monitor page", () => {
  it("lists only the member's organisation findings, with status, first seen and pack links", async () => {
    const mine = await makeOrg("Mine");
    const other = await makeOrg("Other");
    await finding(mine, "fake-one.example");
    await finding(other, "fake-two.example");
    const me = await person(mine);
    const res = await get(me.cookie, "/monitor");
    expect(res.status).toBe(200);
    const page = await res.text();
    expect(page).toContain("fake-one.example");
    expect(page).toContain("Confirmed fake site");
    expect(page).toContain("New, live");
    expect(page).toContain("Takedown pack (PDF)");
    expect(page).not.toContain("fake-two.example");
    // Anonymous: refused or sent to sign in, never the list.
    const anon = await get(undefined, "/monitor");
    expect(anon.status).not.toBe(200);
  });

  it("downloads both pack formats for an own finding and 404s another organisation's", async () => {
    const mine = await makeOrg("Mine");
    const other = await makeOrg("Other");
    await finding(mine, "fake-one.example");
    await finding(other, "fake-two.example");
    const me = await person(mine);
    stubRdap();
    const md = await get(me.cookie, "/monitor/pack/fake-one.example?format=md");
    expect(md.status).toBe(200);
    expect(md.headers.get("content-type")).toContain("text/markdown");
    expect(await md.text()).toContain("abuse@registrar.example");
    const pdf = await get(me.cookie, "/monitor/pack/fake-one.example?format=pdf");
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get("content-type")).toContain("application/pdf");
    expect(new Uint8Array(await pdf.arrayBuffer()).subarray(0, 5)).toEqual(new TextEncoder().encode("%PDF-"));
    expect((await get(me.cookie, "/monitor/pack/fake-two.example?format=md")).status).toBe(404);
  });

  it("dismisses with a reason, stays dismissed, and restores", async () => {
    const mine = await makeOrg("Mine");
    await finding(mine, "fake-one.example");
    const me = await person(mine);
    const bad = await post(me.cookie, "/monitor/dismiss", { host: "fake-one.example", reason: " " });
    expect(bad.status).toBe(400);
    const done = await post(me.cookie, "/monitor/dismiss", { host: "fake-one.example", reason: "Our old site" });
    expect(done.status).toBe(303);
    let page = await (await get(me.cookie, "/monitor")).text();
    expect(page).toContain("Dismissed");
    const restored = await post(me.cookie, "/monitor/restore", { host: "fake-one.example" });
    expect(restored.status).toBe(303);
    page = await (await get(me.cookie, "/monitor")).text();
    expect(page).toContain("Watching");
  });

  it("shows the empty state before any finding", async () => {
    const mine = await makeOrg("Mine");
    const me = await person(mine);
    const page = await (await get(me.cookie, "/monitor")).text();
    expect(page).toContain("No findings yet");
    expect(page).toContain("Not yet monitored");
  });
});
