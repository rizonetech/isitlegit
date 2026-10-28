// @kenjiuno/msgreader as the .msg parser (D01 T01 §6) uses it: its MsgReader class and its constants.
//
// WORKAROUND: the package is CommonJS with each of these on `exports.default`. Wrangler's bundler follows Node's rules
// for a "type": "module" package and hands the whole exports object to a default import, while Vite (the tests) hands
// `exports.default`, so a plain default import is the class in the tests and an object in the deployed Worker (which
// then failed to start: D01 T01 §7). `defaultExport` takes the value either way; the package is pinned at 1.29.0, and
// test/intake/msgreader.test.ts checks both shapes.

import type ReaderClass from "@kenjiuno/msgreader";
import * as readerModule from "@kenjiuno/msgreader";
import type ConstantsValue from "@kenjiuno/msgreader/lib/const.js";
import * as constantsModule from "@kenjiuno/msgreader/lib/const.js";

export function defaultExport<T>(namespace: unknown, isValue: (value: unknown) => boolean): T {
  const outer = (namespace as { default?: unknown }).default;
  if (isValue(outer)) return outer as T;
  const inner = (outer as { default?: unknown } | undefined)?.default;
  if (isValue(inner)) return inner as T;
  throw new Error("@kenjiuno/msgreader's default export was not found");
}

export const MsgReader = defaultExport<typeof ReaderClass>(readerModule, (v) => typeof v === "function");
export const msgreaderConstants = defaultExport<typeof ConstantsValue>(
  constantsModule,
  (v) => typeof v === "object" && v !== null && "MSG" in v,
);
