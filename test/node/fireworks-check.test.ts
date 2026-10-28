import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { getDefaultAutoSelectFamilyAttemptTimeout, setDefaultAutoSelectFamilyAttemptTimeout } from "node:net";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  API,
  BASE_MODEL,
  BILL_SETTLE_MS,
  billingState,
  CONNECT_ATTEMPT_MS,
  configureNetwork,
  describeBill,
  PROBE,
  PROBE_CUTOFF,
  PROBE_TEXT,
  parseCheckArgs,
  probeLines,
  probeOutcome,
  type RunOptions,
  runFireworksCheck,
} from "../../scripts/fireworks-check.ts";

// scripts/fireworks-check.ts (D03 T04 §2) against a stubbed transport: the default and --job modes only read, a
// training mode is decided only by a completed job, a bill is never zero by default, the probe is refused after the free
// offer and while a probe resource exists, --delete-probe touches only the probes' names and reads each deletion back,
// and the key never reaches the output.
const DIR = join(import.meta.dirname, `../../build/test-fireworks-check-${process.pid}`);
const KEY = `fw_${"k".repeat(22)}`;
beforeEach(() => {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
});
afterAll(() => rmSync(DIR, { recursive: true, force: true }));

type Seen = { method: string; url: string; body: unknown; authorization: string | null };
type Reply = { status: number; body?: unknown };

// A Fireworks stand-in: `routes` maps "METHOD path-without-query" to a reply; anything else is a 404.
function stub(routes: Record<string, Reply | ((seen: Seen) => Reply)>) {
  const seen: Seen[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    let body: unknown = init?.body;
    if (typeof body === "string") body = JSON.parse(body);
    const call = { method, url, body, authorization: headers.get("authorization") };
    seen.push(call);
    const path = url.slice(API.length).split("?")[0];
    const route = routes[`${method} ${path}`];
    const reply =
      typeof route === "function" ? route(call) : (route ?? { status: 404, body: { message: "not found" } });
    return new Response(reply.body === undefined ? "" : JSON.stringify(reply.body), { status: reply.status });
  }) as typeof fetch;
  return { seen, impl };
}

const lists = {
  "GET /models": { status: 200, body: { models: [{ name: "accounts/rizonetech/models/m1", state: "READY" }] } },
  "GET /deployments": { status: 200, body: { deployments: [] } },
  "GET /datasets": { status: 200, body: { datasets: [{ name: "accounts/rizonetech/datasets/d1", state: "READY" }] } },
  "GET /supervisedFineTuningJobs": { status: 200, body: { supervisedFineTuningJobs: [] } },
  "GET /creditRedemptions": { status: 200, body: { creditRedemptions: [{ createTime: "2026-10-28T06:47:47Z" }] } },
  "GET /billing/summary": {
    status: 200,
    body: { lineItems: [{ series: "training", totalCost: { currencyCode: "USD", units: "1", nanos: 250000000 } }] },
  },
};
const base = (over: Partial<RunOptions>): RunOptions => ({
  mode: { kind: "list" },
  readKey: async () => KEY,
  now: () => new Date("2026-10-28T14:00:00Z"),
  probeFile: join(DIR, "probe.jsonl"),
  probeTextFile: join(DIR, "probe-text.jsonl"),
  pollMs: 1,
  ...over,
});
const imageProbe = { kind: "probe", variant: "image" } as const;

