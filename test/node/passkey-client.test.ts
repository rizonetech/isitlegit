import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { Browser, Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { APP_JS } from "../../src/web/assets.ts";
import { launch } from "./browser";

// D07 T02 §16: the app script's two conversions between Better Auth's JSON and WebAuthn, run in Chromium on the
// shipped script (imported as the page imports it), with known vectors both ways: the request options' challenge and
// credential ids from base64url to bytes, through the browser's own `parseRequestOptionsFromJSON` and through the
// fallback without it, and an assertion's bytes back to base64url.
const PUBLIC = join(import.meta.dirname, "../../public");
// Bytes 0..15 and their base64url (no padding, `-` and `_` where base64 has `+` and `/`).
const BYTES = Array.from({ length: 16 }, (_, i) => i);
const BYTES_B64URL = "AAECAwQFBgcICQoLDA0ODw";
// 0xfb 0xff 0xbf: "+/+/" in base64, so "-_-_" in base64url; and lengths 1, 2 and 3 mod 3 for the padding rule.
const SIGNS = [0xfb, 0xff, 0xbf, 0xfb, 0xff, 0xbf];
const SIGNS_B64URL = "-_-_-_-_";

let browser: Browser;
let server: Server;
let page: Page;
beforeAll(async () => {
  browser = await launch();
  server = createServer((req, res) => {
    if (req.url === APP_JS) {
      res.writeHead(200, { "content-type": "text/javascript" });
      return res.end(readFileSync(join(PUBLIC, APP_JS)));
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end("<!doctype html><title>t</title>");
  });
  await new Promise<void>((done) => server.listen(0, "localhost", done));
  page = await browser.newPage();
  await page.goto(`http://localhost:${(server.address() as AddressInfo).port}/`);
  // The shipped script as the page loads it, a module; its exports handed to the tests (Vite would rewrite an import()
  // written inside an evaluated function).
  await page.addScriptTag({ type: "module", content: `import * as m from "${APP_JS}"; window.appModule = m;` });
  await page.waitForFunction(() => "appModule" in window);
}, 60_000);
afterAll(async () => {
  await browser?.close();
  await new Promise<void>((done) => server?.close(() => done()));
});

type Module = {
  fromB64url: (v: string) => ArrayBuffer;
  toB64url: (b: ArrayBuffer | ArrayBufferView) => string;
  requestOptionsFromJSON: (j: unknown) => PublicKeyCredentialRequestOptions;
  assertionToJSON: (c: unknown) => Record<string, unknown> & { response: Record<string, string> };
};

describe("passkey conversions", () => {
  it("decodes and encodes base64url, every length and both URL-safe signs", async () => {
    const out = await page.evaluate(
      async ({ b, s }) => {
        const m = (window as unknown as { appModule: Module }).appModule;
        const bytes = (v: string) => Array.from(new Uint8Array(m.fromB64url(v)));
        return {
          decoded: [bytes(b), bytes(s), bytes("AA"), bytes("AAE"), bytes("AAEC")],
          encoded: [
            m.toB64url(new Uint8Array(Array.from({ length: 16 }, (_, i) => i))),
            m.toB64url(new Uint8Array([0xfb, 0xff, 0xbf, 0xfb, 0xff, 0xbf])),
          ],
          short: [
            m.toB64url(new Uint8Array([0])),
            m.toB64url(new Uint8Array([0, 1])),
            m.toB64url(new Uint8Array([0, 1, 2])),
          ],
          // A view into a larger buffer encodes its own bytes only.
          view: m.toB64url(new Uint8Array([9, 0, 1, 9]).subarray(1, 3)),
        };
      },
      { b: BYTES_B64URL, s: SIGNS_B64URL },
    );
    expect(out.decoded).toEqual([BYTES, SIGNS, [0], [0, 1], [0, 1, 2]]);
    expect(out.encoded).toEqual([BYTES_B64URL, SIGNS_B64URL]);
    expect(out.short).toEqual(["AA", "AAE", "AAEC"]);
    expect(out.view).toBe("AAE");
  });

  for (const native of [true, false])
    it(`turns Better Auth's request options into WebAuthn's (${native ? "the browser's parser" : "without it"})`, async () => {
      const out = await page.evaluate(
        async ({ b, s, native }) => {
          const m = (window as unknown as { appModule: Module }).appModule;
          const holder = PublicKeyCredential as unknown as Record<string, unknown>;
          const saved = holder.parseRequestOptionsFromJSON;
          if (!native) holder.parseRequestOptionsFromJSON = undefined;
          try {
            const options = m.requestOptionsFromJSON({
              challenge: b,
              rpId: "localhost",
              timeout: 60000,
              userVerification: "required",
              allowCredentials: [{ id: s, type: "public-key", transports: ["internal"] }],
            });
            const cred = options.allowCredentials?.[0];
            return {
              hadParser: typeof saved === "function",
              challenge: Array.from(new Uint8Array(options.challenge as ArrayBuffer)),
              id: cred ? Array.from(new Uint8Array(cred.id as ArrayBuffer)) : null,
              rest: [options.rpId, options.timeout, options.userVerification, cred?.type, cred?.transports],
            };
          } finally {
            holder.parseRequestOptionsFromJSON = saved;
          }
        },
        { b: BYTES_B64URL, s: SIGNS_B64URL, native },
      );
      if (native) expect(out.hadParser).toBe(true);
      expect(out.challenge).toEqual(BYTES);
      expect(out.id).toEqual(SIGNS);
      expect(out.rest).toEqual(["localhost", 60000, "required", "public-key", ["internal"]]);
    });

  it("turns an assertion back into the JSON verify-authentication takes", async () => {
    const out = await page.evaluate(async () => {
      const m = (window as unknown as { appModule: Module }).appModule;
      const buf = (...b: number[]) => new Uint8Array(b).buffer;
      const full = m.assertionToJSON({
        id: "-_-_-_-_",
        rawId: buf(0xfb, 0xff, 0xbf, 0xfb, 0xff, 0xbf),
        type: "public-key",
        authenticatorAttachment: "platform",
        response: { clientDataJSON: buf(0), authenticatorData: buf(0, 1), signature: buf(0, 1, 2), userHandle: buf(1) },
        getClientExtensionResults: () => ({ credProps: { rk: true } }),
      });
      const bare = m.assertionToJSON({
        id: "AA",
        rawId: buf(0),
        type: "public-key",
        authenticatorAttachment: null,
        response: { clientDataJSON: buf(0), authenticatorData: buf(0), signature: buf(0), userHandle: null },
      });
      return { full, bare };
    });
    expect(out.full).toEqual({
      id: "-_-_-_-_",
      rawId: "-_-_-_-_",
      type: "public-key",
      authenticatorAttachment: "platform",
      response: { clientDataJSON: "AA", authenticatorData: "AAE", signature: "AAEC", userHandle: "AQ" },
      clientExtensionResults: { credProps: { rk: true } },
    });
    // No user handle and no attachment: left out, not sent as null; no extension results: an empty object.
    expect(out.bare).toEqual({
      id: "AA",
      rawId: "AA",
      type: "public-key",
      response: { clientDataJSON: "AA", authenticatorData: "AA", signature: "AA" },
      clientExtensionResults: {},
    });
  });
});
