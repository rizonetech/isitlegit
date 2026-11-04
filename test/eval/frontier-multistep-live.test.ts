// Opt-in experiment transport. Ordinary suites skip it and never spend model credit.
import { env } from "cloudflare:workers";
import puppeteer, { type Browser } from "@cloudflare/puppeteer";
import { describe, it } from "vitest";
import { arrivalEvidence, observedTransport, type Report, ReportSchema } from "../../eval/frontier/multistep-core";
import { captureExecution, exceptionDiagnostic } from "../../eval/frontier/multistep-observation";
import { ulid } from "../../src/db/ulid";
import { canaryFor } from "../../src/walkthrough/canary";
import { dohResolve } from "../../src/walkthrough/url-policy";
import { walk } from "../../src/walkthrough/wonder";
import { allowance } from "../walkthrough/allowance";

const input = env as unknown as Record<string, string | undefined>;
describe.skipIf(input.MULTISTEP_LIVE !== "1")("bounded multi-step experiment", () => {
  it("records the real contained walk and every charged attempt", async ({ task }) => {
    const ordinal = Number(input.MULTISTEP_ORDINAL),
      reservationId = input.MULTISTEP_RESERVATION ?? "";
    const start = new URL(input.MULTISTEP_URL ?? "");
    const budget = allowance(Number(input.WALK_ALLOWANCE_USD));
    const capacity: Report["capacity"] = [];
    let browser: Browser | undefined, result: Awaited<ReturnType<typeof walk>> | undefined;
    const began = Date.now();
    let walkBegan = began,
      caseId = "";
    const captured = await captureExecution(async (at) => {
      caseId = ulid();
      const createdAt = new Date().toISOString();
      await at("case-creation", () =>
        env.DB.prepare(
          "INSERT INTO cases(id,org_id,channel,created_at,updated_at) VALUES(?,'org-frontier','email',?,?)",
        )
          .bind(caseId, createdAt, createdAt)
          .run(),
      );
      const canary = await at("canary", async () => {
        const value = await canaryFor(env.DB, caseId);
        if (!value.ok) throw new Error("canary unavailable");
        return value;
      });
      const activeBrowser = await at("browser-launch", () => puppeteer.launch(env.BROWSER));
      browser = activeBrowser;
      walkBegan = Date.now();
      return at("walk", () =>
        walk(activeBrowser, {
          caseId,
          walkId: reservationId,
          canary,
          startUrl: start.href,
          store: { db: env.DB, bucket: env.ARTEFACTS },
          resolve: dohResolve(),
          meta: {
            env: {
              META_API_KEY: input.WALK_META_API_KEY ?? "",
              CF_AIG_TOKEN: input.WALK_CF_AIG_TOKEN ?? "",
              META_GATEWAY_URL: input.WALK_GATEWAY_URL ?? "",
            },
            budget,
            transportAttempts: 1,
            fetch: observedTransport(fetch, capacity),
          },
        }),
      );
    });
    result = captured.result;
    const diagnostic = captured.diagnostic;
    const followupDiagnostics: NonNullable<Report["diagnostic"]>[] = [];
    {
      const stage = (raw: string): Report["pages"][number]["stage"] => {
        try {
          const url = new URL(raw);
          if (url.origin !== start.origin || url.search || url.hash) return "other";
          if (url.pathname === start.pathname) return "start";
          const suffix = url.pathname.startsWith(start.pathname) ? url.pathname.slice(start.pathname.length) : "";
          return suffix === "lure" || suffix === "login" || suffix === "submitted" ? suffix : "other";
        } catch {
          return "other";
        }
      };
      let rows: { seq: number; at: string; screenshot_key: string | null }[] = [];
      let arrivals: ReturnType<typeof arrivalEvidence> = new Map();
      try {
        rows = caseId
          ? ((
              await env.DB.prepare(
                "SELECT seq,at,screenshot_key FROM walkthrough_actions WHERE case_id=? AND walk_id=? AND kind='action' ORDER BY seq",
              )
                .bind(caseId, reservationId)
                .all()
            ).results as typeof rows)
          : [];
        arrivals = arrivalEvidence(rows, walkBegan);
      } catch (error) {
        followupDiagnostics.push(exceptionDiagnostic("evidence-read", error));
      }
      if (browser?.connected) {
        try {
          await browser.close();
        } catch (error) {
          followupDiagnostics.push(exceptionDiagnostic("browser-close", error));
        }
      }
      const report = ReportSchema.parse({
        diagnostic,
        followupDiagnostics,
        ordinal,
        reservationId,
        outcome: result?.outcome ?? "crashed",
        steps: result?.steps ?? 0,
        ms: result?.ms ?? Math.min(Date.now() - began, 180000),
        pages: (result?.record.pages ?? []).map((page) => ({
          stage: stage(page.url),
          seq: page.seq,
          asksPassword: page.asksPassword,
          ...((page.screenshotKey ? arrivals.get(page.screenshotKey) : undefined) ?? {
            arrivedStep: null,
            arrivedMs: null,
          }),
        })),
        attempts: budget.attempts(),
        capacity,
      });
      (task.meta as Record<string, unknown>).multistep = report;
    }
  });
});
