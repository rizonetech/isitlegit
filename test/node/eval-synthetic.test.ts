// The synthetic South African mail set (D08 T01 §3): the scenario specs, the realism rules, the assembled messages,
// and the runner with a fake model behind the real structured client and the real shared ledger.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { sharedLedger } from "../../eval/frontier/digits.ts";
import { ALL_PARTIES } from "../../eval/generate/parties.ts";
import { DECEPTION_MARKERS, realismProblems } from "../../eval/generate/realism.ts";
import {
  annotationOf,
  countProblems,
  dryRun,
  type GenerateOptions,
  generate,
  otherSets,
  parseRunArgs,
  RUN_CAP_USD,
  scenarioText,
} from "../../eval/generate/run.ts";
import { EXPECTABLE, MIX, registrableOf, Spec, scenario, scenarios } from "../../eval/generate/scenarios.ts";
import { loadSet } from "../../eval/load.ts";
import { Annotation } from "../../eval/schema.ts";
import type { Budget } from "../../src/meta/guard.ts";

const ROOT = join(import.meta.dirname, "../..");
const dirs: string[] = [];
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "eval-synthetic-"));
  dirs.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const specs = scenarios();
const byId = new Map(specs.map((s) => [s.id, s]));
const one = (id: string) => byId.get(id) as Spec;

// A body that passes the rules for its spec: the claimed party, every detail verbatim, neutral words between.
const FILLER =
  "Please keep this note with the rest of the paperwork for the month, and let the team know when it has been read.";
function goodBody(spec: Spec) {
  const details = Object.values(spec.details).join(" and ");
  return {
    subject: `A note from ${spec.claimed}`,
    body: `Good day ${spec.to.name},\n\nThis note comes from ${spec.claimed}. It concerns ${details}. ${FILLER} ${FILLER} ${FILLER}\n\nRegards,\n${spec.from.name}`,
  };
}

describe("scenario specs", () => {
  it("are 160 valid specs with unique ids in the stated mix", () => {
    expect(specs).toHaveLength(160);
    expect(new Set(specs.map((s) => s.id)).size).toBe(160);
    for (const s of specs) expect(() => Spec.parse(s)).not.toThrow();
    for (const [category, count] of Object.entries(MIX))
      expect(specs.filter((s) => s.category === category)).toHaveLength(count);
    expect(specs.filter((s) => s.label === "genuine")).toHaveLength(70);
  });

  it("put every address under .example and every party domain too", () => {
    for (const party of ALL_PARTIES) expect(party.domain).toMatch(/\.example$/);
    for (const s of specs)
      for (const address of [s.from.address, s.to.address, s.returnPath, s.replyTo?.address].filter(Boolean))
        expect(address).toMatch(/@[a-z0-9.-]+\.example$/);
  });

  it("expect only the eight names, each consistent with its spec", () => {
    for (const s of specs) {
      for (const name of s.expected) expect(EXPECTABLE).toContain(name);
      const own = registrableOf(s.from.address);
      expect(s.expected.includes("auth.spf")).toBe(s.label === "attack" && s.auth.spf === "fail");
      expect(s.expected.includes("auth.dkim")).toBe(s.label === "attack" && s.auth.dkim === "fail");
      expect(s.expected.includes("auth.dmarc")).toBe(s.label === "attack" && s.auth.dmarc === "fail");
      expect(s.expected.includes("sender.reply_to")).toBe(
        s.label === "attack" && !!s.replyTo && registrableOf(s.replyTo.address) !== own,
      );
      expect(s.expected.includes("sender.return_path")).toBe(
        s.label === "attack" && registrableOf(s.returnPath) !== own,
      );
      expect(s.expected.includes("attachment.executable")).toBe(s.attachment?.kind === "executable");
      expect(s.expected.includes("attachment.html")).toBe(s.attachment?.kind === "html");
      if (s.label === "attack") expect(s.basis).toBe(s.expected.length ? "checks" : "model");
      else expect(s.expected).toEqual([]);
    }
    // Attacks only a model can see are in the set too (D08 T01 §4).
    expect(specs.filter((s) => s.basis === "model").length).toBeGreaterThan(0);
  });

  it("give a variant the same category and parties with fresh details", () => {
    for (const s of specs.filter((_, i) => i % 7 === 0)) {
      const n = Number(s.id.slice(-3));
      const v = scenario(s.category, n, 1);
      expect(v.id).toBe(`${s.id}-v1`);
      expect([v.category, v.label, v.claimed, v.recipient, v.to]).toEqual([
        s.category,
        s.label,
        s.claimed,
        s.recipient,
        s.to,
      ]);
    }
    const attack = one("invoice-bank-change-001");
    expect(scenario("invoice-bank-change", 1, 1).details).not.toEqual(attack.details);
  });
});

