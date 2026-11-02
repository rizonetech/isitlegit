import { env } from "cloudflare:test";
import puppeteer from "@cloudflare/puppeteer";
import { beforeEach, describe, expect, it } from "vitest";
import brandFacts from "../../data/demo/fynbos-freight/brand.json";
import { bundled } from "../../src/checks/brands";
import { createCase } from "../../src/db/cases";
import { collectSubmission, readSubmissions } from "../../src/fixtures/collect";
import { FIXTURES_HOST, fixturesResponse } from "../../src/fixtures/redirects";
import type { Store } from "../../src/intake/store";
import { canaryFor } from "../../src/walkthrough/canary";
import { Driver } from "../../src/walkthrough/driver";
import { acceptance, walkthroughEvidence } from "../../src/walkthrough/evidence";

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
let sourceSeq = 0;
let source = "192.0.2.1";
const post = (path: string, fields: Record<string, string>, d = deps) =>
  fixturesResponse(
    new Request(`${HOST}${path}`, {
      method: "POST",
      body: new URLSearchParams(fields),
      headers: { "cf-connecting-ip": source },
    }),
    PREFIX,
    d,
  );

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
  // The collector's rate counter is per-isolate state: give each test its own source.
  sourceSeq += 1;
  source = `192.0.2.${sourceSeq}`;
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

  it("canonicalises the slash-less page addresses so their relative targets resolve (G1)", async () => {
    for (const brand of ["nimbusmail", "proteabank"]) {
      const answer = await get(`/${PREFIX}/${brand}`);
      expect(answer?.status, brand).toBe(301);
      expect(answer?.headers.get("location")).toBe(`/${PREFIX}/${brand}/`);
    }
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
    const stored = await readSubmissions(kv, caseId);
    expect(stored).toMatchObject([
      {
        fixture: "nimbusmail",
        fields: [
          { name: "email", value: canary.username },
          { name: "password", value: canary.password },
        ],
      },
    ]);
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
    const stored = await readSubmissions(kv, caseId);
    expect(stored).toMatchObject([
      {
        fixture: "proteabank",
        fields: [
          { name: "card_number", value: canary.username },
          { name: "cvv", value: canary.password },
        ],
      },
    ]);
  });

  it("refuses a non-canary submission and stores nothing", async () => {
    const caseId = await newCase();
    await canaryFor(db, caseId);
    const answer = await post(`/${PREFIX}/collect`, { email: "victim@example.org", password: "hunter2" });
    expect(answer?.status).toBe(403);
    expect((await answer?.text()) ?? "").toContain("Incorrect");
    expect(await readSubmissions(kv, caseId)).toEqual([]);
  });

  it("refuses a wrong password and a password from another case, storing nothing", async () => {
    const first = await newCase();
    const second = await newCase();
    const mine = await minted(first);
    const theirs = await minted(second);
    // A canary-shaped password that was never issued, and the other case's real one.
    for (const password of ["IsItLegit-Canary-ZZZZZZZZZZZZZZZZZZZZ", theirs.password]) {
      const answer = await post(`/${PREFIX}/collect`, { email: mine.username, password });
      expect(answer?.status).toBe(403);
    }
    expect(await readSubmissions(kv, first)).toEqual([]);
  });

  it("never stores private text carried in a field name (G2)", async () => {
    const caseId = await newCase();
    const canary = await minted(caseId);
    const answer = await post(`/${PREFIX}/collect`, {
      email: canary.username,
      password: canary.password,
      "private-note-from-a-stranger": canary.username,
    });
    expect(answer?.status).toBe(200);
    const stored = JSON.stringify(await readSubmissions(kv, caseId));
    expect(stored).not.toContain("private-note-from-a-stranger");
  });

  it("bounds a submission before database work: size, field count and rate (G3)", async () => {
    const caseId = await newCase();
    const canary = await minted(caseId);
    const big = await fixturesResponse(
      new Request(`${HOST}/${PREFIX}/collect`, {
        method: "POST",
        body: new URLSearchParams({ email: canary.username, password: canary.password, pad: "x".repeat(20_000) }),
      }),
      PREFIX,
      deps,
    );
    expect(big?.status).toBe(413);
    const many: Record<string, string> = { email: canary.username, password: canary.password };
    for (let i = 0; i < 25; i += 1) many[`f${i}`] = "x";
    expect((await post(`/${PREFIX}/collect`, many))?.status).toBe(413);
    expect(await readSubmissions(kv, caseId)).toEqual([]);
    // Thirty ordinary refusals from one source are answered; the next is rate-limited first.
    let limited: Response | null = null;
    for (let i = 0; i < 31; i += 1)
      limited = await post(`/${PREFIX}/collect`, { email: "victim@example.org", password: "hunter2" }, deps);
    expect(limited?.status).toBe(429);
  });

  it("keeps both journeys' attempts readable and gives the card journey its own answers (G5, G9)", async () => {
    const caseId = await newCase();
    const canary = await minted(caseId);
    const refused = await post(`/${PREFIX}/collect`, {
      fixture: "proteabank",
      card_number: "not-a-canary",
      cvv: "123",
    });
    expect(refused?.status).toBe(403);
    expect((await refused?.text()) ?? "").toContain("Card not confirmed");
    const card = await post(`/${PREFIX}/collect`, {
      fixture: "proteabank",
      card_number: canary.username,
      cvv: canary.password,
    });
    expect((await card?.text()) ?? "").toContain("Card confirmed");
    await post(`/${PREFIX}/collect`, { fixture: "nimbusmail", email: canary.username, password: canary.password });
    const stored = await readSubmissions(kv, caseId);
    expect(stored).toHaveLength(2);
  });

  it("refuses an unknown canary-shaped username and a GET on the collector (G7)", async () => {
    const answer = await post(`/${PREFIX}/collect`, {
      email: "canary-zzzzzzzzzzzz@canary.isitlegit.co.za",
      password: "IsItLegit-Canary-ZZZZZZZZZZZZZZZZZZZZ",
    });
    expect(answer?.status).toBe(403);
    const getAnswer = await get(`/${PREFIX}/collect`);
    expect(getAnswer?.status).toBe(405);
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
        // The rate counter still answers; only the submission write fails.
        get: async () => null,
        put: async (key: string) => {
          if (key.startsWith("fixtures:submissions:")) throw new Error("kv down");
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
    expect(await readSubmissions(kv, caseId)).toEqual([]);
  });
});

