import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createCase } from "../../src/db/cases";
import { ConfigError, LINK_DAYS, signReportLink, verifyReportLink } from "../../src/web/report-link";

// src/web/report-link.ts (D01 T01 §8): a reply's report link opens one case of one organisation for 7 days, and nothing
// else: a changed, malformed, expired or foreign link is refused, and the signature is keyed.
const SECRET = "test-report-link-secret-0123456789abcdef";
const OTHER = "another-report-link-secret-0123456789ab";
const CASE = "01JB2Z3Y4X5W6V7T8S9R0Q1P2N";
const NOW = Date.UTC(2026, 9, 27, 18, 0, 0);
const DAY = 24 * 60 * 60 * 1000;

async function link(caseId = CASE, orgId = "org-a", now = NOW) {
  return new URL(await signReportLink(SECRET, caseId, orgId, now), "https://isitlegit.example");
}
async function refused(url: URL | string, now = NOW) {
  const result = await verifyReportLink(SECRET, url, now);
  if (result.ok) throw new Error(`accepted ${url}`);
  return result.reason;
}
const withParam = (url: URL, name: string, value: string) => {
  const changed = new URL(url);
  changed.searchParams.set(name, value);
  return changed;
};

describe("report links", () => {
  it("signs a case created through the store and verifies it, for 7 days", async () => {
    const created = await createCase(env.DB, { orgId: "org-a", channel: "email", headersAvailable: true });
    if (!created.ok) throw new Error(created.error.message);
    const url = await link(created.value.id, created.value.orgId);
    expect(url.pathname).toBe(`/r/${created.value.id}`);
    const expires = Math.floor(NOW / 1000) + LINK_DAYS * 86_400;
    expect(await verifyReportLink(SECRET, url, NOW)).toEqual({
      ok: true,
      caseId: created.value.id,
      orgId: "org-a",
      expires,
    });
    // Accepted until its last second, refused from its expiry on.
    expect((await verifyReportLink(SECRET, url, expires * 1000 - 1000)).ok).toBe(true);
    expect(await refused(url, expires * 1000)).toBe("expired");
  });

  it("matches an HMAC-SHA256 computed outside this code, and refuses a link signed with another secret", async () => {
    // Python: hmac.new(SECRET, '["report-link:v1","01JB2Z3Y4X5W6V7T8S9R0Q1P2N","org-a",1793728800]', sha256),
    // base64url without padding. The expiry is NOW's seconds plus 7 days.
    expect(Math.floor(NOW / 1000) + 7 * 86_400).toBe(1793728800);
    const url = await link();
    expect(url.searchParams.get("s")).toBe("7CS0TcXhL5AthejKGJt7AdgFDbLgWNLqb5PIPIGP1QM");
    const foreign = new URL(await signReportLink(OTHER, CASE, "org-a", NOW), "https://isitlegit.example");
    expect(await refused(foreign)).toBe("signature");
  });

  it("keeps any organisation id the case store allows, percent-encoded", async () => {
    for (const orgId of ["org-a", "Acme & Sons / ZA", "x".repeat(200), "line\nbreak"]) {
      const url = await link(CASE, orgId);
      const result = await verifyReportLink(SECRET, url, NOW);
      expect(result.ok && result.orgId, JSON.stringify(orgId)).toBe(orgId);
    }
  });

  it("refuses a changed case, organisation or expiry, and a signature made for another version", async () => {
    const url = await link();
    const otherCase = new URL(url);
    otherCase.pathname = "/r/01JB2Z3Y4X5W6V7T8S9R0Q1P2P";
    expect(await refused(otherCase)).toBe("signature");
    expect(await refused(withParam(url, "o", "org-b"))).toBe("signature");
    expect(await refused(withParam(url, "e", String(Number(url.searchParams.get("e")) + 1)))).toBe("signature");
    // The same case, organisation and expiry signed under another label (another purpose) must not pass.
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sig = await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(JSON.stringify(["report-link:v2", CASE, "org-a", Number(url.searchParams.get("e"))])),
    );
    const v2 = btoa(String.fromCharCode(...new Uint8Array(sig)))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/, "");
    expect(await refused(withParam(url, "s", v2))).toBe("signature");
  });

  it("refuses an expiry more than 7 days ahead, a wrong path, and every malformed shape without throwing", async () => {
    const url = await link();
    // Signed a day in the future: valid in shape, but beyond what a link can live from now.
    expect(await refused(await link(CASE, "org-a", NOW + DAY))).toBe("too-far");
    for (const path of ["/report/x", `/r/${CASE}/extra`, "/r/not-a-ulid", "/"]) {
      const moved = new URL(url);
      moved.pathname = path;
      expect(await refused(moved), path).toBe("path");
    }
    const noSignature = new URL(url);
    noSignature.searchParams.delete("s");
    const repeated = new URL(url);
    repeated.searchParams.append("o", "org-b");
    const extra = withParam(url, "x", "1");
    const cases: [string, URL | string][] = [
      ["no signature", noSignature],
      ["not base64url", withParam(url, "s", `${"!".repeat(43)}`)],
      ["too short", withParam(url, "s", "abc")],
      ["too long", withParam(url, "s", "A".repeat(44))],
      ["padded", withParam(url, "s", `${url.searchParams.get("s")?.slice(0, 42)}=`)],
      ["repeated parameter", repeated],
      ["extra parameter", extra],
      ["expiry not a number", withParam(url, "e", "soon")],
      ["empty organisation", withParam(url, "o", "")],
      ["organisation too long", withParam(url, "o", "x".repeat(201))],
      ["not a URL", "http://["],
    ];
    for (const [label, bad] of cases) expect(await refused(bad), label).toBe("malformed");
  });

  it("verifies the path and query alone, as the report route receives them", async () => {
    const path = await signReportLink(SECRET, CASE, "org-a", NOW);
    expect((await verifyReportLink(SECRET, path, NOW)).ok).toBe(true);
  });

  it("refuses to sign or verify with a missing or short secret, and to sign a case id that is not a ULID", async () => {
    for (const secret of [undefined, "", "x".repeat(31)]) {
      await expect(signReportLink(secret, CASE, "org-a", NOW)).rejects.toBeInstanceOf(ConfigError);
      await expect(verifyReportLink(secret, `/r/${CASE}`, NOW)).rejects.toBeInstanceOf(ConfigError);
    }
    await expect(signReportLink("y".repeat(32), CASE, "org-a", NOW)).resolves.toMatch(/^\/r\//);
    await expect(signReportLink(SECRET, "case-1", "org-a", NOW)).rejects.toThrow("not a ULID");
    await expect(signReportLink(SECRET, CASE, "", NOW)).rejects.toThrow("1 to 200 characters");
  });
});
