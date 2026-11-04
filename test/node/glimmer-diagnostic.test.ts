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
    expect(diagnosticModel("1.1")).toBe(target.name);
    expect(() => diagnosticModel("2.0")).toThrow();
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
    name: diagnosticModel("1.1"),
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
      expect(JSON.parse(String(init?.body)).model).toBe(target.name);
      time += 1000;
      return Response.json({ choices: [{ message: { content: "{}" }, finish_reason: "stop" }] });
    }
    if (method === "POST") {
      const rows = db.prepare("SELECT * FROM glimmer_runtime").all();
      expect(rows.length).toBeGreaterThan(0);
      expect(rows[0]?.deployment).toBe("isitlegit-loupe-eval-1-1");
      expect(rows[0]?.reserved_minutes).toBe(RESERVE_MINUTES);
      expect(JSON.parse(String(init?.body)).deploymentShape).toContain("/versions/");
      exists = true;
      return Response.json(target);
    }
    if (method === "DELETE") {
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
      adminKey: "test",
      inferenceKey: "test",
      fetcher,
      now: () => time,
      evidenceDir: output,
      run: async (o: Parameters<typeof import("../../scripts/glimmer/evaluate.ts").runAnswers>[0]) => {
        expect(o.preflight?.(40)).toBeNull();
        expect(o.preflight?.(39)).toBeTruthy();
        expect(o.concurrency).toBe(1);
        expect(o.retryErrors).toBe(false);
        await o.ask([], "page");
        if (mode === "run-failure") throw new Error("run failed");
        return { pages: 40, skipped: 0, asked: 40, answered: 40, errors: 0 };
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
});
