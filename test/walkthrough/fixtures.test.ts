import { env } from "cloudflare:test";
import puppeteer from "@cloudflare/puppeteer";
import { beforeEach, describe, expect, it } from "vitest";
import brandFacts from "../../data/demo/fynbos-freight/brand.json";
import { createCase } from "../../src/db/cases";
import { collectSubmission, submissionKey } from "../../src/fixtures/collect";
import { FIXTURES_HOST, fixturesResponse } from "../../src/fixtures/redirects";
import type { Store } from "../../src/intake/store";
import { canaryFor } from "../../src/walkthrough/canary";
import { Driver } from "../../src/walkthrough/driver";
import { acceptance } from "../../src/walkthrough/evidence";

// D04 T02 §1: the fictional-brand fixture sites, on their own host under the prefix secret, and
// their collector, which records only a traced canary pair. Real D1 and KV, a stubbed nothing:
// the pages are the dispatcher's own served files, and the flow test drives them in a browser.
const db = (env as unknown as Env).DB;
const kv = (env as unknown as Env).CACHE;
const store: Store = { bucket: env.ARTEFACTS, db };
const PREFIX = "testprefix0123456789abcdef";
const deps = { db, kv };
const HOST = `https://${FIXTURES_HOST}`;

const get = (path: string, prefix: string | undefined = PREFIX, host = HOST) =>
  fixturesResponse(new Request(`${host}${path}`), prefix, deps);
const post = (path: string, fields: Record<string, string>, d = deps) =>
  fixturesResponse(new Request(`${HOST}${path}`, { method: "POST", body: new URLSearchParams(fields) }), PREFIX, d);

async function newCase(): Promise<string> {
  const made = await createCase(db, { orgId: "org-fix", channel: "email", headersAvailable: true });
  if (!made.ok) throw new Error(made.error.message);
  return made.value.id;
}

async function minted(caseId: string) {
  const issue = await canaryFor(db, caseId);
  if (!issue.ok) throw new Error(issue.reason);
  return issue;
}

beforeEach(async () => {
  await db.prepare("DELETE FROM canaries").run();
  await db.prepare("DELETE FROM cases WHERE org_id = 'org-fix'").run();
});

describe("the fictional-brand pages", () => {
  it("answers the lure, login and card pages under the prefix, labelled and noindexed", async () => {
    for (const [path, needle] of [
      ["/nimbusmail/", "View invoice"],
      ["/nimbusmail/login", "NimbusMail sign in"],
      ["/proteabank/", "Protea Bank"],
    ] as const) {
      const answer = await get(`/${PREFIX}${path}`);
      expect(answer?.status, path).toBe(200);
      expect(answer?.headers.get("x-robots-tag")).toBe("noindex, nofollow");
      const html = (await answer?.text()) ?? "";
      expect(html).toContain(needle);
      expect(html).toContain("Test fixture for IsItLegit, not a real service");
    }
    // The operator rule: the lure's facts come from brand.json, never retyped into assertions.
    const lure = (await (await get(`/${PREFIX}/nimbusmail/`))?.text()) ?? "";
    expect(lure).toContain(brandFacts.name);
  });

  it("404s the same pages without the prefix, and is not the app on another host", async () => {
    expect((await get("/nimbusmail/"))?.status).toBe(404);
    expect((await get(`/${PREFIX}/nimbusmail/`, "short"))?.status).toBe(404);
    expect((await fixturesResponse(new Request(`${HOST}/${PREFIX}/nimbusmail/login`), undefined, deps))?.status).toBe(
      404,
    );
    expect(await get(`/${PREFIX}/nimbusmail/`, PREFIX, "https://app.isitlegit.co.za")).toBeNull();
  });

  it("keeps the redirect chains that were already there", async () => {
    const answer = await get(`/${PREFIX}/chain/1`);
    expect(answer?.status).toBe(302);
    expect(answer?.headers.get("location")).toBe(`/${PREFIX}/chain/2`);
  });
});

