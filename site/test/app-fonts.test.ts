// The font integration (D07 T06 §1) in temporary folders: never the shared public/static/fonts/.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, it } from "node:test";
import { copyFonts, fontMiddleware, fontUrls, IMMUTABLE } from "../src/integrations/app-fonts.ts";

const CSS = `@font-face { font-family: "A"; src: url("/static/fonts/a.111.woff2") format("woff2"); }
@font-face { font-family: "A Fallback"; src: local("Arial"); }
@font-face { font-family: "B"; src: url('/static/fonts/b.222.woff2') format("woff2"); }
@font-face { font-family: "B2"; src: url(/static/fonts/b.222.woff2); }`;

let dir: string;
let css: string;
let fonts: string;
let out: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "site-app-fonts-"));
  css = join(dir, "fonts.css");
  fonts = join(dir, "fonts");
  out = join(dir, "dist");
  mkdirSync(fonts);
  writeFileSync(css, CSS);
  writeFileSync(join(fonts, "a.111.woff2"), Buffer.from([1, 2, 3]));
  writeFileSync(join(fonts, "b.222.woff2"), Buffer.from([4, 5, 6, 7]));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("fontUrls", () => {
  it("lists each font URL once, in order, whatever the quoting", () => {
    assert.deepEqual(fontUrls(CSS), ["/static/fonts/a.111.woff2", "/static/fonts/b.222.woff2"]);
  });

  it("refuses a URL that leaves the fonts folder", () => {
    assert.throws(() => fontUrls('src: url("/static/fonts/../secret.woff2")'), /not a plain file name/);
  });
});

describe("copyFonts", () => {
  it("copies every named font byte for byte and leaves no temporary file", () => {
    assert.deepEqual(copyFonts(css, fonts, out), ["a.111.woff2", "b.222.woff2"]);
    const target = join(out, "static/fonts");
    assert.deepEqual(readdirSync(target).sort(), ["a.111.woff2", "b.222.woff2"]);
    assert.deepEqual(readFileSync(join(target, "a.111.woff2")), Buffer.from([1, 2, 3]));
    assert.deepEqual(readFileSync(join(target, "b.222.woff2")), Buffer.from([4, 5, 6, 7]));
  });

  it("fails naming the missing font and copies nothing", () => {
    rmSync(join(fonts, "b.222.woff2"));
    assert.throws(() => copyFonts(css, fonts, out), /missing from .*: b\.222\.woff2$/);
    assert.throws(() => readdirSync(join(out, "static/fonts")), /ENOENT/);
  });

  it("fails when the stylesheet names no font", () => {
    writeFileSync(css, '@font-face { src: local("Arial"); }');
    assert.throws(() => copyFonts(css, fonts, out), /names no font/);
  });
});

// A request through the middleware: what it answered, or that it passed the request on.
function request(url: string): Promise<{ next: boolean; status?: number; headers: Record<string, string>; body: Buffer }> {
  const middleware = fontMiddleware(css, fonts);
  return new Promise((resolve, reject) => {
    const sink = new PassThrough();
    const headers: Record<string, string> = {};
    const chunks: Buffer[] = [];
    const res = Object.assign(sink, {
      statusCode: 0,
      setHeader: (name: string, value: string) => {
        headers[name.toLowerCase()] = value;
      },
    });
    sink.on("data", (chunk: Buffer) => chunks.push(chunk));
    sink.on("end", () => resolve({ next: false, status: res.statusCode, headers, body: Buffer.concat(chunks) }));
    middleware({ url } as IncomingMessage, res as unknown as ServerResponse, (error) =>
      error ? reject(error) : resolve({ next: true, headers, body: Buffer.alloc(0) }),
    );
  });
}

describe("fontMiddleware", () => {
  it("answers a named font with its bytes, type and the immutable cache rule", async () => {
    const answer = await request("/static/fonts/b.222.woff2?v=1");
    assert.equal(answer.next, false);
    assert.equal(answer.status, 200);
    assert.equal(answer.headers["content-type"], "font/woff2");
    assert.equal(answer.headers["cache-control"], IMMUTABLE);
    assert.equal(answer.headers["content-length"], "4");
    assert.deepEqual(answer.body, Buffer.from([4, 5, 6, 7]));
  });

  it("passes on any other URL, an unnamed font and a named font that is missing", async () => {
    assert.equal((await request("/")).next, true);
    writeFileSync(join(fonts, "c.333.woff2"), "x");
    assert.equal((await request("/static/fonts/c.333.woff2")).next, true);
    rmSync(join(fonts, "a.111.woff2"));
    assert.equal((await request("/static/fonts/a.111.woff2")).next, true);
  });
});
