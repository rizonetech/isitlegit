import { env } from "cloudflare:workers";
import puppeteer, { type Browser } from "@cloudflare/puppeteer";
import { afterEach, describe, expect, it } from "vitest";
import { ulid } from "../../src/db/ulid";
import type { Store } from "../../src/intake/store";
import { canaryFor } from "../../src/walkthrough/canary";
import type { Resolve } from "../../src/walkthrough/url-policy";
import { walk } from "../../src/walkthrough/wonder";
import { allowance, RESULT } from "./allowance";
import { site } from "./lure";

// D04 T02 §4, the live run: the real Muse Wonder through AI Gateway `isitlegit`, the real driver on local Browser Run,
// the fictional NimbusMail lure served through the stub `fetch`. Run only by scripts/walkthrough-live.ts, which reserved
// WALK_ALLOWANCE_USD in the shared ledger and passes the key and the gateway's Run token by environment.
const live = env as unknown as Record<string, string | undefined>;
const store: Store = { bucket: env.ARTEFACTS, db: env.DB };
const resolve: Resolve = async (name) => (name.endsWith(".example") ? ["93.184.215.14"] : null);

let browser: Browser | undefined;
afterEach(async () => {
  if (browser?.connected) await browser.close();
});

describe.skipIf(live.WALK_LIVE !== "1")("Muse Wonder, live", () => {
  it("walks the NimbusMail lure to its sign-in page and fills it with the canaries", { timeout: 120_000 }, async ({
    task,
  }) => {
    const budget = allowance(Number(live.WALK_ALLOWANCE_USD));
    const caseId = ulid();
    const now = new Date().toISOString();
    await env.DB.prepare(
      "INSERT INTO cases (id, org_id, channel, created_at, updated_at) VALUES (?, 'org-walk', 'email', ?, ?)",
    )
      .bind(caseId, now, now)
      .run();
    const minted = await canaryFor(env.DB, caseId);
    if (!minted.ok) throw new Error(minted.reason);
    browser = await puppeteer.launch(env.BROWSER);
    let result: Awaited<ReturnType<typeof walk>> | undefined;
    let failure: string | undefined;
    try {
      result = await walk(browser, {
        caseId,
        walkId: "live",
        canary: { username: minted.username, password: minted.password },
        startUrl: "https://lure.example/",
        store,
        fetch: site,
        resolve,
        meta: {
          env: {
            META_API_KEY: live.WALK_META_API_KEY ?? "",
            CF_AIG_TOKEN: live.WALK_CF_AIG_TOKEN ?? "",
            META_GATEWAY_URL: live.WALK_GATEWAY_URL ?? "",
          },
          budget,
        },
      });
    } catch (error) {
      failure = error instanceof Error ? `${error.name}: ${error.message.slice(0, 200)}` : "error";
    } finally {
      // Kept before any assertion and whatever happened, so the script settles what was spent.
      (task.meta as Record<string, unknown>)[RESULT] = {
        ...(result ?? { outcome: "crashed", failure }),
        attempts: budget.attempts(),
      };
    }
    if (!result) throw new Error(failure);
    expect(result.outcome).toBe("finished");
    expect(result.page).toEqual({ url: "https://lure.example/login", filled: ["username", "password"] });
  });
});
