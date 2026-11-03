import { describe, expect, it } from "vitest";
import { livePolicy } from "../../src/checks/expand";
import type { Resolve } from "../../src/walkthrough/url-policy";

// D04 T02 §7: the checks side's policy adapter (`livePolicy` in src/checks/expand.ts) over
// controlled DNS answers. This is the joint proof the one-policy section requires: the same
// module answers both callers, so the allow and refuse cases the walkthrough suite proves for
// `allowedUrl` hold through the adapter the redirect checks and the agent actually call, with
// one resolution shared across a case's links.
const PUBLIC = "93.184.216.34";
const PRIVATE = "10.0.0.5";

function policy(answers: Record<string, string[] | null>) {
  const calls: string[] = [];
  const resolve: Resolve = async (name) => {
    calls.push(name);
    return answers[name] ?? null;
  };
  return { policy: livePolicy(resolve), calls };
}

describe("livePolicy, the checks side of the one URL policy", () => {
  it("allows a public name and shares one resolution across links", async () => {
    const { policy: allow, calls } = policy({ "shop.example": [PUBLIC] });
    expect((await allow("https://shop.example/pay")).ok).toBe(true);
    expect((await allow("https://shop.example/other")).ok).toBe(true);
    expect(calls).toEqual(["shop.example"]);
  });

  it("refuses what the walkthrough policy refuses: scheme, port, credentials, IP literal, local name, private answer", async () => {
    const { policy: allow } = policy({ "shop.example": [PUBLIC], "inner.example": [PRIVATE] });
    expect((await allow("file:///etc/passwd")).ok).toBe(false);
    expect((await allow("https://shop.example:8443/pay")).ok).toBe(false);
    expect((await allow("https://user:pass@shop.example/pay")).ok).toBe(false);
    expect((await allow("https://93.184.216.34/pay")).ok).toBe(false);
    expect((await allow("https://printer.local/pay")).ok).toBe(false);
    const inner = await allow("https://inner.example/pay");
    expect(inner.ok).toBe(false);
    if (!inner.ok) expect(inner.reason).toContain("non-public");
    expect((await allow("https://missing.example/pay")).ok).toBe(false);
  });
});
