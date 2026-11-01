import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { readEvidence } from "../../src/checks/evidence";
import { createCase } from "../../src/db/cases";
import type { Store } from "../../src/intake/store";
import { d1Budget } from "../../src/meta/budget";
import { type VisionDeps, visionStep } from "../../src/vision/step";

// D03 T02 §3: the vision step's own bounds. A launch that never answers and one that refuses both end
// as a stated not_checked on the case, inside the step's deadline, with no browser and no model call.
const store: Store = { bucket: env.ARTEFACTS, db: env.DB };
const META = { META_API_KEY: "k", CF_AIG_TOKEN: "t", META_GATEWAY_URL: "https://gateway.test/v1" };

async function newCase() {
  const made = await createCase(env.DB, { orgId: "org-vision-step", channel: "email", headersAvailable: true });
  if (!made.ok) throw new Error(made.error.message);
  return made.value.id;
}

const deps = (caseId: string, launch: VisionDeps["launch"], deadlineMs?: number): VisionDeps => ({
  db: env.DB,
  store,
  launch,
  meta: { env: META, budget: d1Budget(env.DB, { caller: "vision", caseId }) },
  kv: (env as unknown as Env).CACHE,
  waitUntil: () => {},
  policy: async () => ({ ok: false, reason: "refused" }),
  ...(deadlineMs ? { deadlineMs } : {}),
});

describe("visionStep bounds", () => {
  it("states not_checked inside its deadline when the browser never launches, and when launch refuses", async () => {
    const stalled = await newCase();
    const began = Date.now();
    const out = await visionStep(
      deps(stalled, () => new Promise(() => {}), 25),
      stalled,
    );
    expect(out).toEqual({ outcome: "not_checked", reason: "timeout" });
    expect(Date.now() - began).toBeLessThan(30_000);
    const items = (await readEvidence(env.DB, stalled)).filter((e) => e.check === "vision.not_checked");
    expect(items).toHaveLength(1);
    expect(items[0]?.detail).toMatchObject({ checked: false, reason: "timeout" });

    const refused = await newCase();
    const out2 = await visionStep(
      deps(refused, async () => {
        throw new Error("browser down");
      }),
      refused,
    );
    expect(out2.outcome).toBe("not_checked");
    expect((await readEvidence(env.DB, refused)).some((e) => e.check === "vision.not_checked")).toBe(true);
  }, 60_000);

  it("propagates a storage failure instead of returning an unstated not_checked", async () => {
    // When even the failure statement cannot be written, the step throws: the case must end partial,
    // never proceed to a verdict with the missing coverage concealed.
    const caseId = await newCase();
    const down = {
      prepare: () => {
        throw new Error("d1 down");
      },
    } as unknown as D1Database;
    await expect(
      visionStep(
        {
          ...deps(caseId, async () => {
            throw new Error("browser down");
          }),
          db: down,
        },
        caseId,
      ),
    ).rejects.toThrow();
  });

  it("spends and writes nothing further when the launch resolves after the deadline", async () => {
    const caseId = await newCase();
    let calls = 0;
    const base = deps(
      caseId,
      async () => {
        await new Promise((r) => setTimeout(r, 80));
        return { close: async () => {} } as never;
      },
      25,
    );
    const out = await visionStep(
      {
        ...base,
        meta: {
          ...base.meta,
          fetch: (async () => {
            calls += 1;
            throw new Error("must not be called");
          }) as typeof fetch,
        },
      },
      caseId,
    );
    expect(out).toEqual({ outcome: "not_checked", reason: "timeout" });
    await new Promise((r) => setTimeout(r, 200));
    expect(calls).toBe(0);
    const items = (await readEvidence(env.DB, caseId)).filter((e) => e.check.startsWith("vision."));
    expect(items.map((e) => e.check)).toEqual(["vision.not_checked"]);
    expect(items[0]?.detail).toMatchObject({ reason: "timeout" });
  }, 60_000);
});
