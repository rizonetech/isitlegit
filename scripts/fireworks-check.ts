// The Fireworks account check and image probe (D03 T04 §2): what the account holds and whether Muse Glimmer's free
// supervised fine-tuning accepts screenshots, proven before any training data is built.
//
//   (default)        lists models, deployments, datasets, fine-tuning jobs, credit redemptions and this month's rated
//                    spend; GET requests only.
//   --probe          writes build/glimmer/probe.jsonl (three of our own fixture images with known answers), uploads it
//                    as dataset `isitlegit-probe` and starts one SFT job on Glimmer with that job ID and output model;
//                    refused on or after 2026-12-01 (the free offer ends 2026-11-30) and while any probe resource
//                    exists. `--probe text` is the control: the same questions with each image described in words,
//                    under `isitlegit-probe-text`, run only when the image probe is refused for its images.
//   --job <id>       one job's state, outcome and bill state; GET only. Only a completed job decides a training mode:
//                    `image-refused` (the failure names images) calls for the text control, and `unresolved` (any
//                    other failure) decides nothing until its cause is fixed.
//   --delete-probe   deletes both probes' job, model and dataset, each only when it exists, and reads each back.
//
// Fireworks exposes no credit balance (`/credits` answers 404): the operator's US$100 is the balance of record, and
// rated spend (`billing/summary`) is what this check can prove. Rated costs lag usage by up to a day, so a job's bill is
// `pending` for 24 hours after it completes and is never shown as zero from a missing or failed read. The admin key
// comes from Conclave through conclave-op, is sent only in the Authorization header and is never printed.
//
//   node scripts/fireworks-check.ts --help
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { setDefaultAutoSelectFamilyAttemptTimeout } from "node:net";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { installSignalCleanup, runCommand } from "./smoke.ts";

const ROOT = join(import.meta.dirname, "..");
export const ACCOUNT = "rizonetech";
export const API = `https://api.fireworks.ai/v1/accounts/${ACCOUNT}`;
export const BASE_MODEL = "accounts/fireworks/models/muse-glimmer-30b";
export const PROBE = "isitlegit-probe";
export const PROBE_TEXT = "isitlegit-probe-text";
// Rated costs settle up to a day after usage (https://docs.fireworks.ai/accounts/exporting-usage-and-costs).
export const BILL_SETTLE_MS = 24 * 60 * 60 * 1000;
// The free offer ends 2026-11-30; the probe is refused from the first instant of 2026-12-01 in South Africa.
export const PROBE_CUTOFF = new Date("2026-12-01T00:00:00+02:00");
const VAULT_ADMIN = "IsItLegit Fireworks Admin";
// Fireworks refuses dataset uploads from service-account keys ("dataset uploads are temporarily disabled"), while the
// operator's own user uploads normally (2026-10-28), so the probe runs on a key of that user.
const VAULT_OWNER = "IsItLegit Fireworks Owner";
export const PROBE_FILE = join(ROOT, "build/glimmer/probe.jsonl");
export const PROBE_TEXT_FILE = join(ROOT, "build/glimmer/probe-text.jsonl");
const FIXTURES = join(ROOT, "test/fixtures/meta-smoke");
const REQUEST_MS = 60_000;
// Node's fetch tries each of a host's addresses for 250 ms by default before the next. From this host a connection to
// api.fireworks.ai (US West) takes about 300 ms (curl's time_connect, 2026-10-28), so every address timed out and the
// check failed with ETIMEDOUT; 2 seconds an address connects on the first IPv4 address.
export const CONNECT_ATTEMPT_MS = 2_000;
export function configureNetwork(): void {
  setDefaultAutoSelectFamilyAttemptTimeout(CONNECT_ATTEMPT_MS);
}