describe("default mode", () => {
  it("lists the six things with GET requests only, sending the key only as the bearer", async () => {
    const { seen, impl } = stub(lists);
    const out = await runFireworksCheck(base({ fetch: impl }));
    expect(out.code).toBe(0);
    expect(seen.length).toBe(6);
    expect(seen.every((s) => s.method === "GET")).toBe(true);
    expect(seen.every((s) => s.authorization === `Bearer ${KEY}` && !s.url.includes(KEY))).toBe(true);
    const text = out.lines.join("\n");
    expect(text).toContain("models: 1");
    expect(text).toContain("deployments: 0");
    expect(text).toContain("creditRedemptions: 1");
    expect(text).toContain("rated spend 2026-10-01 to now: US$1.25");
    expect(text).toContain("credit balance: not exposed");
    expect(text).not.toContain(KEY);
  });

  it("follows page tokens", async () => {
    let page = 0;
    const { seen, impl } = stub({
      ...lists,
      "GET /models": () =>
        page++ === 0
          ? { status: 200, body: { models: [{ name: "a" }], nextPageToken: "p2" } }
          : { status: 200, body: { models: [{ name: "b" }] } },
    });
    const out = await runFireworksCheck(base({ fetch: impl }));
    expect(out.lines).toContain("models: 2");
    expect(seen.filter((s) => s.url.includes("/models?")).at(-1)?.url).toContain("pageToken=p2");
  });

  it("fails with Fireworks' message and never echoes the key", async () => {
    const { impl } = stub({ "GET /models": { status: 401, body: { message: `bad key ${KEY}` } } });
    const out = await runFireworksCheck(base({ fetch: impl }));
    expect(out.code).toBe(1);
    expect(out.lines.join("\n")).toContain("HTTP 401");
    expect(out.lines.join("\n")).not.toContain(KEY);
  });

  it("refuses before sending when the vault cannot be read or is empty", async () => {
    const { seen, impl } = stub(lists);
    const failed = await runFireworksCheck(
      base({
        fetch: impl,
        readKey: async () => {
          throw new Error("no vault");
        },
      }),
    );
    const empty = await runFireworksCheck(base({ fetch: impl, readKey: async () => "" }));
    expect([failed.code, empty.code]).toEqual([2, 2]);
    expect(seen.length).toBe(0);
  });
});

describe("which key", () => {
  it("runs the probe on the operator's own key and every other mode on the admin service account", async () => {
    const asked: string[] = [];
    const readKey = async (item: string) => {
      asked.push(item);
      return KEY;
    };
    await runFireworksCheck(base({ fetch: stub(lists).impl, readKey }));
    await runFireworksCheck(base({ fetch: stub({}).impl, readKey, mode: { kind: "delete-probe" } }));
    await runFireworksCheck(base({ fetch: stub({}).impl, readKey, mode: imageProbe }));
    expect(asked).toEqual(["IsItLegit Fireworks Admin", "IsItLegit Fireworks Admin", "IsItLegit Fireworks Owner"]);
  });

  it("names the empty item when the owner key is not filled yet", async () => {
    const { seen, impl } = stub({});
    const out = await runFireworksCheck(base({ fetch: impl, readKey: async () => "", mode: imageProbe }));
    expect(out.code).toBe(2);
    expect(out.lines).toContain('refused: the vault item "IsItLegit Fireworks Owner" has an empty credential');
    expect(seen).toHaveLength(0);
  });
});

describe("--job", () => {
  it("reads one running job with a single GET and calls its bill pending", async () => {
    const { seen, impl } = stub({
      "GET /supervisedFineTuningJobs/abc": { status: 200, body: { name: "j", state: "JOB_STATE_RUNNING" } },
    });
    const out = await runFireworksCheck(base({ fetch: impl, mode: { kind: "job", id: "abc" } }));
    expect(seen.map((s) => s.method)).toEqual(["GET"]);
    expect(out.lines).toContain("probe job abc: JOB_STATE_RUNNING");
    expect(out.lines).toContain("  outcome: running");
    expect(out.lines).toContain("  bill: pending until the job ends (rated costs lag)");
  });

  it("reads a settled job's training usage and rated spend over its window, GET only", async () => {
    const { seen, impl } = stub({
      "GET /supervisedFineTuningJobs/abc": {
        status: 200,
        body: {
          state: "JOB_STATE_FAILED",
          status: { message: "image inputs are not supported" },
          createTime: "2026-10-27T10:00:00Z",
          completedTime: "2026-10-27T11:00:00Z",
        },
      },
      "GET /billingUsage": { status: 200, body: { trainingCosts: [{ jobId: "abc" }] } },
      "GET /billing/summary": { status: 200, body: { lineItems: [] } },
    });
    const out = await runFireworksCheck(base({ fetch: impl, mode: { kind: "job", id: "abc" } }));
    expect(seen.every((s) => s.method === "GET")).toBe(true);
    expect(seen.find((s) => s.url.includes("/billingUsage"))?.url).toContain("usageType=TRAINING");
    expect(seen.find((s) => s.url.includes("/billing/summary"))?.url).toContain("startTime=2026-10-27T10%3A00%3A00Z");
    expect(out.lines).toContain("  outcome: image-refused");
    expect(out.lines).toContain("  bill: US$0.00 of training rated in the job's window");
  });

  it("shows a failed billing read as unavailable, never as zero", async () => {
    const { impl } = stub({
      "GET /supervisedFineTuningJobs/abc": {
        status: 200,
        body: {
          state: "JOB_STATE_COMPLETED",
          createTime: "2026-10-27T10:00:00Z",
          completedTime: "2026-10-27T11:00:00Z",
        },
      },
      "GET /billingUsage": { status: 500, body: { message: "down" } },
    });
    const out = await runFireworksCheck(base({ fetch: impl, mode: { kind: "job", id: "abc" } }));
    expect(out.lines.find((l) => l.includes("bill:"))).toMatch(
      /^ {2}bill: unavailable \(GET \/billingUsage.* HTTP 500: down\)$/,
    );
    expect(out.lines.join("\n")).not.toContain("US$0.00");
  });
});

