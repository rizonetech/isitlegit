import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { createBody } from "../../scripts/glimmer/deploy.ts";
import { operationalRelease } from "../../scripts/glimmer/operational-release.ts";
import type { Exec } from "../../src/vision/glimmer-minutes.ts";
import { SCREENER_SYSTEM_PROMPT_V1_1 } from "../../src/vision/page-screen.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
async function run(mode: string) {
  const root = mkdtempSync(join(tmpdir(), "loupe-operational-"));
  dirs.push(root);
  mkdirSync(join(root, "src/vision"), { recursive: true });
  const artifactRecord = join(root, "output-model.json");
  writeFileSync(
    artifactRecord,
    '{"model_id":"isitlegit-loupe-1-1","checkpoint":"step-4524","job_id":"ts-db85d8de82174aa6824b775ca6e40075"}\n',
  );
  if (mode === "wrong-artifact") writeFileSync(artifactRecord, "{}");
  const active = join(root, "src/vision/glimmer-active.json");
  writeFileSync(active, JSON.stringify({ version: "1.0", deployment: "isitlegit-loupe", previous: null }));
  const db = new DatabaseSync(":memory:");
  for (const name of ["0056_glimmer_runtime.sql", "0064_glimmer_runtime_deployment.sql"])
    db.exec(readFileSync(join(import.meta.dirname, "../../src/db/migrations", name), "utf8"));
  const ledger: Exec = async ({ sql, params }) => {
    if (mode === "ledger-offline") throw new Error("test ledger unavailable");
    const st = db.prepare(sql);
    return /^\s*SELECT/i.test(sql)
      ? { rows: st.all(...params) as Record<string, unknown>[], changes: 0 }
      : { rows: [], changes: Number(st.run(...params).changes) };
  };
  let time = Date.parse("2026-11-04T21:00:00Z");
  let created = false;
  let requests = 0;
  const result = await operationalRelease({
    root,
    artifactRecord,
    evidenceDir: join(root, "evidence"),
    adminKey: "test",
    inferenceKey: "test",
    ledger,
    messages: [
      { role: "system", content: SCREENER_SYSTEM_PROMPT_V1_1 },
      { role: "user", content: "Synthetic page" },
    ],
    now: () => time,
    sleep: async (ms) => {
      time += ms;
    },
    gate: () => ({ verdict: "missing", detail: "independent evidence absent" }),
    fetcher: async (url, init) => {
      if (url.includes("chat/completions")) {
        requests++;
        time += 1000;
        return Response.json({
          id: "actual-test-provider-id",
          choices: [
            {
              message: {
                content: JSON.stringify({
                  has_login_form: true,
                  has_payment_form: false,
                  lure: true,
                  lure_type: "credential",
                  confidence: 0.7,
                  ...(mode === "invalid" ? { brand: null } : {}),
                }),
              },
              finish_reason: "stop",
            },
          ],
        });
      }
      if (url.includes("/models/"))
        return Response.json({
          name: "accounts/rizonetech/models/isitlegit-loupe-1-1",
          state: mode === "wrong-registration" ? "FAILED" : "READY",
          kind: "HF_PEFT_ADDON",
          peftDetails: { baseModel: "accounts/fireworks/models/muse-glimmer-30b", r: 8 },
        });
      if (url.endsWith(":match"))
        return Response.json({
          deploymentShapeVersions: [
            {
              name: "accounts/fireworks/deploymentShapes/test/versions/v1",
              validated: true,
              snapshot: { acceleratorType: "NVIDIA_H200_141GB", acceleratorCount: 1 },
            },
          ],
        });
      if (init.method === "POST") {
        const rows = db.prepare("SELECT * FROM glimmer_runtime").all();
        expect(rows).toHaveLength(1);
        expect(rows[0]?.deployment).toBe("isitlegit-loupe-1-1");
        expect(rows[0]?.reserved_minutes).toBe(34);
        expect(JSON.parse(String(init.body)).deploymentShape).toContain("/versions/");
        created = true;
      }
      const candidate = url.includes("isitlegit-loupe-1-1");
      if (candidate && !created) return new Response(null, { status: 404 });
      return Response.json({
        ...createBody(candidate ? "1.1" : "1.0"),
        state: "READY",
        replicaCount: mode === "unknown-zero" && candidate ? 1 : 0,
        acceleratorType: "NVIDIA_H200_141GB",
        acceleratorCount: 1,
      });
    },
  });
  return {
    result,
    active: JSON.parse(readFileSync(active, "utf8")),
    rows: db.prepare("SELECT * FROM glimmer_runtime").all(),
    requests,
  };
}
it("reserves before capacity creation and binds actual strict smoke while retaining unmet statistical gate", async () => {
  const out = await run("ok");
  expect(out.requests).toBe(1);
  expect(out.result.accounting).toBe("settled");
  expect(out.active).toMatchObject({ version: "1.1", previous: { version: "1.0", deployment: "isitlegit-loupe" } });
  expect(out.result.result).toMatchObject({
    outcome: "promoted",
    releaseEvidence: {
      statisticalQualification: false,
      statisticalGate: { verdict: "missing" },
      smoke: { providerRequestId: "actual-test-provider-id" },
    },
  });
});
it("rejects a brand-bearing answer without changing the active version", async () => {
  const out = await run("invalid");
  expect(out.active.version).toBe("1.0");
  expect(out.result.result.outcome).toBe("failed");
});
it("retains reserved liability when zero replicas cannot be verified", async () => {
  const out = await run("unknown-zero");
  expect(out.result.accounting).toContain("reservation retained");
  expect(out.rows[0]?.settled_at).toBeNull();
});

it("refuses capacity creation and inference when admission cannot be durably reserved", async () => {
  const out = await run("ledger-offline");
  expect(out.requests).toBe(0);
  expect(out.active.version).toBe("1.0");
  expect(out.result.result.outcome).toBe("refused");
  expect(out.rows).toHaveLength(0);
});

it("refuses altered output metadata before any provider operation", async () => {
  await expect(run("wrong-artifact")).rejects.toThrow("output model record hash differs");
});
it("refuses a model registration that is not ready before provisioning", async () => {
  const out = await run("wrong-registration");
  expect(out.active.version).toBe("1.0");
  expect(out.requests).toBe(0);
  expect(out.rows).toHaveLength(0);
  expect(out.result.result.outcome).toBe("failed");
});
