// The doctored payment document pairs (D06 T02 §4; spec 4.9): 20 genuine synthetic documents
// drawn in code (SVG rasterised by sharp, the eval frontier's pattern), each edited by Muse Image
// (muse-image-1.0 through metaRaw, /images/edits) to change one field, giving genuine and doctored
// pairs for the eval. Every document is fictional and stamped SYNTHETIC. A usage-policy refusal is
// recorded, never retried with a reformulated prompt, and its pair is made in code instead.
//
//   node scripts/fixtures/make-doctored.ts              dry run: prints the 20 requests, sends nothing
//   node scripts/fixtures/make-doctored.ts --confirm-credit
//
// Spend cap stated before any paid call (lane outbox, 2026-11-02): US$1.00 for this section, bound
// to the shared ledger through localBudget and never raised. Completed pairs are reused on a
// restart; nothing already saved is sent again.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { z } from "zod";
import { metaRaw } from "../../src/meta/client.ts";
import { localBudget } from "../lib/meta-budget.ts";
import { GATEWAY_URL, readSecretsFromVault } from "../meta-smoke.ts";

const OUT = join(import.meta.dirname, "../../eval/sets/payment-docs");
export const CAP_USD = 1.0;

export type DocSpec = {
  pair: string;
  type: "invoice" | "pop" | "bank_letter";
  supplier: string;
  bank: string;
  account: string;
  doctoredAccount: string;
  amount: string;
  doctoredAmount: string;
  date: string;
  doctoredDate: string;
  edit: "account" | "amount" | "date";
};

const SUPPLIERS = ["Hadeda Couriers", "Karoo Stationery", "Fynbos Cleaning", "Protea Office", "Baobab Logistics"];
const TYPES: DocSpec["type"][] = ["invoice", "pop", "bank_letter"];
const EDITS: DocSpec["edit"][] = ["account", "amount", "date"];

export const DOCS: DocSpec[] = Array.from({ length: 20 }, (_, i) => {
  const account = `6200441${String(7700 + i * 7)}`;
  const amount = `R ${(1100 + i * 137).toLocaleString("en-ZA")}.00`;
  return {
    pair: `pair-${String(i + 1).padStart(2, "0")}`,
    type: TYPES[i % 3] as DocSpec["type"],
    supplier: SUPPLIERS[i % 5] as string,
    bank: "Kestrel Bank (fictional)",
    account,
    doctoredAccount: `${account.slice(0, -1)}${(Number(account.at(-1)) + 1) % 10}`,
    amount,
    doctoredAmount: `R ${(1150 + i * 137).toLocaleString("en-ZA")}.00`,
    date: `2026-10-${String(1 + (i % 28)).padStart(2, "0")}`,
    doctoredDate: `2026-11-${String(1 + (i % 28)).padStart(2, "0")}`,
    edit: EDITS[i % 3] as DocSpec["edit"],
  };
});

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

