// The takedown pack, RDAP contacts, findings lifecycle and alert (D05 T04 §5): fixture RDAP,
// a pack whose PDF opens with its screenshot, findings across captures with dismissal and
// reopening, and one alert per confirmed finding with the stable send key.
import { describe, expect, it } from "vitest";
import { readPdf } from "../../src/invoice/pdf";
import { dismissFinding, findingsFromInvestigations, listFindings, restoreFinding } from "../../src/monitor/findings";
import { rdapContacts } from "../../src/monitor/rdap-contacts";
import { takedownMarkdown, takedownPdf } from "../../src/monitor/takedown";
import { setIdentity } from "../../src/trust/identity";
import { fakeJpeg } from "../fixtures/jpeg";
import { addAddress } from "../trust/helpers";
import { business, db } from "./world";

const DOMAIN_RDAP = {
  entities: [
    {
      roles: ["registrar"],
      vcardArray: ["vcard", [["fn", {}, "text", "Example Registrar"]]],
    },
    {
      roles: ["abuse"],
      vcardArray: ["vcard", [["email", {}, "text", "abuse@registrar.example"]]],
    },
  ],
  name: "x",
};
const IP_RDAP = {
  name: "EXAMPLE-NET",
  entities: [{ roles: ["abuse"], vcardArray: ["vcard", [["email", {}, "text", "abuse@host.example"]]] }],
};

