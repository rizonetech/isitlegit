import { describe, expect, it } from "vitest";
import { defaultExport, MsgReader, msgreaderConstants } from "../../src/intake/msgreader";

// D01 T01 §7: msgreader's class and constants however the bundler resolved its CommonJS default export.
class Reader {}
const isClass = (v: unknown) => typeof v === "function";

describe("defaultExport", () => {
  it("takes the value from Vite's shape and from Wrangler's", () => {
    // Vite: the namespace's default is exports.default. Wrangler (Node's rules): it is the whole exports object.
    expect(defaultExport({ default: Reader }, isClass)).toBe(Reader);
    expect(defaultExport({ default: { default: Reader, __esModule: true } }, isClass)).toBe(Reader);
    expect(() => defaultExport({ default: { other: 1 } }, isClass)).toThrow(/not found/);
  });

  it("finds the real class and constants here", () => {
    expect(typeof MsgReader).toBe("function");
    expect(msgreaderConstants.MSG.FIELD.PREFIX.DOCUMENT).toBe("__substg1.");
  });
});
