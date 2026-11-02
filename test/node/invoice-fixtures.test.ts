// The synthetic invoice directory (D06 T01 §5): the PDFs on disk, the labels and the worker load
// map must be identical sets, so an unlabelled extra file fails coverage. Node side, where the
// file system exists (the worker test cannot read the directory).
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { invoicePdfs } from "../fixtures/invoices/load";

const DIR = join(import.meta.dirname, "../fixtures/invoices");

describe("the synthetic invoice directory", () => {
  it("holds exactly the labelled, loaded PDFs", () => {
    const onDisk = readdirSync(DIR)
      .filter((f) => f.endsWith(".pdf"))
      .sort();
    const labels = (JSON.parse(readFileSync(join(DIR, "labels.json"), "utf-8")) as { files: { file: string }[] }).files
      .map((f) => f.file)
      .sort();
    expect(onDisk).toEqual(labels);
    expect(onDisk).toEqual(Object.keys(invoicePdfs).sort());
  });
});
