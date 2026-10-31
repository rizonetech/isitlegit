// The synthetic South African mail set (D08 T01 §3): the scenario specs, the realism rules, the assembled messages,
// and the runner with a fake model behind the real structured client and the real shared ledger.
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { sharedLedger } from "../../eval/frontier/digits.ts";
import { assemble, attachmentBytes, invoicePdf } from "../../eval/generate/assemble.ts";
import { ALL_PARTIES, REVENUE } from "../../eval/generate/parties.ts";
import { DECEPTION_MARKERS, realismProblems } from "../../eval/generate/realism.ts";
import {
  annotationOf,
  countProblems,
  dryRun,
  type GenerateOptions,
  generate,
  otherSets,
  parseRunArgs,
  promptHash,
  RESULTS_FILE,
  RUN_CAP_USD,
  recoverSet,
  SET_DIR,
  scenarioText,
  stagingOf,
  writeSet,
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
// What each attack asks, so the body makes its category's request (ATTACK_CUES).
const ASK: Record<string, string> = {
  "credential-phishing": "Sign in there to keep access.",
  "bec-payment": "Please make the payment today.",
  "invoice-bank-change": "Our new bank account is the one above.",
  impersonation: "The fee must be settled first.",
  "voice-lure": "Call the number above to stop it.",
  "malware-attachment": "Open the attached file.",
};
function goodBody(spec: Spec) {
  const details = Object.values(spec.details).join(" and ");
  const ask = spec.label === "attack" ? ` ${ASK[spec.category]}` : "";
  return {
    subject: `A note from ${spec.claimed}`,
    body: `Good day ${spec.to.name},\n\nThis note comes from ${spec.claimed}. It concerns ${details}.${ask} ${FILLER} ${FILLER} ${FILLER}\n\nRegards,\n${spec.from.name}`,
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
      expect(s.expected.includes("attachment.macro")).toBe(s.attachment?.kind === "macro");
      expect(s.expected.includes("attachment.html")).toBe(s.attachment?.kind === "html");
      if (s.label === "attack") expect(s.basis).toBe(s.expected.length ? "checks" : "model");
      else expect(s.expected).toEqual([]);
    }
    // Attacks only a model can see are in the set too (D08 T01 §4).
    expect(specs.filter((s) => s.basis === "model").length).toBeGreaterThan(0);
  });

  it("carry authentication results that can occur together", () => {
    // RFC 7489 6.6.2: an SPF pass for the From's own domain is aligned and passes DMARC on its own.
    for (const s of specs)
      if (s.auth.spf === "pass" && registrableOf(s.returnPath) === registrableOf(s.from.address))
        expect(s.auth.dmarc, s.id).toBe("pass");
  });

  it("give malware a program and genuine invoices their PDF, and keep courier fees small", () => {
    for (const s of specs.filter((s) => s.category === "malware-attachment"))
      expect(["executable", "macro"], s.id).toContain(s.attachment?.kind);
    expect(specs.filter((s) => s.attachment?.kind === "macro")).toHaveLength(5);
    for (const s of specs.filter((s) => s.details.invoice && s.label === "genuine"))
      expect(s.attachment, s.id).toEqual({
        filename: `${s.details.invoice}.pdf`,
        mediaType: "application/pdf",
        kind: "pdf",
      });
    const rands = (v: string) => Number(v.replace(/[R\s]/g, ""));
    for (const s of specs.filter((s) => s.category === "impersonation"))
      expect(rands(s.details.amount as string), s.id).toBeLessThanOrEqual(s.claimed === REVENUE.name ? 2500 : 150);
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

  it("refuse an attack body that never makes its request, and any address or link outside .example", () => {
    for (const s of specs.filter((s) => s.label === "attack")) {
      const g = goodBody(s);
      expect(realismProblems(s, { ...g, body: g.body.replace(ASK[s.category] as string, "") }).join(), s.id).toMatch(
        /does not make its/,
      );
    }
    const g = goodBody(attack);
    expect(realismProblems(attack, { ...g, body: `${g.body} Write to priya@sunmail.co.za.` }).join()).toMatch(
      /address outside \.example \(priya@sunmail\.co\.za\)/,
    );
    expect(realismProblems(attack, { ...g, body: `${g.body} See www.realbank.co.za today.` }).join()).toMatch(
      /links outside \.example/,
    );
  });

  it("refuse an attack body that warns against itself, and keep a fraudster's own 'do not' lines", () => {
    const s = one("credential-phishing-001");
    const g = goodBody(s);
    const warning = `${g.body} Do not visit that address, sign in there, or enter your password. Your account remains active.`;
    expect(realismProblems(s, { ...g, body: warning }).join()).toMatch(/warns against itself/);
    const inCharacter = `${g.body} Do not visit a branch, as this can only be resolved online. Do not share your one-time code.`;
    expect(realismProblems(s, { ...g, body: inCharacter })).toEqual([]);
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

describe("the runner's resume and publication", () => {
  it("asks again a scenario whose prompt changed, and an old body the rules now refuse, paying for nothing else", async () => {
    const s = setup();
    const first = fakeModel();
    await generate(options(s, first, { specs: specs.slice(0, 3) }).opts);
    const stored = JSON.parse(readFileSync(s.resultsFile, "utf-8"));
    stored.results[0].prompt = "0".repeat(64); // asked with another prompt
    stored.results[1].prompt = null; // recorded before prompts were kept, body still passing
    stored.results[2].prompt = null; // recorded before prompts were kept, body now refused
    stored.results[2].generated.body = stored.results[2].generated.body.replaceAll(specs[2]?.claimed, "us");
    stored.results[2].generated.subject = "A note";
    writeFileSync(s.resultsFile, JSON.stringify(stored));
    const again = fakeModel();
    const lines: string[] = [];
    await generate(options(s, again, { specs: specs.slice(0, 3), log: (l) => lines.push(l) }).opts);
    expect(again.sent).toHaveLength(2);
    expect(lines.filter((l) => l.includes("asked again"))).toEqual([
      `${specs[0]?.id}: asked again (its prompt changed)`,
      `${specs[2]?.id}: asked again (its body fails the rules now)`,
    ]);
    const after = results(s.resultsFile).results as unknown as { id: string; prompt: string | null }[];
    expect(after.find((r) => r.id === specs[0]?.id)?.prompt).toBe(promptHash(specs[0] as Spec));
    expect(after.find((r) => r.id === specs[1]?.id)?.prompt).toBeNull();
  });

  it("publishes no set while any scenario number has no accepted message", async () => {
    const s = setup();
    const target = specs[0] as Spec;
    // Every form of the first scenario keeps failing its rules; the rest pass.
    const model = fakeModel((spec) =>
      spec.id.startsWith(target.id) ? { ...goodBody(spec), body: "Too short." } : goodBody(spec),
    );
    const report = await generate(options(s, model, { others: { total: 55, genuine: 0 } }).opts);
    expect(report.unfilled).toEqual([target.id]);
    expect(report.stopped).toBe(`incomplete: no accepted message for ${target.id}`);
    expect(report.written).toBe(false);
    expect(existsSync(s.setDir)).toBe(false);
  });

  it("leaves the sets folder as it was, and nothing in staging, when a write fails; replaces a set whole", () => {
    const root = temp();
    const dir = join(root, "sets", "synthetic-sa");
    const accepted = specs.slice(0, 3).map((spec) => ({ spec, generated: goodBody(spec) }));
    let writes = 0;
    const full = (file: string, data: string | Uint8Array) => {
      if (++writes === 2) throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
      writeFileSync(file, data);
    };
    expect(() => writeSet(dir, accepted, "2026-10-31", full)).toThrow(/ENOSPC/);
    expect(existsSync(join(root, "sets")) ? readdirSync(join(root, "sets")) : []).toEqual([]);
    expect(existsSync(stagingOf(dir))).toBe(false);
    writeSet(dir, accepted, "2026-10-31");
    expect(readdirSync(dir).sort()).toEqual(
      [...accepted.map((a) => `${a.spec.id}.eml`), "annotations.json", "labels.json"].sort(),
    );
    // A second version replaces the first whole; a failed one leaves the first in place.
    writes = 0;
    expect(() => writeSet(dir, accepted.slice(0, 2), "2026-10-31", full)).toThrow(/ENOSPC/);
    expect(readdirSync(dir).filter((f) => f.endsWith(".eml"))).toHaveLength(3);
    writeSet(dir, accepted.slice(0, 2), "2026-10-31");
    expect(readdirSync(dir).filter((f) => f.endsWith(".eml"))).toHaveLength(2);
    expect(readdirSync(join(root, "sets"))).toEqual(["synthetic-sa"]);
    expect(existsSync(stagingOf(dir))).toBe(false);
  });
});

describe("the invoice PDF", () => {
  it("is one page carrying the supplier, the customer, the invoice number and the amount, its cross-references true", () => {
    const s = specs.find((x) => x.attachment?.kind === "pdf") as Spec;
    expect(attachmentBytes(s)).toEqual(invoicePdf(s));
    const pdf = new TextDecoder().decode(invoicePdf(s));
    for (const want of ["/Type /Page ", "/Count 1", s.claimed, s.recipient, s.details.invoice as string])
      expect(pdf).toContain(want);
    expect(pdf).toContain((s.details.amount as string).replace(/[^\x20-\x7e]/g, " "));
    const xref = Number(pdf.match(/startxref\n(\d+)/)?.[1]);
    expect(pdf.slice(xref, xref + 4)).toBe("xref");
    const offsets = [...pdf.slice(xref).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
    expect(offsets).toHaveLength(5);
    offsets.forEach((o, i) => expect(pdf.slice(o, o + 8)).toBe(`${i + 1} 0 obj\n`));
  });
});

describe("a set written again", () => {
  const accepted = specs.slice(0, 3).map((spec) => ({ spec, generated: goodBody(spec) }));
  const reading = {
    reviewer: "astra",
    review: "docs/reviews/x.md#Second reading",
    verdict: "agree" as const,
    note: "",
  };
  const annotationsOf = (dir: string) =>
    JSON.parse(readFileSync(join(dir, "annotations.json"), "utf-8")) as { path: string; second_reading: unknown }[];

  it("keeps the readings of unchanged messages and drops those of changed ones", () => {
    const dir = join(temp(), "sets", "synthetic-sa");
    writeSet(dir, accepted, "2026-10-31");
    const read = annotationsOf(dir).map((a) => ({ ...a, second_reading: reading }));
    writeFileSync(join(dir, "annotations.json"), JSON.stringify(read));
    const changed = accepted.map((a, i) =>
      i === 1 ? { ...a, generated: { ...a.generated, body: `${a.generated.body} One more line.` } } : a,
    );
    writeSet(dir, changed, "2026-11-01");
    expect(annotationsOf(dir).map((a) => a.second_reading)).toEqual([reading, null, reading]);
  });

  it("is put back after a crash between moving the old version aside and moving the new one in", async () => {
    const root = temp();
    const dir = join(root, "sets", "synthetic-sa");
    writeSet(dir, accepted, "2026-10-31");
    // The state a crash leaves: the published set moved aside, the new one still in staging.
    mkdirSync(stagingOf(dir), { recursive: true });
    renameSync(dir, join(stagingOf(dir), "synthetic-sa.old"));
    mkdirSync(join(stagingOf(dir), "synthetic-sa.new"));
    expect(existsSync(dir)).toBe(false);
    const s = setup();
    const lines: string[] = [];
    await generate(options(s, fakeModel(), { specs: [], setDir: dir, log: (l) => lines.push(l) }).opts);
    expect(lines[0]).toBe(`${dir} restored from an interrupted swap`);
    expect(readdirSync(dir).filter((f) => f.endsWith(".eml"))).toHaveLength(3);
    expect(existsSync(stagingOf(dir))).toBe(false);
    expect(recoverSet(dir)).toBeNull();
  });

  it("puts the published set back when the new one cannot be moved in", () => {
    const dir = join(temp(), "sets", "synthetic-sa");
    writeSet(dir, accepted, "2026-10-31");
    let renames = 0;
    const failing = (from: string, to: string) => {
      if (++renames === 2) throw Object.assign(new Error("EXDEV"), { code: "EXDEV" });
      renameSync(from, to);
    };
    expect(() => writeSet(dir, accepted.slice(0, 1), "2026-10-31", writeFileSync, failing)).toThrow(/EXDEV/);
    expect(readdirSync(dir).filter((f) => f.endsWith(".eml"))).toHaveLength(3);
    expect(existsSync(stagingOf(dir))).toBe(false);
  });
});

describe("the persisted set", () => {
  const stored = (
    JSON.parse(readFileSync(RESULTS_FILE, "utf-8")) as {
      results: { id: string; status: string; generated: { subject: string; body: string } | null }[];
    }
  ).results;
  const variants = specs.map((s) => scenario(s.category, Number(s.id.slice(-3)), 1));
  const specOf = new Map([...specs, ...variants].map((s) => [s.id, s]));
  const set = loadSet(SET_DIR, "synthetic-sa");

  it("holds the stated population: 160 messages, one per scenario number, in the stated mix", () => {
    expect(set.samples).toHaveLength(160);
    for (const [category, count] of Object.entries(MIX))
      expect(set.samples.filter((s) => s.category === category)).toHaveLength(count);
    const numbers = new Set(set.samples.map((s) => s.path.replace(/(-v\d+)?\.eml$/, "")));
    expect(numbers).toEqual(new Set(specs.map((s) => s.id)));
  });

  it("is every message exactly as its spec and its stored body assemble, each passing the rules, its label its spec's", () => {
    for (const sample of set.samples) {
      const id = sample.path.replace(/\.eml$/, "");
      const spec = specOf.get(id) as Spec;
      const result = stored.find((r) => r.id === id);
      expect(result?.status, id).toBe("accepted");
      const generated = result?.generated as { subject: string; body: string };
      expect(realismProblems(spec, generated), id).toEqual([]);
      expect(
        Buffer.from(readFileSync(join(SET_DIR, sample.path))).equals(Buffer.from(assemble(spec, generated))),
        id,
      ).toBe(true);
      expect([sample.label, sample.category, sample.expected, sample.basis ?? "checks"]).toEqual([
        spec.label,
        spec.category,
        spec.expected,
        spec.basis,
      ]);
    }
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