export const USAGE = `node scripts/fireworks-check.ts [--write-probe-lines | --job <id> | --delete-probe | --probe]

Lists what the Fireworks account ${ACCOUNT} holds, and prepares the Glimmer image probe (D03 T04 §2).

The probe runs on the Serverless Training API (Fireworks closed dataset uploads on 2026-10-28), in two commands:
  node scripts/fireworks-check.ts --write-probe-lines
  ~/.venvs/fireworks/bin/python scripts/glimmer/serverless_probe.py

  (no option)          models, deployments, datasets, fine-tuning jobs, credit redemptions, this month's rated spend
  --write-probe-lines  write the image probe and its text control to build/glimmer/ (local, no key, no request)
  --job <id>           one managed fine-tuning job's state, outcome and training bill
  --delete-probe       delete both managed probes' job, model and dataset
  --probe [text]       UNAVAILABLE while Fireworks keeps dataset uploads closed: the managed probe, uploading
                       ${PROBE} (or ${PROBE_TEXT}) and starting one SFT job on ${BASE_MODEL}
  --help               this text

Exit codes: 0 done, 1 Fireworks refused or failed a request, 2 refused before sending.`;

export type Variant = "image" | "text";
export type Mode =
  | { kind: "list" }
  | { kind: "probe"; variant: Variant }
  | { kind: "job"; id: string }
  | { kind: "delete-probe" }
  | { kind: "write-probe-lines" };

export function parseCheckArgs(argv: string[]): { help: boolean; mode: Mode } {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      probe: { type: "boolean", default: false },
      text: { type: "boolean", default: false },
      job: { type: "string" },
      "delete-probe": { type: "boolean", default: false },
      "write-probe-lines": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
    allowPositionals: true,
  });
  // `--probe text` reads as written; `--text` alone is the same flag.
  const text = values.text || (values.probe && positionals.length === 1 && positionals[0] === "text");
  if (positionals.length > (values.probe ? 1 : 0) || (positionals.length === 1 && positionals[0] !== "text"))
    throw new Error(`unexpected argument: ${positionals.join(" ")}`);
  if (text && !values.probe) throw new Error("text goes with --probe");
  const chosen = [values.probe, values.job !== undefined, values["delete-probe"], values["write-probe-lines"]].filter(
    Boolean,
  ).length;
  if (chosen > 1) throw new Error("choose one of --probe, --job, --delete-probe and --write-probe-lines");
  if (values.job !== undefined && !/^[a-z0-9][a-z0-9-]{0,62}$/.test(values.job))
    throw new Error("--job takes a job ID: lowercase letters, digits and dashes");
  const mode: Mode = values.probe
    ? { kind: "probe", variant: text ? "text" : "image" }
    : values.job !== undefined
      ? { kind: "job", id: values.job }
      : values["delete-probe"]
        ? { kind: "delete-probe" }
        : values["write-probe-lines"]
          ? { kind: "write-probe-lines" }
          : { kind: "list" };
  return { help: values.help, mode };
}

type Line = { messages: { role: "user" | "assistant"; content: unknown }[] };

// Three probe lines from our own fixture images, each answer a fact the image shows (test/fixtures/meta-smoke). The
// text control asks the same questions with the image described in words, so it differs only in carrying no image.
export function probeLines(variant: Variant = "image", dir = FIXTURES): Line[] {
  const facts = JSON.parse(readFileSync(join(dir, "fixtures.json"), "utf-8"));
  const [lw, lh] = facts.logoSize as number[];
  const [pw, ph] = facts.pageSize as number[];
  const image = (name: string) => `data:image/png;base64,${readFileSync(join(dir, name)).toString("base64")}`;
  const line = (name: string, described: string, question: string, answer: string): Line => ({
    messages: [
      {
        role: "user",
        content:
          variant === "image"
            ? [
                { type: "text", text: question },
                { type: "image_url", image_url: { url: image(name) } },
              ]
            : `${described}\n\n${question}`,
      },
      { role: "assistant", content: answer },
    ],
  });
  const box = (b: number[]) => b.join(",");
  return [
    line(
      "code-card.png",
      `A white card with one line of printed text: ${facts.code}.`,
      "What code is printed on this card? Answer with the code only.",
      facts.code,
    ),
    line(
      "logo-card.png",
      `A ${lw} by ${lh} pixel card with a logo whose box is ${box(facts.logoBox)}.`,
      "Where is the logo on this card? Answer as x1,y1,x2,y2 in pixels.",
      box(facts.logoBox),
    ),
    line(
      "continue-page.png",
      `A ${pw} by ${ph} pixel page with a Continue button whose box is ${box(facts.buttonBox)}.`,
      "Where is the Continue button on this page? Answer as x1,y1,x2,y2 in pixels.",
      box(facts.buttonBox),
    ),
  ];
}

