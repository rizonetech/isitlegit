import { describe, expect, it } from "vitest";
import {
  DIAGNOSTIC_RATE,
  diagnosticModel,
  PAIR_RESERVE_USD,
  verifyTarget,
} from "../../scripts/glimmer/diagnostic-pair.ts";

describe("accounted diagnostic target", () => {
  const target = {
    name: "accounts/rizonetech/deployments/isitlegit-loupe-eval-1-1",
    baseModel: "accounts/rizonetech/models/isitlegit-loupe-1-1",
    state: "READY",
    minReplicaCount: 0,
    maxReplicaCount: 1,
    preemptible: true,
    acceleratorType: "NVIDIA_H200_141GB",
    acceleratorCount: 1,
    autoscalingPolicy: { scaleToZeroWindow: "300s" },
  };
  it("uses an explicit isolated deployment, never ambiguous production model routing", () => {
    expect(diagnosticModel("1.1")).toBe(`${target.baseModel}#${target.name}`);
    expect(() => diagnosticModel("2.0")).toThrow();
    expect(diagnosticModel("1.1", "abcdef01")).toBe(`${target.baseModel}#${target.name}-abcdef01`);
    expect(() => diagnosticModel("1.1", "production")).toThrow();
  });
  it("checks actual artifact, GPU price, replica and idle settings before inference", () => {
    expect(() => verifyTarget(target, "1.1")).not.toThrow();
    for (const patch of [
      { baseModel: "other" },
      { name: "accounts/rizonetech/deployments/isitlegit-loupe" },
      { acceleratorCount: 2 },
      { acceleratorType: "NVIDIA_B200_180GB" },
      { maxReplicaCount: 2 },
      { minReplicaCount: 1 },
      { preemptible: false },
      { state: "CREATING" },
      { autoscalingPolicy: { scaleToZeroWindow: "3600s" } },
    ])
      expect(() => verifyTarget({ ...target, ...patch }, "1.1")).toThrow();
  });
  it("reserves published H200 rate plus regional premium within the authorized pair limit", () => {
    expect(DIAGNOSTIC_RATE).toBe(12);
    expect(PAIR_RESERVE_USD).toBeLessThanOrEqual(20);
  });
});

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach } from "vitest";
import { executeSlot, RESERVE_MINUTES } from "../../scripts/glimmer/diagnostic-pair.ts";
import type { Exec } from "../../src/vision/glimmer-minutes.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture(mode = "ok") {
  const output = mkdtempSync(join(tmpdir(), "loupe-diagnostic-"));
  dirs.push(output);
  const db = new DatabaseSync(":memory:");
  for (const migration of ["0056_glimmer_runtime.sql", "0064_glimmer_runtime_deployment.sql"])
    db.exec(readFileSync(join(import.meta.dirname, "../../src/db/migrations", migration), "utf8"));
  const ledger: Exec = async ({ sql, params }) => {
    const stmt = db.prepare(sql);
    return /^\s*SELECT/i.test(sql)
      ? { rows: stmt.all(...params) as Record<string, unknown>[], changes: 0 }
      : { rows: [], changes: Number(stmt.run(...params).changes) };
  };
  let time = Date.parse("2026-11-04T20:00:00Z");
  let exists = mode === "already-active";
  let deleted = false;
  const events: string[] = [];
  const target = {
    name: "accounts/rizonetech/deployments/isitlegit-loupe-eval-1-1",
    baseModel: "accounts/rizonetech/models/isitlegit-loupe-1-1",
    state: "READY",
    minReplicaCount: 0,
    maxReplicaCount: 1,
    preemptible: true,
    acceleratorType: "NVIDIA_H200_141GB",
    acceleratorCount: 1,
    autoscalingPolicy: { scaleToZeroWindow: "300s" },
  };
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    events.push(`${method} ${url.split("/").at(-1)}`);
    expect(init?.signal).toBeDefined();
    if (url.endsWith(":match"))
      return Response.json({
        deploymentShapeVersions: [
          { name: "accounts/fireworks/deploymentShapes/loupe/versions/v1", validated: true, snapshot: target },
        ],
      });
    if (url.includes("chat/completions")) {
      expect(JSON.parse(String(init?.body)).model).toBe(
        mode === "modality" ? target.baseModel : `${target.baseModel}#${target.name}`,
      );
      time += 1000;
      if (mode === "inference-refused") return new Response(null, { status: 404 });
      return Response.json({ choices: [{ message: { content: "{}" }, finish_reason: "stop" }] });
    }
    if (method === "POST") {
      const rows = db.prepare("SELECT * FROM glimmer_runtime").all();
      expect(rows.length).toBeGreaterThan(0);
      expect(rows[0]?.deployment).toBe("isitlegit-loupe-eval-1-1");
      expect(rows[0]?.reserved_minutes).toBe(mode.startsWith("modality") ? 25 : RESERVE_MINUTES);
      expect(JSON.parse(String(init?.body)).deploymentShape).toContain("/versions/");
      if (mode === "creation-conflict") return new Response(null, { status: 409 });
      exists = true;
      return Response.json(target);
    }
    if (method === "DELETE") {
      expect(url).toContain("?ignoreChecks=true");
      if (mode === "shutdown-failure") return new Response("private error", { status: 503 });
      deleted = true;
      return Response.json({});
    }
    if (!exists) return new Response(null, { status: 404 });
    return Response.json({
      ...target,
      ...(mode === "wrong-model" ? { baseModel: "wrong" } : {}),
      ...(deleted ? { state: "DELETED" } : {}),
    });
  };
  return {
    output,
    db,
    events,
    dependencies: {
      ledger,
      modalityProbe: mode.startsWith("modality"),
      modalityRouting: mode === "modality-exact" ? ("model-deployment" as const) : ("model-only" as const),
      adminKey: "test",
      inferenceKey: "test",
      fetcher,
      now: () => time,
      evidenceDir: output,
      run: async (o: Parameters<typeof import("../../scripts/glimmer/evaluate.ts").runAnswers>[0]) => {
        expect(o.preflight?.(mode.startsWith("modality") ? 6 : 40)).toBeNull();
        expect(o.preflight?.(39)).toBeTruthy();
        expect(o.concurrency).toBe(1);
        expect(o.retryErrors).toBe(false);
        await o.ask([], "page");
        if (mode === "run-failure") throw new Error("run failed");
        const count = mode.startsWith("modality") ? 6 : 40;
        return { pages: count, skipped: 0, asked: count, answered: count, errors: 0 };
      },
    },
  };
}
describe("diagnostic lifecycle uses real runtime ledger", () => {
  it("reserves before creation, routes exactly, confirms deletion then settles actual runtime", async () => {
    const f = fixture();
    await executeSlot("1.1", "unused", f.output, f.dependencies);
    const row = f.db.prepare("SELECT * FROM glimmer_runtime").get();
    expect(row?.used_minutes).toBeCloseTo(1 / 60);
    expect(f.events.some((e) => e.startsWith("DELETE"))).toBe(true);
    f.db.close();
  });
  it("retains full unknown liability when shutdown fails", async () => {
    const f = fixture("shutdown-failure");
    await expect(executeSlot("1.1", "unused", f.output, f.dependencies)).rejects.toThrow("503");
    const row = f.db.prepare("SELECT * FROM glimmer_runtime").get();
    expect(row?.used_minutes).toBeNull();
    expect(row?.reserved_minutes).toBe(RESERVE_MINUTES);
    expect(JSON.parse(readFileSync(join(f.output, "1.1.shutdown.json"), "utf8")).confirmedDeleted).toBe(false);
    f.db.close();
  });
  it("deletes the isolated target after an evaluation error without fabricating answers", async () => {
    const f = fixture("run-failure");
    await expect(executeSlot("1.1", "unused", f.output, f.dependencies)).rejects.toThrow("run failed");
    expect(f.events.some((e) => e.startsWith("DELETE"))).toBe(true);
    f.db.close();
  });
  it("refuses wrong artifact before any inference and still shuts down", async () => {
    const f = fixture("wrong-model");
    await expect(executeSlot("1.1", "unused", f.output, f.dependencies)).rejects.toThrow("wrong artifact");
    expect(f.events.some((e) => e.includes("completions"))).toBe(false);
    expect(f.events.some((e) => e.startsWith("DELETE"))).toBe(true);
    f.db.close();
  });
  it("refuses an active target without taking ownership or writing the ledger", async () => {
    const f = fixture("already-active");
    await expect(executeSlot("1.1", "unused", f.output, f.dependencies)).rejects.toThrow("already active");
    expect(f.db.prepare("SELECT * FROM glimmer_runtime").all()).toHaveLength(0);
    expect(f.events).toHaveLength(1);
    f.db.close();
  });
  it("does not create capacity or infer when durable admission is unavailable", async () => {
    const f = fixture();
    f.dependencies.ledger = async () => {
      throw new Error("offline ledger");
    };
    await expect(executeSlot("1.1", "unused", f.output, f.dependencies)).rejects.toThrow("refused");
    expect(f.events.some((e) => e.startsWith("POST deployments?"))).toBe(false);
    expect(f.events.some((e) => e.includes("completions"))).toBe(false);
    f.db.close();
  });
  it("never deletes a conflicting target owned by another creator", async () => {
    const f = fixture("creation-conflict");
    await expect(executeSlot("1.1", "unused", f.output, f.dependencies)).rejects.toThrow("409");
    expect(f.events.some((e) => e.startsWith("DELETE"))).toBe(false);
    expect(f.db.prepare("SELECT * FROM glimmer_runtime").get()?.used_minutes).toBeNull();
    f.db.close();
  });
  it("stops on an infrastructure refusal instead of spending the rest of the cohort", async () => {
    const f = fixture("inference-refused");
    await expect(executeSlot("1.1", "unused", f.output, f.dependencies)).rejects.toThrow("no further pages sent");
    expect(f.events.filter((e) => e.includes("completions"))).toHaveLength(1);
    expect(f.events.some((e) => e.startsWith("DELETE"))).toBe(true);
    f.db.close();
  });
  it("single-page smoke never asks a second input and still closes its reservation", async () => {
    const f = fixture();
    const dependencies = {
      ...f.dependencies,
      smoke: true,
      run: async (o: Parameters<typeof import("../../scripts/glimmer/evaluate.ts").runAnswers>[0]) => {
        await o.ask([], "first");
        await expect(o.ask([], "second")).rejects.toThrow("SMOKE_COMPLETE");
        return { pages: 40, skipped: 0, asked: 1, answered: 1, errors: 0, stopped: "SMOKE_COMPLETE" };
      },
    };
    await executeSlot("1.1", "unused", f.output, dependencies);
    expect(f.events.filter((e) => e.includes("completions"))).toHaveLength(1);
    expect(f.db.prepare("SELECT * FROM glimmer_runtime").get()?.used_minutes).not.toBeNull();
    f.db.close();
  });
});

it("limits the explicit modality protocol to six pages and a five-dollar live-merge reservation", async () => {
  const f = fixture("modality");
  await executeSlot("1.1", "unused", f.output, f.dependencies);
  expect(f.db.prepare("SELECT reserved_minutes FROM glimmer_runtime").get()?.reserved_minutes).toBe(25);
  expect((25 * DIAGNOSTIC_RATE) / 60).toBe(5);
  f.db.close();
});

it("keeps the replacement six-page protocol on the established exact deployment route", async () => {
  const f = fixture("modality-exact");
  await executeSlot("1.1", "unused", f.output, f.dependencies);
  expect(f.db.prepare("SELECT reserved_minutes FROM glimmer_runtime").get()?.reserved_minutes).toBe(25);
  f.db.close();
});