describe("the collector", () => {
  it("stores only the canary fields of a traced submission, under its case", async () => {
    const caseId = await newCase();
    const canary = await minted(caseId);
    const answer = await post(`/${PREFIX}/collect`, {
      fixture: "nimbusmail",
      email: canary.username,
      password: canary.password,
      note: "a real-looking secret that must never be stored",
    });
    expect(answer?.status).toBe(200);
    const accepted = (await answer?.text()) ?? "";
    expect(accepted).toContain("signed in");
    expect(accepted).not.toContain('type="password"');
    const stored = await kv.get(submissionKey(caseId), "json");
    expect(stored).toMatchObject({
      fields: [
        { name: "email", value: canary.username },
        { name: "password", value: canary.password },
      ],
    });
    expect(JSON.stringify(stored)).not.toContain("real-looking secret");
  });

  it("finds the pair in the card form's fields and keeps only those", async () => {
    const caseId = await newCase();
    const canary = await minted(caseId);
    const answer = await post(`/${PREFIX}/collect`, {
      fixture: "proteabank",
      card_number: canary.username,
      expiry: "12/99",
      cvv: canary.password,
    });
    expect(answer?.status).toBe(200);
    const stored = await kv.get(submissionKey(caseId), "json");
    expect(stored).toMatchObject({
      fields: [
        { name: "card_number", value: canary.username },
        { name: "cvv", value: canary.password },
      ],
    });
  });

  it("refuses a non-canary submission and stores nothing", async () => {
    const caseId = await newCase();
    await canaryFor(db, caseId);
    const answer = await post(`/${PREFIX}/collect`, { email: "victim@example.org", password: "hunter2" });
    expect(answer?.status).toBe(403);
    expect((await answer?.text()) ?? "").toContain("Incorrect");
    expect(await kv.get(submissionKey(caseId))).toBeNull();
  });

  it("refuses a wrong password and a password from another case, storing nothing", async () => {
    const first = await newCase();
    const second = await newCase();
    const mine = await minted(first);
    const theirs = await minted(second);
    // A canary-shaped password that was never issued, and the other case's real one.
    for (const password of ["IsItLegit-Canary-zzzzzzzzzzzz", theirs.password]) {
      const answer = await post(`/${PREFIX}/collect`, { email: mine.username, password });
      expect(answer?.status).toBe(403);
    }
    expect(await kv.get(submissionKey(first))).toBeNull();
  });

  it("answers malformed and failing work without the accepted page and without storing", async () => {
    const caseId = await newCase();
    const canary = await minted(caseId);
    const malformed = await fixturesResponse(
      new Request(`${HOST}/${PREFIX}/collect`, {
        method: "POST",
        body: "this is not a form",
        headers: { "content-type": "text/plain" },
      }),
      PREFIX,
      deps,
    );
    expect(malformed?.status).toBe(400);
    const fields = { email: canary.username, password: canary.password };
    const kvDown = await post(`/${PREFIX}/collect`, fields, {
      db,
      kv: {
        get: async () => null,
        put: async () => {
          throw new Error("kv down");
        },
      } as unknown as KVNamespace,
    });
    expect(kvDown?.status).toBe(500);
    expect((await kvDown?.text()) ?? "").not.toContain("signed in");
    const dbDown = await collectSubmission(
      new Request(`${HOST}/${PREFIX}/collect`, { method: "POST", body: new URLSearchParams(fields) }),
      {
        db: {
          prepare: () => {
            throw new Error("d1 down");
          },
        } as unknown as D1Database,
        kv,
      },
    );
    expect(dbDown.status).toBe(500);
    expect(await kv.get(submissionKey(caseId))).toBeNull();
  });
});

describe("the flow in a browser", () => {
  it("drives the served lure to a stored, accepted canary submission", async () => {
    const caseId = await newCase();
    const canary = await minted(caseId);
    const served = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const answer = await fixturesResponse(new Request(input, init), PREFIX, deps);
      return answer ?? new Response("Not found", { status: 404 });
    }) as typeof fetch;
    const driver = await Driver.open(await puppeteer.launch(env.BROWSER), {
      caseId,
      walkId: "fixtures-flow",
      canary,
      startUrl: `${HOST}/${PREFIX}/nimbusmail/`,
      store,
      fetch: served,
      resolve: async () => ["93.184.215.14"],
    });
    try {
      // The lure's View invoice button, then the login page's fields (fixtures/*.html geometry).
      expect((await driver.execute({ tool: "click", x: 100, y: 30 })).outcome).toBe("done");
      expect((await driver.execute({ tool: "click", x: 100, y: 115 })).outcome).toBe("done");
      expect((await driver.execute({ tool: "type", text: canary.username })).outcome).toBe("done");
      expect((await driver.execute({ tool: "click", x: 100, y: 175 })).outcome).toBe("done");
      expect((await driver.execute({ tool: "type", text: canary.password })).outcome).toBe("done");
      expect((await driver.execute({ tool: "click", x: 60, y: 236 })).outcome).toBe("done");
      const record = driver.trace();
      const submission = record.submissions[0];
      expect(submission).toMatchObject({ state: "delivered", status: 200 });
      expect(acceptance(record, submission as NonNullable<typeof submission>)).toBe("accepted");
      const stored = await kv.get(submissionKey(caseId), "json");
      expect(stored).toMatchObject({
        fields: [
          { name: "email", value: canary.username },
          { name: "password", value: canary.password },
        ],
      });
    } finally {
      await driver.close();
    }
  }, 300_000);
});
