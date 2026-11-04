import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createToolExecutor, ledgerLookup, MAX_TOOL_CALLS, toolDefinitions } from "../../src/agent/tools";
import { type EvidenceDraft, readEvidence } from "../../src/checks/evidence";
import { createCase } from "../../src/db/cases";
import { importSuppliers, siteOf } from "../../src/invoice/ledger";
import { checkImport } from "../../src/invoice/ledger-csv";
import { bankKeys } from "../../src/trust/bank";
import { makeOrg } from "../trust/helpers";

// D04 T01 §3: the agent's read-only tools. Implementations are stubs that count their calls; the ledger's real
// implementation runs against a seeded ledger. No model call is made.
const URLS = ["https://phish.example/signin", "https://collect.example/post"];
const ACCOUNT = "62004417731";

async function newCase() {
  const made = await createCase(env.DB, { orgId: "org-tools", channel: "email", headersAvailable: true });
  if (!made.ok) throw new Error(made.error.message);
  return made.value.id;
}

const draft = (tool: string, summary: string): EvidenceDraft => ({
  check: `agent.${tool}`,
  severity: "info",
  summary,
  detail: {},
  artefacts: [],
});

function stubs() {
  const counts = { expand: 0, screenshot: 0, lookupDomain: 0, ledger: 0, walk: 0 };
  const deps = {
    expand: async () => {
      counts.expand += 1;
      return [draft("expand_link", "The link ends at collect.example.")];
    },
    screenshot: async () => {
      counts.screenshot += 1;
      return [draft("screenshot_url", "A screenshot of the page.")];
    },
    lookupDomain: async () => {
      counts.lookupDomain += 1;
      return [draft("lookup_domain", "The domain was registered recently.")];
    },
    ledger: async () => {
      counts.ledger += 1;
      return [draft("ledger_lookup", "The claimed account matches.")];
    },
    walk: async () => {
      counts.walk += 1;
      return [];
    },
  };
  return { deps, counts };
}

describe("toolDefinitions", () => {
  it("offers the seven tools, each definition from its zod schema", () => {
    const definitions = toolDefinitions();
    expect(definitions.map((d) => d.name)).toEqual([
      "expand_link",
      "screenshot_url",
      "lookup_domain",
      "ledger_lookup",
      "walk_phishing_site",
      "segment_logos",
      "compare_logo",
    ]);
    for (const d of definitions) {
      expect(d.type).toBe("function");
      // Strict only where every property is required (Meta refuses a strict tool with an optional one).
      expect(d.strict).toBe(d.name !== "ledger_lookup");
      expect(d.parameters).toMatchObject({ type: "object", additionalProperties: false });
    }
    expect(definitions[0]?.parameters).toMatchObject({ properties: { url: { type: "string" } }, required: ["url"] });
    expect(definitions[3]?.parameters).toMatchObject({ required: ["supplier"] });
  });
});

