import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CLOUDFLARE, checkTokens } from "../../scripts/check-gateway-tokens.ts";

// scripts/check-gateway-tokens.ts (D99 T01 §8) against a local stand-in for Cloudflare's API and the gateway: it passes
// only when each token does exactly its job, says what to do when not, and never sends or prints a token where it
// should not.
const RUN = "r".repeat(40);
const ADMIN = "a".repeat(40);
const PROBE = "isitlegit-token-check-test";
type World = {
  runTokens: string[]; // tokens the gateway lets through
  readers: string[]; // tokens that may read
  writers: string[]; // tokens that may create and delete gateways
  gatewayOpen?: boolean; // a gateway that lets anything through
  gatewayError?: boolean; // a logged 502 for the Run token
  notMeta?: boolean; // a logged 401 for the Run token that is not Meta's answer
  stallAdmin?: boolean; // an API that never answers the admin token
  malformed?: boolean; // the settings answered 503 with null, the providers with an object
  provider?: { enable: boolean; base_url: string } | null; // the meta provider, or none
  providerOnPage?: number; // meta listed on this page of two
  deleteFails?: boolean;
  createLost?: boolean; // the create is committed, then its answer is lost
  redirectTo?: string; // the gateway redirects the Run token's request here
  huge?: boolean; // the gateway answers the Run token with 2 MiB
};
const right: World = { runTokens: [RUN], readers: [ADMIN], writers: [ADMIN] };
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((s) => {
      s.closeAllConnections();
      return new Promise((resolve) => s.close(resolve));
    }),
  );
});
async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function stand(world: World) {
  const settings = { id: "isitlegit", authentication: true, cache_ttl: 0, collect_logs: false };
  const made = new Set<string>();
  const provider = world.provider === undefined ? { enable: true, base_url: "https://api.meta.ai" } : world.provider;
  const base = await listen(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const json = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(body));
    };
    const bearer = (h?: string) => h?.replace(/^Bearer /, "") ?? "";
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname.startsWith("/gateway/")) {
      const token = bearer(req.headers["cf-aig-authorization"] as string | undefined);
      const runs = world.gatewayOpen || world.runTokens.includes(token);
      if (runs && world.redirectTo) {
        res.writeHead(302, { location: world.redirectTo });
        return res.end();
      }
      if (runs && world.huge) {
        res.writeHead(401, { "content-type": "application/json", "cf-aig-log-id": "log-h" });
        return res.end(`{"error":{"code":"invalid_api_key"},"pad":"${"x".repeat(2 * 1024 * 1024)}"}`);
      }
      if (world.gatewayError && runs) return json(502, { name: "AiGatewayError" }, { "cf-aig-log-id": "log-2" });
      if (world.notMeta && runs) return json(401, { message: "rejected upstream" }, { "cf-aig-log-id": "log-3" });
      if (runs) return json(401, { error: { code: "invalid_api_key" } }, { "cf-aig-log-id": "log-1" });
      return json(401, { name: "AiGatewayError", error: [{ code: 2009, message: "Unauthorized" }] });
    }
    const token = bearer(req.headers.authorization);
    if (world.stallAdmin && token === ADMIN) return; // never answers
    const reads = world.readers.includes(token);
    const writes = world.writers.includes(token);
    if (url.pathname.endsWith("/custom-providers")) {
      if (world.malformed) return json(200, { result: {} });
      if (!reads) return json(403, {});
      const page = Number(url.searchParams.get("page") ?? 1);
      const onPage = world.providerOnPage ?? 1;
      const listed = provider && page === onPage ? [{ slug: "meta", ...provider }] : [{ slug: `other-${page}` }];
      return json(200, { result: listed, result_info: { page, total_pages: world.providerOnPage ? 2 : 1 } });
    }
    const id = url.pathname.split("/gateways/")[1];
    if (req.method === "POST") {
      if (!writes) return json(403, { errors: [{ code: 10000 }] });
      const body = JSON.parse(raw);
      made.add(body.id);
      if (world.createLost) return req.socket.destroy();
      return json(200, { result: { id: body.id } });
    }
    if (req.method === "DELETE") {
      if (!writes) return json(403, {});
      if (world.deleteFails) return json(500, {});
      made.delete(id as string);
      return json(200, { result: { id } });
    }
    if (world.malformed) return json(503, null);
    if (!reads) return json(403, { success: false });
    if (id === "isitlegit") return json(200, { result: settings });
    return made.has(id as string) ? json(200, { result: { id } }) : json(404, {});
  });
  return { endpoints: { api: `${base}/api`, gateway: `${base}/gateway` }, made };
}
const check = async (world: World, tokens = { run: RUN, admin: ADMIN }, extra = {}) => {
  const { endpoints, made } = await stand(world);
  const outcome = await checkTokens(tokens, endpoints, { allowEndpoints: true, probeId: PROBE, ...extra });
  return { ...outcome, made };
};
const failure = (lines: string[], name: string) => lines.find((l) => l.startsWith(`failed: ${name}`));