export type Outcome = "completed" | "image-refused" | "unresolved" | "running";
const FAILED = new Set(["JOB_STATE_FAILED", "JOB_STATE_CANCELLED", "JOB_STATE_EXPIRED", "JOB_STATE_EARLY_STOPPED"]);

// What a job proves. Only a completed job decides a training mode; a failure decides one only when Fireworks says the
// images were the problem, and anything else (authentication, quota, outage, a malformed line) decides nothing.
// Only an explicit statement that image input as such is missing proves images are refused. A decode error, an outage,
// or a limit on one image's format, resolution or size is not one (scripts/glimmer/serverless_probe.py holds the same
// rule).
const UNSUPPORTED =
  /(not supported|unsupported|does not support|doesn't support|cannot accept|can't accept|not accepted|not enabled|disabled)[^.\n]{0,60}\b(image inputs?|images|vision|multimodal|image_url)\b|\b(image inputs?|images|vision|multimodal|image_url)\b[^.\n]{0,60}(not supported|unsupported|not accepted|not enabled|disabled)/i;
const INPUT_LIMIT =
  /\b(format|resolution|size|dimensions?|too (large|big|small)|larger|smaller|exceed\w*|limit\w*|max(imum)?|tokens?|pixels?|jpe?g|png|decode|corrupt\w*)/i;

export function probeOutcome(state: unknown, message: unknown): Outcome {
  if (state === "JOB_STATE_COMPLETED") return "completed";
  if (typeof state === "string" && FAILED.has(state))
    return UNSUPPORTED.test(String(message ?? "")) && !INPUT_LIMIT.test(String(message ?? ""))
      ? "image-refused"
      : "unresolved";
  return "running";
}

const TRAINING_SERIES = /train|fine.?tun|\bsft\b/i;

export type BillState =
  | { kind: "pending"; until: string }
  | { kind: "unattributable"; jobs: string[] }
  | { kind: "unavailable"; reason: string }
  | {
      kind: "rated";
      total: number;
      series: { series: string; cost: number }[];
      other?: { series: string; cost: number }[];
    };

// A job's bill from the account's rated spend over the job's window. Rated costs lag, so the bill is pending for a day
// after the job ends; another job's training usage in the window makes the total unattributable; a failed read is
// unavailable. Never zero by default.
export function billingState(input: {
  jobId: string;
  completedTime?: string;
  now: Date;
  trainingJobIds?: string[];
  lineItems?: { series?: string; totalCost?: unknown }[];
  error?: string;
}): BillState {
  const ended = input.completedTime ? Date.parse(input.completedTime) : Number.NaN;
  if (!Number.isFinite(ended)) return { kind: "pending", until: "the job ends" };
  if (input.now.getTime() < ended + BILL_SETTLE_MS)
    return { kind: "pending", until: new Date(ended + BILL_SETTLE_MS).toISOString() };
  if (input.error !== undefined || !input.lineItems || !input.trainingJobIds)
    return { kind: "unavailable", reason: input.error ?? "no billing read" };
  const others = [...new Set(input.trainingJobIds.filter((id) => id && id !== input.jobId))];
  if (others.length) return { kind: "unattributable", jobs: others };
  // Only training is the job's: billing/summary's categories are the account's, so inference or deployment spend in
  // the same window is listed apart and never added to the job's bill.
  const series = input.lineItems.map((item) => ({ series: item.series ?? "unnamed", cost: costOf(item.totalCost) }));
  const training = series.filter((s) => TRAINING_SERIES.test(s.series));
  const other = series.filter((s) => !TRAINING_SERIES.test(s.series) && s.cost !== 0);
  return { kind: "rated", total: training.reduce((sum, s) => sum + s.cost, 0), series: training, other };
}

