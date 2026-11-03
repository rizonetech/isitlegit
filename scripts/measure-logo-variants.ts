// The variant measurement (D03 T03 §5): does a second reference per brand (icon beside
// wordmark) raise the logo match rate? Each labelled sample in eval/sets/logo-variants is
// compared with its claimed brand's wordmark reference and its icon reference through the
// shipped comparison schema and prompt; the one-reference policy is the wordmark judgement
// alone, the two-reference policy matches when either reference matches. Per-sample
// judgements, failures, costs and timings are saved to results.json, and the rates the
// frontier log records are recomputed from that file by the section's test.
//
//   node scripts/measure-logo-variants.ts --confirm-credit
//
// Spend: US$0.50 cap for the run (stated in the lane outbox before the first run), reserved
// per call in the shared ledger, never raised. A failed call is scored as no match.
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

// The shipped judgement schema, mirrored (the Worker module does not load in Node); the
// section test recomputes the rates from the saved judgements, so a drift fails there.
const logoJudgementSchema = z
  .object({
    same_brand: z.boolean(),
    brand_seen: z.string().min(1).max(120).nullable(),
    differences: z.array(z.string().min(1).max(200)).max(8),
    confidence: z.number().min(0).max(1),
  })
  .strict()
  .refine((j) => j.same_brand || j.differences.length > 0, {
    message: "a different-brand judgement must name a difference",
  });

import {
  GATEWAY_URL,
  metaLedger,
  readLedger,
  readSecretsFromVault,
  reserveSpend,
  settleSpend,
  takeLock,
  tokenCost,
} from "./meta-smoke.ts";

const CAP_USD = 0.5;
const SET = join(import.meta.dirname, "../eval/sets/logo-variants");
const today = new Date().toISOString().slice(0, 10);
const run = `logo-variants-${Date.now()}`;

if (!process.argv.includes("--confirm-credit")) {
  console.error("measure-logo-variants: a live run spends Meta credit; pass --confirm-credit");
  process.exit(2);
}
const manual = readFileSync(join(import.meta.dirname, "../todo/99-manual/TODO-01-day0-accounts.md"), "utf-8");
if (!/^Meta credit visible: 2026-/m.test(manual)) {
  console.error("measure-logo-variants: no Meta credit visible line recorded; refusing to spend");
  process.exit(2);
}

type Label = { file: string; brand: string; shown: string; expected_same: boolean };
const labels = (JSON.parse(readFileSync(join(SET, "labels.json"), "utf-8")) as { samples: Label[] }).samples;
const slugOf = (brand: string) => brand.toLowerCase().replace(/[^a-z0-9]+/g, "-");
const ledgerFile = metaLedger();
const unlock = takeLock(`${ledgerFile}.lock`);
if (typeof unlock === "string") {
  console.error(`measure-logo-variants: ${unlock}`);
  process.exit(2);
}

