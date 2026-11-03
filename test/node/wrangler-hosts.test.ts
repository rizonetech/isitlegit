import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The Worker's hosts (D07 T06 §9; D02 T07 §2 adds the fixtures host): the app's custom domain, which every link it mails names, and workers.dev, which
// scripts/smoke.ts sends its token to. Neither is exercised by `wrangler dev`, so the config itself is checked.
const config = JSON.parse(
  readFileSync(new URL("../../wrangler.jsonc", import.meta.url), "utf-8")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n"),
) as { routes?: { pattern: string; custom_domain?: boolean }[]; workers_dev?: boolean; vars: Record<string, string> };

describe("wrangler.jsonc's hosts", () => {
  it("serves the app on app.isitlegit.co.za as a custom domain, the host its mailed links name", () => {
    // The app's host is first; the apex trust paths and the www redirect host are D07 T06 §20's decision, and the
    // redirect fixtures' host (D02 T07 §2) is served by this Worker under a secret path prefix: a further host is
    // a decision, so it fails here until it is named.
    expect(config.routes).toEqual([
      { pattern: "app.isitlegit.co.za", custom_domain: true },
      { pattern: "isitlegit.co.za/v/*", zone_name: "isitlegit.co.za" },
      { pattern: "isitlegit.co.za/s/*", zone_name: "isitlegit.co.za" },
      { pattern: "isitlegit.co.za/b/*", zone_name: "isitlegit.co.za" },
      { pattern: "isitlegit.co.za/static/*", zone_name: "isitlegit.co.za" },
      { pattern: "www.isitlegit.co.za", custom_domain: true },
      { pattern: "fixtures.isitlegit.co.za", custom_domain: true },
    ]);
    expect(new URL(config.vars.APP_URL as string).host).toBe("app.isitlegit.co.za");
    expect(new URL(config.vars.PUBLIC_ORIGIN as string).host).toBe("app.isitlegit.co.za");
  });

  it("keeps workers.dev on for the smoke script's pinned host", () => {
    expect(config.workers_dev).toBe(true);
  });
});
