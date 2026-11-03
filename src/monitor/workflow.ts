// The impersonation monitor's Workflow and its daily dispatch (D05 T04 §2): one instance per organisation per SAST
// day, its id the organisation and the day, so a repeated tick starts nothing new (correction 3). The instance runs
// `monitorOrg` (./run.ts) with the real network: DNS over HTTPS at cloudflare-dns.com, the homepage captured through
// Browser Run with downloads refused and the session closed in every case, and Glimmer woken and settled through
// src/vision/glimmer-wake.ts. Dispatch goes on past an organisation whose instance cannot be created, and says so.

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import puppeteer from "@cloudflare/puppeteer";
import { brandTableRead } from "../checks/brands";
import { ulid } from "../db/ulid";
import { d1Budget } from "../meta/budget";
import { d1Exec, findBurst } from "../vision/glimmer-minutes";
import { type Burst, REQUEST_MS, settleGlimmer } from "../vision/glimmer-wake";
import type { LogoImage } from "../vision/logo-compare";
import { cropBoxes, segment } from "../vision/sam";
import { closeGlimmer, openGlimmer, screenPage } from "../vision/screen";
import { kvCache, walkthroughStep } from "../walkthrough/trigger";
import { dohResolve } from "../walkthrough/url-policy";
import { walk } from "../walkthrough/wonder";
import { ctCandidates } from "./ct";
import { findingsFromInvestigations } from "./findings";
import { monitorPipeline, type PipelineDeps } from "./pipeline";
import {
  type Capture,
  CaptureFailed,
  type Lookup,
  type MonitorDeps,
  monitorOrg,
  protectedOrgs,
  type RunSummary,
  sastDay,
} from "./run";
import { secondLook } from "./second-look";
import { type Cdp, collectEvidence } from "./signals";

export type MonitorParams = { orgId: string; day: string };
const DOH = "https://cloudflare-dns.com/dns-query";
const LOOKUP_MS = 5_000;
const CAPTURE_MS = 20_000;
// Seconds Glimmer is reserved for each page the run may screen (§3), the screener's own allowance.
const CALL_SECONDS = 20;

// A and AAAA answers for a host; NXDOMAIN or no address is "none", a failed or timed-out query of either family is
// "failed" (correction 13).
export async function dohLookup(host: string, fetcher: typeof fetch = fetch): Promise<Lookup> {
  const answers: string[] = [];
  for (const type of ["A", "AAAA"] as const) {
    let body: { Status?: number; Answer?: { type: number; data: string }[] };
    try {
      const res = await fetcher(`${DOH}?name=${encodeURIComponent(host)}&type=${type}`, {
        headers: { accept: "application/dns-json" },
        signal: AbortSignal.timeout(LOOKUP_MS),
      });
      if (!res.ok) return { status: "failed", error: `http-${res.status}` };
      body = (await res.json()) as typeof body;
    } catch (error) {
      return { status: "failed", error: (error as Error).name || "Error" };
    }
    // RCODE 3 is NXDOMAIN; 0 with no address answers is a name without one.
    if (body.Status !== 0 && body.Status !== 3) return { status: "failed", error: `rcode-${body.Status}` };
    for (const a of body.Answer ?? []) if (a.type === 1 || a.type === 28) answers.push(a.data);
  }
  return answers.length ? { status: "resolves", answers } : { status: "none" };
}

// The homepage through Browser Run: a JPEG screenshot, the visible text and the address it ended on, downloads
// refused, the session closed whatever happens (correction 8). HTTPS first; a host with no HTTPS listener (refused,
// reset, or a TLS failure) is tried once over HTTP, a lure served that way being as real (completion review gap 7); a
// timeout is not retried, so a capture stays bounded. An HTTP error answer, or none, is a failed capture, never a page
// to keep (gap 6).
const NO_HTTPS =
  /ERR_CONNECTION_REFUSED|ERR_CONNECTION_RESET|ERR_CONNECTION_CLOSED|ERR_EMPTY_RESPONSE|ERR_SSL|ERR_CERT/;