describe("realism rules", () => {
  const attack = one("invoice-bank-change-001");
  const genuine = one("genuine-business-004");

  it("pass a body that meets every rule", () => {
    for (const s of specs) expect(realismProblems(s, goodBody(s)), s.id).toEqual([]);
  });

  it("refuse a planted real bank name", () => {
    const g = goodBody(attack);
    expect(realismProblems(attack, { ...g, body: `${g.body}\nPayments also go through Capitec.` }).join()).toMatch(
      /real organisation: .*Capitec/,
    );
  });

  it("refuse a body too short, too long, without its parties, with a placeholder or model talk", () => {
    const g = goodBody(genuine);
    expect(
      realismProblems(genuine, { ...g, body: `${genuine.claimed} ${Object.values(genuine.details).join(" ")}` }).join(),
    ).toMatch(/words/);
    expect(realismProblems(genuine, { ...g, body: `${g.body} ${"word ".repeat(400)}` }).join()).toMatch(/words/);
    expect(
      realismProblems(genuine, { ...g, subject: "Hello", body: g.body.replaceAll(genuine.claimed, "us") }).join(),
    ).toMatch(/does not name/);
    expect(realismProblems(genuine, { ...g, body: `${g.body} [Your name]` }).join()).toMatch(/placeholder/);
    expect(realismProblems(genuine, { ...g, body: `${g.body} {{amount}}` }).join()).toMatch(/placeholder/);
    expect(realismProblems(genuine, { ...g, body: `Here is the email you asked for.\n${g.body}` }).join()).toMatch(
      /model/,
    );
    expect(realismProblems(genuine, { ...g, body: `${g.body} I cannot help with writing that.` }).join()).toMatch(
      /model/,
    );
    // A writer in character is not a model talking (bec-payment-007's first body).
    const bec = goodBody(one("bec-payment-007"));
    expect(
      realismProblems(one("bec-payment-007"), {
        ...bec,
        body: `${bec.body} I am tied up in meetings so I cannot process it myself.`,
      }),
    ).toEqual([]);
  });

  it("refuse a fluent attack body without its deception", () => {
    const g = goodBody(attack);
    const account = attack.details.account as string;
    expect(account).toBeTruthy();
    expect(realismProblems(attack, { ...g, body: g.body.replace(account, "the usual account") }).join()).toMatch(
      /lacks its account/,
    );
  });

  it("refuse genuine mail carrying a deception marker or a link off its parties' domains", () => {
    const g = goodBody(genuine);
    expect(realismProblems(genuine, { ...g, body: `${g.body} Please pay urgently.` }).join()).toMatch(
      /deception marker/,
    );
    expect(realismProblems(genuine, { ...g, body: `${g.body} See https://elsewhere.example/x` }).join()).toMatch(
      /links off/,
    );
    expect(DECEPTION_MARKERS.length).toBeGreaterThan(5);
  });
});

// The fake model: the structured client's fetch, answering from the scenario text it was sent.
const env = {
  META_API_KEY: "LLM_test_key_0123456789",
  CF_AIG_TOKEN: "aig-token-0123456789",
  META_GATEWAY_URL: "https://gateway.test/v1/",
};
const textOf = (body: Record<string, unknown>) =>
  ((body.input as { content: { text: string }[] }[])[0]?.content[0]?.text ?? "") as string;
const specFor = (text: string) => {
  const from = text.match(/^From: (.+), writing as (.+)\.$/m);
  const details = Object.fromEntries(
    [...(text.match(/^Required details, each verbatim: (.+)\.$/m)?.[1] ?? "").matchAll(/(\w+) "([^"]*)"/g)].map((m) => [
      m[1],
      m[2],
    ]),
  );
  return specs
    .concat(specs.map((s) => scenario(s.category, Number(s.id.slice(-3)), 1)))
    .find(
      (s) =>
        s.from.name === from?.[1] && s.claimed === from?.[2] && JSON.stringify(s.details) === JSON.stringify(details),
    );
};
const answer = (value: unknown) =>
  new Response(
    JSON.stringify({
      id: "resp_1",
      object: "response",
      status: "completed",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify(value) }] }],
      output_text: JSON.stringify(value),
      usage: { input_tokens: 2000, output_tokens: 1000 },
    }),
    { status: 200, headers: { "content-type": "application/json", "cf-aig-log-id": "log-1" } },
  );