export function svgOf(spec: DocSpec, doctored = false): string {
  const account = doctored && spec.edit === "account" ? spec.doctoredAccount : spec.account;
  const amount = doctored && spec.edit === "amount" ? spec.doctoredAmount : spec.amount;
  const date = doctored && spec.edit === "date" ? spec.doctoredDate : spec.date;
  const title =
    spec.type === "pop" ? "Proof of Payment" : spec.type === "bank_letter" ? "Bank Confirmation Letter" : "Tax Invoice";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="1000">
<rect width="800" height="1000" fill="white"/>
<text x="60" y="70" font-family="sans-serif" font-size="30" fill="#b00">SYNTHETIC TEST DOCUMENT</text>
<text x="60" y="130" font-family="sans-serif" font-size="28">${esc(title)}</text>
<text x="60" y="190" font-family="sans-serif" font-size="20">Supplier: ${esc(spec.supplier)} (Pty) Ltd</text>
<text x="60" y="230" font-family="sans-serif" font-size="20">Bank: ${esc(spec.bank)}</text>
<text x="60" y="270" font-family="sans-serif" font-size="20">Account number: ${account}</text>
<text x="60" y="310" font-family="sans-serif" font-size="20">Branch code: 250655</text>
<text x="60" y="350" font-family="sans-serif" font-size="20">Amount: ${amount}</text>
<text x="60" y="390" font-family="sans-serif" font-size="20">Date: ${date}</text>
<text x="60" y="430" font-family="sans-serif" font-size="20">Reference: PAY-${spec.pair}</text>
</svg>`;
}

export const pngOf = async (spec: DocSpec, doctored = false): Promise<Buffer> =>
  sharp(Buffer.from(svgOf(spec, doctored)))
    .png()
    .toBuffer();

export const editInstruction = (spec: DocSpec): string => {
  const [field, from, to] =
    spec.edit === "account"
      ? ["account number", spec.account, spec.doctoredAccount]
      : spec.edit === "amount"
        ? ["amount", spec.amount, spec.doctoredAmount]
        : ["date", spec.date, spec.doctoredDate];
  return `Change the ${field} from ${from} to ${to}. Keep every other part of the document identical, including the red SYNTHETIC TEST DOCUMENT stamp.`;
};

export const ImageResponse = z.object({
  data: z.array(z.object({ b64_json: z.string().min(1) })).min(1),
});

export type EditFn = (spec: DocSpec, genuinePng: Buffer) => Promise<Buffer>;

export type Label = {
  pair: string;
  role: "genuine" | "doctored";
  file: string;
  type: string;
  edit: string | null;
  old: string | null;
  new: string | null;
  made_by: "code" | "model" | null;
  note?: string;
};

const save = (name: string, bytes: Buffer | string) => {
  const tmp = join(OUT, `.${name}.tmp`);
  writeFileSync(tmp, bytes);
  renameSync(tmp, join(OUT, name));
};

export async function makePair(spec: DocSpec, edit: EditFn | null): Promise<Label[]> {
  mkdirSync(OUT, { recursive: true });
  const genuineName = `${spec.pair}-genuine.png`;
  const doctoredName = `${spec.pair}-doctored.png`;
  if (!existsSync(join(OUT, genuineName))) save(genuineName, await pngOf(spec));
  let madeBy: "code" | "model" = "code";
  let note: string | undefined;
  if (!existsSync(join(OUT, doctoredName))) {
    let doctored: Buffer | null = null;
    if (edit) {
      try {
        doctored = await edit(spec, readFileSync(join(OUT, genuineName)));
        madeBy = "model";
      } catch (error) {
        // The failure kind is recorded, never retried with a reformulated prompt (gap 5).
        note = `model edit failed: ${(error as Error).name || "Error"}`;
        doctored = null;
      }
    }
    save(doctoredName, doctored ?? (await pngOf(spec, true)));
  }
  const [oldV, newV] =
    spec.edit === "account"
      ? [spec.account, spec.doctoredAccount]
      : spec.edit === "amount"
        ? [spec.amount, spec.doctoredAmount]
        : [spec.date, spec.doctoredDate];
  return [
    {
      pair: spec.pair,
      role: "genuine",
      file: genuineName,
      type: spec.type,
      edit: null,
      old: null,
      new: null,
      made_by: null,
    },
    {
      pair: spec.pair,
      role: "doctored",
      file: doctoredName,
      type: spec.type,
      edit: spec.edit,
      old: oldV,
      new: newV,
      made_by: madeBy,
      ...(note ? { note } : {}),
    },
  ];
}

export async function runAll(edit: EditFn | null): Promise<Label[]> {
  const labels: Label[] = [];
  for (const spec of DOCS) labels.push(...(await makePair(spec, edit)));
  save("labels.json", `${JSON.stringify(labels, null, 2)}\n`);
  return labels;
}

if (import.meta.main) {
  const confirm = process.argv.includes("--confirm-credit");
  if (!confirm) {
    for (const spec of DOCS) console.log(`${spec.pair}: ${editInstruction(spec)}`);
    console.log("dry run: 20 requests, nothing sent");
  } else {
    const secrets = await readSecretsFromVault();
    const budget = localBudget("make-doctored");
    const edit: EditFn = async (spec, genuinePng) => {
      const answer = await metaRaw(
        "/images/edits",
        {
          model: "muse-image-1.0",
          prompt: editInstruction(spec),
          images: [{ image_url: `data:image/png;base64,${genuinePng.toString("base64")}` }],
          n: 1,
        },
        {
          env: { META_API_KEY: secrets.meta, CF_AIG_TOKEN: secrets.run, META_GATEWAY_URL: GATEWAY_URL },
          budget,
          owner: { kind: "script", name: "make-doctored" },
          waitUntil: () => {},
        },
      );
      const parsed = ImageResponse.parse(answer.data);
      return Buffer.from(parsed.data[0]?.b64_json as string, "base64");
    };
    const labels = await runAll(edit);
    console.log(`wrote ${labels.length} labels to ${OUT}`);
  }
}