export function describeBill(bill: BillState): string {
  switch (bill.kind) {
    case "pending":
      return `bill: pending until ${bill.until} (rated costs lag)`;
    case "unattributable":
      return `bill: unattributable (other training jobs in the window: ${bill.jobs.join(", ")})`;
    case "unavailable":
      return `bill: unavailable (${bill.reason})`;
    case "rated": {
      const list = (items: { series: string; cost: number }[]) =>
        items.map((s) => `${s.series} US$${s.cost.toFixed(2)}`).join(", ");
      const own = bill.series.length ? ` (${list(bill.series)})` : "";
      const other = bill.other?.length ? `; not the job's, excluded: ${list(bill.other)}` : "";
      return `bill: US$${bill.total.toFixed(2)} of training rated in the job's window${own}${other}`;
    }
  }
}

function writeAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, text);
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

export type RunOptions = {
  mode: Mode;
  readKey?: (item: string) => Promise<string>;
  fetch?: typeof fetch;
  now?: () => Date;
  probeFile?: string;
  probeTextFile?: string;
  fixturesDir?: string;
  log?: (line: string) => void;
  datasetWaitMs?: number;
  pollMs?: number;
};
export type RunOutcome = { code: 0 | 1 | 2; lines: string[] };

class FireworksError extends Error {}