describe("scripts/check-gateway-tokens.ts", () => {
  it("passes when each token does exactly its job, leaving nothing behind and printing no token", async () => {
    const outcome = await check(right);
    expect(outcome.ok).toBe(true);
    expect(outcome.lines).toHaveLength(8);
    expect(outcome.lines.every((l) => l.startsWith("passed: "))).toBe(true);
    expect(outcome.made.size).toBe(0);
    expect(outcome.lines.join("\n")).not.toMatch(/r{40}|a{40}/);
  });

  it("fails swapped tokens, saying which permission is missing", async () => {
    const outcome = await check(right, { run: ADMIN, admin: RUN });
    expect(outcome.ok).toBe(false);
    expect(failure(outcome.lines, "the gateway lets the Run token through")).toMatch(/needs AI Gateway Run/);
    // With Cloudflare, the admin token is let through as well; then its Read gives the swap away.
    const real = await check({ ...right, runTokens: [RUN, ADMIN] }, { run: ADMIN, admin: RUN });
    expect(failure(real.lines, "the Run token cannot read")).toMatch(/HTTP 200/);
  });

  it("fails a Run token that can read, or that can change the gateways, removing what it made", async () => {
    const reads = await check({ ...right, readers: [ADMIN, RUN] });
    expect(failure(reads.lines, "the Run token cannot read")).toMatch(/HTTP 200; .*Run-only token/);
    const writes = await check({ ...right, writers: [ADMIN, RUN] });
    expect(writes.ok).toBe(false);
    expect(failure(writes.lines, "the Run token cannot change the gateways")).toMatch(/holds AI Gateway Edit/);
    expect(writes.made.size).toBe(0);
  });

  it("fails an admin token without Edit, and names a throwaway gateway it could not delete", async () => {
    const noEdit = await check({ ...right, writers: [] });
    expect(failure(noEdit.lines, "the admin token holds Edit")).toMatch(/HTTP 403; .*needs AI Gateway Edit/);
    const stuck = await check({ ...right, deleteFails: true });
    expect(failure(stuck.lines, "the admin token holds Edit")).toMatch(
      new RegExp(`gateway ${PROBE} may exist: delete it in the dashboard`),
    );
  });

  it("removes a throwaway gateway whose create answer was lost, and tells who may need to delete one", async () => {
    const pending: (string | null)[] = [];
    const { endpoints, made } = await stand({ ...right, createLost: true });
    const outcome = await checkTokens({ run: RUN, admin: ADMIN }, endpoints, {
      allowEndpoints: true,
      probeId: PROBE,
      onPending: (id) => pending.push(id),
    });
    expect(made.size).toBe(0);
    expect(failure(outcome.lines, "the admin token holds Edit")).toMatch(/unreachable/);
    expect(pending.at(-1)).toBeNull();
    expect(pending).toContain(PROBE);
    // A lost answer and a failed removal: the gateway is named.
    const stuck = await stand({ ...right, createLost: true, deleteFails: true });
    const named = await checkTokens({ run: RUN, admin: ADMIN }, stuck.endpoints, {
      allowEndpoints: true,
      probeId: PROBE,
    });
    expect(failure(named.lines, "the admin token holds Edit")).toMatch(new RegExp(`gateway ${PROBE} may exist`));
  });

  it("checks the meta provider is enabled at Meta's address, on whichever page it is listed", async () => {
    const disabled = await check({ ...right, provider: { enable: false, base_url: "https://api.meta.ai" } });
    expect(failure(disabled.lines, "the admin token reads the meta provider")).toMatch(
      /disabled at https:\/\/api\.meta\.ai/,
    );
    const moved = await check({ ...right, provider: { enable: true, base_url: "https://elsewhere.example" } });
    expect(failure(moved.lines, "the admin token reads the meta provider")).toMatch(
      /at https:\/\/elsewhere\.example; it should be/,
    );
    const missing = await check({ ...right, provider: null });
    expect(failure(missing.lines, "the admin token reads the meta provider")).toMatch(/no meta provider/);
    expect((await check({ ...right, providerOnPage: 2 })).ok).toBe(true);
  });

  it("fails a gateway that lets a request with no token through", async () => {
    const outcome = await check({ ...right, gatewayOpen: true });
    expect(outcome.lines.slice(0, 2).every((l) => /^failed: .*turn Authenticated Gateway on/.test(l))).toBe(true);
  });

  it("counts only Meta's own answer as the Run token crossing", async () => {
    for (const world of [
      { ...right, gatewayError: true },
      { ...right, notMeta: true },
    ]) {
      const outcome = await check(world);
      expect(failure(outcome.lines, "the gateway lets the Run token through")).toMatch(/was not Meta's answer/);
    }
  });

  it("never follows a redirect, so the token stays with the gateway", async () => {
    let reached = 0;
    const elsewhere = await listen((_req, res) => {
      reached++;
      res.end("{}");
    });
    const outcome = await check({ ...right, redirectTo: elsewhere });
    expect(failure(outcome.lines, "the gateway lets the Run token through")).toMatch(
      /redirect \(HTTP 302\), which is not followed/,
    );
    expect(reached).toBe(0);
  });

  it("refuses an answer over 1 MiB without reading it", async () => {
    const outcome = await check({ ...right, huge: true });
    expect(failure(outcome.lines, "the gateway lets the Run token through")).toMatch(/more than 1 MiB/);
  });

  it("sends tokens only to Cloudflare's hosts unless a test says otherwise", async () => {
    let reached = 0;
    const local = await listen((_req, res) => {
      reached++;
      res.end("{}");
    });
    const outcome = await checkTokens({ run: RUN, admin: ADMIN }, { api: local, gateway: local });
    expect(outcome).toEqual({
      ok: false,
      lines: [
        "failed: the endpoints are Cloudflare's (the tokens go only to api.cloudflare.com and gateway.ai.cloudflare.com)",
      ],
    });
    expect(reached).toBe(0);
    expect(CLOUDFLARE).toEqual({
      api: "https://api.cloudflare.com/client/v4",
      gateway: "https://gateway.ai.cloudflare.com/v1",
    });
  });

  it("names malformed answers as failed checks instead of crashing", async () => {
    const outcome = await check({ ...right, malformed: true });
    expect(failure(outcome.lines, "the admin token reads the gateway")).toMatch(/HTTP 503/);
    expect(failure(outcome.lines, "the admin token reads the meta provider")).toMatch(/no meta provider/);
  });

  it("refuses a malformed token before any request, printing none of it", async () => {
    const leaky = `abc${"q".repeat(30)}\nsecret-tail-${"z".repeat(20)}`;
    const outcome = await check(right, { run: leaky, admin: ADMIN });
    expect(outcome.lines).toHaveLength(1);
    expect(outcome.lines[0]).toMatch(/^failed: the run token is well formed .*paste the token again/);
    expect(outcome.lines.join("\n")).not.toMatch(/q{30}|secret-tail|a{40}/);
  });

  it("names the endpoint and what to do when nothing can be reached", async () => {
    const outcome = await checkTokens(
      { run: RUN, admin: ADMIN },
      { api: "http://127.0.0.1:1", gateway: "http://127.0.0.1:1" },
      { allowEndpoints: true },
    );
    expect(outcome.lines[0]).toBe(
      "failed: the gateway refuses a request with no token (127.0.0.1:1 unreachable; check the network and run again)",
    );
  });

  it("prints each check as it ends, so a stalled one leaves the earlier results shown", async () => {
    const shown: string[] = [];
    const outcome = await check({ ...right, stallAdmin: true }, undefined, {
      log: (l: string) => shown.push(l),
      timeoutMs: 300,
    });
    expect(outcome.ok).toBe(false);
    const earlier = shown.indexOf("passed: the Run token cannot read the gateway's settings");
    expect(earlier).toBeGreaterThan(-1);
    expect(earlier).toBeLessThan(shown.indexOf("  checking: the admin token reading the gateway..."));
    expect(failure(shown, "the admin token reads the gateway")).toMatch(/no answer within 0\.3 s/);
  });

  it("stops a stalled vault read when interrupted, naming itself, from the real entry point", async () => {
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
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
    for (let waited = 0; !existsSync(pidFile); waited += 50) {
      if (waited > 10_000) throw new Error("the vault read never started");
      await new Promise((r) => setTimeout(r, 50));
    }
    const stalled = Number(readFileSync(pidFile, "utf-8"));
    child.kill("SIGINT");
    expect(await exited).toBe(130);
    expect(stderr).toContain("check-gateway-tokens: interrupted");
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
