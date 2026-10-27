import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { runSmoke } from "../../scripts/smoke.ts";

// scripts/smoke.ts against a local stand-in for the deployed Worker: it passes only when every check is ok, and fails
// on a failed check, on a Worker that never accepts the token, and on any other answer.
let server: Server | undefined;
afterEach(() => server?.close());

async function serve(answer: (authorization: string | undefined) => { status: number; body?: unknown }) {
  const local = createServer((req, res) => {
    const { status, body } = answer(req.headers.authorization);
    res.writeHead(status, { "content-type": "application/json" });
    res.end(body === undefined ? "Not Found" : JSON.stringify(body));
  });
  server = local;
  await new Promise<void>((resolve) => local.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(local.address() as AddressInfo).port}`;
}
const checks = (browser: string) => ({ DB: "ok", ARTEFACTS: "ok", CACHE: "ok", ANALYSIS: "ok", BROWSER: browser });
const noPause = async () => {};

describe("scripts/smoke.ts", () => {
  it("sets a fresh 64-hex token, sends it, and passes when every check is ok", async () => {
    let secret = "";
    const base = await serve((auth) =>
      auth === `Bearer ${secret}`
        ? { status: 200, body: { ok: true, commit: "abc", checks: checks("ok") } }
        : { status: 404 },
    );
    const outcome = await runSmoke(base, (token) => (secret = token), 1_000, noPause);
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    expect(outcome).toEqual({
      ok: true,
      lines: ["commit: abc", "DB: ok", "ARTEFACTS: ok", "CACHE: ok", "ANALYSIS: ok", "BROWSER: ok"],
    });
    expect(outcome.lines.join("\n")).not.toContain(secret);
  });

  it("fails on a failed check and names it", async () => {
    const base = await serve(() => ({
      status: 503,
      body: { ok: false, commit: "abc", checks: checks("launch refused") },
    }));
    const outcome = await runSmoke(base, () => {}, 1_000, noPause);
    expect(outcome.ok).toBe(false);
    expect(outcome.lines).toContain("BROWSER: launch refused");
  });

  it("fails when the Worker never accepts the token, and on any other answer", async () => {
    const missing = await serve(() => ({ status: 404 }));
    expect(await runSmoke(missing, () => {}, 0, noPause)).toEqual({
      ok: false,
      lines: [`smoke: ${missing}/internal/smoke answered 404`],
    });
    server?.close();
    const broken = await serve(() => ({ status: 500, body: {} }));
    expect((await runSmoke(broken, () => {}, 0, noPause)).ok).toBe(false);
  });

  it("retries a 404 while the new secret propagates", async () => {
    let calls = 0;
    let secret = "";
    const base = await serve((auth) =>
      ++calls < 3 || auth !== `Bearer ${secret}`
        ? { status: 404 }
        : { status: 200, body: { ok: true, commit: "abc", checks: checks("ok") } },
    );
    expect((await runSmoke(base, (token) => (secret = token), 60_000, noPause)).ok).toBe(true);
    expect(calls).toBe(3);
  });
});
