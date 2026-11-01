// D08 T01 §3: the synthetic set's expected evidence, proved through the real checks step rather than assumed. Every
// scenario is assembled (with a fixed body carrying its details), parsed, stored as the pipeline stores it, and run
// through `checks` for an organisation with a Google receiver; each expected item must be raised and none of the
// eight expectable checks raised unexpectedly. "Raised" is an item above info: a passing result is reported too, at
// info, and each check sets its own weight (a bounce address elsewhere is `low` by design, src/checks/sender.ts).
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { assemble } from "../../eval/generate/assemble";
import { challengeSpecs } from "../../eval/generate/challenge";
import { EXPECTABLE, finish, type Spec, scenario, scenarios } from "../../eval/generate/scenarios";
import { readEvidence } from "../../src/checks/evidence";
import { createCase } from "../../src/db/cases";
import { parseMessage, storeParsed } from "../../src/intake/parse";
import { parsedKey, putRaw, type Store } from "../../src/intake/store";
import { checks } from "../../src/pipeline/analysis-workflow";

const store: Store = { bucket: env.ARTEFACTS, db: env.DB };
const ORG = "org-synthetic";
const RAISED = new Set(["low", "medium", "high", "critical"]);

// A body that carries every detail, long enough to be read as mail; the checks never read it for these eight.
const bodyFor = (spec: Spec) =>
  `Good day,\n\n${spec.trick}\n\n${Object.values(spec.details).join("\n")}\n\nKind regards,\n${spec.from.name}\n${spec.claimed}`;

beforeAll(async () => {
  const now = new Date().toISOString();
  const domains = [...new Set([...scenarios(), ...challengeSpecs()].map((s) => s.to.address.split("@")[1] as string))];
  for (const [i, domain] of domains.entries())
    await env.DB.prepare(
      "INSERT INTO org_domains (id, org_id, domain, token, state, method, verified_at, created_at) VALUES (?, ?, ?, ?, 'verified', 'dns', ?, ?)",
    )
      .bind(`claim-synthetic-${i}`, ORG, domain, "t".repeat(16), now, now)
      .run();
});

// The expectable checks the pipeline raised for a scenario's assembled message.
async function raised(spec: Spec): Promise<string[]> {
  const made = await createCase(env.DB, { orgId: ORG, channel: "email", headersAvailable: true });
  if (!made.ok) throw new Error(made.error.message);
  const id = made.value.id;
  const raw = assemble(spec, { subject: `About ${spec.claimed}`, body: bodyFor(spec) });
  await putRaw(store, id, raw);
  await storeParsed(store, id, await parseMessage(raw), {
    original: raw,
    format: "eml",
    headersAvailable: true,
    path: "eml",
    otherOriginals: 0,
  });
  await checks(store, id, parsedKey(id), { orgId: ORG, channel: "email" }, async () => ["aspmx.l.google.com"]);
  const names = (await readEvidence(env.DB, id))
    .filter((e) => RAISED.has(e.severity) && (EXPECTABLE as readonly string[]).includes(e.check))
    .map((e) => e.check);
  return [...new Set(names)].sort();
}

describe("the synthetic set's expected evidence", () => {
  it("is raised for every scenario, and nothing else of the eight", async () => {
    const wrong: string[] = [];
    for (const spec of scenarios()) {
      const got = await raised(spec);
      const want = [...spec.expected].sort();
      if (JSON.stringify(got) !== JSON.stringify(want))
        wrong.push(`${spec.id}: raised ${got.join(",") || "nothing"}, expected ${want.join(",") || "nothing"}`);
    }
    expect(wrong).toEqual([]);
  }, 300_000);

  it("raises exactly the expected evidence for every challenge scenario", async () => {
    for (const spec of challengeSpecs()) expect(await raised(spec), spec.id).toEqual([...spec.expected].sort());
  }, 300_000);

  it("raises nothing for a Reply-To and a Return-Path on the sender's own registrable domain", async () => {
    const base = scenario("genuine-business", 1);
    const control = finish({
      ...base,
      id: "genuine-business-901",
      replyTo: { name: "Accounts", address: `accounts@billing.${base.from.address.split("@")[1]}` },
      returnPath: `bounce@mail.out.${base.from.address.split("@")[1]}`,
    });
    expect(control.expected).toEqual([]);
    expect(await raised(control)).toEqual([]);
  });

  it("raises the Reply-To and Return-Path checks once they sit on other registrable domains", async () => {
    const base = scenario("genuine-business", 1);
    const moved = finish({
      ...base,
      id: "invoice-bank-change-902",
      category: "invoice-bank-change",
      label: "attack",
      replyTo: { name: "Accounts", address: "accounts@quickpost.example" },
      returnPath: "bounce@inboxnow.example",
    });
    expect(moved.expected).toEqual(["sender.reply_to", "sender.return_path"]);
    expect(await raised(moved)).toEqual(["sender.reply_to", "sender.return_path"]);
  });
});

describe("the assembled messages", () => {
  it("parse back with the spec's headers, the marker and its parts", async () => {
    for (const s of scenarios()) {
      const g = { subject: `About ${s.claimed}`, body: bodyFor(s) };
      const parsed = await parseMessage(assemble(s, g));
      const header = (name: string) =>
        parsed.headers.filter((h) => h.name.toLowerCase() === name.toLowerCase()).map((h) => h.value);
      expect(header("X-IsItLegit-Synthetic"), s.id).toEqual(["true"]);
      expect(header("From")[0]).toContain(s.from.address);
      expect(header("To")[0]).toContain(s.to.address);
      expect(header("Return-Path")[0]).toContain(s.returnPath);
      expect(header("Reply-To")[0] ?? null).toEqual(s.replyTo ? expect.stringContaining(s.replyTo.address) : null);
      expect(header("Subject")[0]).toBe(g.subject);
      expect(header("Authentication-Results")[0]).toContain(`spf=${s.auth.spf}`);
      expect(parsed.text).toContain(Object.values(s.details)[0]);
      expect(parsed.attachments.map((a) => a.filename)).toEqual(s.attachment ? [s.attachment.filename] : []);
    }
  });
});