describe("probe outcome", () => {
  it("decides a mode only from a completed job or an image-specific refusal", () => {
    expect(probeOutcome("JOB_STATE_COMPLETED", "")).toBe("completed");
    expect(probeOutcome("JOB_STATE_FAILED", "Model does not support image inputs")).toBe("image-refused");
    expect(probeOutcome("JOB_STATE_FAILED", "vision fine-tuning is not supported")).toBe("image-refused");
    // A decode error or an outage says nothing about whether images can train (completion review G4).
    expect(probeOutcome("JOB_STATE_FAILED", "Image decode failed: invalid PNG")).toBe("unresolved");
    expect(probeOutcome("JOB_STATE_FAILED", "image service temporarily unavailable")).toBe("unresolved");
    expect(probeOutcome("JOB_STATE_FAILED", "Unsupported image format: only JPEG is accepted")).toBe("unresolved");
    expect(probeOutcome("JOB_STATE_FAILED", "Image resolution is not supported")).toBe("unresolved");
    expect(probeOutcome("JOB_STATE_FAILED", "images larger than 4096 tokens are not supported")).toBe("unresolved");
    expect(probeOutcome("JOB_STATE_FAILED", "quota exceeded")).toBe("unresolved");
    expect(probeOutcome("JOB_STATE_CANCELLED", "")).toBe("unresolved");
    expect(probeOutcome("JOB_STATE_FAILED", "imagery licence")).toBe("unresolved");
    expect(probeOutcome("JOB_STATE_RUNNING", "")).toBe("running");
  });
});

describe("bill state", () => {
  const ended = "2026-10-27T11:00:00Z";
  const settled = new Date(Date.parse(ended) + BILL_SETTLE_MS);
  it("is pending until a day after the job ends", () => {
    const early = billingState({
      jobId: "p",
      completedTime: ended,
      now: new Date(settled.getTime() - 1),
      trainingJobIds: [],
      lineItems: [],
    });
    expect(early).toEqual({ kind: "pending", until: settled.toISOString() });
  });
  it("is unattributable when another job trained in the window", () => {
    const bill = billingState({
      jobId: "p",
      completedTime: ended,
      now: settled,
      trainingJobIds: ["p", "other"],
      lineItems: [],
    });
    expect(bill).toEqual({ kind: "unattributable", jobs: ["other"] });
  });
  it("is unavailable when a read failed or is missing", () => {
    expect(billingState({ jobId: "p", completedTime: ended, now: settled, error: "HTTP 500" }).kind).toBe(
      "unavailable",
    );
    expect(billingState({ jobId: "p", completedTime: ended, now: settled, trainingJobIds: [] }).kind).toBe(
      "unavailable",
    );
  });
  it("counts only training as the job's bill and lists other spend apart", () => {
    const bill = billingState({
      jobId: "p",
      completedTime: ended,
      now: settled,
      trainingJobIds: ["p"],
      lineItems: [
        { series: "training", totalCost: { units: "2", nanos: 500000000 } },
        { series: "serverless", totalCost: "0.25" },
      ],
    });
    expect(describeBill(bill)).toBe(
      "bill: US$2.50 of training rated in the job's window (training US$2.50); not the job's, excluded: serverless US$0.25",
    );
  });
});

