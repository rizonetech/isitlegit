import { describe, expect, it } from "vitest";
import { newItem } from "../../scripts/glimmer/import-new.ts";
import type { PhreshIndex } from "../../scripts/glimmer/import-phreshphish.ts";
import { PageMeta } from "../../scripts/glimmer/store.ts";

// The 1.1 sources' importer (D03 T04 §44): a row's brand is grouping only, never a trusted label (§45).
const row = (over: Partial<PhreshIndex> = {}): PhreshIndex =>
  ({
    sha256: "a".repeat(64),
    url: "https://acme.example/",
    label: "phish",
    target: "Acme Bank",
    offset: 0,
    length: 0,
    shot: false,
    ...over,
  }) as PhreshIndex;

const reader = {
  renderHtml: async () => ({
    screenshot: new Uint8Array([1]),
    text: "Sign in to Acme",
    has_login_form: true,
    has_payment_form: false,
  }),
} as never;

describe("import-new", () => {
  it("stores a lure row's brand as grouping-only, never ground truth", () => {
    const item = newItem(row(), () => "<p>Sign in</p>", reader);
    expect(item.labels).toMatchObject({ lure: true, brand: "Acme Bank" });
    expect(item.label_source.brand).toBe("grouping-only");
    expect(item.label_source.lure).toBe("ground-truth");
  });

  it("stores a benign row's brand the same way, with its lure type trusted", () => {
    const item = newItem(row({ label: "benign" }), () => "<p>Sign in</p>", reader);
    expect(item.labels).toMatchObject({ lure: false, lure_type: "none", brand: "Acme Bank" });
    expect(item.label_source.brand).toBe("grouping-only");
    expect(item.label_source.lure_type).toBe("ground-truth");
  });

  it("stores a grouping-only brand in the page record (the import's regression)", () => {
    // Before `grouping-only` joined LABEL_SOURCES, every branded page of these sources failed the record's
    // validation and was excluded with a zod error.
    const meta = PageMeta.parse({
      source: "ows",
      origin: "public",
      licence: "CC BY 4.0",
      host: "acme.example",
      template: null,
      south_africa: false,
      labels: { lure: true, brand: "Acme Bank" },
      label_source: { lure: "ground-truth", brand: "grouping-only" },
      sha256: { screenshot: "a".repeat(64), text: "b".repeat(64) },
      redacted: false,
    });
    expect(meta.label_source.brand).toBe("grouping-only");
  });

  it("refuses a row whose label is neither phish nor benign, and an oversized row", () => {
    expect(newItem(row({ label: "spam" }), () => "", reader).labels).toEqual({});
    expect(newItem(row({ oversized: true }), () => "", reader).labels).toEqual({});
  });
});
