// The Copy address action's outcomes (D07 T06 §2); the browser test proves the page wires it.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { COPIED, COPY_FAILED, copy } from "../src/scripts/copy.ts";

describe("copy", () => {
  it("writes the address and announces success", async () => {
    const written: string[] = [];
    assert.equal(await copy({ writeText: async (t) => void written.push(t) }, "check@isitlegit.co.za"), COPIED);
    assert.deepEqual(written, ["check@isitlegit.co.za"]);
  });

  it("announces how to copy by hand when the browser refuses", async () => {
    assert.equal(await copy({ writeText: () => Promise.reject(new Error("denied")) }, "x@y"), COPY_FAILED);
  });

  it("announces the same when there is no clipboard", async () => {
    assert.equal(await copy(undefined, "x@y"), COPY_FAILED);
  });
});
