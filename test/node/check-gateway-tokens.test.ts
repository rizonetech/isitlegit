import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkTokens } from "../../scripts/check-gateway-tokens.ts";

// scripts/check-gateway-tokens.ts (D99 T01 §8) against a local stand-in for Cloudflare's API and the gateway: it passes
// only when each token does exactly its job, says what to do when not, and never prints a token.
const RUN = "r".repeat(40);
const ADMIN = "a".repeat(40);
type World = {
  runTokens: string[]; // tokens the gateway lets through
  readers: string[]; // tokens that may read the settings
  writers: string[]; // tokens that may write them
  gatewayOpen?: boolean; // a gateway that lets anything through
  gatewayError?: boolean; // a gateway that fails the Run token's request itself, while logging it
  stallAdmin?: boolean; // an API that never answers the admin token
  notMeta?: boolean; // a logged 401 for the Run token that is not Meta's answer
  malformed?: boolean; // settings answered 503 with null, providers with an object
  acceptsEmptyUpdate?: boolean; // an API that answers 200 to an update with no fields
  oddEditErrors?: boolean; // an empty update answered 503 with errors that are not a list
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
      if (world.gatewayError && world.runTokens.includes(token))
        return json(502, { name: "AiGatewayError", error: [{ code: 2005 }] }, { "cf-aig-log-id": "log-2" });
      if (world.notMeta && world.runTokens.includes(token))
        return json(401, { message: "rejected upstream" }, { "cf-aig-log-id": "log-3" });
      if (world.gatewayOpen || world.runTokens.includes(token))
        return json(401, { error: { code: "invalid_api_key" } }, { "cf-aig-log-id": "log-1" });
      return json(401, { name: "AiGatewayError", error: [{ code: 2009, message: "Unauthorized" }] });
    }
    const token = bearer(req.headers.authorization);
    if (world.stallAdmin && token === ADMIN) return; // never answers
    if (world.malformed && req.method === "GET")
      return req.url?.endsWith("/custom-providers") ? json(200, { result: {} }) : json(503, null);
    if (req.url?.endsWith("/custom-providers"))
      return world.readers.includes(token) ? json(200, { result: [{ slug: "meta" }] }) : json(403, { success: false });
    if (req.method === "PUT") {
      if (!world.writers.includes(token)) return json(403, { errors: [{ code: 10000 }] });
      if (world.acceptsEmptyUpdate) return json(200, { result: { ...settings, ...JSON.parse(raw || "{}") } });
      if (world.oddEditErrors) return json(503, { errors: { code: 7001 } });
      // Cloudflare's answer to an update with no fields, once the token's Edit is accepted.
      return json(400, { errors: [{ code: 7001, message: "Expected number, received nan" }] });
    }
    return world.readers.includes(token) ? json(200, { result: settings }) : json(403, { success: false });
  });
  server = local;
  await new Promise<void>((resolve) => local.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(local.address() as AddressInfo).port}`;
  return { api: `${base}/api`, gateway: `${base}/gateway` };
}
const failure = (lines: string[], check: string) => lines.find((l) => l.startsWith(`failed: ${check}`));

describe("scripts/check-gateway-tokens.ts", () => {
  it("passes when each token does exactly its job, naming every check and printing no token", async () => {
    const outcome = await checkTokens({ run: RUN, admin: ADMIN }, await stand(right));
    expect(outcome.ok).toBe(true);
    expect(outcome.lines).toHaveLength(7);
    expect(outcome.lines.every((l) => l.startsWith("passed: "))).toBe(true);
    expect(outcome.lines.join("\n")).not.toMatch(/r{40}|a{40}/);
  });

  it("fails swapped tokens, saying which permission is missing", async () => {
    const outcome = await checkTokens({ run: ADMIN, admin: RUN }, await stand(right));
    expect(outcome.ok).toBe(false);
    expect(failure(outcome.lines, "the gateway lets the Run token through to Meta")).toMatch(
      /refused by the gateway; "IsItLegit AI Gateway token" needs AI Gateway Run/,
    );
  });

  it("fails a Run token that can read the settings", async () => {
    const outcome = await checkTokens({ run: RUN, admin: ADMIN }, await stand({ ...right, readers: [ADMIN, RUN] }));
    expect(outcome.ok).toBe(false);
    expect(failure(outcome.lines, "the Run token cannot read")).toMatch(/HTTP 200; .*Run-only token/);
  });

  it("fails an admin token that cannot write", async () => {
    const outcome = await checkTokens({ run: RUN, admin: ADMIN }, await stand({ ...right, writers: [] }));
    expect(outcome.ok).toBe(false);
    expect(failure(outcome.lines, "the admin token holds Edit")).toMatch(/HTTP 403; .*needs AI Gateway Edit/);
  });

  it("fails a gateway that lets a request with no token through", async () => {
    const outcome = await checkTokens({ run: RUN, admin: ADMIN }, await stand({ ...right, gatewayOpen: true }));
    expect(outcome.ok).toBe(false);
    expect(outcome.lines.slice(0, 2).every((l) => /^failed: .*turn Authenticated Gateway on/.test(l))).toBe(true);
  });

  it("fails a gateway error that carries a log id: only Meta's own answer proves the token crossed", async () => {
    const outcome = await checkTokens({ run: RUN, admin: ADMIN }, await stand({ ...right, gatewayError: true }));
    expect(outcome.ok).toBe(false);
    expect(failure(outcome.lines, "the gateway lets the Run token through to Meta")).toMatch(
      /HTTP 502 was not Meta's answer/,
    );
    const other = await checkTokens({ run: RUN, admin: ADMIN }, await stand({ ...right, notMeta: true }));
    expect(failure(other.lines, "the gateway lets the Run token through to Meta")).toMatch(
      /HTTP 401 was not Meta's answer/,
    );
  });

  it("refuses a malformed token before any request, printing none of it", async () => {
    const leaky = `abc${"q".repeat(30)}\nsecret-tail-${"z".repeat(20)}`;
    const outcome = await checkTokens({ run: leaky, admin: ADMIN }, await stand(right));
    expect(outcome.ok).toBe(false);
    expect(outcome.lines).toHaveLength(1);
    expect(outcome.lines[0]).toMatch(/^failed: the run token is well formed .*paste the token again/);
    expect(outcome.lines.join("\n")).not.toMatch(/q{30}|secret-tail|a{40}/);
  });

  it("fails, naming the endpoint and what to do, when nothing can be reached", async () => {
    const outcome = await checkTokens(
      { run: RUN, admin: ADMIN },
      { api: "http://127.0.0.1:1", gateway: "http://127.0.0.1:1" },
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.lines[0]).toBe(
      "failed: the gateway refuses a request with no token (127.0.0.1:1 unreachable; check the network and run again)",
    );
  });

  it("prints each check as it ends, so a stalled one leaves the earlier results shown", async () => {
    const shown: string[] = [];
    const outcome = await checkTokens({ run: RUN, admin: ADMIN }, await stand({ ...right, stallAdmin: true }), {
      log: (line) => shown.push(line),
      timeoutMs: 300,
    });
    expect(outcome.ok).toBe(false);
    expect(shown.indexOf("passed: the Run token cannot read the gateway's settings")).toBeGreaterThan(-1);
    expect(shown.indexOf("passed: the Run token cannot read the gateway's settings")).toBeLessThan(
      shown.indexOf("  checking: the admin token reading the gateway..."),
    );
    expect(failure(shown, "the admin token reads the gateway")).toMatch(/no answer within 0\.3 s; check the network/);
  });

  it("fails an empty update that is accepted, rather than trusting it", async () => {
    const outcome = await checkTokens({ run: RUN, admin: ADMIN }, await stand({ ...right, acceptsEmptyUpdate: true }));
    expect(outcome.ok).toBe(false);
    expect(failure(outcome.lines, "the admin token holds Edit")).toMatch(/HTTP 200 to an empty update/);
  });

  it("names a malformed answer to the Edit probe as a failed check", async () => {
    const outcome = await checkTokens({ run: RUN, admin: ADMIN }, await stand({ ...right, oddEditErrors: true }));
    expect(outcome.ok).toBe(false);
    expect(failure(outcome.lines, "the admin token holds Edit")).toMatch(/HTTP 503 to an empty update/);
  });

  it("names a malformed answer as a failed check instead of crashing", async () => {
    const outcome = await checkTokens({ run: RUN, admin: ADMIN }, await stand({ ...right, malformed: true }));
    expect(outcome.ok).toBe(false);
    expect(failure(outcome.lines, "the admin token reads the gateway")).toMatch(/HTTP 503/);
    expect(failure(outcome.lines, "the admin token reads the meta provider")).toMatch(/no meta provider/);
  });

  it("stops a stalled vault read when interrupted, from the real entry point", async () => {
    const dir = join(import.meta.dirname, `../../build/test-check-tokens-${process.pid}`);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const pidFile = join(dir, "vault.pid");
    writeFileSync(join(dir, "conclave-op"), `#!/bin/sh\necho $$ > "${pidFile}"\nexec sleep 30\n`, { mode: 0o755 });
    const child = spawn(process.execPath, ["scripts/check-gateway-tokens.ts"], {
      cwd: join(import.meta.dirname, "../.."),
      env: { PATH: `${dir}:${process.env.PATH}` },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
    for (let waited = 0; !existsSync(pidFile); waited += 50) {
      if (waited > 10_000) throw new Error("the vault read never started");
      await new Promise((r) => setTimeout(r, 50));
    }
    const stalled = Number(readFileSync(pidFile, "utf-8"));
    child.kill("SIGINT");
    expect(await exited).toBe(130);
    const alive = () => {
      try {
        process.kill(stalled, 0);
        return true;
      } catch {
        return false;
      }
    };
    for (let waited = 0; alive() && waited < 2_000; waited += 50) await new Promise((r) => setTimeout(r, 50));
    expect(alive()).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  }, 20_000);

  it("names the vault item when it cannot be read, from the real entry point", () => {
    const run = spawnSync(process.execPath, ["scripts/check-gateway-tokens.ts"], {
      cwd: join(import.meta.dirname, "../.."),
      env: { PATH: "" },
      encoding: "utf-8",
      timeout: 20_000,
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('failed: reading "IsItLegit AI Gateway token" from Conclave');
  });
});
