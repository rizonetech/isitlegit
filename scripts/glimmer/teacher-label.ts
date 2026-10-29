// Muse Spark as a second opinion on Loupe's evaluation pages (D03 T04 §9).
//
//   node scripts/glimmer/teacher-label.ts [--max <pages>]
//
// The free rules (`label-rules.ts`) fill every brand and lure type, so Spark's job is a check, not a fill: it answers
// the screener's own request (`buildScreenRequest`, `SCREENER_SYSTEM_PROMPT`) for the pages that can enter evaluation (a
// trusted `lure`), South African pages first. A page where Spark's `lure` disagrees with its source's is written to
// `<store>/review-queue.jsonl`, which keeps it out of training and evaluation (the operator removed the human checks,
// 2026-10-28 21:32 SAST); neither label is overwritten. A field still missing is filled with label source `spark`, which
// evaluation never trusts. `lure` never comes from Spark.
//
// Spend: each call's estimate is reserved in the one Meta ledger both lanes share before it is sent and settled at
// Meta's reported cost after (`scripts/meta-smoke.ts`), under the ledger's run lock, with `run` = `glimmer-teacher-<id>`;
// no call is sent that would take the ledger's `glimmer-` entries past US$20.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { metaResponses } from "../../src/meta/client.ts";
import { buildScreenRequest, PageAnswer, SCREENER_SYSTEM_PROMPT } from "../../src/vision/page-screen.ts";
import { localBudget } from "../lib/meta-budget.ts";
import {
  GATEWAY_URL,
  metaLedger,
  readLedger,
  readSecretsFromVault,
  reserveSpend,
  type Spend,
  settleSpend,
  takeLock,
  tokenCost,
} from "../meta-smoke.ts";
import { openStore, type StoredPage, storeDir } from "./store.ts";

export const SPARK = "muse-spark-1.3";
export const GLIMMER_CAP_USD = 20;
// A worst case for one page: the system prompt and up to 6,000 characters of text, one 1280 by 2000 screenshot, and
// a short JSON answer.
export const ESTIMATE_USD = tokenCost(SPARK, 9_000, 400);
const TRUSTED = new Set(["ground-truth", "construction", "dom", "claude", "astra+claude"]);

// The ledger's run lock beside it, never the ledger itself: a lock written over the ledger's path leaves it unreadable.
export const ledgerLock = (ledgerFile: string) => `${ledgerFile}.lock`;

export type Ask = (input: unknown[], instructions: string) => Promise<{ text: string; usd: number | null }>;

// The pages worth a second opinion: those that can enter evaluation, South African first, not checked before.
export function candidates(pages: StoredPage[], checked: Set<string>): StoredPage[] {
  return pages
    .filter((p) => TRUSTED.has(p.label_source.lure ?? "") && p.labels.lure !== undefined && !checked.has(p.id))
    .sort((a, b) => Number(b.south_africa) - Number(a.south_africa) || a.id.localeCompare(b.id));
}

// The ledger's spend on Glimmer's Spark work so far: every `glimmer-` entry's cost, else its estimate.
export function glimmerSpend(ledger: Spend[]): number {
  return ledger
    .filter((entry) => entry.run.startsWith("glimmer-"))
    .reduce((sum, entry) => sum + (typeof entry.cost === "number" ? entry.cost : entry.estimate), 0);
}

// The screener's request as Responses input: the page text and the screenshot, the system prompt as instructions.
export function responsesInput(page: StoredPage, screenshot: Uint8Array, text: string): unknown[] {
  const request = buildScreenRequest({ image: screenshot, host: page.host, text, mode: "image" });
  const user = request.messages.find((m) => m.role === "user");
  const parts = Array.isArray(user?.content) ? user.content : [];
  return [
    {
      role: "user",
      content: parts.map((part) =>
        part.type === "text"
          ? { type: "input_text", text: part.text }
          : { type: "input_image", image_url: part.image_url.url },
      ),
    },
  ];
}

export type TeacherResult = {
  checked: number;
  agreed: number;
  queued: number;
  filled: number;
  spentUsd: number;
  stopped?: string;
};

