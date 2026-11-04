import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { CaseView } from "../../src/checks/case-view";
import { readEvidence, saveEvidence } from "../../src/checks/evidence";
import { voiceRequestEvidence } from "../../src/checks/voice";
import { createCase } from "../../src/db/cases";
import { verified } from "../../src/voice/extract";
import { StoredVoice, type VoiceClaim } from "../../src/voice/schema";

function claim(payment_quote: string | null): VoiceClaim {
  return {
    request: "pay",
    request_quote: "Please pay",
    claimed_identity: null,
    identity_quote: null,
    urgency: "low",
    urgency_quote: null,
    payment_quote,
  };
}

async function persisted(transcript: string, quote: string | null) {
  const result = verified(claim(quote), transcript);
  const voice = StoredVoice.parse(JSON.parse(JSON.stringify({ state: "read", ...result, complete: true })));
  const made = await createCase(env.DB, {
    orgId: "org-figures",
    channel: "upload",
    uploadedBy: "user-figures",
    headersAvailable: false,
  });
  if (!made.ok) throw new Error(made.error.message);
  const items = voiceRequestEvidence({ voice, raw: `raw/${made.value.id}/audio` } as CaseView);
  await saveEvidence(env.DB, made.value.id, items);
  return (await readEvidence(env.DB, made.value.id)).find((item) => item.check === "voice.request")?.detail;
}

describe("voice figures from the complete transcript to stored evidence", () => {
  it("persists only figures wholly inside the verified payment quote", async () => {
    const transcript = "Reference 987654321. Please pay R48 000 to account 0012 3456 78. Later pay R200.";
    const quote = "Please pay R48 000 to account 0012 3456 78";
    const detail = await persisted(transcript, quote);
    const raw = "R48 000";
    expect(detail).toMatchObject({
      paymentQuote: quote,
      paymentFigures: {
        quoteStart: transcript.indexOf(quote),
        quoteEnd: transcript.indexOf(quote) + quote.length,
        items: [
          {
            kind: "amount",
            raw,
            start: transcript.indexOf(raw),
            end: transcript.indexOf(raw) + raw.length,
            value: "48000",
            currency: "R",
          },
          {
            kind: "account",
            raw: "0012 3456 78",
            start: transcript.indexOf("0012"),
            end: transcript.indexOf("0012") + 12,
            value: "0012345678",
            currency: null,
          },
        ],
      },
    });
  });

  it("does not manufacture a figure from a quote cutting through one", async () => {
    for (const [transcript, quote] of [
      ["Please pay R100 million today", "Please pay R100"],
      ["Please pay into account 991234567899", "12345678"],
      ["Please pay R48 000 today", "000 today"],
    ]) {
      expect(await persisted(String(transcript), String(quote))).toMatchObject({ paymentFigures: { items: [] } });
    }
  });

  it("maps case and whitespace matching to original source offsets", async () => {
    const transcript = "Please pay R48\t000 to account 0012 3456 78 today.";
    const detail = await persisted(transcript, "please PAY R48  000 to account 0012 3456 78 today");
    expect(detail).toMatchObject({
      paymentFigures: {
        quoteStart: 0,
        quoteEnd: transcript.length - 1,
        items: [
          { raw: "R48\t000", start: 11, end: 18, value: "48000", currency: "R" },
          { raw: "0012 3456 78", value: "0012345678" },
        ],
      },
    });
  });

  it("keeps historical claims without derived figures without parsing a substring", () => {
    const voice = StoredVoice.parse({
      state: "read",
      complete: true,
      dropped: 0,
      claim: {
        request: "pay",
        requestQuote: "Please pay",
        claimedIdentity: null,
        identityQuote: null,
        urgency: "low",
        urgencyQuote: null,
        paymentQuote: "R100",
      },
    });
    expect(voiceRequestEvidence({ voice, raw: "raw/legacy/audio" } as CaseView)[0]?.detail).not.toHaveProperty(
      "paymentFigures",
    );
  });
});

it("rejects altered stored numeric readings, spans, currency and quote support", () => {
  const result = verified(claim("Please pay R100.50 to 0012 3456 78"), "Please pay R100.50 to 0012 3456 78 today");
  const good = { state: "read", ...result, complete: true };
  expect(StoredVoice.safeParse(good).success).toBe(true);
  const changed = (edit: (value: typeof good) => void) => {
    const copy = structuredClone(good);
    edit(copy);
    expect(StoredVoice.safeParse(copy).success).toBe(false);
  };
  changed((v) => {
    if (v.claim.paymentFigures?.items[0]) v.claim.paymentFigures.items[0].value = "1.00";
  });
  changed((v) => {
    if (v.claim.paymentFigures?.items[0]) v.claim.paymentFigures.items[0].end++;
  });
  changed((v) => {
    if (v.claim.paymentFigures) v.claim.paymentFigures.quoteStart = 20;
  });
  changed((v) => {
    v.claim.paymentQuote = null;
  });
  changed((v) => {
    if (v.claim.paymentFigures?.items[1]) v.claim.paymentFigures.items[1].currency = "R";
  });
  changed((v) => {
    if (v.claim.paymentFigures?.items[0]) v.claim.paymentFigures.items.push(v.claim.paymentFigures.items[0]);
  });
});

