import { describe, expect, it } from "vitest";
import { FIXTURES_HOST, fixturesResponse } from "../../src/fixtures/redirects";

// Exact eval-owned asset bytes at 68d67b96e9030a79935e92a0ca9dc698030dc0dd.
// A changed page requires its owner's new contract, not a regenerated expected value.
const PAGES = [
  ["", "0948b3d667b4e900197af3e3b360fe987a11b897efb19bb3a092d12f598a2677"],
  ["lure", "0dac65e0866776ead2a8c29ccb262b5b0890850cb8654d2768323c737320b28c"],
  ["login", "23d233aae081f9947f9b6c927eae1e7884dd241821af2d2c70d45f140e77f7d8"],
  ["submitted", "36b3256012bd8b19fbefcf96cceb3bc3e9decb8418a7284895d6aa03236b383d"],
] as const;
const PREFIX = "synthetic-prefix-for-tests";
const ROOT = `https://${FIXTURES_HOST}/${PREFIX}/nimbusmail-multistep/`;
const request = (url: string, method = "GET", prefix: string | undefined = PREFIX) =>
  fixturesResponse(new Request(url, { method }), prefix);
function protections(response: Response | null) {
  expect(response?.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  expect(response?.headers.get("cache-control")).toBe("no-store");
}
async function sha256(text: string) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

describe("multi-step fixture routing", () => {
  it.each(PAGES)("serves exact authorized bytes for %s", async (path, hash) => {
    const answer = await request(ROOT + path);
    expect(answer?.status).toBe(200);
    protections(answer);
    expect(answer?.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await sha256((await answer?.text()) ?? "")).toBe(hash);
  });

  it.each(PAGES)("HEAD preserves headers without sending the %s body", async (path) => {
    const get = await request(ROOT + path);
    const head = await request(ROOT + path, "HEAD");
    expect(head?.status).toBe(200);
    if (!head || !get) throw new Error("fixture host did not handle request");
    expect([...head.headers]).toEqual([...get.headers]);
    expect(await head?.text()).toBe("");
  });

  it("canonicalizes the index before all relative navigation", async () => {
    const redirect = await request(ROOT.slice(0, -1));
    expect(redirect?.status).toBe(301);
    protections(redirect);
    expect(redirect?.headers.get("location")).toBe(`/${PREFIX}/nimbusmail-multistep/`);
    const index = (await (await request(ROOT))?.text()) ?? "";
    const lure = (await (await request(`${ROOT}lure`))?.text()) ?? "";
    const login = (await (await request(`${ROOT}login`))?.text()) ?? "";
    expect(index).toContain('location.assign("lure")');
    expect(lure).toContain('href="login"');
    expect(login).toContain('location.replace("submitted")');
    for (const [from, relative] of [
      [ROOT, "lure"],
      [`${ROOT}lure`, "login"],
      [`${ROOT}login`, "submitted"],
    ] as const) {
      const next = new URL(relative, from).href;
      expect(next).toBe(ROOT + relative);
      expect((await request(next))?.status).toBe(200);
    }
  });

  it.each(PAGES)("keeps %s inside the configured host and prefix", async (path) => {
    for (const url of [
      `https://${FIXTURES_HOST}/nimbusmail-multistep/${path}`,
      ROOT.replace(PREFIX, "wrong-prefix") + path,
    ]) {
      const answer = await request(url);
      expect(answer?.status).toBe(404);
      protections(answer);
    }
    for (const prefix of ["", "short"]) {
      const answer = await request(ROOT + path, "GET", prefix);
      expect(answer?.status).toBe(404);
      protections(answer);
    }
    const missing = await fixturesResponse(new Request(ROOT + path), undefined);
    expect(missing?.status).toBe(404);
    protections(missing);
    expect(await request((ROOT + path).replace(FIXTURES_HOST, "app.isitlegit.co.za"))).toBeNull();
  });

  it.each(["POST", "PUT", "PATCH", "DELETE", "OPTIONS"])(
    "refuses %s without a collector dependency",
    async (method) => {
      for (const [path] of PAGES) {
        const answer = await request(ROOT + path, method);
        expect(answer?.status).toBe(405);
        protections(answer);
        expect(await answer?.text()).toBe("");
      }
    },
  );

  it("keeps HEAD bodyless for existing HTML fixture routes", async () => {
    for (const path of ["nimbusmail/", "nimbusmail/login", "proteabank/", "fynbos-lookalike/"]) {
      const url = `https://${FIXTURES_HOST}/${PREFIX}/${path}`;
      const get = await request(url);
      const head = await request(url, "HEAD");
      expect(head?.status).toBe(200);
      if (!head || !get) throw new Error("fixture host did not handle request");
      expect([...head.headers]).toEqual([...get.headers]);
      expect(await head.text()).toBe("");
      expect((await get.text()).length).toBeGreaterThan(0);
    }
  });

  it("does not create route aliases for unknown paths", async () => {
    for (const path of ["unknown", "login/", "lure/", "submitted/", "index.html", "collect"]) {
      const answer = await request(ROOT + path);
      expect(answer?.status).toBe(404);
      protections(answer);
    }
  });
});