describe("createToolExecutor", () => {
  it("saves evidence per call with new IDs, and a walk call between calls moves none", async () => {
    const caseId = await newCase();
    const { deps, counts } = stubs();
    const run = createToolExecutor({ db: env.DB, caseId, urls: URLS }, deps);
    const first = await run.call("expand_link", { url: URLS[0] });
    expect(first.status).toBe("ok");
    const firstId = first.status === "ok" ? first.evidence[0]?.id : undefined;
    expect(firstId).toMatch(/^E\d+$/);
    await run.call("walk_phishing_site", { url: URLS[0] });
    const second = await run.call("screenshot_url", { url: URLS[0] });
    expect(second.status).toBe("ok");
    const stored = (await readEvidence(env.DB, caseId)).filter((e) => e.check.startsWith("agent."));
    expect(stored.map((e) => e.check)).toEqual(["agent.expand_link", "agent.screenshot_url"]);
    expect(stored[0]?.id).toBe(firstId);
    expect(counts).toEqual({ expand: 1, screenshot: 1, lookupDomain: 0, ledger: 0, walk: 1 });
  });

  it("returns stored walkthrough evidence without walking again", async () => {
    const caseId = await newCase();
    const { deps, counts } = stubs();
    const { addEvidence } = await import("../../src/checks/evidence");
    await addEvidence(env.DB, caseId, "walkthrough", [
      {
        check: "walkthrough.chain",
        severity: "info",
        summary: "The walk visited 1 page.",
        detail: { pages: [{ url: URLS[0] as string }] },
        artefacts: [],
      },
    ]);
    const run = createToolExecutor({ db: env.DB, caseId, urls: URLS }, deps);
    const result = await run.call("walk_phishing_site", { url: URLS[0] });
    expect(result.status).toBe("ok");
    expect(result.status === "ok" && result.evidence.map((e) => e.check)).toEqual(["walkthrough.chain"]);
    expect(counts.walk).toBe(0);
  });

  it("refuses malformed arguments, unknown tools and URLs outside the case, running and writing nothing", async () => {
    const caseId = await newCase();
    const { deps, counts } = stubs();
    // A fresh executor per call, so the call cap can never mask the refusal each case means to prove.
    const bad: [string, unknown, string][] = [
      ["expand_link", {}, "invalid_arguments"],
      ["expand_link", { url: 7 }, "invalid_arguments"],
      ["expand_link", { url: URLS[0], extra: 1 }, "invalid_arguments"],
      ["expand_link", { url: "https://elsewhere.example/" }, "url_not_in_case"],
      ["screenshot_url", { url: "https://elsewhere.example/" }, "url_not_in_case"],
      ["lookup_domain", { domain: "elsewhere.example" }, "domain_not_in_case"],
      ["lookup_domain", {}, "invalid_arguments"],
      ["ledger_lookup", {}, "invalid_arguments"],
      ["ledger_lookup", { supplier: "A", org_id: "other-org" }, "invalid_arguments"],
      ["walk_phishing_site", { url: "https://elsewhere.example/" }, "url_not_in_case"],
      ["send_mail", { url: URLS[0] }, "unknown_tool"],
      ["constructor", { url: URLS[0] }, "unknown_tool"],
      ["toString", { url: URLS[0] }, "unknown_tool"],
      ["expand_link", "{not json", "invalid_arguments"],
    ];
    for (const [name, args, reason] of bad) {
      const run = createToolExecutor({ db: env.DB, caseId, urls: URLS }, deps);
      expect(await run.call(name, args), `${name} ${JSON.stringify(args)}`).toEqual({
        status: "refused",
        tool: name,
        reason,
      });
    }
    expect(counts).toEqual({ expand: 0, screenshot: 0, lookupDomain: 0, ledger: 0, walk: 0 });
    expect((await readEvidence(env.DB, caseId)).some((e) => e.check.startsWith("agent."))).toBe(false);
  });

  it("keeps issued IDs when the fallback walk writes its evidence between calls", async () => {
    const caseId = await newCase();
    const { deps } = stubs();
    const { addEvidence } = await import("../../src/checks/evidence");
    const run = createToolExecutor(
      { db: env.DB, caseId, urls: URLS },
      {
        ...deps,
        walk: async () => {
          const written = await addEvidence(env.DB, caseId, "walkthrough", [
            {
              check: "walkthrough.chain",
              severity: "info",
              summary: "The walk visited 1 page.",
              detail: { pages: [{ url: URLS[0] as string }] },
              artefacts: [],
            },
          ]);
          return written;
        },
      },
    );
    const first = await run.call("expand_link", { url: URLS[0] });
    const firstId = first.status === "ok" ? first.evidence[0]?.id : undefined;
    expect(await run.call("walk_phishing_site", { url: URLS[0] })).toMatchObject({ status: "ok" });
    expect((await run.call("expand_link", { url: URLS[0] })).status).toBe("ok");
    const stored = await readEvidence(env.DB, caseId);
    expect(stored.find((e) => e.check === "agent.expand_link")?.id).toBe(firstId);
    expect(stored.map((e) => e.check)).toContain("walkthrough.chain");
    // A walk of the other page is refused: the case already walked, and the stored walk is not its answer.
    expect(await run.call("walk_phishing_site", { url: URLS[1] })).toEqual({
      status: "refused",
      tool: "walk_phishing_site",
      reason: "already_walked",
    });
  });

  it("refuses the ninth call, a call after the deadline, and a result that arrives after it", async () => {
    const caseId = await newCase();
    const { deps } = stubs();
    const run = createToolExecutor({ db: env.DB, caseId, urls: URLS }, deps);
    for (let i = 0; i < MAX_TOOL_CALLS; i++) await run.call("expand_link", { url: URLS[0] });
    expect(await run.call("expand_link", { url: URLS[0] })).toMatchObject({ status: "refused", reason: "call_cap" });
    const slow = createToolExecutor(
      { db: env.DB, caseId, urls: URLS },
      {
        ...deps,
        expand: async () => {
          await new Promise((resolve) => setTimeout(resolve, 40));
          return [draft("expand_link", "Late.")];
        },
      },
      { budgetMs: 10 },
    );
    const before = (await readEvidence(env.DB, caseId)).filter((e) => e.summary === "Late.");
    expect(await slow.call("expand_link", { url: URLS[0] })).toMatchObject({ status: "refused", reason: "time_cap" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await readEvidence(env.DB, caseId)).filter((e) => e.summary === "Late.")).toEqual(before);
    expect(await slow.call("expand_link", { url: URLS[0] })).toMatchObject({ status: "refused", reason: "time_cap" });
  });

  it("starts no write once the deadline passed during the work", async () => {
    const caseId = await newCase();
    const { deps } = stubs();
    let t = 0;
    const run = createToolExecutor(
      { db: env.DB, caseId, urls: URLS },
      {
        ...deps,
        expand: async () => {
          t = 200;
          return [draft("expand_link", "Too late.")];
        },
      },
      { budgetMs: 100, now: () => t },
    );
    expect(await run.call("expand_link", { url: URLS[0] })).toMatchObject({ status: "refused", reason: "time_cap" });
    expect((await readEvidence(env.DB, caseId)).some((e) => e.summary === "Too late.")).toBe(false);
  });

  it("states a failed implementation as unchecked coverage, never as a finding", async () => {
    const caseId = await newCase();
    const { deps } = stubs();
    const run = createToolExecutor(
      { db: env.DB, caseId, urls: URLS },
      {
        ...deps,
        expand: async () => {
          throw new TypeError("network down");
        },
      },
    );
    const result = await run.call("expand_link", { url: URLS[0] });
    expect(result).toMatchObject({ status: "failed", reason: "TypeError" });
    const stored = (await readEvidence(env.DB, caseId)).find((e) => e.check === "agent.expand_link");
    expect(stored).toMatchObject({ severity: "info", detail: { checked: false, error: "TypeError" } });
  });
});