it("maps lowercase expansion and surrogate pairs to exact original offsets", async () => {
  const transcript = "😀 İ Please pay R100.50 today";
  const detail = await persisted(transcript, "i\u0307 please PAY r100.50 today");
  expect(detail).toMatchObject({
    paymentFigures: {
      quoteStart: 3,
      quoteEnd: transcript.length,
      items: [
        {
          raw: "R100.50",
          start: transcript.indexOf("R100"),
          end: transcript.indexOf("R100") + 7,
          value: "100.50",
          currency: "R",
        },
      ],
    },
  });
});

it("keeps figures with a payment sentence that makes no request", async () => {
  const result = verified(
    { ...claim("Account 0012 3456 78"), request: "none", request_quote: null },
    "Account 0012 3456 78",
  );
  const voice = StoredVoice.parse({ state: "read", ...result, complete: true });
  const item = voiceRequestEvidence({ voice, raw: "raw/figures/audio" } as CaseView)[0];
  expect(item).toMatchObject({
    severity: "info",
    detail: { paymentFigures: { items: [{ kind: "account", value: "0012345678" }] } },
  });
});

it("stores every small figure and exact raw whitespace instead of generic display clipping", async () => {
  const transcript = `Please pay ${Array(30).fill("R1").join(" ")}`;
  const detail = await persisted(transcript, transcript);
  const figures = detail?.paymentFigures as { items: unknown[] } | undefined;
  expect(figures?.items).toHaveLength(30);
  const raw = `R${" ".repeat(400)}100`;
  const spaced = await persisted(`Please pay ${raw} today`, "Please pay R 100 today");
  expect(spaced).toMatchObject({ paymentFigures: { items: [{ raw, start: 11, end: 11 + raw.length, value: "100" }] } });
});

it("bounds evidence by whole figures with explicit omissions", async () => {
  const raw = `R${" ".repeat(1800)}1`;
  const transcript = `Please pay ${Array(40).fill(raw).join(" ")}`;
  const quote = `Please pay ${Array(40).fill("R 1").join(" ")}`;
  const detail = await persisted(transcript, quote);
  const figures = detail?.paymentFigures as
    | { items: { raw: string; start: number; end: number }[]; omitted: number }
    | undefined;
  if (!figures) throw new Error("missing figures");
  expect(figures.omitted).toBeGreaterThan(0);
  expect(figures.items.length + figures.omitted).toBe(40);
  for (const item of figures.items) expect(transcript.slice(item.start, item.end)).toBe(item.raw);
  expect(new TextEncoder().encode(JSON.stringify(detail)).byteLength).toBeLessThanOrEqual(64 * 1024);
});

it.each([
  "Please pay - R100 today",
  "Please pay − 100.50 today",
  "Please pay R100 and thirteen today",
  "Please pay 100 million and 50 thousand today",
  "Please pay R100 & 50 thousand today",
  "Please pay negative 100 million and 50 thousand today",
])("round-one regression: no partial signed/composite evidence for %s", async (transcript) => {
  expect(await persisted(transcript, transcript)).toMatchObject({ paymentFigures: { items: [] } });
});

it.each([
  "Please pay R100 & 50 thousand & 20 thousand today",
  "Please pay R100 & 50 thousand & 20 thousand & R30 today",
  "Please pay negative R100 and 50 thousand & 20 thousand today",
])("completion regression: repeated compound joins retain only the quote for %s", async (transcript) => {
  expect(await persisted(transcript, transcript)).toMatchObject({ paymentFigures: { items: [] } });
});

it.each([
  "Please pay R100 & -50 thousand & 20 thousand today",
  "Please pay R100 and negative 50 thousand and 20 thousand today",
  "Please pay R100 and minus R50 and R20 today",
  "Please pay R100 & − 50 thousand & 20 thousand today",
])("reconciliation regression: signed later components reject the whole expression for %s", async (transcript) => {
  expect(await persisted(transcript, transcript)).toMatchObject({ paymentFigures: { items: [] } });
});

it.each([
  "Please pay R100 & R-50 thousand & 20 thousand today",
  "Please pay R100 and ZAR-50 thousand and 20 thousand today",
])("signed currency components also reject the whole expression for %s", async (transcript) => {
  expect(await persisted(transcript, transcript)).toMatchObject({ paymentFigures: { items: [] } });
});

it.each([
  "Please pay R100 and ZAR50 today",
  "Please pay R100 & USD50 thousand & EUR20 today",
  "Please pay R100 and GBP50 today",
  "Please pay R100 & ZAR50 & USD20 & EUR30 & GBP40 today",
])("successor regression: adjacent currency codes stay inside the rejected compound for %s", async (transcript) => {
  expect(await persisted(transcript, transcript)).toMatchObject({ paymentFigures: { items: [] } });
});