type Launch = (browser: Env["BROWSER"]) => Promise<Awaited<ReturnType<typeof puppeteer.launch>>>;
export async function browserCapture(
  browser: Env["BROWSER"],
  host: string,
  launch: Launch = (b) => puppeteer.launch(b),
  path = "",
): Promise<Capture> {
  const session = await launch(browser);
  try {
    const page = await session.newPage();
    const cdp = await page.target().createCDPSession();
    await cdp.send("Browser.setDownloadBehavior", { behavior: "deny" });
    let response: Awaited<ReturnType<typeof page.goto>> = null;
    for (const scheme of ["https", "http"] as const) {
      try {
        response = await page.goto(`${scheme}://${host}/${path}`, {
          waitUntil: "domcontentloaded",
          timeout: CAPTURE_MS,
        });
        break;
      } catch (error) {
        if (scheme === "http" || !NO_HTTPS.test(String((error as Error)?.message ?? error))) throw error;
      }
    }
    if (!response) throw new CaptureFailed("no-response");
    if (response.status() >= 400) throw new CaptureFailed(`http-${response.status()}`);
    // The evidence in the order that no page script can blind (completion review round 3): the structure over the
    // protocol either side of the screenshot, the page-controlled `innerText` last.
    const evidence = await collectEvidence({
      cdp: cdp as unknown as Cdp,
      screenshot: async () => (await page.screenshot({ type: "jpeg", quality: 70 })) as Uint8Array,
      // Run in the page, where the Worker's types have no DOM: the visible text, as a string expression.
      text: async () => String(await page.evaluate("document.body ? document.body.innerText : ''")).slice(0, 200_000),
    });
    return { ...evidence, url: page.url() };
  } finally {
    await session.close();
  }
}

export function monitorDeps(
  env: Env,
  runId: string,
  opts: { fetcher?: typeof fetch; now?: () => number; sparkFetch?: typeof fetch; ctFetch?: typeof fetch } = {},
): MonitorDeps & { heldSince: (id: string) => Promise<number | null> } {
  const ledger = d1Exec(env.DB);
  const { sparkFetch, ...loupe } = opts;
  const wakeCtx = (calls: number) => ({ env, ledger, burstId: runId, calls, callSeconds: CALL_SECONDS, ...loupe });
  // Spark's context (D03 T01): the budget over D1, and its record writes held until the step's end, as a Workflow step
  // has no request to keep them alive.
  const pending: Promise<unknown>[] = [];
  const keep = (p: Promise<unknown>) => void pending.push(p);
  const spark = {
    env,
    budget: d1Budget(env.DB, { caller: "monitor", waitUntil: keep }),
    waitUntil: keep,
    // The Meta client's transport, which only a test names (the Loupe seam's twin).
    ...(sparkFetch ? { fetch: sparkFetch } : {}),
  };
  return {
    // CT runs on its own transport; when a test names the run's transports, CT stays off
    // unless it names ctFetch too, so a stubbed run never reaches the network by surprise.
    ...(opts.ctFetch || (!opts.fetcher && !opts.sparkFetch)
      ? { ct: (tokens: string[]) => ctCandidates(opts.ctFetch ?? fetch, tokens) }
      : {}),
    db: env.DB,
    store: env.ARTEFACTS,
    resolve: (host) => dohLookup(host),
    capture: (host) => browserCapture(env.BROWSER, host),
    // A seeded host's page (D05 T04 §6): the fixtures prefix is the Worker's own secret,
    // applied here and never stored in the seed.
    captureSeed: (host: string, path: string) =>
      browserCapture(
        env.BROWSER,
        host,
        undefined,
        `${(env as { FIXTURES_PREFIX?: string }).FIXTURES_PREFIX ?? ""}/${path}`,
      ),
    // The run's one Loupe session: a failed wake or warm-up settlement stays in it (D03 T04 §40), and `closeGlimmer`
    // settles it again to the same cutoff.
    open: (calls) => openGlimmer(wakeCtx(calls)),
    close: (session) => closeGlimmer(session),
    screen: (page, session, run) => screenPage(page, session, spark, run),
    second: (page, run) => secondLook(page, run, spark),
    flush: () => Promise.allSettled(pending.splice(0)),
    heldSince: async (id) => {
      const held = await findBurst(ledger, id);
      return held && !held.settled ? Date.parse(held.wakeAt) : null;
    },
    settle: (burst, until) => settleGlimmer(wakeCtx(0), burst, until),
  };
}

