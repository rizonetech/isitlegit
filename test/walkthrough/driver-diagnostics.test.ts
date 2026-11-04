import { env } from "cloudflare:workers";
import type { Browser } from "@cloudflare/puppeteer";
import { describe, expect, it, vi } from "vitest";
import { ulid } from "../../src/db/ulid";
import { d1Budget } from "../../src/meta/budget";
import { DriverDiagnostic, driverDiagnostic } from "../../src/walkthrough/diagnostics";
import { Driver, type OpenOptions } from "../../src/walkthrough/driver";
import { type WalkOptions, walk } from "../../src/walkthrough/wonder";

const secret = "private_token_and_canary";
const failure = () =>
  Object.assign(new Error(`net::ERR_CONNECTION_RESET at https://${secret}.example`), {
    name: "ProtocolError",
    code: "ECONNRESET",
    arbitrary: secret,
  });
function rig(fault?: string, thrown: unknown = failure(), navigate?: () => Promise<void>) {
  const listeners = new Map<string, (event: never) => void>();
  const hit = async (name: string) => {
    if (name === fault) throw thrown;
  };
  const cdp = {
    on: (name: string, callback: (event: never) => void) => listeners.set(name, callback),
    send: async (name: string) => {
      await hit(name);
      if (name === "Page.getFrameTree") return { frameTree: { frame: { id: "main" } } };
      if (name === "Page.createIsolatedWorld") return { executionContextId: 1 };
      if (name === "Runtime.evaluate") return { result: { value: { visible: "safe", hidden: [], omitted: 0 } } };
      return {};
    },
  };
  const page = {
    setViewport: () => hit("viewport"),
    setBypassServiceWorker: () => hit("bypass"),
    evaluateOnNewDocument: () => hit("worker-guard"),
    createCDPSession: async () => {
      await hit("page-session");
      return cdp;
    },
    goto: navigate ?? (() => hit("navigate")),
    screenshot: () => hit("screenshot"),
  };
  const browser = {
    target: () => ({
      createCDPSession: async () => {
        await hit("browser-session");
        return cdp;
      },
    }),
    on: cdp.on,
    newPage: async () => {
      await hit("new-page");
      return page;
    },
    close: vi.fn(async () => {}),
  };
  return {
    browser: browser as unknown as Browser,
    emit: (name: string, event: unknown) => listeners.get(name)?.(event as never),
  };
}
async function options(): Promise<OpenOptions> {
  const caseId = ulid();
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO cases (id, org_id, channel, created_at, updated_at) VALUES (?, 'org-walk', 'email', ?, ?)",
  )
    .bind(caseId, now, now)
    .run();
  return {
    caseId,
    walkId: "diagnostic",
    startUrl: "https://fixture.example/",
    canary: { username: secret, password: secret },
    store: { db: env.DB, bucket: env.ARTEFACTS },
    resolve: async () => ["93.184.215.14"],
    fetch: vi.fn(async () => new Response("safe")) as typeof fetch,
  };
}
async function persisted(o: OpenOptions) {
  return env.DB.prepare("SELECT action_json, reason FROM walkthrough_actions WHERE case_id = ? AND kind = 'end'")
    .bind(o.caseId)
    .first<{ action_json: string; reason: string }>();
}
const diagnostic = (value: unknown) => (value as { diagnostic?: unknown })?.diagnostic;