describe("rdap contacts", () => {
  it("parses registrar, network and abuse contacts, and states a missing one", async () => {
    const fetchFn = (async (url: string | URL) =>
      new Response(JSON.stringify(String(url).includes("/ip/") ? IP_RDAP : DOMAIN_RDAP), {
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
    const got = await rdapContacts(fetchFn, {
      domain: "fake.example",
      bootstrap: [[["example"], ["https://rdap.example/"]]],
      ip: "192.0.2.5",
    });
    expect(got.registrar).toBe("Example Registrar");
    expect(got.registrarAbuse).toBe("abuse@registrar.example");
    expect(got.network).toBe("EXAMPLE-NET");
    expect(got.networkAbuse).toBe("abuse@host.example");
    const bare = await rdapContacts(
      (async () => new Response(JSON.stringify({ entities: [] }))) as unknown as typeof fetch,
      { domain: "fake.example", bootstrap: [[["example"], ["https://rdap.example/"]]] },
    );
    expect(bare.unavailable).toContain("registrar-abuse-contact");
    // Malformed RDAP shapes state themselves, never throw.
    // Built as JSON text: serialising a 5000-deep object throws before the lookup runs.
    let deepJson = '{"roles":["abuse"]}';
    for (let i = 0; i < 5000; i++) deepJson = `{"entities":[${deepJson}]}`;
    const deep = JSON.parse(deepJson) as Record<string, unknown>;
    for (const bad of [
      { entities: {} },
      { entities: [null] },
      { entities: [{ roles: {}, vcardArray: ["vcard", {}] }] },
      { entities: [{ roles: ["registrar"], vcardArray: ["vcard", [null]] }] },
      { entities: [{ roles: ["registrar"], handle: { toString: null, valueOf: null } }] },
      deep,
    ]) {
      const gotBad = await rdapContacts(
        (async () => new Response(bad === deep ? deepJson : JSON.stringify(bad))) as unknown as typeof fetch,
        {
          domain: "fake.example",
          bootstrap: [[["example"], ["https://rdap.example/"]]],
        },
      );
      expect(gotBad.registrarAbuse).toBeNull();
      expect(gotBad.unavailable).toContain("registrar-abuse-contact");
    }
  });
});

async function settled(
  orgId: string,
  host: string,
  state: string,
  capture = "cap-1",
  created = "2026-11-02T00:00:00Z",
) {
  await db
    .prepare(
      `INSERT INTO monitor_investigations (org_id, domain, capture_key, case_id, capture_url, state, evidence_refs, created_at, updated_at)
       VALUES (?, ?, ?, NULL, NULL, ?, '["E1"]', ?, ?)
       ON CONFLICT (org_id, capture_key) DO UPDATE SET state = excluded.state`,
    )
    .bind(orgId, host, capture, state, created, created)
    .run();
}

describe("rdap streaming limit", () => {
  it("cancels an oversized chunked answer and states the contacts unavailable", async () => {
    let cancelled = false;
    const fetchFn = (async () => {
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new Uint8Array(64 * 1024).fill(0x61));
        },
        cancel() {
          cancelled = true;
        },
      });
      return new Response(body, { headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const got = await rdapContacts(fetchFn, {
      domain: "fake.example",
      bootstrap: [[["example"], ["https://rdap.example/"]]],
    });
    expect(cancelled).toBe(true);
    expect(got.unavailable).toContain("domain-rdap");
  });
});

describe("findings and the pack", () => {
  it("creates, alerts once, dismisses across captures and reopens on a new confirmed capture", async () => {
    const { orgId } = await business();
    // Alert mail goes only to a demo alias or the operator (src/mail/allowlist.ts), so the
    // identity's alert contact here is a verified demo alias.
    await addAddress(orgId, "alerts@demo.isitlegit.co.za");
    await setIdentity(db, orgId, "owner", {
      displayNames: ["Fynbos"],
      financeContact: "alerts@demo.isitlegit.co.za",
      protected: true,
    });
    await settled(orgId, "fake.example", "confirmed");
    let sends = 0;
    const mail = {
      db,
      apiKey: "test",
      fetch: (async () => {
        sends++;
        return new Response(JSON.stringify({ data: { succeeded: 1, failed: 0, email_id: "mail-1" } }), {
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch,
      pause: async () => {},
    };
    const deps = { mail, appUrl: "https://app.isitlegit.co.za" };
    const first = await findingsFromInvestigations(db, orgId, deps);
    expect(first.created).toBe(1);
    expect(first.alerted).toBe(1);
    expect(sends).toBe(1);
    const again = await findingsFromInvestigations(db, orgId, deps);
    expect(again.alerted).toBe(0);
    expect(sends).toBe(1);

    expect(await dismissFinding(db, orgId, "fake.example", "Our old campaign site")).toBe(true);
    await settled(orgId, "fake.example", "confirmed", "cap-2", "2999-01-01T00:00:00Z");
    await findingsFromInvestigations(db, orgId, deps);
    let findings = await listFindings(db, orgId);
    expect(findings[0]?.status).toBe("new");
    expect(await dismissFinding(db, orgId, "fake.example", "Still ours")).toBe(true);
    expect(await restoreFinding(db, orgId, "fake.example")).toBe(true);
    findings = await listFindings(db, orgId);
    expect(findings[0]?.status).toBe("watching");

    const finding = findings[0] as NonNullable<(typeof findings)[number]>;
    const contacts = await rdapContacts(
      (async (url: string | URL) =>
        new Response(JSON.stringify(String(url).includes("/ip/") ? IP_RDAP : DOMAIN_RDAP))) as typeof fetch,
      { domain: "fake.example", bootstrap: [[["example"], ["https://rdap.example/"]]], ip: "192.0.2.5" },
    );
    const md = takedownMarkdown({
      finding,
      contacts,
      evidenceSummaries: ["The logo matches."],
      screenshotName: "screenshot.jpg",
    });
    for (const field of [
      "Example Registrar",
      "abuse@registrar.example",
      "EXAMPLE-NET",
      "abuse@host.example",
      "fake.example",
    ])
      expect(md).toContain(field);
    const pdf = takedownPdf({
      finding,
      contacts,
      evidenceSummaries: ["The logo matches."],
      screenshotName: "screenshot.jpg",
      screenshotJpeg: fakeJpeg(1280, 800, 30_000),
    });
    const parsed = await readPdf(pdf);
    expect(parsed.unread).toEqual([]);
    expect(parsed.text).toContain("Takedown request");
    expect(new TextDecoder("latin1").decode(pdf)).toContain("DCTDecode");
    // The embedded image is the capture byte for byte, read back out of the PDF.
    const jpeg = fakeJpeg(1280, 800, 30_000);
    let at = -1;
    outer: for (let i = 0; i + jpeg.byteLength <= pdf.byteLength; i++) {
      for (let j = 0; j < jpeg.byteLength; j++) if (pdf[i + j] !== jpeg[j]) continue outer;
      at = i;
      break;
    }
    expect(at).toBeGreaterThan(-1);
  });
});