// The settlement a run could not make, made again on its own: it throws while the ledger refuses, so the step retries
// it without capturing anything again (completion review gap 10).
export async function settleAgain(
  deps: Pick<MonitorDeps, "settle"> & { heldSince?: (id: string) => Promise<number | null> },
  burst: Burst & { until?: number },
): Promise<true> {
  // A wake time not known when the run ended (null once it has been through the step's JSON) is read now; a lookup
  // that fails throws, so the step retries it.
  let wakeAt = Number(burst.wakeAt ?? Number.NaN);
  if (!Number.isFinite(wakeAt)) {
    const held = await deps.heldSince?.(burst.id);
    if (held === null) return true;
    if (held === undefined || !Number.isFinite(held)) throw new Error("the reservation's wake time is unknown");
    wakeAt = held;
  }
  const until = Number.isFinite(burst.until) ? (burst.until as number) : wakeAt + REQUEST_MS;
  const result = (await deps.settle({ id: burst.id, wakeAt, deadline: burst.deadline }, until)) as {
    ok?: boolean;
    detail?: string;
  };
  if (result?.ok === false) throw new Error(`settlement refused: ${result.detail ?? "refused"}`);
  return true;
}

// The Workflow's body: the run in one retried step, then the run's reservation settled in a step of its own, keyed by
// the run's id, whatever the run step returned or however it failed (an attempt whose last write failed hands nothing
// back, and its retry may have nothing to capture and so never wake; round 3). The settle step reads the ledger and is
// a no-op when nothing is held. A run that failed still fails, after the settlement.
type Steps = Pick<WorkflowStep, "do">;
// The pipeline's production deps (D05 T04 §4): the walkthrough with its own driver, and the SAM logo
// crop through Browser Run, on the same Browser binding the capture uses.
export function pipelineDeps(env: Env): PipelineDeps {
  const store = { bucket: env.ARTEFACTS, db: env.DB };
  return {
    db: env.DB,
    bucket: env.ARTEFACTS,
    store,
    kv: env.CACHE,
    meta: {
      env,
      budget: d1Budget(env.DB, { caller: "monitor" }),
    },
    walk: async (caseId) => {
      const { table } = await brandTableRead(env);
      return walkthroughStep(
        {
          db: env.DB,
          store,
          cache: kvCache(env.CACHE),
          launch: () => puppeteer.launch(env.BROWSER),
          walk,
          resolve: dohResolve(),
          meta: { env, budget: d1Budget(env.DB, { caller: "walkthrough", caseId }) },
          table,
          revision: env.CF_VERSION_METADATA?.id ?? null,
          walkId: () => ulid(),
        },
        caseId,
      );
    },
    cropLogo: async (screenshot, dataUrl): Promise<LogoImage | null> => {
      const meta = {
        env,
        budget: d1Budget(env.DB, { caller: "monitor" }),
        owner: { kind: "monitor" as const, run: "pipeline", host: "page", step: "logo" },
      };
      const boxes = await segment(meta, dataUrl, "logo");
      if (!boxes.length) return null;
      const browser = await puppeteer.launch(env.BROWSER);
      try {
        const { crops } = await cropBoxes(browser, screenshot, boxes);
        const crop = crops[0];
        return crop ? { bytes: crop.bytes, mediaType: "image/png", label: "the page's logo crop" } : null;
      } finally {
        await browser.close();
      }
    },
  };
}

