import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import "../src/index";
import type { SmokeResult } from "../src/smoke";

// GET /internal/smoke is invisible without the run's token, and with it uses every binding (D00 T01 §5); locally the
// bindings are Miniflare's simulations, Browser Run included (it launches a local Chrome).
const smoke = (headers: Record<string, string> = {}) =>
  exports.default.fetch("https://example.com/internal/smoke", { headers });

describe("GET /internal/smoke", () => {
  it("answers 404 without a token, with a wrong one, or with a malformed header", async () => {
    for (const headers of [{}, { authorization: "Bearer wrong" }, { authorization: "test-smoke-token" }]) {
      const response = await smoke(headers);
      expect(response.status, JSON.stringify(headers)).toBe(404);
      expect(await response.text()).toBe("Not Found");
    }
  });

  it("with the token, runs each binding with synthetic data, cleans up, and names every result", async () => {
    const response = await smoke({ authorization: "Bearer test-smoke-token" });
    const body = (await response.json()) as SmokeResult;
    expect(Object.keys(body.checks).sort()).toEqual(["ANALYSIS", "ARTEFACTS", "BROWSER", "CACHE", "DB"]);
    for (const name of ["DB", "ARTEFACTS", "CACHE", "ANALYSIS", "BROWSER"] as const)
      expect(body.checks[name], name).toBe("ok");
    expect(body).toMatchObject({ ok: true, commit: "0123456789abcdef0123456789abcdef01234567" });
    expect(body.version).toMatch(/\S/);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
  }, 60_000);
});
