import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

// test/end-workflows.ts: a test that starts an analysis instance and does not wait for it leaves nothing running once
// it ends. A case that does not exist fails the instance's first step, which retries with backoff: left alone, it
// would outlive its test and keep the runtime open (trust-lane run 41254406140).
const id = `leak-${crypto.randomUUID()}`;

describe("a Workflow instance a test leaves behind", () => {
  it("is started and left running", async () => {
    await env.ANALYSIS.create({ id, params: { caseId: id } });
    const { status } = await (await env.ANALYSIS.get(id)).status();
    expect(["queued", "running", "waiting"]).toContain(status);
  });

  it("is no longer running once that test has ended", async () => {
    // Disposed with its test: it is gone, or at most in an ended state, never still running.
    const status = await env.ANALYSIS.get(id)
      .then((instance) => instance.status())
      .then((s) => s.status as string)
      .catch((error: Error) => (String(error.message).includes("instance.not_found") ? "gone" : Promise.reject(error)));
    expect(["queued", "running", "waiting", "waitingForPause", "paused"]).not.toContain(status);
  });
});
