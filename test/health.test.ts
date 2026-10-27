import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
// Vitest watch mode reruns this file when the Worker changes only if the test imports it; requests still go through
// `exports`, as in production (developers.cloudflare.com/workers/testing/vitest-integration/migration-guides/migrate-from-unstable-dev/).
import "../src/index";

describe("GET /health", () => {
  it("answers 200 with ok and the commit the Worker is configured with", async () => {
    expect(env.COMMIT_SHA).toBe("0123456789abcdef0123456789abcdef01234567");
    const response = await exports.default.fetch("https://example.com/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, commit: env.COMMIT_SHA });
  });
});