// One login walk against the served pages, for the readings below (D04 T02 §8).
async function walkLogin(pair: { username: string; password: string }, d = deps) {
  const caseId = await newCase();
  const served = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const answer = await fixturesResponse(new Request(input, init), PREFIX, d);
    return answer ?? new Response("Not found", { status: 404 });
  }) as typeof fetch;
  const driver = await Driver.open(await puppeteer.launch(env.BROWSER), {
    caseId,
    walkId: "fixtures-reading",
    canary: pair,
    startUrl: `${HOST}/${PREFIX}/nimbusmail/`,
    store,
    fetch: served,
    resolve: async () => ["93.184.215.14"],
  });
  try {
    await driver.execute({ tool: "click", x: 100, y: 30 });
    await driver.execute({ tool: "click", x: 100, y: 115 });
    await driver.execute({ tool: "type", text: pair.username });
    await driver.execute({ tool: "click", x: 100, y: 175 });
    await driver.execute({ tool: "type", text: pair.password });
    await driver.execute({ tool: "click", x: 60, y: 236 });
    return { caseId, record: driver.trace() };
  } finally {
    await driver.close();
  }
}

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
      const stored = await readSubmissions(kv, caseId);
      expect(stored).toMatchObject([
        {
          fields: [
            { name: "email", value: canary.username },
            { name: "password", value: canary.password },
          ],
        },
      ]);
    } finally {
      await driver.close();
    }
  }, 300_000);

  it("drives the served card form to a stored, accepted submission (G4)", async () => {
    const caseId = await newCase();
    const canary = await minted(caseId);
    const served = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const answer = await fixturesResponse(new Request(input, init), PREFIX, deps);
      return answer ?? new Response("Not found", { status: 404 });
    }) as typeof fetch;
    const driver = await Driver.open(await puppeteer.launch(env.BROWSER), {
      caseId,
      walkId: "fixtures-card",
      canary,
      startUrl: `${HOST}/${PREFIX}/proteabank/`,
      store,
      fetch: served,
      resolve: async () => ["93.184.215.14"],
    });
    try {
      // The card page's fields (fixtures/proteabank/index.html geometry): the canary username
      // goes in the card field and the canary password in the CVV field, as the driver types.
      expect((await driver.execute({ tool: "click", x: 100, y: 115 })).outcome).toBe("done");
      expect((await driver.execute({ tool: "type", text: canary.username })).outcome).toBe("done");
      // The driver types canary values only, so the expiry field stays empty, as it would when
      // the model has no canary for it; the form carries no required fields.
      expect((await driver.execute({ tool: "click", x: 100, y: 235 })).outcome).toBe("done");
      expect((await driver.execute({ tool: "type", text: canary.password })).outcome).toBe("done");
      expect((await driver.execute({ tool: "click", x: 60, y: 296 })).outcome).toBe("done");
      const record = driver.trace();
      const submission = record.submissions[0];
      expect(submission).toMatchObject({ state: "delivered", status: 200 });
      expect(acceptance(record, submission as NonNullable<typeof submission>)).toBe("accepted");
      const stored = await readSubmissions(kv, caseId);
      expect(stored).toMatchObject([
        {
          fixture: "proteabank",
          fields: [
            { name: "card_number", value: canary.username },
            { name: "cvv", value: canary.password },
          ],
        },
      ]);
    } finally {
      await driver.close();
    }
  }, 300_000);

  it("reads a refused pair as rejected and collector failures as unknown (D04 T02 §8)", async () => {
    const issuedCase = await newCase();
    const issued = await minted(issuedCase);
    // A format-valid pair that was never issued together: the collector refuses it (403).
    const refused = await walkLogin({ username: issued.username, password: "IsItLegit-Canary-ZZZZZZZZZZZZZZZZZZZZ" });
    const refusedSubmission = refused.record.submissions[0];
    if (!refusedSubmission) throw new Error("no submission");
    expect(refusedSubmission.status).toBe(403);
    expect(acceptance(refused.record, refusedSubmission)).toBe("rejected");

    // The collector's store fails (500): a backend failure, not a refusal.
    const kvDown = {
      db,
      kv: {
        get: async () => null,
        put: async (key: string) => {
          if (key.startsWith("fixtures:submissions:")) throw new Error("kv down");
        },
      } as unknown as KVNamespace,
    };
    const caseForPair = await newCase();
    const pair = await minted(caseForPair);
    const failed = await walkLogin(pair, kvDown);
    const failedSubmission = failed.record.submissions[0];
    if (!failedSubmission) throw new Error("no submission");
    expect(failedSubmission.status).toBe(500);
    expect(acceptance(failed.record, failedSubmission)).toBe("unknown");

    // The collector is rate-limited (429) before it ever sees the credentials.
    for (let i = 0; i < 30; i += 1)
      await fixturesResponse(
        new Request(`${HOST}/${PREFIX}/collect`, {
          method: "POST",
          body: new URLSearchParams({ email: "victim@example.org", password: "hunter2" }),
        }),
        PREFIX,
        deps,
      );
    const limitedCase = await newCase();
    const limitedPair = await minted(limitedCase);
    const limited = await walkLogin(limitedPair);
    const limitedSubmission = limited.record.submissions[0];
    if (!limitedSubmission) throw new Error("no submission");
    expect(limitedSubmission.status).toBe(429);
    expect(acceptance(limited.record, limitedSubmission)).toBe("unknown");
    const items = walkthroughEvidence(
      { startUrl: `${HOST}/${PREFIX}/nimbusmail/`, outcome: "finished", record: limited.record },
      null,
      null,
      bundled,
    );
    expect(items.map((e) => e.check)).not.toContain("walkthrough.canary_accepted");
  }, 300_000);
});
