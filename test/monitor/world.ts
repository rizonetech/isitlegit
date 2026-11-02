// The monitor tests' shared world (D05 T04 §2 and §3): a protected business to run, DNS answers and captures by host, a
// Loupe session that screens pages (benign unless told otherwise), a close that can be refused, and a log of every call.
import { env } from "cloudflare:test";
import { candidatesForBusiness } from "../../src/monitor/candidates";
import type { Signals } from "../../src/monitor/parked";
import type { Capture, Lookup, MonitorDeps } from "../../src/monitor/run";
import { setIdentity } from "../../src/trust/identity";
import type { Burst } from "../../src/vision/glimmer-wake";
import type { GlimmerSession, Screened } from "../../src/vision/screen";
import { fakeJpeg } from "../fixtures/jpeg";
import { protectableOrg } from "../trust/helpers";

export const db = env.DB;
export const DAY_MS = 24 * 60 * 60_000;
export const START = new Date("2026-11-02T04:15:00Z");
let n = 0;

export async function business() {
  const tag = `${++n}${crypto.randomUUID().slice(0, 6)}`;
  const domain = `fynbos${tag}.co.za`;
  const contact = `accounts@${domain}`;
  const orgId = await protectableOrg(domain, contact, `Fynbos ${tag}`);
  await setIdentity(db, orgId, "owner", { displayNames: ["Fynbos"], financeContact: contact, protected: true });
  return { orgId, domain, contact, candidates: candidatesForBusiness([domain]) };
}

// A world the run talks to: DNS answers by host, captures that succeed or fail by host (each taking 30 seconds), a Loupe
// session that screens pages (benign unless told a host is a lure or that screening fails), a close that can be refused,
// and a log of every call.
export const NO_FORM: Signals = { inputs: 0, passwords: 0, forms: 0, iframes: 0, components: 0, hidden: 0 };
export function world(at: Date) {
  const calls: string[] = [];
  const answers = new Map<string, Lookup>();
  const failing = new Map<string, Error>();
  const lures = new Set<string>();
  const failScreen = new Set<string>();
  const signals = new Map<string, Signals>();
  const text = new Map<string, string>();
  const closed: { burst: Burst | null; until: number | null }[] = [];
  // The moment (on this world's clock) each page was handed to the screener.
  const screenedAt: number[] = [];
  let closeAnswer: unknown = { ok: true };
  let now = at;
  const deps: MonitorDeps = {
    db,
    store: env.ARTEFACTS,
    now: () => now,
    resolve: async (host) => {
      calls.push(`dns:${host}`);
      return answers.get(host) ?? { status: "none" };
    },
    capture: async (host): Promise<Capture> => {
      calls.push(`capture:${host}`);
      now = new Date(now.getTime() + 30_000);
      const error = failing.get(host);
      if (error) throw error;
      const words = text.get(host) ?? `Welcome to ${host}. ${"A page of ordinary words about freight. ".repeat(12)}`;
      return {
        // A whole JPEG of a modest size, so the page is neither empty nor image-led.
        screenshot: fakeJpeg(1280, 800, 30_000),
        text: words,
        // The tree's own text is the page's words here: a page that spoofs its innerText is the browser test's.
        parkText: words,
        url: `https://${host}/`,
        signals: signals.get(host) ?? NO_FORM,
      };
    },
    open: async (count): Promise<GlimmerSession> => {
      calls.push(`open:${count}`);
      const wakeAt = now.getTime();
      return {
        ctx: {} as GlimmerSession["ctx"],
        burst: { id: "burst-1", wakeAt, deadline: wakeAt + 60_000 },
        state: "ready",
        reservedUntil: wakeAt + 20 * 60_000,
        lastRequestEnd: null,
      };
    },
    screen: async (page, session): Promise<Screened> => {
      calls.push(`screen:${page.host}`);
      screenedAt.push(now.getTime());
      now = new Date(now.getTime() + 2_000);
      if (failScreen.has(page.host ?? ""))
        return { ok: false, glimmer_reason: "error", spark_reason: "budget", spark_calls: [] };
      session.lastRequestEnd = now.getTime();
      const lure = lures.has(page.host ?? "");
      return {
        ok: true,
        screen: {
          brand: lure ? "Kestrel Freight" : null,
          has_login_form: lure,
          has_payment_form: false,
          lure,
          lure_type: lure ? "credential" : "none",
          confidence: lure ? 0.94 : 0.05,
          screener: "glimmer",
        },
        glimmer_reason: null,
        spark_call: null,
        tier: "glimmer",
        escalation: null,
        spark_calls: [],
      };
    },
    close: async (session) => {
      calls.push("settle");
      closed.push({ burst: session.burst, until: session.lastRequestEnd ?? null });
      return closeAnswer;
    },
    settle: async () => closeAnswer,
  };
  return {
    deps,
    calls,
    answers,
    failing,
    lures,
    failScreen,
    signals,
    text,
    closed,
    screenedAt,
    refuseSettlement: (answer: unknown) => {
      closeAnswer = answer;
    },
    later: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
    captures: () => calls.filter((c) => c.startsWith("capture:")).map((c) => c.slice(8)),
    screens: () => calls.filter((c) => c.startsWith("screen:")).map((c) => c.slice(7)),
  };
}

export const host = async (orgId: string, domain: string) =>
  db
    .prepare("SELECT * FROM monitor_hosts WHERE org_id = ? AND domain = ?")
    .bind(orgId, domain)
    .first<Record<string, unknown>>();
export const runRow = async (orgId: string) =>
  db
    .prepare("SELECT * FROM monitor_runs WHERE org_id = ? ORDER BY day DESC LIMIT 1")
    .bind(orgId)
    .first<Record<string, unknown>>();
export const live = (ip: string): Lookup => ({ status: "resolves", answers: [ip] });

// A database that commits the run's DNS batch and then stops answering, as a Worker stopped right after it would.
export function stopsAfterBatch(target: D1Database): D1Database {
  let committed = false;
  return new Proxy(target, {
    get(t, key) {
      if (key === "batch")
        return async (statements: D1PreparedStatement[]) => {
          const result = await t.batch(statements);
          committed = true;
          return result;
        };
      if (key === "prepare")
        return (sql: string) => {
          if (committed) throw new Error("worker stopped");
          return t.prepare(sql);
        };
      const value = Reflect.get(t, key);
      return typeof value === "function" ? value.bind(t) : value;
    },
  });
}
