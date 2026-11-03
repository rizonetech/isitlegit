// Monitor seeds (D05 T04 §6): demo-only candidate seeds, provisioned with read-back, never
// read for an ordinary organisation, and captured at their page path by the daily run.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import brandFacts from "../../data/demo/fynbos-freight/brand.json";
import { createCase } from "../../src/db/cases";
import { readSubmissions } from "../../src/fixtures/collect";
import { FIXTURES_HOST, fixturesResponse } from "../../src/fixtures/redirects";
import { alertNewFindings, findingsFromInvestigations } from "../../src/monitor/findings";
import type { MonitorDeps } from "../../src/monitor/run";
import { monitorOrg } from "../../src/monitor/run";
import { addSeed, isDemoOrg, removeSeed, revokeDemoFlag, seedsFor } from "../../src/monitor/seeds";
import { browserCapture, monitorDeps } from "../../src/monitor/workflow";
import { setIdentity } from "../../src/trust/identity";
import { canaryFor } from "../../src/walkthrough/canary";
import { makeOrg, protectableOrg } from "../trust/helpers";
import { business, db } from "./world";

async function demoOrg(demo: unknown) {
  const orgId = await makeOrg("Seed Org");
  await db
    .prepare(`UPDATE "organization" SET metadata = ? WHERE id = ?`)
    .bind(JSON.stringify(demo === undefined ? {} : { demo, custom: "kept" }), orgId)
    .run();
  return orgId;
}