export async function runFireworksCheck(options: RunOptions): Promise<RunOutcome> {
  const lines: string[] = [];
  const say = (line: string) => {
    lines.push(line);
    options.log?.(line);
  };
  const now = options.now ?? (() => new Date());
  const fetchImpl = options.fetch ?? fetch;

  // The probe's two files for scripts/glimmer/serverless_probe.py: local, no key, no request.
  if (options.mode.kind === "write-probe-lines") {
    for (const [variant, file] of [
      ["image", options.probeFile ?? PROBE_FILE],
      ["text", options.probeTextFile ?? PROBE_TEXT_FILE],
    ] as const) {
      try {
        writeAtomic(
          file,
          `${probeLines(variant, options.fixturesDir)
            .map((line) => JSON.stringify(line))
            .join("\n")}\n`,
        );
      } catch (error) {
        // The rename never ran, so an earlier good file is still in place.
        say(`could not write ${file} (${(error as Error).message}); free space or fix the folder's permissions`);
        return { code: 1, lines };
      }
      say(`wrote ${variant} probe lines: ${file}`);
    }
    return { code: 0, lines };
  }

  if (options.mode.kind === "probe" && now() >= PROBE_CUTOFF) {
    say(`refused: the free Glimmer training offer ended 2026-11-30; no probe is started on or after 2026-12-01`);
    return { code: 2, lines };
  }

  // The probe uploads, so it runs as the operator's own user; everything else reads or deletes as the admin service
  // account.
  const item = options.mode.kind === "probe" ? VAULT_OWNER : VAULT_ADMIN;
  let key: string;
  try {
    key = await (options.readKey ?? ((title: string) => readKeyFromVault(title)))(item);
  } catch (error) {
    say(`refused: ${(error as Error).message}`);
    return { code: 2, lines };
  }
  if (!key) {
    say(`refused: the vault item "${item}" has an empty credential`);
    return { code: 2, lines };
  }
  // Nothing Fireworks returns is printed until this has taken the key out of it.
  const clean = (text: string) => text.split(key).join("[key]");

  async function call(method: "GET" | "POST" | "DELETE", path: string, body?: unknown | FormData) {
    const headers: Record<string, string> = { authorization: `Bearer ${key}` };
    let payload: string | FormData | undefined;
    if (body instanceof FormData) payload = body;
    else if (body !== undefined) {
      headers["content-type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const response = await fetchImpl(`${API}${path}`, {
      method,
      headers,
      ...(payload !== undefined ? { body: payload } : {}),
      signal: AbortSignal.timeout(REQUEST_MS),
    });
    const text = await response.text();
    const ok = response.status >= 200 && response.status <= 299;
    // An empty success is an answer only to a DELETE; a read or a create with no body has said nothing, and is never
    // taken for an empty account or zero spend.
    if (ok && !text.trim() && method !== "DELETE")
      throw new FireworksError(`${method} ${path} answered HTTP ${response.status} with an empty body`);
    let json: unknown = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      // A success that is not JSON (an HTML error page behind a proxy) is no answer: never read as an empty account.
      if (ok)
        throw new FireworksError(`${method} ${path} answered HTTP ${response.status} with a body that is not JSON`);
      json = { message: text.slice(0, 300) };
    }
    if (ok && (json === null || typeof json !== "object" || Array.isArray(json)))
      throw new FireworksError(`${method} ${path} answered HTTP ${response.status} with no JSON object`);
    return { status: response.status, json: json as Record<string, unknown> };
  }
  async function must(method: "GET" | "POST" | "DELETE", path: string, body?: unknown | FormData) {
    const answer = await call(method, path, body);
    if (answer.status < 200 || answer.status > 299) {
      const message = typeof answer.json.message === "string" ? answer.json.message : "";
      throw new FireworksError(
        clean(`${method} ${path} answered HTTP ${answer.status}${message ? `: ${message}` : ""}`),
      );
    }
    return answer.json;
  }
  async function list(collection: string): Promise<Record<string, unknown>[]> {
    const items: Record<string, unknown>[] = [];
    let token = "";
    do {
      const page = await must(
        "GET",
        `/${collection}?pageSize=200${token ? `&pageToken=${encodeURIComponent(token)}` : ""}`,
      );
      const found = page[collection];
      // Fireworks leaves an empty list out of its JSON; anything other than a list or nothing is not an answer.
      if (found !== undefined && !Array.isArray(found))
        throw new FireworksError(`GET /${collection} answered without a list of ${collection}`);
      items.push(...((found as Record<string, unknown>[] | undefined) ?? []));
      token = typeof page.nextPageToken === "string" ? page.nextPageToken : "";
    } while (token);
    return items;
  }
  const exists = async (path: string) => {
    const answer = await call("GET", path);
    if (answer.status === 404) return false;
    if (answer.status >= 200 && answer.status <= 299) return true;
    throw new FireworksError(`GET ${path} answered HTTP ${answer.status}`);
  };
  const pathsOf = (name: string) => ({
    job: `/supervisedFineTuningJobs/${name}`,
    model: `/models/${name}`,
    dataset: `/datasets/${name}`,
  });
  const short = (name: unknown) => String(name ?? "").replace(`accounts/${ACCOUNT}/`, "");

  try {
    switch (options.mode.kind) {
      case "list": {
        for (const collection of ["models", "deployments", "datasets", "supervisedFineTuningJobs"]) {
          const items = await list(collection);
          say(`${collection}: ${items.length}`);
          for (const item of items)
            say(
              `  ${short(item.name)}${item.state ? ` ${item.state}` : ""}${item.createTime ? ` created ${item.createTime}` : ""}`,
            );
        }
        const redemptions = await list("creditRedemptions");
        say(`creditRedemptions: ${redemptions.length}`);
        for (const item of redemptions) say(`  redeemed ${item.createTime}`);
        const at = now();
        const start = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
        const summary = await must(
          "GET",
          `/billing/summary?startTime=${start.toISOString()}&endTime=${at.toISOString()}`,
        );
        const items = lineItemsOf(summary);
        const total = items.reduce((sum, item) => sum + costOf(item.totalCost), 0);
        say(`rated spend ${start.toISOString().slice(0, 10)} to now: US$${total.toFixed(2)}`);
        for (const item of items) say(`  ${item.series ?? "unnamed"}: US$${Number(costOf(item.totalCost)).toFixed(2)}`);
        say("credit balance: not exposed by the Fireworks API (the operator's figure is the balance of record)");
        return { code: 0, lines };
      }
      case "job": {
        const id = options.mode.id;
        const job = await must("GET", `/supervisedFineTuningJobs/${id}`);
        const status = job.status as { message?: string } | undefined;
        say(`probe job ${id}: ${job.state}`);
        if (status?.message) say(`  status: ${clean(status.message)}`);
        say(`  outcome: ${probeOutcome(job.state, status?.message)}`);
        if (job.estimatedCost !== undefined) say(`  estimatedCost: ${JSON.stringify(job.estimatedCost)}`);
        if (job.outputModel) say(`  outputModel: ${job.outputModel}`);
        const completedTime = typeof job.completedTime === "string" ? job.completedTime : undefined;
        let bill = billingState({ jobId: id, now: now(), ...(completedTime ? { completedTime } : {}) });
        if (bill.kind !== "pending") {
          const window = `startTime=${encodeURIComponent(String(job.createTime))}&endTime=${encodeURIComponent(now().toISOString())}`;
          try {
            const usage = await must("GET", `/billingUsage?usageType=TRAINING&${window}`);
            const summary = await must("GET", `/billing/summary?${window}`);
            bill = billingState({
              jobId: id,
              now: now(),
              ...(completedTime ? { completedTime } : {}),
              trainingJobIds: ((usage.trainingCosts as { jobId?: string }[] | undefined) ?? []).map(
                (row) => row.jobId ?? "",
              ),
              lineItems: lineItemsOf(summary),
            });
          } catch (error) {
            bill = billingState({
              jobId: id,
              now: now(),
              ...(completedTime ? { completedTime } : {}),
              error: (error as Error).message,
            });
          }
        }
        say(`  ${describeBill(bill)}`);
        return { code: 0, lines };
      }
      case "delete-probe": {
        let left = 0;
        for (const name of [PROBE, PROBE_TEXT])
          for (const [kind, path] of Object.entries(pathsOf(name))) {
            if (!(await exists(path))) {
              say(`no ${kind} ${name}`);
              continue;
            }
            await must("DELETE", path);
            // A deletion counts only once a read finds the resource gone.
            if (await exists(path)) {
              left++;
              say(`${kind} ${name} still exists after its DELETE`);
            } else say(`deleted ${kind} ${name}`);
          }
        return { code: left ? 1 : 0, lines };
      }
      case "probe": {
        const name = options.mode.variant === "image" ? PROBE : PROBE_TEXT;
        const paths = pathsOf(name);
        for (const [kind, path] of Object.entries(paths))
          if (await exists(path)) {
            say(`refused: a probe ${kind} already exists (${name}); run --delete-probe first`);
            return { code: 2, lines };
          }
        const probe = probeLines(options.mode.variant, options.fixturesDir);
        const text = `${probe.map((line) => JSON.stringify(line)).join("\n")}\n`;
        // Each variant has its own file, so the text control can never overwrite the image probe.
        const file =
          options.mode.variant === "image"
            ? (options.probeFile ?? PROBE_FILE)
            : (options.probeTextFile ?? PROBE_TEXT_FILE);
        writeAtomic(file, text);
        const display = options.mode.variant === "image" ? "IsItLegit image probe" : "IsItLegit text control probe";
        await must("POST", "/datasets", {
          datasetId: name,
          dataset: { displayName: display, format: "CHAT", exampleCount: String(probe.length), userUploaded: {} },
        });
        const form = new FormData();
        form.append("file", new Blob([readFileSync(file)], { type: "application/jsonl" }), "probe.jsonl");
        await must("POST", `/datasets/${name}:upload`, form);
        // The upload is validated before a job may read it.
        const deadline = Date.now() + (options.datasetWaitMs ?? 120_000);
        for (;;) {
          const dataset = await must("GET", paths.dataset);
          if (dataset.state === "READY") break;
          const message = (dataset.status as { message?: string } | undefined)?.message;
          if (dataset.state === "FAILED" || dataset.state === "STATE_FAILED") {
            say(`the dataset failed validation${message ? `: ${clean(message)}` : ""}; no job was started`);
            say(`  outcome: ${probeOutcome("JOB_STATE_FAILED", message)}`);
            return { code: 1, lines };
          }
          if (Date.now() > deadline) {
            say(`the dataset is still ${dataset.state} after the wait; no job was started`);
            return { code: 1, lines };
          }
          await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? 5_000));
        }
        const job = await must("POST", `/supervisedFineTuningJobs?supervisedFineTuningJobId=${name}`, {
          displayName: display,
          baseModel: BASE_MODEL,
          dataset: `accounts/${ACCOUNT}/datasets/${name}`,
          outputModel: `accounts/${ACCOUNT}/models/${name}`,
          epochs: 1,
        });
        // Clean-up finds the job by this name, so a job under any other name is a failure to report, not a success.
        if (job.name !== `accounts/${ACCOUNT}/supervisedFineTuningJobs/${name}`) {
          say(`the job came back as ${short(job.name)}, not supervisedFineTuningJobs/${name}; delete it by that name`);
          return { code: 1, lines };
        }
        say(`started job ${short(job.name)}: ${job.state}`);
        return { code: 0, lines };
      }
    }
  } catch (error) {
    if (error instanceof FireworksError) {
      say(error.message);
      return { code: 1, lines };
    }
    say(clean(`request failed: ${(error as Error).message}`));
    return { code: 1, lines };
  }
}

