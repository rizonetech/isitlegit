import { describe, expect, it } from "vitest";
import {
  checkReadBack,
  createBody,
  type Deployment,
  EVAL_DEPLOYMENT,
  openDeployments,
  updateBody,
} from "../../scripts/glimmer/deploy.ts";

// scripts/glimmer/deploy.ts (D03 T04 §12): one deployment, created once, scaled to zero after 5 minutes; every update
// carries only the fields its mask names, and a wrong read-back fails the command.
function fakeFireworks(start: Deployment | null, readBack?: (d: Deployment) => Deployment) {
  let current = start;
  const calls: { method: string; url: string; body?: unknown }[] = [];
  const fetcher = async (url: string, init: RequestInit) => {
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method: String(init.method), url, body });
    if (init.method === "GET")
      return current
        ? new Response(JSON.stringify(readBack ? readBack(current) : current), { status: 200 })
        : new Response("{}", { status: 404 });
    if (init.method === "POST") current = { ...body, name: "accounts/rizonetech/deployments/isitlegit-loupe" };
    if (init.method === "PATCH") current = { ...current, ...body };
    if (init.method === "DELETE") {
      const had = current;
      current = null;
      return had ? new Response("{}", { status: 200 }) : new Response("{}", { status: 404 });
    }
    return new Response(JSON.stringify(current), { status: 200 });
  };
  return { fetcher, calls };
}

describe("ensure", () => {
  it("creates the live-merge deployment once and finds it the second time", async () => {
    const { fetcher, calls } = fakeFireworks(null);
    const deployments = openDeployments("key", fetcher);
    expect((await deployments.ensure("1.0")).created).toBe(true);
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({
      baseModel: "accounts/rizonetech/models/isitlegit-loupe-1-0",
      deploymentShape: "default",
      minReplicaCount: 0,
      maxReplicaCount: 1,
      autoscalingPolicy: { scaleToZeroWindow: "300s" },
    });
    expect(calls.find((c) => c.method === "POST")?.url).toMatch(/deployments\?deploymentId=isitlegit-loupe$/);
    expect((await deployments.ensure("1.0")).created).toBe(false);
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  it("refuses to treat a deployment of another version as this one", async () => {
    const { fetcher } = fakeFireworks({ ...createBody("1.0") });
    await expect(openDeployments("key", fetcher).ensure("1.1")).rejects.toThrow(/serves .*1-0/);
  });
});

describe("updates", () => {
  it("refuse a request with no mask, and send only the masked fields", () => {
    expect(() => updateBody([], { maxReplicaCount: 1 })).toThrow(/explicit mask/);
    expect(updateBody(["maxReplicaCount"], { maxReplicaCount: 1, minReplicaCount: 3 })).toEqual({ maxReplicaCount: 1 });
    expect(() => updateBody(["minReplicaCount"], {})).toThrow(/no value/);
  });

  it("stop, start and status send and read what they say", async () => {
    const { fetcher, calls } = fakeFireworks({ ...createBody("1.0"), replicaCount: 1 });
    const deployments = openDeployments("key", fetcher);
    expect(await deployments.stop()).toMatchObject({ minReplicaCount: 0, maxReplicaCount: 0 });
    expect(calls.at(-2)).toMatchObject({ method: "PATCH", body: { minReplicaCount: 0, maxReplicaCount: 0 } });
    expect(await deployments.start()).toMatchObject({ maxReplicaCount: 1 });
    expect(calls.at(-2)).toMatchObject({ method: "PATCH", body: { maxReplicaCount: 1 } });
    expect((await deployments.status())?.replicaCount).toBe(1);
  });

  it("fail when the read-back does not show the settings asked for", async () => {
    const { fetcher } = fakeFireworks({ ...createBody("1.0") }, (d) => ({
      ...d,
      autoscalingPolicy: { scaleToZeroWindow: "3600s" },
    }));
    await expect(openDeployments("key", fetcher).start()).rejects.toThrow(/scale-to-zero 3600s/);
    expect(() =>
      checkReadBack({ minReplicaCount: 1, maxReplicaCount: 1, autoscalingPolicy: { scaleToZeroWindow: "300s" } }, 1),
    ).toThrow(/minimum 1/);
  });
});

describe("the held-out run's preemptible deployment (§13)", () => {
  it("is created on its own id, preemptible, and found the second time", async () => {
    const { fetcher, calls } = fakeFireworks(null);
    const evaluation = openDeployments("key", fetcher, EVAL_DEPLOYMENT);
    expect((await evaluation.ensurePreemptible("1.0")).created).toBe(true);
    const post = calls.find((c) => c.method === "POST");
    expect(post?.url).toMatch(/deployments\?deploymentId=isitlegit-loupe-eval$/);
    expect(post?.body).toMatchObject({
      baseModel: "accounts/rizonetech/models/isitlegit-loupe-1-0",
      preemptible: true,
    });
    expect((await evaluation.ensurePreemptible("1.0")).created).toBe(false);
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  it("is deleted and refused when it does not read back preemptible, so no run lands on held capacity", async () => {
    const { fetcher, calls } = fakeFireworks(null, ({ preemptible: _, ...rest }) => rest);
    await expect(openDeployments("key", fetcher, EVAL_DEPLOYMENT).ensurePreemptible("1.0")).rejects.toThrow(
      /did not read back preemptible/,
    );
    expect(calls.map((c) => c.method)).toContain("DELETE");
  });

  it("refuses an existing deployment that is not preemptible or serves another version", async () => {
    const plain = fakeFireworks({ ...createBody("1.0") });
    await expect(openDeployments("key", plain.fetcher, EVAL_DEPLOYMENT).ensurePreemptible("1.0")).rejects.toThrow(
      /not a preemptible deployment/,
    );
    const other = fakeFireworks({ ...createBody("1.0", true) });
    await expect(openDeployments("key", other.fetcher, EVAL_DEPLOYMENT).ensurePreemptible("1.1")).rejects.toThrow(
      /not a preemptible deployment/,
    );
  });

  it("is deleted by remove, and the dedicated deployment is never touched", async () => {
    const { fetcher, calls } = fakeFireworks({ ...createBody("1.0", true) });
    expect(await openDeployments("key", fetcher, EVAL_DEPLOYMENT).remove()).toBeNull();
    expect(calls.every((c) => c.url.includes("/deployments/isitlegit-loupe-eval"))).toBe(true);
  });
});
