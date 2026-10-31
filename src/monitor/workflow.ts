// The impersonation monitor's Workflow and its daily dispatch (D05 T04 §2): one instance per organisation per SAST
// day, its id the organisation and the day, so a repeated tick starts nothing new (correction 3). The instance runs
// `monitorOrg` (./run.ts) with the real network: DNS over HTTPS at cloudflare-dns.com, the homepage captured through
// Browser Run with downloads refused and the session closed in every case, and Glimmer woken and settled through
// src/vision/glimmer-wake.ts. Dispatch goes on past an organisation whose instance cannot be created, and says so.

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import puppeteer from "@cloudflare/puppeteer";
import { d1Exec, findBurst } from "../vision/glimmer-minutes";
import { type Burst, REQUEST_MS, settleGlimmer, WARMUP_LIMIT_MS, wakeGlimmer } from "../vision/glimmer-wake";
import { type Capture, CaptureFailed, type Lookup, type MonitorDeps, monitorOrg, protectedOrgs, sastDay } from "./run";

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
): Promise<Capture> {
  const session = await launch(browser);
  try {
    const page = await session.newPage();
    const cdp = await page.target().createCDPSession();
    await cdp.send("Browser.setDownloadBehavior", { behavior: "deny" });
    let response: Awaited<ReturnType<typeof page.goto>> = null;
    for (const scheme of ["https", "http"] as const) {
      try {
        response = await page.goto(`${scheme}://${host}/`, { waitUntil: "domcontentloaded", timeout: CAPTURE_MS });
        break;
      } catch (error) {
        if (scheme === "http" || !NO_HTTPS.test(String((error as Error)?.message ?? error))) throw error;
      }
    }
    if (!response) throw new CaptureFailed("no-response");
    if (response.status() >= 400) throw new CaptureFailed(`http-${response.status()}`);
    const screenshot = (await page.screenshot({ type: "jpeg", quality: 70 })) as Uint8Array;
    // Run in the page, where the Worker's types have no DOM: the visible text, as a string expression.
    const text = String(await page.evaluate("document.body ? document.body.innerText : ''")).slice(0, 200_000);
    return { screenshot, text, url: page.url() };
  } finally {
    await session.close();
  }
}

export function monitorDeps(
  env: Env,
  runId: string,
  opts: { fetcher?: typeof fetch; now?: () => number } = {},
): MonitorDeps {
  const ledger = d1Exec(env.DB);
  const wakeCtx = (calls: number) => ({ env, ledger, burstId: runId, calls, callSeconds: CALL_SECONDS, ...opts });
  return {
    db: env.DB,
    store: env.ARTEFACTS,
    resolve: (host) => dohLookup(host),
    capture: (host) => browserCapture(env.BROWSER, host),
    // A final answer whose own settlement failed names no reservation (glimmer-wake.ts is D03's); it is this run's,
    // found by its id, so the Workflow can settle it again.
    wake: async (calls) => {
      const woken = await wakeGlimmer(wakeCtx(calls));
      if (woken.outcome === "woken" || !("settled" in woken) || woken.settled !== false) return woken;
      const held = await findBurst(ledger, runId).catch(() => null);
      if (!held || held.settled) return woken;
      const wakeAt = Date.parse(held.wakeAt);
      return { ...woken, burst: { id: runId, wakeAt, deadline: wakeAt + WARMUP_LIMIT_MS } };
    },
    settle: (burst, until) => settleGlimmer(wakeCtx(0), burst, until),
  };
}

// The settlement a run could not make, made again on its own: it throws while the ledger refuses, so the step retries
// it without capturing anything again (completion review gap 10).
export async function settleAgain(deps: Pick<MonitorDeps, "settle">, burst: Burst): Promise<true> {
  const result = (await deps.settle(burst, burst.wakeAt + REQUEST_MS)) as { ok?: boolean; detail?: string };
  if (result?.ok === false) throw new Error(`settlement refused: ${result.detail ?? "refused"}`);
  return true;
}

export class MonitorWorkflow extends WorkflowEntrypoint<Env, MonitorParams> {
  async run(event: WorkflowEvent<MonitorParams>, step: WorkflowStep) {
    const runId = `monitor-${event.payload.orgId}-${event.payload.day}`;
    const deps = monitorDeps(this.env, runId);
    // A failed run throws, so the step retries it; a retry is idempotent (the hosts' state and the run row are
    // upserts, and owed captures are read back from the hosts' state).
    const summary = await step.do(
      "monitor",
      { retries: { limit: 2, delay: "1 minute", backoff: "exponential" }, timeout: "30 minutes" },
      async () => monitorOrg(deps, event.payload.orgId, runId),
    );
    const unsettled = summary.unsettled;
    if (unsettled)
      await step.do(
        "settle",
        { retries: { limit: 5, delay: "1 minute", backoff: "exponential" }, timeout: "1 minute" },
        () => settleAgain(deps, unsettled),
      );
    return summary;
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