describe("probe lines", () => {
  it("makes three chat lines with one base64 image part each and our fixtures' answers", () => {
    const facts = JSON.parse(readFileSync(join(import.meta.dirname, "../fixtures/meta-smoke/fixtures.json"), "utf-8"));
    const lines = probeLines().map((line) => JSON.parse(JSON.stringify(line)));
    expect(lines.length).toBe(3);
    for (const line of lines) {
      const parts = line.messages[0].content as { type: string; image_url?: { url: string } }[];
      expect(parts.filter((p) => p.type === "image_url").length).toBe(1);
      expect(parts.find((p) => p.type === "image_url")?.image_url?.url).toMatch(
        /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/,
      );
      expect(line.messages[1].role).toBe("assistant");
    }
    expect(lines[0].messages[1].content).toBe(facts.code);
  });

  it("makes a text control with the same answers and no image part", () => {
    const image = probeLines("image");
    const text = probeLines("text");
    expect(text.map((l) => l.messages.at(1)?.content)).toEqual(image.map((l) => l.messages.at(1)?.content));
    expect(JSON.stringify(text)).not.toContain("image_url");
    expect(text.every((l) => typeof l.messages.at(0)?.content === "string")).toBe(true);
  });
});

describe("--probe", () => {
  // The probe's dataset is absent until it is created, then READY; the job comes back under the pinned name.
  const fresh = (name: string) => {
    let created = false;
    return {
      "POST /datasets": () => {
        created = true;
        return { status: 200, body: { name: `accounts/rizonetech/datasets/${name}` } };
      },
      [`GET /datasets/${name}`]: () =>
        created ? { status: 200, body: { state: "READY" } } : { status: 404, body: { message: "not found" } },
      [`POST /datasets/${name}:upload`]: { status: 200, body: {} },
      "POST /supervisedFineTuningJobs": {
        status: 200,
        body: { name: `accounts/rizonetech/supervisedFineTuningJobs/${name}`, state: "JOB_STATE_CREATING" },
      },
    } as Record<string, Reply | ((seen: Seen) => Reply)>;
  };

  it("uploads the three lines and starts one SFT job on Glimmer under the pinned job ID", async () => {
    const { seen, impl } = stub(fresh(PROBE));
    const out = await runFireworksCheck(base({ fetch: impl, mode: imageProbe }));
    expect(out.code).toBe(0);
    expect(readFileSync(join(DIR, "probe.jsonl"), "utf-8").trim().split("\n").length).toBe(3);
    const create = seen.find((s) => s.method === "POST" && s.url.endsWith("/datasets"));
    expect(create?.body).toMatchObject({ datasetId: PROBE, dataset: { format: "CHAT", exampleCount: "3" } });
    const upload = seen.find((s) => s.url.endsWith(`/datasets/${PROBE}:upload`));
    expect(upload?.body).toBeInstanceOf(FormData);
    const job = seen.find((s) => s.url.includes("/supervisedFineTuningJobs?"));
    expect(job?.url).toContain(`supervisedFineTuningJobId=${PROBE}`);
    expect(job?.body).toEqual({
      displayName: "IsItLegit image probe",
      baseModel: BASE_MODEL,
      dataset: `accounts/rizonetech/datasets/${PROBE}`,
      outputModel: `accounts/rizonetech/models/${PROBE}`,
      epochs: 1,
    });
    expect(out.lines.at(-1)).toBe(`started job supervisedFineTuningJobs/${PROBE}: JOB_STATE_CREATING`);
  });

  it("fails when the job comes back under another name", async () => {
    const { impl } = stub({
      ...fresh(PROBE),
      "POST /supervisedFineTuningJobs": {
        status: 200,
        body: { name: "accounts/rizonetech/supervisedFineTuningJobs/0b1c", state: "JOB_STATE_CREATING" },
      },
    });
    const out = await runFireworksCheck(base({ fetch: impl, mode: imageProbe }));
    expect(out.code).toBe(1);
    expect(out.lines.at(-1)).toContain("supervisedFineTuningJobs/0b1c");
  });

  it("runs the text control under its own names only", async () => {
    const { seen, impl } = stub(fresh(PROBE_TEXT));
    const out = await runFireworksCheck(base({ fetch: impl, mode: { kind: "probe", variant: "text" } }));
    expect(out.code).toBe(0);
    expect(readFileSync(join(DIR, "probe-text.jsonl"), "utf-8")).not.toContain("image_url");
    // The text control has its own file: the image probe is never overwritten (completion review G2).
    expect(existsSync(join(DIR, "probe.jsonl"))).toBe(false);
    const writes = seen.filter((s) => s.method !== "GET");
    expect(
      writes.every(
        (s) => s.url.includes(PROBE_TEXT) || (s.body as { datasetId?: string } | undefined)?.datasetId === PROBE_TEXT,
      ),
    ).toBe(true);
    const job = seen.find((s) => s.url.includes("/supervisedFineTuningJobs?"));
    expect(job?.body).toMatchObject({ outputModel: `accounts/rizonetech/models/${PROBE_TEXT}` });
  });

  it("refuses on and after 2026-12-01 SAST without a request, and runs the instant before", async () => {
    const late = stub(fresh(PROBE));
    const refused = await runFireworksCheck(base({ fetch: late.impl, mode: imageProbe, now: () => PROBE_CUTOFF }));
    expect(refused.code).toBe(2);
    expect(late.seen.length).toBe(0);
    const early = stub(fresh(PROBE));
    const before = await runFireworksCheck(
      base({ fetch: early.impl, mode: imageProbe, now: () => new Date(PROBE_CUTOFF.getTime() - 1) }),
    );
    expect(before.code).toBe(0);
  });

  it("refuses while any probe resource exists, sending nothing but reads", async () => {
    const { seen, impl } = stub({ ...fresh(PROBE), [`GET /models/${PROBE}`]: { status: 200, body: { name: PROBE } } });
    const out = await runFireworksCheck(base({ fetch: impl, mode: imageProbe }));
    expect(out.code).toBe(2);
    expect(seen.every((s) => s.method === "GET")).toBe(true);
  });

  it("starts no job while the dataset never becomes READY", async () => {
    let reads = 0;
    const { seen, impl } = stub({
      ...fresh(PROBE),
      [`GET /datasets/${PROBE}`]: () =>
        reads++ === 0 ? { status: 404 } : { status: 200, body: { state: "UPLOADING" } },
    });
    const out = await runFireworksCheck(base({ fetch: impl, mode: imageProbe, datasetWaitMs: 5 }));
    expect(out.code).toBe(1);
    expect(seen.some((s) => s.method === "POST" && s.url.includes("/supervisedFineTuningJobs"))).toBe(false);
  });
});

