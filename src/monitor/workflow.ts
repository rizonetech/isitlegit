// The impersonation monitor's Workflow and its daily dispatch (D05 T04 §2): one instance per organisation per SAST
// day, its id the organisation and the day, so a repeated tick starts nothing new (correction 3). The instance runs
// `monitorOrg` (./run.ts) with the real network: DNS over HTTPS at cloudflare-dns.com, the homepage captured through
// Browser Run with downloads refused and the session closed in every case, and Glimmer woken and settled through
// src/vision/glimmer-wake.ts. Dispatch goes on past an organisation whose instance cannot be created, and says so.

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import puppeteer from "@cloudflare/puppeteer";
import { d1Exec } from "../vision/glimmer-minutes";
import { settleGlimmer, wakeGlimmer } from "../vision/glimmer-wake";
import { type Capture, type Lookup, type MonitorDeps, monitorOrg, protectedOrgs, sastDay } from "./run";

export type MonitorParams = { orgId: string; day: string };
const DOH = "https://cloudflare-dns.com/dns-query";
const LOOKUP_MS = 5_000;
const CAPTURE_MS = 30_000;
// Seconds Glimmer is reserved for each page the run may screen (§3).
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

// The homepage through Browser Run: a JPEG screenshot and the visible text, downloads refused, the session closed
// whatever happens (correction 8).
export async function browserCapture(browser: Env["BROWSER"], host: string): Promise<Capture> {
  const session = await puppeteer.launch(browser);
  try {
    const page = await session.newPage();
    const cdp = await page.target().createCDPSession();
    await cdp.send("Browser.setDownloadBehavior", { behavior: "deny" });
    await page.goto(`https://${host}/`, { waitUntil: "domcontentloaded", timeout: CAPTURE_MS });
    const screenshot = (await page.screenshot({ type: "jpeg", quality: 70 })) as Uint8Array;
    // Run in the page, where the Worker's types have no DOM: the visible text, as a string expression.
    const text = String(await page.evaluate("document.body ? document.body.innerText : ''")).slice(0, 200_000);
    return { screenshot, text };
  } finally {
    await session.close();
  }
}

export function monitorDeps(env: Env, runId: string, calls = 0): MonitorDeps {
  const ledger = d1Exec(env.DB);
  const wakeCtx = (n: number) => ({ env, ledger, burstId: runId, calls: n, callSeconds: CALL_SECONDS });
  return {
    db: env.DB,
    store: env.ARTEFACTS,
    resolve: (host) => dohLookup(host),
    capture: (host) => browserCapture(env.BROWSER, host),
    wake: (n) => wakeGlimmer(wakeCtx(n || calls)),
    settle: (burst) => settleGlimmer(wakeCtx(calls), burst),
  };
}

export class MonitorWorkflow extends WorkflowEntrypoint<Env, MonitorParams> {
  async run(event: WorkflowEvent<MonitorParams>, step: WorkflowStep) {
    const runId = `monitor-${event.payload.orgId}-${event.payload.day}`;
    // One step: its retries rerun the whole organisation, which is idempotent (the hosts' state and the run row are
    // upserts, a capture already stored is simply stored again under its new moment).
    return step.do(
      "monitor",
      { retries: { limit: 2, delay: "1 minute", backoff: "exponential" }, timeout: "30 minutes" },
      async () => monitorOrg(monitorDeps(this.env, runId), event.payload.orgId, runId),
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
