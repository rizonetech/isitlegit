import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The Worker's two hosts (D07 T06 §9): the app's custom domain, which every link it mails names, and workers.dev, which
// scripts/smoke.ts sends its token to. Neither is exercised by `wrangler dev`, so the config itself is checked.
const config = JSON.parse(
  readFileSync(new URL("../../wrangler.jsonc", import.meta.url), "utf-8")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n"),
) as { routes?: { pattern: string; custom_domain?: boolean }[]; workers_dev?: boolean; vars: Record<string, string> };

describe("wrangler.jsonc's hosts", () => {
  it("serves the app on app.isitlegit.co.za as a custom domain, the host its mailed links name", () => {
    expect(config.routes).toEqual([{ pattern: "app.isitlegit.co.za", custom_domain: true }]);
    expect(new URL(config.vars.APP_URL as string).host).toBe("app.isitlegit.co.za");
    expect(new URL(config.vars.PUBLIC_ORIGIN as string).host).toBe("app.isitlegit.co.za");
  });

  it("keeps workers.dev on for the smoke script's pinned host", () => {
    expect(config.workers_dev).toBe(true);
  });
});