describe("ledgerLookup", () => {
  it("answers match or no match only, an unknown supplier as an answer, and never writes the number", async () => {
    const keys = await bankKeys(env);
    const org = await makeOrg();
    const text = [
      "name,domain,bank,branch_code,account_number,phone",
      `Acme Supplies,acme.example,Kestrel Bank,250655,${ACCOUNT},`,
    ].join("\r\n");
    const checked = checkImport(new TextEncoder().encode(text).length, text, siteOf);
    if (!checked.ok) throw new Error("seed refused");
    await importSuppliers(env.DB, keys, org, "owner", checked.rows);
    const ledger = ledgerLookup(env.DB, org, keys);
    const drafts = [
      ...(await ledger({ supplier: "Acme Supplies", accountNumber: ACCOUNT, branchCode: "250655" })),
      ...(await ledger({ supplier: "Acme Supplies", accountNumber: "62004417732", branchCode: "250655" })),
      ...(await ledger({ supplier: "Nobody" })),
    ];
    expect(drafts.map((d) => d.detail)).toEqual([
      { supplier: "Acme Supplies", known: true, match: true, phone: null },
      { supplier: "Acme Supplies", known: true, match: false, phone: null },
      { supplier: null, known: false },
    ]);
    expect(JSON.stringify(drafts)).not.toContain(ACCOUNT);
    // A name at the argument's own limit still fits the evidence summary contract (round 2).
    const long = await ledger({ supplier: "S".repeat(200) });
    expect(Array.from(long[0]?.summary ?? "").length).toBeLessThanOrEqual(200);
    // Markup in a name is plain words in the summary and the full name only in the detail (round 5).
    const marked = await ledger({ supplier: "Acme <Supplies>" });
    expect(marked[0]?.summary).not.toContain("<");
    const viaTool = createToolExecutor(
      { db: env.DB, caseId: await newCase(), urls: URLS },
      { ...stubs().deps, ledger },
    );
    expect((await viaTool.call("ledger_lookup", { supplier: "Acme <Supplies>" })).status).toBe("ok");
    const caseId = await newCase();
    const { deps } = stubs();
    const run = createToolExecutor({ db: env.DB, caseId, urls: URLS }, { ...deps, ledger });
    const result = await run.call("ledger_lookup", {
      supplier: "Acme Supplies",
      account_number: ACCOUNT,
      branch_code: "250655",
    });
    expect(result.status).toBe("ok");
    expect(JSON.stringify(result)).not.toContain(ACCOUNT);
    expect(JSON.stringify(await readEvidence(env.DB, caseId))).not.toContain(ACCOUNT);
  });
});