describe("bounded driver failure diagnostics", () => {
  it.each([
    ["browser-session", "setup.browser-session"],
    ["Target.setDiscoverTargets", "setup.discover-targets"],
    ["Fetch.enable", "setup.interception"],
    ["Browser.setDownloadBehavior", "setup.download-denial"],
    ["new-page", "setup.new-page"],
    ["viewport", "setup.viewport"],
    ["bypass", "setup.service-worker-bypass"],
    ["worker-guard", "setup.worker-guard"],
    ["page-session", "setup.page-session"],
    ["DOM.enable", "setup.dom"],
    ["Page.getFrameTree", "frames.read"],
    ["navigate", "navigation.goto"],
  ])("retains actual %s operation through terminal, view, action and D1", async (fault, operation) => {
    const o = await options();
    const driver = await Driver.open(rig(fault).browser, o);
    const expected = { operation, category: "protocol", networkCode: "ECONNRESET" };
    expect(driver.ended?.outcome).toBe("error");
    expect(diagnostic(driver.ended)).toEqual(expected);
    expect(diagnostic(await driver.view())).toEqual(expected);
    expect(diagnostic(await driver.execute({ tool: "wait", seconds: 1 }))).toEqual(expected);
    expect(JSON.parse((await persisted(o))?.action_json ?? "null").diagnostic).toEqual(expected);
    expect(JSON.stringify(await persisted(o))).not.toContain(secret);
  });
  it("attributes start-policy failure and keeps unknown exception properties private", async () => {
    const o = await options();
    o.resolve = async () => {
      throw { name: secret, message: secret, code: secret };
    };
    const driver = await Driver.open(rig().browser, o);
    expect(diagnostic(driver.ended)).toEqual({ operation: "policy.start", category: "unknown" });
    expect(JSON.stringify([driver.ended, await persisted(o)])).not.toContain(secret);
  });
  it("carries setup failure through production walk without a model call even when end persistence fails", async () => {
    const o = await options();
    o.store = {
      ...o.store,
      db: {
        prepare: () => {
          throw failure();
        },
      } as unknown as D1Database,
    };
    const fetch = vi.fn(async () => {
      throw new Error("model must not be called");
    });
    const meta: WalkOptions["meta"] = {
      env: { META_API_KEY: "k", CF_AIG_TOKEN: "t", META_GATEWAY_URL: "https://gateway.test/v1" },
      budget: d1Budget(env.DB, { caller: "walkthrough" }),
      fetch: fetch as typeof globalThis.fetch,
    };
    const result = await walk(rig("new-page").browser, { ...o, meta });
    expect(result.outcome).toBe("error");
    expect(diagnostic(result)).toEqual({
      operation: "setup.new-page",
      category: "protocol",
      networkCode: "ECONNRESET",
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(secret);
  });
  it("labels the first view read failure", async () => {
    const o = await options();
    const driver = await Driver.open(rig("Runtime.evaluate").browser, o);
    const result = await driver.view({ screenshot: false });
    expect(diagnostic(result)).toEqual({ operation: "view.read", category: "protocol", networkCode: "ECONNRESET" });
  });
  it("carries first screenshot failure through the actual walk without a model call", async () => {
    const o = await options();
    const fetch = vi.fn(async () => {
      throw new Error("no model call");
    });
    const result = await walk(rig("screenshot").browser, {
      ...o,
      meta: {
        env: { META_API_KEY: "k", CF_AIG_TOKEN: "t", META_GATEWAY_URL: "https://gateway.test/v1" },
        budget: d1Budget(env.DB, { caller: "walkthrough" }),
        fetch: fetch as typeof globalThis.fetch,
      },
    });
    expect(diagnostic(result)).toEqual({
      operation: "view.screenshot",
      category: "protocol",
      networkCode: "ECONNRESET",
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(JSON.parse((await persisted(o))?.action_json ?? "null").diagnostic).toEqual(diagnostic(result));
  });
  it("records bounded network metadata on a refused request without making it terminal", async () => {
    const o = await options();
    const r = rig();
    o.fetch = async () => {
      throw Object.assign(new Error(secret), { name: secret, code: "ECONNRESET" });
    };
    const driver = await Driver.open(r.browser, o);
    r.emit("Fetch.requestPaused", {
      requestId: "r",
      frameId: "main",
      resourceType: "Document",
      request: { url: o.startUrl, method: "GET", headers: {} },
    });
    await vi.waitFor(async () => {
      const row = await env.DB.prepare(
        "SELECT action_json, reason FROM walkthrough_actions WHERE case_id = ? AND kind = 'request'",
      )
        .bind(o.caseId)
        .first<{ action_json: string; reason: string }>();
      expect(row).not.toBeNull();
      expect(JSON.parse(row?.action_json ?? "null").diagnostic).toEqual({
        operation: "interception.fetch",
        category: "unknown",
        networkCode: "ECONNRESET",
      });
      expect(JSON.stringify(row)).not.toContain(secret);
    });
    expect(driver.ended).toBeUndefined();
    await driver.end("done", "finished");
  });
  it("retains the intercepted request's policy identity", async () => {
    let calls = 0;
    const second = await options();
    second.resolve = async () => {
      if (++calls > 1) throw failure();
      return ["93.184.215.14"];
    };
    const live = rig();
    const actual = await Driver.open(live.browser, second);
    live.emit("Fetch.requestPaused", {
      requestId: "r",
      frameId: "main",
      resourceType: "Document",
      request: { url: second.startUrl, method: "GET", headers: {} },
    });
    await vi.waitFor(() => expect(actual.ended?.outcome).toBe("error"));
    await actual.end("done", "late");
    expect(diagnostic(actual.ended)).toEqual({
      operation: "policy.request",
      category: "protocol",
      networkCode: "ECONNRESET",
    });
  });
  it("rejects unknown diagnostic keys and never reflects malicious names or message suffixes", () => {
    const expected = { operation: "navigation.goto", category: "unknown", networkCode: "ERR_CONNECTION_RESET" };
    const error = Object.assign(new Error(`net::ERR_CONNECTION_RESET ${secret}`), {
      name: secret,
      code: secret,
      [secret]: secret,
    });
    expect(driverDiagnostic("navigation.goto", error)).toEqual(expected);
    expect(DriverDiagnostic.safeParse({ ...expected, [secret]: secret }).success).toBe(false);
    expect(DriverDiagnostic.safeParse({ ...expected, operation: secret }).success).toBe(false);
    expect(DriverDiagnostic.safeParse({ ...expected, category: secret }).success).toBe(false);
    expect(DriverDiagnostic.safeParse({ ...expected, networkCode: secret }).success).toBe(false);
    expect(
      driverDiagnostic("action", {
        get name() {
          throw new Error(secret);
        },
        get code() {
          throw new Error(secret);
        },
      }),
    ).toEqual({ operation: "action", category: "unknown" });
  });
  it("preserves first asynchronous interception failure over a later containment failure", async () => {
    const o = await options();
    const r = rig("Fetch.fulfillRequest");
    const driver = await Driver.open(r.browser, o);
    r.emit("Fetch.requestPaused", {
      requestId: "r",
      frameId: "main",
      resourceType: "Document",
      request: { url: o.startUrl, method: "GET", headers: {} },
    });
    await vi.waitFor(() => expect(driver.ended?.outcome).toBe("error"));
    r.emit("targetcreated", {
      type: () => {
        throw new TypeError(secret);
      },
    });
    await driver.end("done", "late");
    expect(diagnostic(driver.ended)).toEqual({
      operation: "interception.fulfill",
      category: "protocol",
      networkCode: "ECONNRESET",
    });
    expect(JSON.parse((await persisted(o))?.action_json ?? "null").diagnostic).toEqual(diagnostic(driver.ended));
  });
  it("keeps interception causality while navigation later fails", async () => {
    const o = await options();
    let began = false;
    let rejectNavigation: (error: Error) => void = () => {};
    const navigation = new Promise<void>((_, reject) => {
      rejectNavigation = reject;
    });
    const r = rig("Fetch.fulfillRequest", failure(), () => {
      began = true;
      return navigation;
    });
    const opening = Driver.open(r.browser, o);
    await vi.waitFor(() => expect(began).toBe(true));
    r.emit("Fetch.requestPaused", {
      requestId: "r",
      frameId: "main",
      resourceType: "Document",
      request: { url: o.startUrl, method: "GET", headers: {} },
    });
    await vi.waitFor(() => expect(persisted(o)).resolves.not.toBeNull());
    rejectNavigation(new TypeError(secret));
    const driver = await opening;
    expect(diagnostic(driver.ended)).toEqual({
      operation: "interception.fulfill",
      category: "protocol",
      networkCode: "ECONNRESET",
    });
  });
  it.each(["session", "terminate", "detach"])(
    "records swallowed containment %s failure without changing containment behavior",
    async (fault) => {
      const o = await options();
      const r = rig();
      const driver = await Driver.open(r.browser, o);
      r.emit("targetcreated", {
        type: () => "worker",
        createCDPSession: async () => {
          if (fault === "session") throw failure();
          return {
            send: async () => {
              if (fault === "terminate") throw failure();
            },
            detach: async () => {
              if (fault === "detach") throw failure();
            },
          };
        },
      });
      try {
        await vi.waitFor(async () => {
          const row = await env.DB.prepare(
            "SELECT action_json FROM walkthrough_actions WHERE case_id = ? AND kind = 'popup'",
          )
            .bind(o.caseId)
            .first<{ action_json: string }>();
          expect(JSON.parse(row?.action_json ?? "null")?.diagnostic).toEqual({
            operation: `containment.${fault}`,
            category: "protocol",
            networkCode: "ECONNRESET",
          });
        });
        expect(driver.ended).toBeUndefined();
      } finally {
        await driver.end("done", "finished");
      }
    },
  );
  it("labels a target containment failure", async () => {
    const o = await options();
    const r = rig();
    const driver = await Driver.open(r.browser, o);
    r.emit("targetcreated", {
      type: () => {
        throw failure();
      },
    });
    await vi.waitFor(() => expect(driver.ended?.outcome).toBe("error"));
    await driver.end("done", "late");
    expect(diagnostic(driver.ended)).toEqual({
      operation: "containment.target",
      category: "protocol",
      networkCode: "ECONNRESET",
    });
  });
  it("preserves refusal and timer outcomes against late callback failures", async () => {
    for (const timed of [false, true]) {
      const o = await options();
      const r = rig();
      if (timed) {
        o.resolve = () => new Promise(() => {});
        o.limits = { steps: 8, ms: 20 };
      } else o.startUrl = "file:///private";
      const driver = await Driver.open(r.browser, o);
      r.emit("targetcreated", {
        type: () => {
          throw failure();
        },
      });
      await driver.end("error", "late");
      expect(driver.ended?.outcome).toBe(timed ? "limit" : "refused");
      expect(diagnostic(driver.ended)).toBeUndefined();
    }
  });
  it("leaves ordinary successful views and completion without failure metadata", async () => {
    const o = await options();
    const driver = await Driver.open(rig().browser, o);
    const view = await driver.view({ screenshot: false });
    expect(view.outcome).toBe("done");
    expect(view.text).toBe("safe");
    expect(diagnostic(view)).toBeUndefined();
    await driver.end("done", "finished");
    expect(driver.ended).toEqual({ outcome: "done", reason: "finished" });
    expect(JSON.parse((await persisted(o))?.action_json ?? "null").diagnostic).toBeUndefined();
  });
});
