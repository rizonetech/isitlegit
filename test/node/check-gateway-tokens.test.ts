import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { checkTokens } from "../../scripts/check-gateway-tokens.ts";

// scripts/check-gateway-tokens.ts (D99 T01 §8) against a local stand-in for Cloudflare's API and the gateway: it passes
// only when each token does exactly its job, and never prints a token.
const RUN = "r".repeat(40);
const ADMIN = "a".repeat(40);
type World = {
  runTokens: string[]; // tokens the gateway lets through
  readers: string[]; // tokens that may read the settings
  writers: string[]; // tokens that may write them
  gatewayOpen?: boolean; // a gateway that lets anything through
};
const right: World = { runTokens: [RUN], readers: [ADMIN], writers: [ADMIN] };
let server: Server | undefined;
afterEach(() => server?.close());

async function stand(world: World) {
  const settings = { id: "isitlegit", authentication: true, cache_ttl: 0, collect_logs: false };
  const local = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const json = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(body));
    };
    const bearer = (h?: string) => h?.replace(/^Bearer /, "") ?? "";
    if (req.url?.startsWith("/gateway/")) {
      const token = bearer(req.headers["cf-aig-authorization"] as string | undefined);
      if (world.gatewayOpen || world.runTokens.includes(token))
        return json(401, { error: { code: "invalid_api_key" } }, { "cf-aig-log-id": "log-1" });
      return json(401, { name: "AiGatewayError", error: [{ code: 2009, message: "Unauthorized" }] });
    }
    const token = bearer(req.headers.authorization);
    if (req.url?.endsWith("/custom-providers"))
      return world.readers.includes(token) ? json(200, { result: [{ slug: "meta" }] }) : json(403, { success: false });
    if (req.method === "PUT")
      return world.writers.includes(token) ? json(200, { result: { ...settings, ...JSON.parse(raw) } }) : json(403, {});
    return world.readers.includes(token) ? json(200, { result: settings }) : json(403, { success: false });
  });
  server = local;
  await new Promise<void>((resolve) => local.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(local.address() as AddressInfo).port}`;
  return { api: `${base}/api`, gateway: `${base}/gateway` };
}

describe("scripts/check-gateway-tokens.ts", () => {
  it("passes when each token does exactly its job, naming every check and printing no token", async () => {
    const outcome = await checkTokens({ run: RUN, admin: ADMIN }, await stand(right));
    expect(outcome.ok).toBe(true);
    expect(outcome.lines).toHaveLength(7);
    expect(outcome.lines.every((l) => l.startsWith("passed: "))).toBe(true);
    expect(outcome.lines.join("\n")).not.toMatch(/r{40}|a{40}/);
  });

  it("fails swapped tokens", async () => {
    const outcome = await checkTokens({ run: ADMIN, admin: RUN }, await stand(right));
    expect(outcome.ok).toBe(false);
    expect(outcome.lines).toContain(
      "failed: the gateway lets the Run token through (HTTP 401, refused by the gateway)",
    );
  });

  it("fails a Run token that can read the settings", async () => {
    const outcome = await checkTokens({ run: RUN, admin: ADMIN }, await stand({ ...right, readers: [ADMIN, RUN] }));
    expect(outcome.ok).toBe(false);
    expect(outcome.lines).toContain("failed: the Run token cannot read the gateway's settings (HTTP 200)");
  });

  it("fails an admin token that cannot write", async () => {
    const outcome = await checkTokens({ run: RUN, admin: ADMIN }, await stand({ ...right, writers: [] }));
    expect(outcome.ok).toBe(false);
    expect(outcome.lines).toContain("failed: the admin token writes the settings back unchanged (HTTP 403)");
  });

  it("fails a gateway that lets a request with no token through", async () => {
    const outcome = await checkTokens({ run: RUN, admin: ADMIN }, await stand({ ...right, gatewayOpen: true }));
    expect(outcome.ok).toBe(false);
    expect(outcome.lines.slice(0, 2)).toEqual([
      "failed: the gateway refuses a request with no token (HTTP 401)",
      "failed: the gateway refuses a made-up token (HTTP 401)",
    ]);
  });

  it("fails, naming why, when the endpoints cannot be reached", async () => {
    const outcome = await checkTokens(
      { run: RUN, admin: ADMIN },
      { api: "http://127.0.0.1:1", gateway: "http://127.0.0.1:1" },
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.lines.at(-1)).toMatch(/^failed: the checks ran/);
  });
});
