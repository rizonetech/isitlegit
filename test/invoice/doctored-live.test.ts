// The §4 measurement live (D06 T02 §4): Muse Spark extraction (§2) reads every genuine and
// doctored image in test/fixtures/payment-docs; an edit is caught when the doctored read names the
// new value, and a genuine control is scored on its original value. Runs only with
// DOCTORED_LIVE=1 and the keys scripts/fixtures/measure-doctored.ts passes, inside the section's
// stated US$1.00 allowance (reserveSectionSpend through sectionBudget).
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { type Label, sectionBudget } from "../../scripts/fixtures/make-doctored.ts";
import { extractPaymentDocument } from "../../src/invoice/payment-doc";
import { d1Budget } from "../../src/meta/budget";
import LABELS from "../fixtures/payment-docs/labels.json";
import { paymentDocImages } from "../fixtures/payment-docs/load";

const live = env as unknown as Record<string, string | undefined>;
const LIVE = live.DOCTORED_LIVE === "1";
const db = (env as unknown as Env).DB;

describe.skipIf(!LIVE)("doctored pairs measurement (§4)", () => {
  it("reads the set and records caught and missed edits", { timeout: 600_000 }, async ({ task }) => {
    const labels = LABELS as Label[];
    const ctx = {
      env: {
        ...(live.DOCTORED_META_API_KEY ? { META_API_KEY: live.DOCTORED_META_API_KEY } : {}),
        ...(live.DOCTORED_CF_AIG_TOKEN ? { CF_AIG_TOKEN: live.DOCTORED_CF_AIG_TOKEN } : {}),
        ...(live.DOCTORED_GATEWAY_URL ? { META_GATEWAY_URL: live.DOCTORED_GATEWAY_URL } : {}),
      },
      budget: sectionBudget(d1Budget(db, { caller: "measure-doctored" })),
      owner: { kind: "script" as const, name: "measure-doctored" },
      waitUntil: () => {},
    };
    const rows: Record<string, unknown>[] = [];
    for (const label of labels) {
      const bytes = paymentDocImages[label.file] as Uint8Array;
      const got = await extractPaymentDocument(
        {
          kind: "image",
          imageDataUrl: `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`,
          filename: label.file,
        },
        ctx,
      );
      if (!got.ok) {
        rows.push({ file: label.file, role: label.role, edit: label.edit, outcome: `failed:${got.reason}` });
        continue;
      }
      const f = got.fields;
      const twin = labels.find((l) => l.pair === label.pair && l.role === "doctored");
      const editKind = label.edit ?? twin?.edit;
      const read =
        editKind === "account"
          ? f.beneficiary.account_number?.replace(/[\s-]+/g, "")
          : editKind === "amount"
            ? f.amount_cents
            : editKind === "date"
              ? (f.paid_at ?? f.issued_at)
              : null;
      const wanted =
        label.role === "genuine"
          ? editKind === "account"
            ? twin?.old?.replace(/[\s-]+/g, "")
            : editKind === "amount"
              ? Number(String(twin?.old).replace(/[^\d]/g, ""))
              : twin?.old
          : editKind === "account"
            ? label.new?.replace(/[\s-]+/g, "")
            : editKind === "amount"
              ? Number(String(label.new).replace(/[^\d]/g, ""))
              : label.new;
      rows.push({
        file: label.file,
        role: label.role,
        edit: label.edit,
        read: read ?? null,
        wanted: wanted ?? null,
        outcome: String(read) === String(wanted) ? (label.role === "genuine" ? "genuine-read" : "caught") : "missed",
        type: f.type,
      });
    }
    (task.meta as Record<string, unknown>)["doctored-measurement"] = { rows };
    expect(rows).toHaveLength(40);
  });
});
