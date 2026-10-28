import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import "../src/index";

// Every binding D00 T01 §5 declares works from inside the Worker (local simulations of the deployed resources):
// a binding missing from wrangler.jsonc fails here, where `wrangler d1 list` and its kind would still pass.
describe("bindings", () => {
  it("DB answers a query", async () => {
    expect(await env.DB.prepare("select 1 as one").first()).toEqual({ one: 1 });
  });

  it("ARTEFACTS stores, reads and deletes an object", async () => {
    await env.ARTEFACTS.put("test/object", "body");
    expect(await (await env.ARTEFACTS.get("test/object"))?.text()).toBe("body");
    await env.ARTEFACTS.delete("test/object");
    expect(await env.ARTEFACTS.get("test/object")).toBeNull();
  });

  it("CACHE stores and reads a key", async () => {
    await env.CACHE.put("test:key", "value");
    expect(await env.CACHE.get("test:key")).toBe("value");
  });

  it("ANALYSIS runs an instance to completion", async () => {
    const instance = await env.ANALYSIS.create({ id: "test-case", params: { caseId: "test-case" } });
    await expect
      .poll(async () => (await instance.status()).status, { timeout: 15_000, interval: 200 })
      .toBe("complete");
    // No case has this id, so the Workflow ends at its `admit` step (D01 T01 §7), as the binding smoke's instances do.
    expect((await instance.status()).output).toEqual({ caseId: "test-case", skipped: true });
  });

  it("BROWSER is bound (test/smoke.test.ts launches and closes a session through it)", () => {
    expect(env.BROWSER).toBeDefined();
  });
});
