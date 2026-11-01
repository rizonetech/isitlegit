import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { ruleVerdict } from "../../src/agent/rule-verdict";
import { readEvidence } from "../../src/checks/evidence";
import { createCase } from "../../src/db/cases";
import { parsedKey, putRaw, type Store } from "../../src/intake/store";
import { checks, parse } from "../../src/pipeline/analysis-workflow";

// D04 T01 §9: ordinary mail through the real parse and checks, then the rule-based verdict. The family rule must not
// call these suspicious; each is a kind of genuine mail the display-name and link checks could mistake for a lure.
const store: Store = { bucket: env.ARTEFACTS, db: env.DB };
const mail = (from: string, body: string, extra = "") =>
  [
    `From: ${from}`,
    "To: member@client.example",
    "Subject: Your monthly update",
    "Date: Sat, 01 Nov 2026 08:00:00 +0200",
    "Message-ID: <benign@mail.example>",
    "MIME-Version: 1.0",
    ...(extra ? [extra] : []),
    "Content-Type: text/plain; charset=utf-8",
    "",
    body,
  ].join("\r\n");

async function verdictOf(raw: string) {
  const made = await createCase(env.DB, { orgId: "org-benign", channel: "email", headersAvailable: true });
  if (!made.ok) throw new Error(made.error.message);
  const id = made.value.id;
  await putRaw(store, id, new TextEncoder().encode(raw));
  await parse(store, id, { channel: "email", sourceKind: "mail", headersAvailable: true });
  await checks(store, id, parsedKey(id), { orgId: "org-benign", channel: "email" });
  const evidence = await readEvidence(env.DB, id);
  return { view: ruleVerdict(evidence, { headersAvailable: true }), fired: evidence.filter((e) => e.severity !== "info").map((e) => `${e.check}:${e.severity}`) };
}

describe("the family rule on ordinary mail", () => {
  it.each([
    ["a mailing-list rewrite", mail('"Jane Doe via Ops List" <ops@lists.example.org>', "Minutes of Friday's meeting are attached below.")],
    ["a delegated sender", mail('"Thandi Mokoena on behalf of Acme" <thandi@acme.example>', "Please find the agenda for Monday.", "Sender: assistant@acme.example")],
    ["a newsletter from its own domain", mail('"Acme Weekly" <news@acme.example>', "This week: three tips. Read more at https://acme.example/blog/tips")],
    ["a link whose text names its own site", mail('"Acme Billing" <billing@acme.example>', "Your statement is at https://acme.example/statement (acme.example).")],
  ])("%s is not called suspicious", async (_name, raw) => {
    const { view, fired } = await verdictOf(raw);
    expect(view.verdict, `fired: ${fired.join(", ")}`).toBe("safe");
  });
});