export async function runMonitor(
  step: Steps,
  deps: MonitorDeps & { heldSince: (id: string) => Promise<number | null> },
  orgId: string,
  runId: string,
  pipeline?: (orgId: string) => Promise<{ investigated: number }>,
  findings?: (orgId: string) => Promise<{ created: number; alerted: number; reopened: number }>,
): Promise<RunSummary> {
  let summary: RunSummary | undefined;
  let failure: unknown;
  try {
    summary = await step.do(
      "monitor",
      { retries: { limit: 2, delay: "1 minute", backoff: "exponential" }, timeout: "30 minutes" },
      async () => monitorOrg(deps, orgId, runId),
    );
  } catch (error) {
    failure = error;
  }
  const held: Burst = summary?.unsettled ?? { id: runId, wakeAt: Number.NaN, deadline: Number.NaN };
  await step.do(
    "settle",
    { retries: { limit: 5, delay: "1 minute", backoff: "exponential" }, timeout: "1 minute" },
    () => settleAgain(deps, held),
  );
  // The full pipeline on the run's flagged pages (D05 T04 §4), after settlement, in its own step: a
  // page that fails settles partial on its own row and never fails the run.
  if (pipeline)
    await step.do(
      "pipeline",
      { retries: { limit: 2, delay: "1 minute", backoff: "exponential" }, timeout: "30 minutes" },
      async () => pipeline(orgId),
    );
  // Findings and their alerts (D05 T04 §5), after the pipeline settles. An exhausted failure
  // marks the persisted run partial, so the console warns instead of a clean success with
  // findings or alerts missing.
  if (findings)
    await step
      .do(
        "findings",
        { retries: { limit: 2, delay: "1 minute", backoff: "exponential" }, timeout: "5 minutes" },
        async () => findings(orgId),
      )
      .catch(async (error: unknown) => {
        console.log(
          JSON.stringify({ event: "monitor-findings", outcome: "failed", error: (error as Error).name || "Error" }),
        );
        // The partial mark is itself a retried step: if it cannot be written, the failure
        // propagates instead of a clean summary over a successful-looking run.
        await step.do(
          "findings-partial",
          { retries: { limit: 5, delay: "1 minute", backoff: "exponential" }, timeout: "1 minute" },
          async () => {
            await deps.db
              .prepare("UPDATE monitor_runs SET outcome = 'partial' WHERE org_id = ? AND run_id = ?")
              .bind(orgId, runId)
              .run();
            return { marked: true };
          },
        );
        if (summary) summary = { ...summary, outcome: "partial" };
      });
  if (failure !== undefined) throw failure;
  return summary as RunSummary;
}

export class MonitorWorkflow extends WorkflowEntrypoint<Env, MonitorParams> {
  async run(event: WorkflowEvent<MonitorParams>, step: WorkflowStep) {
    const runId = `monitor-${event.payload.orgId}-${event.payload.day}`;
    const since = new Date(Date.parse(event.payload.day) - 7 * 24 * 60 * 60_000).toISOString();
    return runMonitor(
      step,
      monitorDeps(this.env, runId),
      event.payload.orgId,
      runId,
      (orgId) => monitorPipeline(pipelineDeps(this.env), orgId, since),
      (orgId) =>
        findingsFromInvestigations(this.env.DB, orgId, {
          mail: this.env.SMTP2GO_API_KEY
            ? { db: this.env.DB, apiKey: this.env.SMTP2GO_API_KEY, operator: this.env.OPERATOR_EMAIL }
            : null,
          appUrl: this.env.APP_URL,
        }),
    );
  }
}

// The day's dispatch: an instance for each organisation with protection on (each instance checks eligibility again
// when it starts, correction 12). An instance already created today is left alone; one that cannot be created is
// logged and the others go on (correction 11).
export async function scheduledMonitor(
  env: Pick<Env, "DB" | "MONITOR">,
  now = new Date(),
  log: (line: string) => void = console.log,
): Promise<{ started: number; existing: number; failed: number }> {
  const day = sastDay(now);
  const result = { started: 0, existing: 0, failed: 0 };
  for (const orgId of await protectedOrgs(env.DB)) {
    const id = `monitor-${orgId}-${day}`;
    try {
      await env.MONITOR.create({ id, params: { orgId, day } });
      result.started++;
    } catch (error) {
      if (/already exists|instance\.already_exists|duplicate/i.test(String(error))) {
        result.existing++;
        continue;
      }
      result.failed++;
      log(JSON.stringify({ event: "monitor-dispatch", outcome: "failed", error: (error as Error).name || "Error" }));
    }
  }
  return result;
}