describe("--delete-probe", () => {
  // Each probe resource exists until its DELETE, then reads as gone (or, when it is `sticky`, survives it).
  function account(sticky = "") {
    const gone = new Set<string>();
    const routes: Record<string, (seen: Seen) => Reply> = {};
    for (const name of [PROBE, PROBE_TEXT])
      for (const path of [`/supervisedFineTuningJobs/${name}`, `/models/${name}`, `/datasets/${name}`]) {
        routes[`GET ${path}`] = () => (gone.has(path) ? { status: 404 } : { status: 200, body: {} });
        routes[`DELETE ${path}`] = () => {
          if (path !== sticky) gone.add(path);
          return { status: 200, body: {} };
        };
      }
    return routes;
  }

  it("deletes exactly both probes' job, model and dataset, reading each back", async () => {
    const { seen, impl } = stub(account());
    const out = await runFireworksCheck(base({ fetch: impl, mode: { kind: "delete-probe" } }));
    expect(out.code).toBe(0);
    const deleted = seen.filter((s) => s.method === "DELETE").map((s) => s.url.slice(API.length));
    expect(deleted).toEqual(
      [PROBE, PROBE_TEXT].flatMap((n) => [`/supervisedFineTuningJobs/${n}`, `/models/${n}`, `/datasets/${n}`]),
    );
    expect(seen.every((s) => s.method === "GET" || s.method === "DELETE")).toBe(true);
    expect(seen.filter((s) => s.method === "GET").length).toBe(12);
  });

  it("fails when a read-back still finds a deleted resource", async () => {
    const { impl } = stub(account(`/models/${PROBE}`));
    const out = await runFireworksCheck(base({ fetch: impl, mode: { kind: "delete-probe" } }));
    expect(out.code).toBe(1);
    expect(out.lines).toContain(`model ${PROBE} still exists after its DELETE`);
  });

  it("sends no DELETE for what is absent", async () => {
    const { seen, impl } = stub({});
    const out = await runFireworksCheck(base({ fetch: impl, mode: { kind: "delete-probe" } }));
    expect(out.code).toBe(0);
    expect(seen.some((s) => s.method === "DELETE")).toBe(false);
  });
});