function fakeModel(write: (spec: Spec, call: number, text: string) => unknown = (spec) => goodBody(spec)) {
  const sent: string[] = [];
  const fetch = (async (_url: unknown, init?: RequestInit) => {
    const text = textOf(JSON.parse(String(init?.body)));
    sent.push(text);
    const spec = specFor(text);
    if (!spec) throw new Error(`the fake model does not know this scenario:\n${text}`);
    return answer(write(spec, sent.length, text));
  }) as typeof globalThis.fetch;
  return { sent, context: { env, sleep: async () => {}, random: () => 0.5, fetch } };
}
function guardStub() {
  const rows: { id: string; state: string }[] = [];
  const guard: Budget = {
    async reserve(_model, _estimate, _attempt, id) {
      rows.push({ id: id as string, state: "reserved" });
      return id as string;
    },
    async settle(id) {
      const row = rows.find((r) => r.id === id);
      if (row) row.state = "settled";
    },
    async uncertain(id) {
      const row = rows.find((r) => r.id === id);
      if (row) row.state = "uncertain";
    },
    async refused() {},
    async cached() {},
    async outputFailed() {},
  };
  return { guard, rows };
}
const instant = () => new Date("2026-10-31T10:00:00Z");
function setup(capUsd = RUN_CAP_USD) {
  const dir = temp();
  const ledgerFile = join(dir, "meta-spend.json");
  return {
    dir,
    ledgerFile,
    resultsFile: join(dir, "results.json"),
    setDir: join(dir, "sets", "synthetic-sa"),
    ledger: sharedLedger(ledgerFile, "eval-synthetic-test", { now: instant, capUsd, waitMs: 0, sleep: async () => {} }),
  };
}
const options = (
  s: ReturnType<typeof setup>,
  model: ReturnType<typeof fakeModel>,
  extra: Partial<GenerateOptions> = {},
) => {
  const { guard, rows } = guardStub();
  return {
    rows,
    opts: {
      context: model.context,
      guard,
      ledger: s.ledger,
      resultsFile: s.resultsFile,
      setDir: s.setDir,
      others: { total: 55, genuine: 0 },
      now: instant,
      ...extra,
    } satisfies GenerateOptions,
  };
};
const results = (file: string) =>
  JSON.parse(readFileSync(file, "utf-8")) as { results: { id: string; status: string; tries: number }[] };

