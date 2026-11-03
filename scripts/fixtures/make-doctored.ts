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

const save = (name: string, bytes: Buffer | string, out: string = OUT) => {
  const tmp = join(out, `.${name}.tmp`);
  writeFileSync(tmp, bytes);
  renameSync(tmp, join(out, name));
};

export async function makePair(spec: DocSpec, edit: EditFn | null, out: string = OUT): Promise<Label[]> {
  mkdirSync(out, { recursive: true });
  const genuineName = `${spec.pair}-genuine.png`;
  const doctoredName = `${spec.pair}-doctored.png`;
  if (!existsSync(join(out, genuineName))) save(genuineName, await pngOf(spec), out);
  let madeBy: "code" | "model" = "code";
  let note: string | undefined;
  if (!existsSync(join(out, doctoredName))) {
    let doctored: Buffer | null = null;
    if (edit) {
      try {
        doctored = await edit(spec, readFileSync(join(out, genuineName)));
        madeBy = "model";
      } catch (error) {
        // A content-policy refusal alone falls back to a code-made pair, recorded and never
        // retried with a reformulated prompt; every other failure stops the run (gap 5).
        const kind = (error as { kind?: string }).kind ?? (error as Error).name ?? "Error";
        if (kind !== "content-policy") throw error;
        note = `model edit refused: ${kind}`;
        doctored = null;
      }
    }
    if (doctored) {
      const meta = await sharp(doctored)
        .metadata()
        .catch(() => null);
      const unchanged = doctored.equals(readFileSync(join(out, genuineName)));
      if (!meta?.width || !meta?.height || unchanged) {
        note = unchanged
          ? "model edit returned the genuine image unchanged; made in code"
          : "model edit returned an undecodable image; made in code";
        doctored = null;
        madeBy = "code";
      }
    }
    // Provenance is published before the image, so no completed image can exist without the
    // record of how it was made; a sidecar without its image is simply overwritten next run.
    save(
      `${spec.pair}.json`,
      `${JSON.stringify({ pair: spec.pair, made_by: madeBy, ...(note ? { note } : {}) }, null, 2)}\n`,
      out,
    );
    save(doctoredName, doctored ?? (await pngOf(spec, true)), out);
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

export async function runAll(edit: EditFn | null, out: string = OUT): Promise<Label[]> {
  // A restart reuses completed pairs with their original provenance: existing doctored labels
  // keep their made_by and note, and no completed pair is sent again.
  const prior = new Map<string, Label>();
  try {
    for (const l of JSON.parse(readFileSync(join(out, "labels.json"), "utf-8")) as Label[])
      prior.set(`${l.pair}:${l.role}`, l);
  } catch {}
  // A pair whose image landed but whose manifest checkpoint did not recovers its provenance
  // from the sidecar makePair wrote with the image.
  for (const spec of DOCS) {
    if (prior.has(`${spec.pair}:doctored`)) continue;
    try {
      const side = JSON.parse(readFileSync(join(out, `${spec.pair}.json`), "utf-8")) as {
        made_by: "code" | "model";
        note?: string;
      };
      const [oldV, newV] =
        spec.edit === "account"
          ? [spec.account, spec.doctoredAccount]
          : spec.edit === "amount"
            ? [spec.amount, spec.doctoredAmount]
            : [spec.date, spec.doctoredDate];
      prior.set(`${spec.pair}:doctored`, {
        pair: spec.pair,
        role: "doctored",
        file: `${spec.pair}-doctored.png`,
        type: spec.type,
        edit: spec.edit,
        old: oldV,
        new: newV,
        made_by: side.made_by,
        ...(side.note ? { note: side.note } : {}),
      });
    } catch {}
  }
  // Checkpointing starts from the prior manifest, so an interrupted restart never drops the
  // provenance of pairs it has not reached yet.
  const labels: Label[] = [...prior.values()];
  const replace = (l: Label) => {
    const i = labels.findIndex((x) => x.pair === l.pair && x.role === l.role);
    if (i >= 0) labels[i] = l;
    else labels.push(l);
  };
  for (const spec of DOCS) {
    const made = await makePair(spec, edit, out);
    for (const l of made) {
      const old = prior.get(`${l.pair}:${l.role}`);
      replace(
        old && l.role === "doctored" ? { ...l, made_by: old.made_by, ...(old.note ? { note: old.note } : {}) } : l,
      );
    }
    save("labels.json", `${JSON.stringify(labels, null, 2)}\n`, out);
  }
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
          budget: sectionBudget(budget),
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

// The section's persistent allowance (completion gap 2): every paid attempt in this section, from
// either runner, reserves its estimate here first, and the file is never reset by a restart, so
// the stated US$1.00 cap binds generation, measurement and retries together.
// The allowance inside the per-attempt Budget.reserve (round 2): the client retries transport,
// and every attempt is charged, so the section cap is checked where each attempt reserves, not
// once per call.
export function sectionBudget<T extends { reserve: (...args: never[]) => unknown }>(base: T, file?: string): T {
  return {
    ...base,
    reserve: (...args: never[]) => {
      const estimate = typeof args[1] === "number" ? args[1] : 0;
      reserveSectionSpend(estimate, file);
      return base.reserve(...args);
    },
  } as T;
}

export function reserveSectionSpend(amountUsd: number, file: string = join(OUT, "spend.json")): number {
  let spent = 0;
  try {
    spent = (JSON.parse(readFileSync(file, "utf-8")) as { countedUsd: number }).countedUsd;
  } catch {}
  if (spent + amountUsd > CAP_USD)
    throw new Error(`section cap: US$${spent.toFixed(4)} counted of US$${CAP_USD}; refusing`);
  const next = spent + amountUsd;
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ countedUsd: next }, null, 2)}\n`);
  renameSync(tmp, file);
  return next;
}
