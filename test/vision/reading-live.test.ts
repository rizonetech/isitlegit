import { env } from "cloudflare:workers";
import puppeteer from "@cloudflare/puppeteer";
import { describe, expect, it } from "vitest";
import { readEvidence } from "../../src/checks/evidence";
import { createCase } from "../../src/db/cases";
import { putAttachment, type Store } from "../../src/intake/store";
import { visionStep } from "../../src/vision/step";
import { allowedUrl, dohResolve } from "../../src/walkthrough/url-policy";
import { PHISHING_HTML, storeMail } from "../fixtures/vision/emails";
import { allowance, RESULT } from "../walkthrough/allowance";

// D03 T02 §3 live: the vision step with the live Muse Spark on three synthetic fixtures, under the
// allowance scripts/vision-live.ts reserved. Runs only with VISION_LIVE=1 and the keys it passes.
const live = env as unknown as Record<string, string | undefined>;
const LIVE = live.VISION_LIVE === "1";
const store: Store = { bucket: env.ARTEFACTS, db: env.DB };

// A minimal renderable PDF with one text page per entry, the generator the vision tests use.
function makePdf(texts: string[]): Uint8Array {
  const objects: string[] = [];
  const kids = texts.map((_, i) => `${4 + i * 2} 0 R`).join(" ");
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Kids [${kids}] /Count ${texts.length} >>`;
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  texts.forEach((text, i) => {
    const page = 4 + i * 2;
    const content = 5 + i * 2;
    objects[page] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${content} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`;
    const stream = `BT /F1 48 Tf 72 700 Td (${text.replace(/[()\\]/g, "")}) Tj ET`;
    objects[content] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  });
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [0];
  for (let n = 1; n < objects.length; n++) {
    offsets[n] = pdf.length;
    pdf += `${n} 0 obj\n${objects[n]}\nendobj\n`;
  }
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let n = 1; n < objects.length; n++) pdf += `${String(offsets[n]).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new TextEncoder().encode(pdf);
}

describe.skipIf(!LIVE)("vision step live", () => {
  it("reads three synthetic fixtures", { timeout: 300_000 }, async ({ task }) => {
    const budget = allowance(Number(live.VISION_ALLOWANCE_USD ?? "0"));
    const meta = {
      env: {
        ...(live.VISION_META_API_KEY ? { META_API_KEY: live.VISION_META_API_KEY } : {}),
        ...(live.VISION_CF_AIG_TOKEN ? { CF_AIG_TOKEN: live.VISION_CF_AIG_TOKEN } : {}),
        ...(live.VISION_GATEWAY_URL ? { META_GATEWAY_URL: live.VISION_GATEWAY_URL } : {}),
      },
      budget,
    };
    const fixtures: { name: string; seed: (caseId: string) => Promise<void> }[] = [
      {
        name: "protea phishing page",
        seed: async (caseId) => {
          await storeMail(store, caseId, {
            html: PHISHING_HTML,
            text: "Dear member, verify your account within 24 hours to avoid suspension.",
          });
        },
      },
      {
        name: "text-only payment request",
        seed: async (caseId) => {
          await storeMail(store, caseId, { text: "Dear member,\nPlease pay R 4 200 to the new account today." });
        },
      },
      {
        name: "invoice pdf",
        seed: async (caseId) => {
          await storeMail(store, caseId, { text: "Invoice 77 attached. Please pay into our new account." });
          await putAttachment(
            store,
            caseId,
            "invoice-77.pdf",
            makePdf(["Invoice 77 Total R 4 200"]),
            "application/pdf",
          );
        },
      },
    ];
    const cases: { name: string; outcome: string; items: string[]; ms: number }[] = [];
    for (const fixture of fixtures) {
      const made = await createCase(env.DB, { orgId: "org-vision-live", channel: "email", headersAvailable: true });
      if (!made.ok) throw new Error(made.error.message);
      const caseId = made.value.id;
      await fixture.seed(caseId);
      const at = Date.now();
      const out = await visionStep(
        {
          db: env.DB,
          store,
          launch: () => puppeteer.launch(env.BROWSER),
          meta: { env: meta.env, budget },
          kv: (env as unknown as Env).CACHE,
          waitUntil: () => {},
          policy: (raw) => allowedUrl(raw, dohResolve()),
        },
        caseId,
      );
      const items = (await readEvidence(env.DB, caseId))
        .filter((e) => e.check.startsWith("vision."))
        .map((e) => `${e.check}:${e.severity}`);
      cases.push({ name: fixture.name, outcome: out.outcome, items, ms: Date.now() - at });
    }
    (task.meta as Record<string, unknown>)[RESULT] = { outcome: "vision-live", attempts: budget.attempts(), cases };
    expect(cases.map((c) => c.outcome)).toEqual(["read", "read", "read"]);
  });
});