describe("the runner", () => {
  it("dry run lists every scenario with its label and spends nothing, from the command line too", () => {
    const lines = dryRun();
    expect(lines).toHaveLength(161);
    expect(lines.at(-1)).toBe("160 scenarios: 70 genuine, 90 attacks; nothing sent");
    expect(lines.find((l) => l.startsWith("impersonation-001\t"))).toMatch(/attack\timpersonation\t/);
    const out = execFileSync(process.execPath, [join(ROOT, "eval/generate/run.ts"), "dry"], {
      encoding: "utf-8",
      env: { ...process.env, OP_SERVICE_ACCOUNT_TOKEN: "" },
      timeout: 60_000,
    });
    expect(out.trim().split("\n")).toEqual(lines);
  });

  it("refuses unknown commands and options before anything is read", () => {
    expect(parseRunArgs(["dry"])).toEqual({ command: "dry" });
    expect(parseRunArgs(["generate", "--retry-pending"])).toEqual({ command: "generate", retryPending: true });
    expect(parseRunArgs(["dry", "--retry-pending"])).toHaveProperty("error");
    expect(parseRunArgs(["spend"])).toHaveProperty("error");
  });

  it("writes the whole set when every scenario is accepted, and the loader reads it", async () => {
    const s = setup();
    const model = fakeModel();
    const { opts, rows } = options(s, model);
    const report = await generate(opts);
    expect(report.stopped).toBeNull();
    expect(report.written).toBe(true);
    expect(report.accepted).toBe(160);
    expect(model.sent).toHaveLength(160);
    expect(rows.every((r) => r.state === "settled")).toBe(true);
    const set = loadSet(s.setDir, "synthetic-sa");
    expect(set.samples).toHaveLength(160);
    const annotations = JSON.parse(readFileSync(join(s.setDir, "annotations.json"), "utf-8")) as unknown[];
    expect(annotations).toHaveLength(160);
    for (const a of annotations) expect(() => Annotation.parse(a)).not.toThrow();
    expect(readdirSync(s.setDir).filter((f) => f.endsWith(".eml"))).toHaveLength(160);
    // Spend stays under the cap in the shared ledger.
    const ledger = JSON.parse(readFileSync(s.ledgerFile, "utf-8")) as { cost: number; state: string }[];
    expect(ledger.every((e) => e.state === "settled")).toBe(true);
    expect(ledger.reduce((sum, e) => sum + e.cost, 0)).toBeLessThanOrEqual(RUN_CAP_USD);
  });

  it("refuses the call that would pass the cap, sending nothing more and leaving that scenario unanswered", async () => {
    const s = setup(0.012);
    const model = fakeModel();
    const { opts } = options(s, model, { specs: specs.slice(0, 3) });
    const report = await generate(opts);
    expect(report.stopped).toMatch(/cap/);
    expect(report.accepted).toBe(1);
    expect(report.written).toBe(false);
    expect(model.sent).toHaveLength(1);
    const stored = results(s.resultsFile).results;
    expect(stored.map((r) => [r.id, r.status])).toEqual([[specs[0]?.id, "accepted"]]);
    expect(existsSync(s.setDir)).toBe(false);
  });

  it("pays nothing on a resumed run for scenarios already answered", async () => {
    const s = setup();
    const first = fakeModel();
    await generate(options(s, first, { specs: specs.slice(0, 4) }).opts);
    expect(first.sent).toHaveLength(4);
    const again = fakeModel();
    const report = await generate(options(s, again, { specs: specs.slice(0, 4) }).opts);
    expect(report.stopped).toMatch(/^incomplete/);
    expect(again.sent).toHaveLength(0);
    expect(report.accepted).toBe(4);
  });

  it("asks once more with the problems named, then replaces a scenario failing twice by a variant", async () => {
    const s = setup();
    const target = one("invoice-bank-change-002");
    const model = fakeModel((spec, call) =>
      call <= 2
        ? { ...goodBody(spec), body: goodBody(spec).body.replace(spec.details.account as string, "the usual") }
        : goodBody(spec),
    );
    const report = await generate(options(s, model, { specs: [target] }).opts);
    expect(model.sent).toHaveLength(3);
    expect(model.sent[0]).not.toContain("A previous draft was refused");
    expect(model.sent[1]).toContain("A previous draft was refused for: the body lacks its account");
    expect(report.rejected).toEqual([target.id]);
    expect(report.accepted).toBe(1);
    expect(results(s.resultsFile).results.map((r) => [r.id, r.status, r.tries])).toEqual([
      [target.id, "rejected", 2],
      [`${target.id}-v1`, "accepted", 1],
    ]);
  });

  it("stops incomplete with nothing written to the set when the counts cannot be reached", async () => {
    const s = setup();
    const report = await generate(options(s, fakeModel(), { specs: specs.slice(0, 5) }).opts);
    expect(report.written).toBe(false);
    expect(report.stopped).toMatch(/^incomplete: .*genuine accepted, fewer than 60/);
    expect(existsSync(s.setDir)).toBe(false);
  });

  it("leaves a scenario an interrupted run left pending, unless asked to resend it", async () => {
    const s = setup();
    await generate(options(s, fakeModel(), { specs: specs.slice(0, 1) }).opts);
    const stored = JSON.parse(readFileSync(s.resultsFile, "utf-8"));
    stored.results[0].status = "pending";
    const { writeFileSync } = await import("node:fs");
    writeFileSync(s.resultsFile, JSON.stringify(stored));
    const held = fakeModel();
    const report = await generate(options(s, held, { specs: specs.slice(0, 1) }).opts);
    expect(held.sent).toHaveLength(0);
    expect(report.ambiguous).toEqual([specs[0]?.id]);
    const resent = fakeModel();
    await generate(options(s, resent, { specs: specs.slice(0, 1), retryPending: true }).opts);
    expect(resent.sent).toHaveLength(1);
  });
});

describe("counts", () => {
  it("hold the set to its mix and the totals with every other set", () => {
    expect(countProblems(specs, { total: 55, genuine: 0 })).toEqual([]);
    const fewAttacks = specs.filter((s) => s.category !== "voice-lure" || Number(s.id.slice(-3)) <= 7);
    expect(countProblems(fewAttacks, { total: 55, genuine: 0 })).toEqual(["7 voice-lure accepted, fewer than 8"]);
    expect(countProblems(specs.slice(0, 100), { total: 0, genuine: 0 }).join()).toMatch(/fewer than 150/);
    expect(otherSets().total).toBeGreaterThan(0);
  });

  it("annotate a label from its scenario and the details its body carries", () => {
    const s = one("bec-payment-001");
    const a = annotationOf(s, `${s.id}.eml`, "2026-10-31");
    expect(() => Annotation.parse(a)).not.toThrow();
    expect(a.rationale).toContain(s.trick);
    expect(scenarioText(s, null)).toContain(Object.values(s.details)[0]);
  });
});
