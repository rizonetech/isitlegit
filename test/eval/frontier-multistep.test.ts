// No-spend fixture proof on the actual contained driver, not a Wonder result.
import { env } from "cloudflare:workers";
import puppeteer from "@cloudflare/puppeteer";
import { expect, it } from "vitest";
import index from "../../fixtures/nimbusmail-multistep/index.html";
import login from "../../fixtures/nimbusmail-multistep/login.html";
import lure from "../../fixtures/nimbusmail-multistep/lure.html";
import submitted from "../../fixtures/nimbusmail-multistep/submitted.html";
import { ulid } from "../../src/db/ulid";
import { canaryFor } from "../../src/walkthrough/canary";
import { Driver, LIMITS } from "../../src/walkthrough/driver";

it("reaches the credential page through actual driver actions with no provider transport", {
  timeout: 60000,
}, async () => {
  const browser = await puppeteer.launch(env.BROWSER);
  let driver: Driver | undefined;
  try {
    const caseId = ulid(),
      at = new Date().toISOString();
    await env.DB.prepare(
      "INSERT INTO cases(id,org_id,channel,created_at,updated_at) VALUES(?,'org-frontier','email',?,?)",
    )
      .bind(caseId, at, at)
      .run();
    const canary = await canaryFor(env.DB, caseId);
    if (!canary.ok) throw new Error("canary unavailable");
    const pages: Record<string, string> = {
      "/multistep/": index,
      "/multistep/lure": lure,
      "/multistep/login": login,
      "/multistep/submitted": submitted,
    };
    const requests: string[] = [];
    driver = await Driver.open(browser, {
      caseId,
      walkId: "fixture-only",
      canary,
      startUrl: "https://fixture.example/multistep/",
      store: { db: env.DB, bucket: env.ARTEFACTS },
      resolve: async (host) => (host === "fixture.example" ? ["93.184.215.14"] : null),
      fetch: async (input) => {
        const url = new URL(String(input));
        requests.push(url.pathname);
        if (url.pathname === "/favicon.ico") return new Response(null, { status: 404 });
        const body = pages[url.pathname];
        if (!body) throw new Error("unexpected fixture path");
        return new Response(body, { headers: { "content-type": "text/html" } });
      },
    });
    await driver.view({ screenshot: false });
    for (const selector of ["#accept", "#human", "a[href=login]"]) {
      const page = await browser
        .targets()
        .find((target) => target.type() === "page" && target.url().startsWith("https://fixture.example/"))
        ?.page();
      if (!page) throw new Error("missing driver page");
      const point = await page.$eval(selector, (element) => {
        const r = element.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
      });
      expect((await driver.execute({ tool: "click", ...point })).outcome).toBe("done");
      await driver.view({ screenshot: false });
    }
    expect(LIMITS).toEqual({ steps: 8, ms: 60000 });
    const trace = driver.trace();
    expect(trace.pages.some((page) => page.url.endsWith("/multistep/login") && page.asksPassword === true)).toBe(true);
    // Chromium requests its default favicon; the real fixtures host returns404 for this unprefixed path.
    expect(requests.filter((path) => path !== "/favicon.ico")).toEqual([
      "/multistep/",
      "/multistep/lure",
      "/multistep/login",
    ]);
    const actions = await env.DB.prepare(
      "SELECT count(*) AS n FROM walkthrough_actions WHERE case_id=? AND kind='action'",
    )
      .bind(caseId)
      .first<{ n: number }>();
    expect(actions?.n).toBe(3);
  } finally {
    await driver?.close();
    if (browser.connected) await browser.close();
  }
});
