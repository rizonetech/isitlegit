import { spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { destinationProblem, refusal, runCommand, runSmoke } from "../../scripts/smoke.ts";

// scripts/smoke.ts against a local stand-in for the deployed Worker (D00 T01 §5): it passes only on HTTP 200 from the
// version the secret published, at the expected commit, with exactly the five checks all ok; it fails on anything
// else, bounds every request with one deadline, retries while the new version propagates, and says what it is doing.
const COMMIT = "a".repeat(40);
const VERSION = "v-new";
let server: Server | undefined;
afterEach(() => server?.close());

type Answer = { status: number; body?: unknown; stall?: "headers" | "body" };
async function serve(answer: (authorization: string | undefined) => Answer) {
  const local = createServer((req, res) => {
    const { status, body, stall } = answer(req.headers.authorization);
    if (stall === "headers") return;
    res.writeHead(status, { "content-type": "application/json" });
    if (stall === "body") return res.write('{"ok":');
    res.end(body === undefined ? "Not Found" : typeof body === "string" ? body : JSON.stringify(body));
  });
  server = local;
  await new Promise<void>((resolve) => local.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(local.address() as AddressInfo).port}`;
}
const allOk = { DB: "ok", ARTEFACTS: "ok", CACHE: "ok", ANALYSIS: "ok", BROWSER: "ok" };
const pass = { ok: true, commit: COMMIT, version: VERSION, checks: allOk };
// The stand-in is plain HTTP on loopback, so these runs lift the destination rule; its own test keeps it.
const quick = {
  commit: COMMIT,
  putSecret: async () => VERSION,
  waitMs: 2_000,
  pause: async () => {},
  checkDestination: () => null,
};

describe("scripts/smoke.ts", () => {
  it("sends the token only over HTTPS to the IsItLegit Worker, refused before any secret is set", async () => {
    expect(destinationProblem("https://isitlegit.derick-f5a.workers.dev")).toBeNull();
    expect(destinationProblem("https://isitlegit.co.za")).toBeNull();
    expect(destinationProblem("https://app.isitlegit.co.za")).toBeNull();
    expect(destinationProblem("http://isitlegit.derick-f5a.workers.dev")).toMatch(/not HTTPS/);
    expect(destinationProblem("https://evil.example")).toMatch(/is not the IsItLegit Worker/);
    expect(destinationProblem("https://isitlegit.co.za.evil.example")).toMatch(/is not the IsItLegit Worker/);
    expect(destinationProblem("https://other.derick-f5a.workers.dev")).toMatch(/is not the IsItLegit Worker/);
    // Another account's Worker of the same name: the subdomain is the account's.
    expect(destinationProblem("https://isitlegit.attacker-account.workers.dev")).toMatch(/is not the IsItLegit Worker/);
    expect(destinationProblem("not a url")).toMatch(/is not a URL/);
    let set = false;
    const outcome = await runSmoke("http://isitlegit.derick-f5a.workers.dev", {
      commit: COMMIT,
      putSecret: async () => {
        set = true;
        return VERSION;
      },
    });
    expect(outcome.ok).toBe(false);
    expect(set).toBe(false);
  });

  it("refuses a redirect instead of following it with the token", async () => {
    const base = await serve(() => ({ status: 302, body: "" }));
    const outcome = await runSmoke(base, quick);
    expect(outcome.ok).toBe(false);
    expect(outcome.lines.join("\n")).toContain("answered HTTP 302");
  });

  it("kills a command still running at the deadline, with everything it started, and reports a failed one", async () => {
    // The launcher chain the script uses: pnpm exec starts the real command as its child.
    const started = Date.now();
    const marker = `smoke-test-${process.pid}-${Date.now()}`;
    await expect(
      runCommand("pnpm", ["exec", "node", "-e", `setTimeout(() => {}, 20000) // ${marker}`], "", Date.now() + 2_500),
    ).rejects.toThrow("did not finish before the deadline");
    expect(Date.now() - started).toBeLessThan(5_000);
    const survivors = spawnSync("pgrep", ["-f", marker], { encoding: "utf-8" }).stdout.trim();
    expect(survivors, "a process outlived the deadline").toBe("");
    await expect(runCommand(process.execPath, ["-e", "process.exit(3)"], "", Date.now() + 5_000)).rejects.toThrow(
      "exit 3",
    );
    expect(
      await runCommand(process.execPath, ["-e", "process.stdin.pipe(process.stdout)"], "echo", Date.now() + 5_000),
    ).toBe("echo");
  });

  it("sets a fresh 64-hex token, passes on a clean answer from the new version, and reports progress and time", async () => {
    let secret = "";
    const logged: string[] = [];
    const base = await serve((auth) => (auth === `Bearer ${secret}` ? { status: 200, body: pass } : { status: 404 }));
    const outcome = await runSmoke(base, {
      ...quick,
      putSecret: async (token: string) => {
        secret = token;
        return VERSION;
      },
      log: (line) => logged.push(line),
    });
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    expect(outcome.ok).toBe(true);
    expect(outcome.lines).toEqual(expect.arrayContaining(["version: v-new", "BROWSER: ok"]));
    expect(outcome.lines.at(-1)).toMatch(/^passed in \d+ s$/);
    expect(logged[0]).toMatch(/^Setting a fresh SMOKE_TOKEN/);
    expect(logged).toContain("The secret is live in version v-new.");
    expect([...logged, ...outcome.lines].join("\n")).not.toContain(secret);
  });

  it("refuses every answer short of a clean pass, naming why", () => {
    const at = (status: number, body: unknown) =>
      refusal(status, typeof body === "string" ? body : JSON.stringify(body), COMMIT, VERSION);
    expect(at(200, pass)).toBeNull();
    expect(at(503, pass)).toBe("answered HTTP 503");
    expect(at(200, "{not json")).toBe("answered a body that is not JSON");
    expect(at(200, { ...pass, checks: undefined })).toBe("answered no checks");
    expect(at(200, { ...pass, checks: { DB: "ok" } })).toBe("answered checks DB, not all five");
    expect(at(200, { ...pass, checks: { ...allOk, EXTRA: "ok" } })).toMatch(/not all five/);
    expect(at(200, { ...pass, checks: { ...allOk, BROWSER: "launch refused" } })).toBe(
      "failed BROWSER (launch refused)",
    );
    expect(at(200, { ...pass, ok: false })).toBe("answered ok: false with every check ok");
    expect(at(200, { ...pass, commit: "b".repeat(40) })).toMatch(/^served commit b+, expected a+$/);
    expect(at(200, { ...pass, version: "v-old" })).toBe("served version v-old, expected v-new");
  });

  it("fails an answer that contradicts itself, an incomplete one and a failed check", async () => {
    for (const answer of [
      { status: 503, body: { ok: true, commit: COMMIT, version: VERSION, checks: { DB: "failed" } } },
      { status: 200, body: { ok: true, commit: COMMIT, version: VERSION, checks: { DB: "ok" } } },
      {
        status: 503,
        body: { ok: false, commit: COMMIT, version: VERSION, checks: { ...allOk, BROWSER: "launch refused" } },
      },
    ]) {
      const base = await serve(() => answer);
      const outcome = await runSmoke(base, quick);
      expect(outcome.ok, JSON.stringify(answer)).toBe(false);
      expect(outcome.lines.at(-1)).toMatch(/^failed in/);
      server?.close();
    }
  });

  it("fails within its deadline on stalled headers, a stalled body, or a Worker that never accepts the token", async () => {
    for (const stall of ["headers", "body"] as const) {
      const base = await serve(() => ({ status: 200, stall }));
      const started = Date.now();
      const outcome = await runSmoke(base, { ...quick, waitMs: 500 });
      expect(outcome.ok, stall).toBe(false);
      expect(outcome.lines[0]).toMatch(/gave no answer/);
      expect(Date.now() - started).toBeLessThan(3_000);
      server?.closeAllConnections();
      server?.close();
    }
    const missing = await serve(() => ({ status: 404 }));
    const outcome = await runSmoke(missing, {
      ...quick,
      waitMs: 300,
      pause: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 50))),
    });
    expect(outcome.lines[0]).toBe("smoke: no passing answer within 0.3 s");
  });

  it("waits out the old version while the new one propagates", async () => {
    let calls = 0;
    const base = await serve(() =>
      ++calls < 3 ? { status: 200, body: { ...pass, version: "v-old" } } : { status: 200, body: pass },
    );
    expect((await runSmoke(base, quick)).ok).toBe(true);
    expect(calls).toBe(3);
  });
});
