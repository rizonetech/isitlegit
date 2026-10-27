import { spawn, spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  destinationProblem,
  killGroup,
  parseSmokeArgs,
  type Runner,
  refusal,
  rotateWith,
  runCommand,
  runSmoke,
} from "../../scripts/smoke.ts";

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
const TOKEN = "b".repeat(64);
const quick = {
  commit: COMMIT,
  getToken: async () => TOKEN,
  activeVersion: async () => VERSION,
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
    let read = false;
    const outcome = await runSmoke("http://isitlegit.derick-f5a.workers.dev", {
      commit: COMMIT,
      getToken: async () => {
        read = true;
        return TOKEN;
      },
      activeVersion: async () => VERSION,
    });
    expect(outcome.ok).toBe(false);
    expect(read).toBe(false);
  });

  it("refuses a redirect instead of following it with the token", async () => {
    // A second endpoint the redirect points at: it must never see a request, let alone the token.
    const seen: (string | undefined)[] = [];
    const elsewhere = createServer((req, res) => {
      seen.push(req.headers.authorization);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(pass));
    });
    await new Promise<void>((resolve) => elsewhere.listen(0, "127.0.0.1", resolve));
    const target = `http://127.0.0.1:${(elsewhere.address() as AddressInfo).port}/internal/smoke`;
    const local = createServer((_req, res) => {
      res.writeHead(302, { location: target });
      res.end();
    });
    server = local;
    await new Promise<void>((resolve) => local.listen(0, "127.0.0.1", resolve));
    const outcome = await runSmoke(`http://127.0.0.1:${(local.address() as AddressInfo).port}`, quick);
    elsewhere.close();
    expect(outcome.ok).toBe(false);
    expect(outcome.lines.join("\n")).toContain("answered HTTP 302");
    expect(seen).toEqual([]);
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

  it("uses the vault's token and the active version, publishes nothing, and reports progress and time", async () => {
    const logged: string[] = [];
    const base = await serve((auth) => (auth === `Bearer ${TOKEN}` ? { status: 200, body: pass } : { status: 404 }));
    const outcome = await runSmoke(base, { ...quick, log: (line) => logged.push(line) });
    expect(outcome.ok).toBe(true);
    expect(outcome.lines).toEqual(expect.arrayContaining(["version: v-new", "BROWSER: ok"]));
    expect(outcome.lines.at(-1)).toMatch(/^passed in \d+ s$/);
    expect(logged[0]).toMatch(/^Reading the smoke token and the version serving all traffic/);
    expect(logged).toContain("Version v-new serves all traffic.");
    expect([...logged, ...outcome.lines].join("\n")).not.toContain(TOKEN);
  });

  it("rotates only when asked: a new token, the version it published, and that version checked", async () => {
    let token = "";
    const base = await serve((auth) => (auth === `Bearer ${token}` ? { status: 200, body: pass } : { status: 404 }));
    const outcome = await runSmoke(base, {
      ...quick,
      getToken: async () => {
        throw new Error("a rotation does not read the old token");
      },
      rotate: async () => {
        token = "c".repeat(64);
        return { token, version: VERSION };
      },
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.lines.join("\n")).not.toContain(token);
  });

  it("reconciles an interrupted rotation: the vault first, the Worker failing, then a second --rotate", async () => {
    const vault = { fields: [{ id: "credential", value: "a".repeat(64) }] };
    const worker = { token: "a".repeat(64), fail: true };
    const run: Runner = async (command, args, input) => {
      if (command === "op" && args[1] === "get") return JSON.stringify(vault);
      if (command === "op" && args[0] === "read") return `${vault.fields[0]?.value}\n`;
      // The template reaches op through a real pipe (sh -c 'cat | exec op ...').
      if (command === "sh" && args.includes("edit")) {
        vault.fields = JSON.parse(input).fields;
        return "";
      }
      if (args.includes("secret")) {
        if (worker.fail) throw new Error("wrangler secret put: network error");
        worker.token = input;
        return "";
      }
      if (args.includes("status")) return JSON.stringify({ versions: [{ version_id: VERSION, percentage: 100 }] });
      if (args.includes("list"))
        return JSON.stringify([
          { id: "v-old", number: 1 },
          { id: VERSION, number: 2 },
        ]);
      throw new Error(`unexpected ${command} ${args.join(" ")}`);
    };
    const rotate = rotateWith(run, () => ({}));
    const first = await rotate(Date.now() + 2_000).catch((e: Error) => e);
    expect((first as Error).message).toMatch(
      /vault has the new token but the Worker did not take it .* `--rotate` runs again/,
    );
    expect(vault.fields[0]?.value).not.toBe(worker.token);
    worker.fail = false;
    const second = await rotate(Date.now() + 2_000);
    expect(second).toEqual({ token: worker.token, version: VERSION });
    expect(vault.fields[0]?.value).toBe(worker.token);
    expect(worker.token).toMatch(/^[0-9a-f]{64}$/);
  });

  it("ends inside its whole budget even when the last read of the active version stalls", async () => {
    let reads = 0;
    const base = await serve(() => ({ status: 404 }));
    const started = Date.now();
    const outcome = await runSmoke(base, {
      ...quick,
      waitMs: 800,
      activeVersion: (deadline: number) =>
        ++reads === 1
          ? Promise.resolve(VERSION)
          : new Promise<string>((_, reject) => setTimeout(() => reject(new Error("stalled")), deadline - Date.now())),
    });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(outcome.ok).toBe(false);
  });

  it("refuses a rotation while a rollback is in effect, before the vault or the Worker changes", async () => {
    const calls: string[] = [];
    const run: Runner = async (command, args) => {
      calls.push(`${command} ${args.join(" ")}`);
      if (args.includes("status")) return JSON.stringify({ versions: [{ version_id: "v-good", percentage: 100 }] });
      if (args.includes("list"))
        return JSON.stringify([
          { id: "v-good", number: 3 },
          { id: "v-broken", number: 4 },
        ]);
      throw new Error(`unexpected ${command} ${args.join(" ")}`);
    };
    await expect(rotateWith(run, () => ({}))(Date.now() + 2_000)).rejects.toThrow(
      /a rollback is in effect \(v-good serves, the newest version is v-broken\).*nothing was changed/,
    );
    expect(calls.some((c) => c.startsWith("op ") || c.includes("edit") || c.includes("secret"))).toBe(false);
  });

  it("stops a rotation before the Worker changes when the vault did not take the token", async () => {
    const vault = { fields: [{ id: "credential", value: "a".repeat(64) }] };
    let put = false;
    const run: Runner = async (command, args) => {
      if (command === "op" && args[1] === "get") return JSON.stringify(vault);
      if (command === "op" && args[0] === "read") return `${vault.fields[0]?.value}\n`;
      if (command === "sh" && args.includes("edit")) return ""; // op answered, but stored nothing
      if (args.includes("secret")) put = true;
      if (args.includes("status")) return JSON.stringify({ versions: [{ version_id: VERSION, percentage: 100 }] });
      if (args.includes("list")) return JSON.stringify([{ id: VERSION, number: 2 }]);
      return "";
    };
    await expect(rotateWith(run, () => ({}))(Date.now() + 2_000)).rejects.toThrow(/vault did not take the new token/);
    expect(put).toBe(false);
  });

  it("reports a failed setup as a failed run, never an exception", async () => {
    const outcome = await runSmoke("http://127.0.0.1:1", {
      ...quick,
      getToken: async () => {
        throw new Error("op: not signed in");
      },
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.lines[0]).toBe("smoke: op: not signed in");
  });

  it("checks the whole command line before anything runs", () => {
    const commit = "a".repeat(40);
    expect(parseSmokeArgs(["https://x", "--commit", commit, "--rotate"])).toEqual({
      base: "https://x",
      commit,
      rotate: true,
    });
    expect(parseSmokeArgs(["https://x"])).toEqual({ base: "https://x", rotate: false });
    expect(() => parseSmokeArgs(["https://x", "--commit"])).toThrow();
    expect(() => parseSmokeArgs(["https://x", "--commit", "abc"])).toThrow(/full 40-hex/);
    expect(() => parseSmokeArgs(["https://x", "--rotat"])).toThrow();
    expect(() => parseSmokeArgs([])).toThrow(/exactly one/);
  });

  it("fails when the version serving all traffic changes during the run", async () => {
    let reads = 0;
    const base = await serve(() => ({ status: 200, body: pass }));
    const outcome = await runSmoke(base, {
      ...quick,
      activeVersion: async () => (++reads === 1 ? VERSION : "v-other"),
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.lines).toContain("smoke: the version serving all traffic changed during the run: v-new to v-other");
  });

  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
    it(`stops every running command when the run gets ${signal}`, async () => {
      // A real run of the script's runCommand in its own Node process, signalled mid-command.
      const marker = `smoke-${signal}-${process.pid}-${Date.now()}`;
      // The parent builds the marker at run time, so only the command's own line contains it, not the parent's.
      const [head, tail] = [marker.slice(0, 6), marker.slice(6)];
      const program = `import("./scripts/smoke.ts").then((m) => { m.installSignalCleanup();
      m.runCommand("pnpm", ["exec", "node", "-e", "setTimeout(() => {}, 20000) // " + "${head}" + "${tail}"], "", Date.now() + 60000); });`;
      const parent = spawn(process.execPath, ["-e", program], {
        cwd: join(import.meta.dirname, "../.."),
        stdio: "ignore",
      });
      const alive = () => spawnSync("pgrep", ["-f", marker], { encoding: "utf-8" }).stdout.trim();
      for (let i = 0; i < 100 && !alive(); i++) await new Promise((r) => setTimeout(r, 100));
      expect(alive(), "the command started").not.toBe("");
      const exited = new Promise<number | null>((resolve) => parent.on("exit", (code) => resolve(code)));
      parent.kill(signal);
      expect(await exited).toBe(130);
      for (let i = 0; i < 20 && alive(); i++) await new Promise((r) => setTimeout(r, 100));
      expect(alive(), `a command outlived ${signal}`).toBe("");
    }, 30_000);

  it("kills a command's whole tree on Windows through taskkill", () => {
    const calls: string[][] = [];
    killGroup(4242, "win32", (command, args) => calls.push([command, ...args]));
    expect(calls).toEqual([["taskkill", "/pid", "4242", "/T", "/F"]]);
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
      expect(outcome.lines[0]).toBe("smoke: no passing answer within 0.5 s");
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

  it("names a refused connection apart from the deadline", async () => {
    const base = await serve(() => ({ status: 404 }));
    server?.close();
    const outcome = await runSmoke(base, quick);
    expect(outcome.lines[0]).toMatch(/^smoke: http:\/\/127\.0\.0\.1:\d+\/internal\/smoke gave no answer: /);
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