try {
  const ledger = readLedger(ledgerFile);
  const secrets = await readSecretsFromVault();
  const headers = {
    authorization: `Bearer ${secrets.meta}`,
    "cf-aig-authorization": `Bearer ${secrets.run}`,
    "cf-aig-collect-log": "true",
    "cf-aig-collect-log-payload": "false",
    "content-type": "application/json",
  };
  let spent = 0;
  const dataUrl = (path: string) => `data:image/png;base64,${readFileSync(path).toString("base64")}`;

  const compare = async (sample: Label, reference: "wordmark" | "icon") => {
    const estimate = tokenCost("muse-spark-1.3", 1500, 400);
    if (spent + estimate > CAP_USD) throw new Error(`the US$${CAP_USD} cap would be passed; stopping`);
    const reserved = reserveSpend(ledgerFile, ledger, {
      date: today,
      run,
      call: `logo-variant ${reference} ${sample.file}`,
      estimate,
    });
    if ("refused" in reserved) throw new Error(reserved.refused);
    spent += estimate;
    const started = Date.now();
    try {
      // The shipped comparison call (src/vision/logo-compare.ts): fixed prompt, crop first,
      // reference second, validated answer. Built here from the same schema module the Worker
      // uses for its request shape, with the comparison's own instructions.
      const response = await fetch(`${GATEWAY_URL}/responses`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: "muse-spark-1.3",
          store: false,
          max_output_tokens: 800,
          reasoning: { effort: "low" },
          instructions: [
            "You compare two logo images and judge whether they are the same brand's logo.",
            "The first image is a page being checked. The second image is the reference logo.",
            "same_brand: true only when the page shows the same brand's logo as the reference (the same name or mark, allowing size, colour depth and rendering differences); false when it shows a different brand, a different name, or no logo.",
            "brand_seen: the brand name the page itself shows, or null when it shows none.",
            "differences: short phrases naming how the page's logo differs from the reference; empty when they are the same logo. A different-brand judgement must name a difference.",
            "confidence: how sure you are, from 0 to 1.",
          ].join("\n"),
          text: {
            format: {
              type: "json_schema",
              name: "logo_comparison",
              strict: true,
              schema: {
                type: "object",
                additionalProperties: false,
                required: ["same_brand", "brand_seen", "differences", "confidence"],
                properties: {
                  same_brand: { type: "boolean" },
                  brand_seen: { anyOf: [{ type: "string" }, { type: "null" }] },
                  differences: { type: "array", maxItems: 8, items: { type: "string" } },
                  confidence: { type: "number", minimum: 0, maximum: 1 },
                },
              },
            },
          },
          input: [
            {
              role: "user",
              content: [
                { type: "input_text", text: "First image, the page to judge:" },
                { type: "input_image", image_url: dataUrl(join(SET, "samples", sample.file)), detail: "auto" },
                { type: "input_text", text: "Second image, the reference logo:" },
                {
                  type: "input_image",
                  image_url: dataUrl(join(SET, "refs", `${slugOf(sample.brand)}-${reference}.png`)),
                  detail: "auto",
                },
              ],
            },
          ],
        }),
        signal: AbortSignal.timeout(120_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = (await response.json()) as {
        output?: { type?: string; content?: { type?: string; text?: string }[] }[];
        usage?: { input_tokens: number; output_tokens: number; input_tokens_details?: { cached_tokens?: number } };
      };
      const text = (data.output ?? [])
        .flatMap((item) => (item.type === "message" ? (item.content ?? []) : []))
        .filter((part) => part.type === "output_text")
        .map((part) => part.text ?? "")
        .join("");
      const judgement = logoJudgementSchema.parse(JSON.parse(text));
      const usage = data.usage;
      const cost = usage
        ? tokenCost(
            "muse-spark-1.3",
            usage.input_tokens,
            usage.output_tokens,
            usage.input_tokens_details?.cached_tokens ?? 0,
          )
        : estimate;
      settleSpend(ledgerFile, ledger, reserved.entry, cost);
      return { same: judgement.same_brand, failed: null as string | null, ms: Date.now() - started, cost };
    } catch (error) {
      settleSpend(ledgerFile, ledger, reserved.entry, null);
      return { same: false, failed: error instanceof Error ? error.name : "failed", ms: Date.now() - started, cost: 0 };
    }
  };

  const results: {
    file: string;
    brand: string;
    shown: string;
    expected_same: boolean;
    wordmark: Awaited<ReturnType<typeof compare>>;
    icon: Awaited<ReturnType<typeof compare>>;
  }[] = [];
  for (const sample of labels) {
    const wordmark = await compare(sample, "wordmark");
    const icon = await compare(sample, "icon");
    results.push({
      file: sample.file,
      brand: sample.brand,
      shown: sample.shown,
      expected_same: sample.expected_same,
      wordmark,
      icon,
    });
    console.log(`${sample.file}: wordmark ${wordmark.same}, icon ${icon.same}, expected ${sample.expected_same}`);
    writeFileSync(join(SET, "results.json.tmp"), `${JSON.stringify({ run, capUsd: CAP_USD, results }, null, 1)}\n`);
    renameSync(join(SET, "results.json.tmp"), join(SET, "results.json"));
  }
  const rate = (pick: (r: (typeof results)[number]) => boolean) => {
    const same = results.filter((r) => r.expected_same);
    const different = results.filter((r) => !r.expected_same);
    return {
      trueMatch: `${same.filter((r) => pick(r)).length}/${same.length}`,
      falseMatch: `${different.filter((r) => pick(r)).length}/${different.length}`,
    };
  };
  console.log("one-reference", JSON.stringify(rate((r) => r.wordmark.same)));
  console.log("two-reference", JSON.stringify(rate((r) => r.wordmark.same || r.icon.same)));
} finally {
  unlock();
}