describe("monitor seeds", () => {
  it("reads seeds only for an organisation flagged demo === true, validates targets, isolates tenants, and revokes the flag without deleting the organisation", async () => {
    const demo = await demoOrg(true);
    const otherDemo = await demoOrg(true);
    const ordinary = await demoOrg(false);
    const malformed = await demoOrg("yes");

    // Validation rejects malformed hosts and paths.
    expect(await addSeed(db, demo, { host: "https://fixtures.isitlegit.co.za", path: "fynbos-lookalike/" })).toBe(
      false,
    );
    expect(await addSeed(db, demo, { host: "fixtures.isitlegit.co.za", path: "../secret" })).toBe(false);
    expect(await addSeed(db, demo, { host: "fixtures.isitlegit.co.za", path: "" })).toBe(false);
    expect(await addSeed(db, demo, { host: "localhost", path: "fynbos-lookalike/" })).toBe(false);

    expect(await addSeed(db, demo, { host: "FIXTURES.ISITLEGIT.CO.ZA", path: "/fynbos-lookalike/" })).toBe(true);
    expect(await isDemoOrg(db, demo)).toBe(true);
    expect(await isDemoOrg(db, ordinary)).toBe(false);
    expect(await isDemoOrg(db, malformed)).toBe(false);
    expect(await seedsFor(db, demo)).toEqual([{ host: "fixtures.isitlegit.co.za", path: "fynbos-lookalike/" }]);
    // Cross-organisation isolation: another demo organisation does not see `demo`'s seeds.
    expect(await seedsFor(db, otherDemo)).toEqual([]);

    // Provisioning the same seed for an ordinary organisation stores a row nobody reads.
    await addSeed(db, ordinary, { host: "fixtures.isitlegit.co.za", path: "fynbos-lookalike/" });
    expect(await seedsFor(db, ordinary)).toEqual([]);

    // Revoking the demo flag disables seeds without deleting the organisation row or other metadata keys.
    expect(await revokeDemoFlag(db, demo)).toBe(true);
    expect(await isDemoOrg(db, demo)).toBe(false);
    expect(await seedsFor(db, demo)).toEqual([]);
    const orgStillExists = await db
      .prepare(`SELECT id, metadata FROM "organization" WHERE id = ?`)
      .bind(demo)
      .first<{ id: string; metadata: string }>();
    expect(orgStillExists?.id).toBe(demo);
    expect(JSON.parse(orgStillExists?.metadata ?? "{}")).toEqual({ demo: false, custom: "kept" });

    // Restore demo flag, then remove the seed explicitly.
    await db
      .prepare(`UPDATE "organization" SET metadata = ? WHERE id = ?`)
      .bind(JSON.stringify({ demo: true }), demo)
      .run();
    expect(await seedsFor(db, demo)).toEqual([{ host: "fixtures.isitlegit.co.za", path: "fynbos-lookalike/" }]);
    expect(await removeSeed(db, demo, "fixtures.isitlegit.co.za")).toBe(true);
    expect(await seedsFor(db, demo)).toEqual([]);
  });

  it("captures a seeded host at its page path in the daily run, stays pinned past the rotating 300-host cap, and never runs for ordinary or revoked-demo organisations even when persisted", async () => {
    const { orgId } = await business();
    await db
      .prepare(`UPDATE "organization" SET metadata = ? WHERE id = ?`)
      .bind(JSON.stringify({ demo: true }), orgId)
      .run();
    await addSeed(db, orgId, { host: "fixtures.isitlegit.co.za", path: "fynbos-lookalike/" });
    const captured: string[] = [];
    const screened: string[] = [];
    // Give 320 CT names on a day whose rotation offset is non-zero (2026-11-04 -> dayIndex 20762),
    // proving the seed stays pinned at the front of `candidates` and `choose()`.
    const manyCt = Array.from({ length: 320 }, (_, i) => `fynbos-ct-${String(i).padStart(3, "0")}.example`);
    const makeDeps = (nowIso: string) =>
      ({
        db,
        bucket: env.ARTEFACTS,
        store: env.ARTEFACTS,
        kv: (env as unknown as { CACHE: KVNamespace }).CACHE,
        now: () => new Date(nowIso),
        ct: async () => ({ names: manyCt, failed: [] }),
        resolve: async (host: string) =>
          host === "fixtures.isitlegit.co.za" || host.startsWith("fynbos-ct-0")
            ? { status: "resolves" as const, answers: ["192.0.2.1"] }
            : { status: "none" as const },
        capture: async (host: string) => {
          captured.push(`root:${host}`);
          return {
            screenshot: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
            text: `Page at ${host}`,
            url: `https://${host}/`,
            signals: null,
            parkText: null,
          };
        },
        captureSeed: async (host: string, path: string) => {
          captured.push(`seed:${host}/${path}`);
          return {
            screenshot: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
            text: "Fynbos Freight sign in",
            url: `https://${host}/secret-prefix/${path}`,
            signals: { links: 1, inputs: 2, passwords: 1, forms: 1, frames: 0 },
            parkText: "Fynbos Freight sign in",
          };
        },
        screen: async (page: { host?: string }) => {
          screened.push(page.host ?? "");
          return {
            ok: true as const,
            tier: "glimmer" as const,
            glimmer_reason: "ok" as const,
            spark_calls: [],
            screen: {
              screener: "glimmer" as const,
              brand: "Fynbos Freight",
              has_login_form: true,
              has_payment_form: false,
              lure: true,
              lure_type: "credential" as const,
              confidence: 0.96,
            },
          };
        },
        open: async () => ({ state: "warm", reservedUntil: 0, burst: { id: "b", wakeAt: 0, deadline: 0 } }) as never,
        close: async () => ({ ok: true }) as never,
        settle: async () => ({ ok: true }) as never,
        heldSince: async () => null,
      }) as unknown as MonitorDeps;

    await monitorOrg(makeDeps("2026-11-04T02:00:00.000Z"), orgId, `monitor-${orgId}-seed-1`);
    expect(captured[0]).toBe("seed:fixtures.isitlegit.co.za/fynbos-lookalike/");
    expect(screened).toContain("fixtures.isitlegit.co.za");
    const hostRow = await db
      .prepare("SELECT capture_url FROM monitor_hosts WHERE org_id = ? AND domain = 'fixtures.isitlegit.co.za'")
      .bind(orgId)
      .first<{ capture_url: string }>();
    expect(hostRow?.capture_url).toBe("https://fixtures.isitlegit.co.za/secret-prefix/fynbos-lookalike/");

    // Now revoke the demo flag and leave an unscreened capture row for fixtures.isitlegit.co.za in monitor_hosts:
    // the next run must neither resolve, capture, nor screen the persisted seed host.
    await revokeDemoFlag(db, orgId);
    await db
      .prepare("DELETE FROM monitor_screens WHERE org_id = ? AND domain = 'fixtures.isitlegit.co.za'")
      .bind(orgId)
      .run();
    captured.length = 0;
    screened.length = 0;
    await monitorOrg(makeDeps("2026-11-05T02:00:00.000Z"), orgId, `monitor-${orgId}-seed-2`);
    expect(captured.some((c) => c.includes("fixtures.isitlegit.co.za"))).toBe(false);
    expect(screened).not.toContain("fixtures.isitlegit.co.za");
  });

  it("applies FIXTURES_PREFIX in monitorDeps.captureSeed and preserves the final URL in browserCapture", async () => {
    const visited: string[] = [];
    const fakeLaunch = async () =>
      ({
        newPage: async () => ({
          target: () => ({
            createCDPSession: async () => ({
              send: async (method: string) => {
                if (method === "DOM.getDocument") return { root: { nodeId: 1, nodeName: "HTML", children: [] } };
                if (method === "Accessibility.getFullAXTree") return { nodes: [] };
                return {};
              },
            }),
          }),
          goto: async (url: string) => {
            visited.push(url);
            return { status: () => 200 };
          },
          screenshot: async () => new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
          evaluate: async () => "Fynbos Freight sign in",
          url: () => visited.at(-1) ?? "",
        }),
        close: async () => {},
      }) as never;

    const direct = await browserCapture(
      {} as never,
      "fixtures.isitlegit.co.za",
      fakeLaunch,
      "pfx123/fynbos-lookalike/",
    );
    expect(direct.url).toBe("https://fixtures.isitlegit.co.za/pfx123/fynbos-lookalike/");
    expect(direct.text).toBe("Fynbos Freight sign in");

    const deps = monitorDeps(
      {
        DB: db,
        ARTEFACTS: env.ARTEFACTS,
        FIXTURES_PREFIX: "/secret-prefix-abc/",
      } as unknown as Env,
      "run-1",
    );
    expect(typeof deps.captureSeed).toBe("function");
  });

  it("routes demo subdomain alerts to alerts@demo.isitlegit.co.za, skips unconfirmed findings, records refusals/failures, and deduplicates repeat runs", async () => {
    const orgId = await protectableOrg(
      "fynbosfreight.demo.isitlegit.co.za",
      "accounts@fynbosfreight.demo.isitlegit.co.za",
      "Fynbos Freight",
    );
    await setIdentity(db, orgId, "owner", {
      displayNames: ["Fynbos Freight"],
      financeContact: "accounts@fynbosfreight.demo.isitlegit.co.za",
      protected: true,
    });
    await db
      .prepare(`UPDATE "organization" SET metadata = ? WHERE id = ?`)
      .bind(JSON.stringify({ demo: true }), orgId)
      .run();

    // 1. An unconfirmed investigation creates a finding but sends no alert.
    await db
      .prepare(
        `INSERT INTO monitor_hosts (org_id, domain, resolves, first_seen, last_seen)
         VALUES (?, 'unconfirmed.example', 1, '2026-11-03T01:00:00Z', '2026-11-03T01:00:00Z')`,
      )
      .bind(orgId)
      .run();
    await db
      .prepare(
        `INSERT INTO monitor_investigations (org_id, domain, capture_key, case_id, state, created_at, updated_at)
         VALUES (?, 'unconfirmed.example', 'monitor/u/1/', 'case-u', 'unconfirmed', '2026-11-03T01:00:00Z', '2026-11-03T01:01:00Z')`,
      )
      .bind(orgId)
      .run();
    const sentRequests: { to?: string[]; subject?: string }[] = [];
    const okFetcher: typeof fetch = async (_input, init) => {
      sentRequests.push(JSON.parse(String(init?.body ?? "{}")) as { to?: string[]; subject?: string });
      return Response.json({ data: { succeeded: 1, failed: 0, email_id: "smtp-demo-1" } });
    };
    const firstPass = await findingsFromInvestigations(
      db,
      orgId,
      { mail: { db, apiKey: "k", fetch: okFetcher }, appUrl: "https://app.isitlegit.co.za" },
      () => new Date("2026-11-03T01:02:00Z"),
    );
    expect(firstPass.created).toBe(1);
    expect(firstPass.alerted).toBe(0);
    expect(sentRequests).toHaveLength(0);

    // 2. A confirmed investigation on the fixture host fails delivery first (400 -> alert_state = 'failed'),
    // then succeeds on retry, routing to alerts@demo.isitlegit.co.za, and sends nothing on a repeat run.
    await db
      .prepare(
        `INSERT INTO monitor_hosts (org_id, domain, resolves, first_seen, last_seen)
         VALUES (?, 'fixtures.isitlegit.co.za', 1, '2026-11-03T01:00:00Z', '2026-11-03T01:00:00Z')`,
      )
      .bind(orgId)
      .run();
    await db
      .prepare(
        `INSERT INTO monitor_investigations (org_id, domain, capture_key, case_id, state, created_at, updated_at)
         VALUES (?, 'fixtures.isitlegit.co.za', 'monitor/f/1/', 'case-f', 'confirmed', '2026-11-03T01:00:00Z', '2026-11-03T01:03:00Z')`,
      )
      .bind(orgId)
      .run();
    const failFetcher: typeof fetch = async () => Response.json({ data: { error_code: "E_BAD" } }, { status: 400 });
    const failedPass = await findingsFromInvestigations(
      db,
      orgId,
      {
        mail: { db, apiKey: "k", fetch: failFetcher, pause: async () => {} },
        appUrl: "https://app.isitlegit.co.za",
      },
      () => new Date("2026-11-03T01:04:00Z"),
    );
    expect(failedPass.alerted).toBe(0);
    const afterFail = await db
      .prepare(
        "SELECT alert_state, alerted_at FROM monitor_findings WHERE org_id = ? AND host = 'fixtures.isitlegit.co.za'",
      )
      .bind(orgId)
      .first<{ alert_state: string; alerted_at: string | null }>();
    expect(afterFail).toEqual({ alert_state: "failed", alerted_at: null });

    const retryPass = await alertNewFindings(
      db,
      orgId,
      { mail: { db, apiKey: "k", fetch: okFetcher }, appUrl: "https://app.isitlegit.co.za" },
      () => new Date("2026-11-03T01:05:00Z"),
    );
    expect(retryPass).toBe(1);
    expect(sentRequests).toHaveLength(1);
    expect(sentRequests[0]?.to).toEqual(["alerts@demo.isitlegit.co.za"]);
    expect(sentRequests[0]?.subject).toBe("Impersonation found: fixtures.isitlegit.co.za");

    const repeatPass = await alertNewFindings(
      db,
      orgId,
      { mail: { db, apiKey: "k", fetch: okFetcher }, appUrl: "https://app.isitlegit.co.za" },
      () => new Date("2026-11-03T01:06:00Z"),
    );
    expect(repeatPass).toBe(0);
    expect(sentRequests).toHaveLength(1);
  });

  it("serves the fynbos-lookalike fixture with brand.json facts, protea SVG mark, noindex, slash-less redirect, and canary collector storage", async () => {
    const kv = (env as unknown as { CACHE: KVNamespace }).CACHE;
    const prefix = "testprefix0123456789abcdef";
    const host = `https://${FIXTURES_HOST}`;

    const redir = await fixturesResponse(new Request(`${host}/${prefix}/fynbos-lookalike`), prefix, { db, kv });
    expect(redir?.status).toBe(301);
    expect(redir?.headers.get("location")).toBe(`/${prefix}/fynbos-lookalike/`);

    const page = await fixturesResponse(new Request(`${host}/${prefix}/fynbos-lookalike/`), prefix, { db, kv });
    expect(page?.status).toBe(200);
    expect(page?.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    const html = (await page?.text()) ?? "";
    expect(html).toContain("Test fixture for IsItLegit, not a real service");
    expect(html).toContain(brandFacts.name);
    expect(html).toContain(brandFacts.legal_name);
    expect(html).toContain(brandFacts.tagline);
    expect(html).toContain(brandFacts.registration_number);
    expect(html).toContain(brandFacts.address.street);
    expect(html).toContain(brandFacts.address.city);
    expect(html).toContain(brandFacts.address.postcode);
    expect(html).toContain(brandFacts.mailboxes.accounts);
    expect(html).toContain('aria-label="Fynbos Freight: a king protea in bloom"');

    const orgId = await makeOrg("Canary Org");
    const made = await createCase(db, { orgId, channel: "email", headersAvailable: true });
    if (!made.ok) throw new Error(made.error.message);
    const caseId = made.value.id;
    const canary = await canaryFor(db, caseId);
    if (!canary.ok) throw new Error(canary.reason);

    const refused = await fixturesResponse(
      new Request(`${host}/${prefix}/collect`, {
        method: "POST",
        body: new URLSearchParams({ fixture: "fynbos-lookalike", email: "victim@example.org", password: "hunter2" }),
        headers: { "cf-connecting-ip": "192.0.2.91" },
      }),
      prefix,
      { db, kv },
    );
    expect(refused?.status).toBe(403);
    const refusedHtml = (await refused?.text()) ?? "";
    expect(refusedHtml).toContain("Incorrect details");
    expect(refusedHtml).toContain('value="fynbos-lookalike"');
    expect(await readSubmissions(kv, caseId)).toEqual([]);

    const accepted = await fixturesResponse(
      new Request(`${host}/${prefix}/collect`, {
        method: "POST",
        body: new URLSearchParams({
          fixture: "fynbos-lookalike",
          email: canary.username,
          password: canary.password,
          secret_extra: "never-stored",
        }),
        headers: { "cf-connecting-ip": "192.0.2.92" },
      }),
      prefix,
      { db, kv },
    );
    expect(accepted?.status).toBe(200);
    const stored = await readSubmissions(kv, caseId);
    expect(stored).toMatchObject([
      {
        fixture: "fynbos-lookalike",
        fields: [
          { name: "email", value: canary.username },
          { name: "password", value: canary.password },
        ],
      },
    ]);
    expect(JSON.stringify(stored)).not.toContain("never-stored");
  });
});
