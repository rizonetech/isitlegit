// Training copies (D05 T04 §10): one copy per labelled finding, the completion marker last,
// none for an unlabelled or missing page, and the copy kept after the case artefacts go.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { copyForTraining } from "../../src/monitor/training";
import { fakeJpeg } from "../fixtures/jpeg";

const bucket = env.ARTEFACTS;
const KEY = "monitor/org-1/fake.example/2026-11-02T03:00:00.000Z/";

async function seedCapture() {
  await bucket.put(`${KEY}screenshot.jpg`, fakeJpeg(1280, 800, 1000));
  await bucket.put(`${KEY}text.txt`, "Sign in to your Fynbos account");
}

describe("copyForTraining", () => {
  it("copies the fetched page once with its provenance, marker last", async () => {
    await seedCapture();
    const copy = {
      orgId: "org-1",
      host: "fake.example",
      captureKey: KEY,
      captureUrl: "https://fake.example/",
      label: "lure" as const,
      why: "confirmed",
      source: "pipeline" as const,
    };
    expect(await copyForTraining(bucket, copy)).toBe("copied");
    expect(await copyForTraining(bucket, copy)).toBe("exists");
    const meta = await bucket.get(`training/${KEY}meta.json`);
    expect(meta).not.toBeNull();
    const parsed = JSON.parse(await (meta as NonNullable<typeof meta>).text()) as {
      label: string;
      host: string;
      url: string;
    };
    expect(parsed.label).toBe("lure");
    expect(parsed.host).toBe("fake.example");
    expect(parsed.url).toBe("https://fake.example/");
    expect(await bucket.head(`training/${KEY}done.json`)).not.toBeNull();
    // The case's own artefacts are deleted at 30 days; the training copy stays.
    await bucket.delete(`${KEY}screenshot.jpg`);
    await bucket.delete(`${KEY}text.txt`);
    expect(await bucket.head(`training/${KEY}screenshot.jpg`)).not.toBeNull();
  });

  it("states a missing source and writes no marker", async () => {
    const missing = await copyForTraining(bucket, {
      orgId: "org-1",
      host: "gone.example",
      captureKey: "monitor/org-1/gone.example/2026-11-02T03:00:00.000Z/",
      captureUrl: null,
      label: "benign",
      why: "dismissed",
      source: "dismissal",
    });
    expect(missing).toBe("missing-source");
    expect(await bucket.head("training/monitor/org-1/gone.example/2026-11-02T03:00:00.000Z/done.json")).toBeNull();
  });
});