export async function teach(options: {
  store: ReturnType<typeof openStore>;
  ask: Ask;
  ledgerFile: string;
  run: string;
  max: number;
  date?: string;
}): Promise<TeacherResult> {
  const { store, ask, ledgerFile, run } = options;
  const queueFile = join(store.dir, "review-queue.jsonl");
  const checkedFile = join(store.dir, "raw", "teacher", "checked.jsonl");
  mkdirSync(dirname(checkedFile), { recursive: true });
  const checked = new Set(
    existsSync(checkedFile)
      ? readFileSync(checkedFile, "utf-8")
          .split("\n")
          .filter(Boolean)
          .map((l) => (JSON.parse(l) as { id: string }).id)
      : [],
  );
  const result: TeacherResult = { checked: 0, agreed: 0, queued: 0, filled: 0, spentUsd: 0 };
  const date = options.date ?? new Date().toISOString().slice(0, 10);
  for (const page of candidates(store.manifest({ tolerant: true }), checked).slice(0, options.max)) {
    const ledger = readLedger(ledgerFile);
    if (glimmerSpend(ledger) + ESTIMATE_USD > GLIMMER_CAP_USD) {
      result.stopped = `the next call would take Glimmer's Spark spend past US$${GLIMMER_CAP_USD}`;
      break;
    }
    const reserved = reserveSpend(ledgerFile, ledger, {
      date,
      run,
      call: `${SPARK} ${page.id}`,
      estimate: ESTIMATE_USD,
    });
    if ("refused" in reserved) {
      result.stopped = reserved.refused;
      break;
    }
    const { screenshot, text } = store.readPage(page.id);
    let answer: PageAnswer | null = null;
    let usd: number | null = null;
    try {
      const reply = await ask(responsesInput(page, screenshot, text), SCREENER_SYSTEM_PROMPT);
      usd = reply.usd;
      const parsed = PageAnswer.safeParse(JSON.parse(reply.text.replace(/^```(?:json)?\s*|\s*```$/g, "")));
      answer = parsed.success ? parsed.data : null;
    } catch {
      answer = null; // no answer is no opinion: the page keeps its source label and is not queued
    } finally {
      const unsaved = settleSpend(ledgerFile, ledger, reserved.entry, usd);
      if (unsaved) result.stopped = unsaved;
    }
    result.spentUsd += usd ?? ESTIMATE_USD;
    appendFileSync(checkedFile, `${JSON.stringify({ id: page.id, answered: answer !== null })}\n`);
    result.checked++;
    if (!answer) continue;
    if (answer.lure !== page.labels.lure) {
      // Neither label is overwritten: the page waits in the queue, out of training and evaluation.
      appendFileSync(
        queueFile,
        `${JSON.stringify({ id: page.id, source: { lure: page.labels.lure }, spark: answer })}\n`,
      );
      result.queued++;
    } else result.agreed++;
    // Only a field still missing is filled, and it is marked as Spark's, which evaluation never trusts.
    const labels = { ...page.labels };
    const sources = { ...page.label_source };
    for (const field of ["brand", "has_login_form", "has_payment_form"] as const) {
      if (labels[field] === undefined) {
        (labels as Record<string, unknown>)[field] = answer[field];
        sources[field] = "spark";
        result.filled++;
      }
    }
    if (Object.keys(labels).length !== Object.keys(page.labels).length) store.setLabels(page.id, labels, sources);
    if (result.stopped) break;
  }
  return result;
}

// The teacher's answer is one PageAnswer object (a verdict, a brand, two form flags and a short reason).
export const TEACHER_MAX_OUTPUT_TOKENS = 600;

if (import.meta.filename === process.argv[1]) {
  const at = process.argv.indexOf("--max");
  const max = at >= 0 ? Number(process.argv[at + 1]) : 500;
  const ledgerFile = metaLedger();
  const release = takeLock(ledgerLock(ledgerFile));
  if (typeof release === "string") {
    console.error(`teacher-label: ${release}`);
    process.exit(1);
  }
  try {
    const secrets = await readSecretsFromVault();
    const env = { META_API_KEY: secrets.meta, CF_AIG_TOKEN: secrets.run, META_GATEWAY_URL: GATEWAY_URL };
    // Every attempt is reserved in main's budget (D03 T01 §2) before it is sent and settled after, by the client;
    // the answer is one short JSON object, so its output is bounded.
    const budget = localBudget("glimmer-teacher-label");
    const owner = { kind: "script", name: "glimmer-teacher-label" } as const;
    const ask: Ask = async (input, instructions) => {
      const { data } = await metaResponses(
        { model: SPARK, input: input as never, instructions, max_output_tokens: TEACHER_MAX_OUTPUT_TOKENS },
        { env, budget, owner },
      );
      const usage = (
        data as {
          usage?: { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number } };
        }
      ).usage;
      const usd =
        typeof usage?.input_tokens === "number" && typeof usage?.output_tokens === "number"
          ? tokenCost(SPARK, usage.input_tokens, usage.output_tokens, usage.input_tokens_details?.cached_tokens ?? 0)
          : null;
      return { text: (data as { output_text?: string }).output_text ?? "", usd };
    };
    const result = await teach({
      store: openStore(storeDir()),
      ask,
      ledgerFile,
      run: `glimmer-teacher-${Date.now()}`,
      max,
    });
    console.log(JSON.stringify(result));
  } finally {
    release();
  }
}