describe("malformed answers", () => {
  it("reads a success that is not JSON as no answer, never as an empty account", async () => {
    const html = (async () => new Response("<html>gateway error</html>", { status: 200 })) as typeof fetch;
    const out = await runFireworksCheck(base({ fetch: html }));
    expect(out.code).toBe(1);
    expect(out.lines.join("\n")).toContain("not JSON");
    expect(out.lines.join("\n")).not.toContain("models: 0");
  });

  it("reads an empty success as no answer, never as zero spend", async () => {
    const emptyBilling = stub({ ...lists, "GET /billing/summary": { status: 200 } });
    const out = await runFireworksCheck(base({ fetch: emptyBilling.impl }));
    expect(out.code).toBe(1);
    expect(out.lines.join("\n")).toContain("empty body");
    expect(out.lines.join("\n")).not.toContain("US$0.00");
    const emptyList = stub({ ...lists, "GET /models": { status: 200 } });
    expect((await runFireworksCheck(base({ fetch: emptyList.impl }))).code).toBe(1);
  });

  it("refuses a collection that is not a list and a cost that is not an amount", async () => {
    const notList = stub({ ...lists, "GET /models": { status: 200, body: { models: "none" } } });
    expect((await runFireworksCheck(base({ fetch: notList.impl }))).code).toBe(1);
    const badCost = stub({
      ...lists,
      "GET /billing/summary": { status: 200, body: { lineItems: [{ series: "training", totalCost: "n/a" }] } },
    });
    const out = await runFireworksCheck(base({ fetch: badCost.impl }));
    expect(out.code).toBe(1);
    expect(out.lines.join("\n")).toContain("not an amount");
    expect(out.lines.join("\n")).not.toContain("US$0.00");
  });
});

describe("--write-probe-lines", () => {
  it("writes both probe files without a key or a request", async () => {
    const { seen, impl } = stub({});
    const readKey = async () => {
      throw new Error("no key needed");
    };
    const out = await runFireworksCheck(
      base({ fetch: impl, readKey, mode: { kind: "write-probe-lines" }, probeTextFile: join(DIR, "probe-text.jsonl") }),
    );
    expect(out.code).toBe(0);
    expect(seen).toHaveLength(0);
    const image = readFileSync(join(DIR, "probe.jsonl"), "utf-8").trim().split("\n");
    const text = readFileSync(join(DIR, "probe-text.jsonl"), "utf-8").trim().split("\n");
    expect([image.length, text.length]).toEqual([3, 3]);
    expect(image.every((line) => line.includes("image_url"))).toBe(true);
    expect(text.some((line) => line.includes("image_url"))).toBe(false);
  });

  it("keeps the earlier files and says why when it cannot write", async () => {
    const folder = join(DIR, "locked");
    mkdirSync(folder);
    writeFileSync(join(folder, "probe.jsonl"), "earlier\n");
    chmodSync(folder, 0o500);
    try {
      const out = await runFireworksCheck(
        base({
          mode: { kind: "write-probe-lines" },
          probeFile: join(folder, "probe.jsonl"),
          probeTextFile: join(folder, "probe-text.jsonl"),
        }),
      );
      expect(out.code).toBe(1);
      expect(out.lines.at(-1)).toContain("could not write");
      expect(readFileSync(join(folder, "probe.jsonl"), "utf-8")).toBe("earlier\n");
    } finally {
      chmodSync(folder, 0o700);
    }
  });
});

describe("arguments", () => {
  it("takes one mode and a safe job ID", () => {
    expect(parseCheckArgs([]).mode).toEqual({ kind: "list" });
    expect(parseCheckArgs(["--probe"]).mode).toEqual({ kind: "probe", variant: "image" });
    expect(parseCheckArgs(["--probe", "text"]).mode).toEqual({ kind: "probe", variant: "text" });
    expect(parseCheckArgs(["--job", "abc-1"]).mode).toEqual({ kind: "job", id: "abc-1" });
    expect(() => parseCheckArgs(["--probe", "video"])).toThrow();
    expect(() => parseCheckArgs(["text"])).toThrow();
    expect(() => parseCheckArgs(["--probe", "--delete-probe"])).toThrow();
    expect(parseCheckArgs(["--write-probe-lines"]).mode).toEqual({ kind: "write-probe-lines" });
    expect(() => parseCheckArgs(["--job", "../models"])).toThrow();
  });
});

describe("network", () => {
  it("gives each address long enough to connect from South Africa to US West", () => {
    const before = getDefaultAutoSelectFamilyAttemptTimeout();
    try {
      configureNetwork();
      expect(getDefaultAutoSelectFamilyAttemptTimeout()).toBe(CONNECT_ATTEMPT_MS);
      expect(CONNECT_ATTEMPT_MS).toBeGreaterThanOrEqual(1_000);
    } finally {
      setDefaultAutoSelectFamilyAttemptTimeout(before);
    }
  });
});
