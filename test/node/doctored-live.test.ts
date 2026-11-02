// The §4 measurement live (D06 T02 §4): Muse Spark extraction (§2) reads every genuine and
// doctored image from eval/sets/payment-docs; an edit is caught when the doctored read names the
// new value. Runs only with DOCTORED_LIVE=1 and the keys scripts/fixtures/measure-doctored.ts
// passes from the vault, inside the section's stated US$1.00 cap.
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Label } from "../../scripts/fixtures/make-doctored.ts";
import { localBudget } from "../../scripts/lib/meta-budget.ts";
import { extractPaymentDocument } from "../../src/invoice/payment-doc.ts";

const LIVE = process.env.DOCTORED_LIVE === "1";
const DIR = join(import.meta.dirname, "../../eval/sets/payment-docs");

describe.skipIf(!LIVE)("doctored pairs measurement (§4)", () => {
  it("reads all 40 images and records caught and missed edits", { timeout: 600_000 }, async () => {
    const labels = JSON.parse(readFileSync(join(DIR, "labels.json"), "utf-8")) as Label[];
    const ctx = {
      env: {
        ...(process.env.DOCTORED_META_API_KEY ? { META_API_KEY: process.env.DOCTORED_META_API_KEY } : {}),
        ...(process.env.DOCTORED_CF_AIG_TOKEN ? { CF_AIG_TOKEN: process.env.DOCTORED_CF_AIG_TOKEN } : {}),
        ...(process.env.DOCTORED_GATEWAY_URL ? { META_GATEWAY_URL: process.env.DOCTORED_GATEWAY_URL } : {}),
      },
      budget: localBudget("measure-doctored"),
      owner: { kind: "script" as const, name: "measure-doctored" },
      waitUntil: () => {},
    };
    const rows: Record<string, unknown>[] = [];
    for (const label of labels) {
      const bytes = readFileSync(join(DIR, label.file));
      const got = await extractPaymentDocument(
        { kind: "image", imageDataUrl: `data:image/png;base64,${bytes.toString("base64")}`, filename: label.file },
        ctx,
      );
      if (!got.ok) {
        rows.push({ file: label.file, role: label.role, edit: label.edit, outcome: `failed:${got.reason}` });
        continue;
      }
      const f = got.fields;
      const read =
        label.edit === "account"
          ? f.beneficiary.account_number?.replace(/[\s-]+/g, "")
          : label.edit === "amount"
            ? f.amount_cents
            : label.edit === "date"
              ? (f.paid_at ?? f.issued_at)
              : null;
      const wanted =
        label.role === "genuine"
          ? null
          : label.edit === "account"
            ? label.new?.replace(/[\s-]+/g, "")
            : label.edit === "amount"
              ? Number(String(label.new).replace(/[^\d]/g, ""))
              : label.new;
      rows.push({
        file: label.file,
        role: label.role,
        edit: label.edit,
        read: read ?? null,
        wanted: wanted ?? null,
        outcome: label.role === "genuine" ? "genuine-read" : String(read) === String(wanted) ? "caught" : "missed",
        type: f.type,
      });
    }
    const tmp = join(DIR, ".measurement.json.tmp");
    writeFileSync(tmp, `${JSON.stringify(rows, null, 2)}\n`);
    renameSync(tmp, join(DIR, "measurement.json"));
    const doctored = rows.filter((r) => r.role === "doctored");
    console.log(
      `doctored-live caught ${doctored.filter((r) => r.outcome === "caught").length} of ${doctored.length}; genuine read ${rows.filter((r) => r.role === "genuine" && r.outcome === "genuine-read").length} of 20; failed ${rows.filter((r) => String(r.outcome).startsWith("failed")).length}`,
    );
    expect(rows).toHaveLength(40);
  });
});