// Rated costs arrive as a google.type.Money ({ currencyCode, units, nanos }) or a plain number or string.
// Rated costs arrive as a google.type.Money ({ currencyCode, units, nanos }) or a plain number or numeric string. A
// value that is none of those is malformed, never zero.
function costOf(value: unknown): number {
  let amount: number;
  if (value && typeof value === "object") {
    const money = value as { units?: unknown; nanos?: unknown };
    amount = Number(money.units ?? 0) + Number(money.nanos ?? 0) / 1e9;
  } else if (typeof value === "number" || (typeof value === "string" && value.trim() !== "")) amount = Number(value);
  else amount = Number.NaN;
  if (!Number.isFinite(amount)) throw new FireworksError(`a rated cost is not an amount (${JSON.stringify(value)})`);
  return amount;
}

function lineItemsOf(summary: Record<string, unknown>): { series?: string; totalCost?: unknown }[] {
  const items = summary.lineItems;
  if (items === undefined) return [];
  if (!Array.isArray(items)) throw new FireworksError("billing/summary answered without a list of lineItems");
  return items as { series?: string; totalCost?: unknown }[];
}

async function readKeyFromVault(item: string): Promise<string> {
  try {
    return (
      await runCommand("conclave-op", ["read", `op://Conclave/${item}/credential`], "", Date.now() + 60_000)
    ).trim();
  } catch {
    throw new Error(
      `reading "${item}" from Conclave failed; check the item exists and that conclave-op can reach 1Password`,
    );
  }
}

if (import.meta.filename === process.argv[1]) {
  let args: ReturnType<typeof parseCheckArgs>;
  try {
    args = parseCheckArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`fireworks-check: ${(error as Error).message}\n\n${USAGE}`);
    process.exit(2);
  }
  if (args.help) {
    console.log(USAGE);
    process.exit(0);
  }
  installSignalCleanup("fireworks-check");
  configureNetwork();
  const outcome = await runFireworksCheck({ mode: args.mode, log: (line) => console.log(line) });
  process.exit(outcome.code);
}
