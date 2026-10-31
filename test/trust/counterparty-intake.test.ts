// The counterparty intake path (D05 T02 §1; spec 2a): a non-member's forward becomes a case of the protected business
// its attached original claims (by display name or From domain), only when the forwarder proves its own domain and
// exactly one protected business matches; anything else is dropped with no reply. Counterparty cases are held by their
// own limits (5 a day per forwarder, 50 per protected business), counted from the cases themselves, and never use the
// organisation's own daily cap.
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COUNTERPARTY_PER_IDENTITY, COUNTERPARTY_PER_SENDER } from "../../src/db/cases";
import { handleEmail, originalClaim, RetryDelivery } from "../../src/intake/email";
import { EMAIL_ROUTING_AUTHSERV_ID } from "../../src/intake/sender";
import { isAllowedRecipient } from "../../src/mail/allowlist";
import { SMTP2GO_URL, sendMail } from "../../src/mail/smtp2go";
import { setIdentity } from "../../src/trust/identity";
import { msgs } from "../fixtures/msg/load";
import { addAddress, addDomain, makeOrg, protectableOrg } from "./helpers";

const db = env.DB;
const mailEnv = { ...(env as unknown as Env), SMTP2GO_API_KEY: `api-${"k".repeat(32)}` };
const quiet = () => {};

let fetchSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  // No mail leaves a test: a counterparty drop sends nothing, and nothing here should reach SMTP2GO.
  fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    throw new Error("no network in this test");
  });
});
afterEach(() => {
  fetchSpy.mockRestore();
  vi.restoreAllMocks();
});

let n = 0;
const unique = () => `${++n}-${crypto.randomUUID().slice(0, 6)}`;
// Names are unique per test: the database is shared across a file, and two protected businesses of one name make a
// claim by that name ambiguous (which the gate rightly drops).
const nameOf = (base: string) => `${base} ${unique()}`;
let FYNBOS = "";
let KAROO = "";
beforeEach(() => {
  FYNBOS = nameOf("Fynbos Freight");
  KAROO = nameOf("Karoo Couriers");
});

// A protected business with a verified domain and finance contact, its identity switched on.
async function protectedBusiness(name: string, domain: string) {
  const orgId = await protectableOrg(domain, `money@${domain}`, name);
  await setIdentity(db, orgId, "owner", { displayNames: [name], financeContact: `money@${domain}`, protected: true });
  return orgId;
}

// A forward as Email Routing hands it to the Worker: `forwarder` sends it, authenticated for its own domain unless told
// otherwise, carrying an attached original from `originalFrom` (or inline, with no original).
function forward(
  forwarder: string,
  originalFrom: string,
  options: { auth?: string; inline?: boolean; messageId?: string } = {},
) {
  const domain = forwarder.slice(forwarder.indexOf("@") + 1);
  const messageId = options.messageId ?? `<${crypto.randomUUID()}@${domain}>`;
  const auth =
    options.auth ?? `${EMAIL_ROUTING_AUTHSERV_ID}; spf=pass smtp.mailfrom=${forwarder}; dkim=pass header.d=${domain}`;
  const head = [
    `Authentication-Results: ${auth}`,
    `Message-ID: ${messageId}`,
    `From: Checker <${forwarder}>`,
    "To: check@isitlegit.co.za",
    "Subject: Fwd: new banking details",
    "MIME-Version: 1.0",
  ];
  const original = [
    `From: ${originalFrom}`,
    "To: accounts@customer.example",
    "Subject: New banking details",
    `Message-ID: <${crypto.randomUUID()}@original.example>`,
    "Date: Sat, 31 Oct 2026 08:00:00 +0200",
    "",
    "Please pay into our new account.",
  ].join("\r\n");
  const text = options.inline
    ? [...head, "Content-Type: text/plain; charset=utf-8", "", "---------- Forwarded message ---------", original, ""]
    : [
        ...head,
        'Content-Type: multipart/mixed; boundary="b"',
        "",
        "--b",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "Is this real?",
        "--b",
        "Content-Type: message/rfc822",
        'Content-Disposition: attachment; filename="original.eml"',
        "",
        original,
        "--b--",
        "",
      ];
  return deliver(forwarder, new TextEncoder().encode(text.join("\r\n")), messageId);
}

function deliver(from: string, bytes: Uint8Array, messageId: string | null) {
  const headers = new Headers();
  if (messageId) headers.set("Message-ID", messageId);
  return {
    from,
    to: "check@isitlegit.co.za",
    headers,
    raw: new Response(bytes).body as ReadableStream<Uint8Array>,
    rawSize: bytes.byteLength,
    setReject: () => {},
    forward: async () => ({ messageId: "" }),
    reply: async () => ({ messageId: "" }),
  } as unknown as ForwardableEmailMessage;
}

type Row = { id: string; org_id: string; channel: string; origin: string | null; forwarded_by: string | null };
const cases = async (orgId: string) =>
  (
    await db
      .prepare("SELECT id, org_id, channel, origin, forwarded_by FROM cases WHERE org_id = ? ORDER BY rowid")
      .bind(orgId)
      .all<Row>()
  ).results;

describe("the gate", () => {
  it("files a claim by display name or by domain as the protected business's counterparty case", async () => {
    const domain = `fynbos${unique()}.example`;
    const orgId = await protectedBusiness(FYNBOS, domain);
    const checker = `pay@customer${unique()}.example`;
    const byName = await handleEmail(
      forward(checker, `"${FYNBOS}" <billing@elsewhere.example>`),
      mailEnv,
      new Date(),
      quiet,
    );
    expect(byName).toMatchObject({ kind: "admitted", counterparty: true });
    const byDomain = await handleEmail(
      forward(checker, `Billing <billing@mail.${domain}>`),
      mailEnv,
      new Date(),
      quiet,
    );
    expect(byDomain).toMatchObject({ kind: "admitted", counterparty: true });
    expect(await cases(orgId)).toEqual([
      {
        id: (byName as { caseId: string }).caseId,
        org_id: orgId,
        channel: "email",
        origin: "counterparty",
        forwarded_by: checker,
      },
      {
        id: (byDomain as { caseId: string }).caseId,
        org_id: orgId,
        channel: "email",
        origin: "counterparty",
        forwarded_by: checker,
      },
    ]);
  });

  it("drops a forward claiming no protected business, an inline forward, and an unauthenticated forwarder, making no case", async () => {
    const domain = `fynbos${unique()}.example`;
    const orgId = await protectedBusiness(FYNBOS, domain);
    const checker = `pay@customer${unique()}.example`;
    const lines: string[] = [];
    const log = (line: string) => lines.push(line);
    expect(await handleEmail(forward(checker, "Someone <a@unrelated.example>"), mailEnv, new Date(), log)).toEqual({
      kind: "dropped",
    });
    // Inline: the From the gate would read is the forwarder's own, so it claims nothing, even naming the business.
    expect(
      await handleEmail(
        forward(checker, `"${FYNBOS}" <billing@elsewhere.example>`, { inline: true }),
        mailEnv,
        new Date(),
        log,
      ),
    ).toEqual({ kind: "dropped" });
    expect(
      await handleEmail(
        forward(checker, `"${FYNBOS}" <billing@elsewhere.example>`, {
          auth: `${EMAIL_ROUTING_AUTHSERV_ID}; spf=fail smtp.mailfrom=${checker}; dkim=none`,
        }),
        mailEnv,
        new Date(),
        log,
      ),
    ).toEqual({ kind: "dropped" });
    expect(await cases(orgId)).toEqual([]);
    expect(lines.map((l) => JSON.parse(l).counterparty)).toEqual(["no-match", "no-claim", "unauthenticated"]);
    for (const line of lines) expect(line).not.toContain(checker);
  });

  it("drops a claim that more than one protected business matches", async () => {
    const a = await protectedBusiness(KAROO, `karoo${unique()}.example`);
    const b = await protectedBusiness(KAROO, `karoo${unique()}.example`);
    const lines: string[] = [];
    expect(
      await handleEmail(
        forward(`pay@customer${unique()}.example`, `"${KAROO}" <x@other.example>`),
        mailEnv,
        new Date(),
        (l) => lines.push(l),
      ),
    ).toEqual({ kind: "dropped" });
    expect([...(await cases(a)), ...(await cases(b))]).toEqual([]);
    expect(JSON.parse(lines[0] ?? "{}").counterparty).toBe("ambiguous");
  });

  it("reads the claim of an Outlook .msg original through the same parsing as the pipeline", async () => {
    // A real .msg (test/fixtures/msg/invoice-request.msg) attached to a forward, as Outlook sends it.
    const b64 = btoa(String.fromCharCode(...msgs.full)).replace(/(.{76})/g, "$1\r\n");
    const checker = `pay@customer${unique()}.example`;
    const domain = checker.slice(checker.indexOf("@") + 1);
    const bytes = new TextEncoder().encode(
      [
        `Authentication-Results: ${EMAIL_ROUTING_AUTHSERV_ID}; spf=pass smtp.mailfrom=${checker}; dkim=pass header.d=${domain}`,
        `Message-ID: <msg-${unique()}@${domain}>`,
        `From: Checker <${checker}>`,
        "To: check@isitlegit.co.za",
        "Subject: Fwd: invoice",
        "MIME-Version: 1.0",
        'Content-Type: multipart/mixed; boundary="b"',
        "",
        "--b",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "Is this real?",
        "--b",
        'Content-Type: application/vnd.ms-outlook; name="original.msg"',
        'Content-Disposition: attachment; filename="original.msg"',
        "Content-Transfer-Encoding: base64",
        "",
        b64,
        "--b--",
        "",
      ].join("\r\n"),
    );
    const claim = await originalClaim(bytes);
    expect(claim?.displayName || claim?.domain).toBeTruthy();
    const orgId = await protectedBusiness(claim?.displayName ?? FYNBOS, `msgbiz${unique()}.example`);
    const outcome = await handleEmail(deliver(checker, bytes, null), mailEnv, new Date(), quiet);
    expect(outcome).toMatchObject({ kind: "admitted", counterparty: true });
    expect((await cases(orgId)).map((c) => c.origin)).toEqual(["counterparty"]);
  });

  it("leaves a member's own forward as it was: filed to its organisation, no origin", async () => {
    const memberDomain = `member${unique()}.co.za`;
    const memberOrg = await makeOrg("Member Co");
    await addDomain(memberOrg, memberDomain);
    await addAddress(memberOrg, `boss@${memberDomain}`);
    await protectedBusiness(FYNBOS, `fynbos${unique()}.example`);
    const outcome = await handleEmail(
      forward(`boss@${memberDomain}`, `"${FYNBOS}" <billing@elsewhere.example>`),
      mailEnv,
      new Date(),
      quiet,
    );
    expect(outcome.kind).toBe("admitted");
    expect(outcome).not.toHaveProperty("counterparty");
    expect((await cases(memberOrg)).map((c) => c.origin)).toEqual([null]);
  });
});

describe("the limits", () => {
  const at = (iso: string) => new Date(iso);

  it("admits five a day from one forwarder, then drops silently; a new SAST day opens again", async () => {
    const orgId = await protectedBusiness(FYNBOS, `fynbos${unique()}.example`);
    const checker = `pay@customer${unique()}.example`;
    const day = at("2026-10-31T08:00:00Z");
    for (let i = 0; i < COUNTERPARTY_PER_SENDER; i++)
      expect((await handleEmail(forward(checker, `"${FYNBOS}" <b@x.example>`), mailEnv, day, quiet)).kind).toBe(
        "admitted",
      );
    const lines: string[] = [];
    expect(
      await handleEmail(forward(checker, `"${FYNBOS}" <b@x.example>`), mailEnv, day, (l) => lines.push(l)),
    ).toEqual({
      kind: "dropped",
    });
    expect(JSON.parse(lines[0] ?? "{}").counterparty).toBe("limited");
    expect(fetchSpy).not.toHaveBeenCalled();
    // 00:00 SAST is 22:00 UTC the day before.
    expect(
      (await handleEmail(forward(checker, `"${FYNBOS}" <b@x.example>`), mailEnv, at("2026-10-31T22:00:01Z"), quiet))
        .kind,
    ).toBe("admitted");
    expect(await cases(orgId)).toHaveLength(COUNTERPARTY_PER_SENDER + 1);
  });

  it("admits fifty a day about one business from many forwarders, then drops", async () => {
    const orgId = await protectedBusiness(FYNBOS, `fynbos${unique()}.example`);
    const day = at("2026-10-30T09:00:00Z");
    for (let i = 0; i < COUNTERPARTY_PER_IDENTITY; i++)
      expect(
        (
          await handleEmail(
            forward(`p${i}@customer${unique()}.example`, `"${FYNBOS}" <b@x.example>`),
            mailEnv,
            day,
            quiet,
          )
        ).kind,
      ).toBe("admitted");
    expect(
      await handleEmail(forward(`late@customer${unique()}.example`, `"${FYNBOS}" <b@x.example>`), mailEnv, day, quiet),
    ).toEqual({ kind: "dropped" });
    expect(await cases(orgId)).toHaveLength(COUNTERPARTY_PER_IDENTITY);
  });

  it("keeps the counterparty limits and the organisation's own cap apart, both ways", async () => {
    const domain = `fynbos${unique()}.example`;
    const orgId = await protectedBusiness(FYNBOS, domain);
    // The business's own cap is one case a day.
    await db.prepare("INSERT INTO org_limits (org_id, daily_cases) VALUES (?, 1)").bind(orgId).run();
    const day = at("2026-10-29T09:00:00Z");
    const staff = `money@${domain}`;
    expect((await handleEmail(forward(staff, "Supplier <s@supplier.example>"), mailEnv, day, quiet)).kind).toBe(
      "admitted",
    );
    // Its cap reached by its own staff, a counterparty check about it still gets in.
    expect(
      (await handleEmail(forward(`pay@customer${unique()}.example`, `"${FYNBOS}" <b@x.example>`), mailEnv, day, quiet))
        .kind,
    ).toBe("admitted");
    // And counterparty checks never used the staff's cap: a fresh business, five counterparty cases, then staff mail.
    const other = `karoo${unique()}.example`;
    const otherOrg = await protectedBusiness(KAROO, other);
    await db.prepare("INSERT INTO org_limits (org_id, daily_cases) VALUES (?, 1)").bind(otherOrg).run();
    for (let i = 0; i < 5; i++)
      await handleEmail(forward(`p${i}@customer${unique()}.example`, `"${KAROO}" <b@x.example>`), mailEnv, day, quiet);
    expect(
      (await handleEmail(forward(`money@${other}`, "Supplier <s@supplier.example>"), mailEnv, day, quiet)).kind,
    ).toBe("admitted");
    expect((await cases(otherOrg)).map((c) => c.origin)).toEqual([...Array(5).fill("counterparty"), null]);
  });

  it("takes no slot for a duplicate and gives a slot back when an admission is undone", async () => {
    const orgId = await protectedBusiness(FYNBOS, `fynbos${unique()}.example`);
    const checker = `pay@customer${unique()}.example`;
    const day = at("2026-10-28T09:00:00Z");
    const messageId = `<dup-${unique()}@customer.example>`;
    expect(
      (await handleEmail(forward(checker, `"${FYNBOS}" <b@x.example>`, { messageId }), mailEnv, day, quiet)).kind,
    ).toBe("admitted");
    expect(
      (await handleEmail(forward(checker, `"${FYNBOS}" <b@x.example>`, { messageId }), mailEnv, day, quiet)).kind,
    ).toBe("duplicate");
    // Storage fails once: the admission is undone, its case removed, and the slot is free again.
    const put = vi.spyOn(env.ARTEFACTS, "put").mockRejectedValueOnce(new Error("r2 down"));
    await expect(
      handleEmail(forward(checker, `"${FYNBOS}" <b@x.example>`), mailEnv, day, quiet),
    ).rejects.toBeInstanceOf(RetryDelivery);
    put.mockRestore();
    // Four more fit (five in all: the duplicate and the undone one took none).
    for (let i = 0; i < COUNTERPARTY_PER_SENDER - 1; i++)
      expect((await handleEmail(forward(checker, `"${FYNBOS}" <b@x.example>`), mailEnv, day, quiet)).kind).toBe(
        "admitted",
      );
    expect((await handleEmail(forward(checker, `"${FYNBOS}" <b@x.example>`), mailEnv, day, quiet)).kind).toBe(
      "dropped",
    );
    expect(await cases(orgId)).toHaveLength(COUNTERPARTY_PER_SENDER);
  });

  it("admits one of two concurrent arrivals for the last slot", async () => {
    const orgId = await protectedBusiness(FYNBOS, `fynbos${unique()}.example`);
    const checker = `pay@customer${unique()}.example`;
    const day = at("2026-10-27T09:00:00Z");
    for (let i = 0; i < COUNTERPARTY_PER_SENDER - 1; i++)
      await handleEmail(forward(checker, `"${FYNBOS}" <b@x.example>`), mailEnv, day, quiet);
    const both = await Promise.all([
      handleEmail(forward(checker, `"${FYNBOS}" <b@x.example>`), mailEnv, day, quiet),
      handleEmail(forward(checker, `"${FYNBOS}" <b@x.example>`), mailEnv, day, quiet),
    ]);
    expect(both.map((o) => o.kind).sort()).toEqual(["admitted", "dropped"]);
    expect(await cases(orgId)).toHaveLength(COUNTERPARTY_PER_SENDER);
  });
});

describe("the one reply", () => {
  async function counterpartyCase(name: string, checker: string) {
    await protectedBusiness(name, `biz${unique()}.example`);
    const outcome = await handleEmail(forward(checker, `"${name}" <b@x.example>`), mailEnv, new Date(), quiet);
    expect(outcome).toMatchObject({ kind: "admitted", counterparty: true });
    return (outcome as { caseId: string }).caseId;
  }

  it("admits the forwarder for its own case's reply, and refuses a notice, mail naming no case, or another case", async () => {
    const checker = `pay@customer${unique()}.example`;
    const first = await counterpartyCase(FYNBOS, checker);
    const second = await counterpartyCase(KAROO, checker);
    const other = await counterpartyCase(nameOf("Ibis Mutual"), `else@customer${unique()}.example`);
    expect(await isAllowedRecipient(db, checker, "reply", undefined, new Date(), first)).toBe(true);
    expect(await isAllowedRecipient(db, checker, "reply", undefined, new Date(), second)).toBe(true);
    expect(await isAllowedRecipient(db, checker, "reply", undefined, new Date())).toBe(false);
    expect(await isAllowedRecipient(db, checker, "reply", undefined, new Date(), other)).toBe(false);
    expect(await isAllowedRecipient(db, checker, "notice", undefined, new Date(), first)).toBe(false);
    expect(await isAllowedRecipient(db, checker, "alert", undefined, new Date(), first)).toBe(false);
  });

  it("admits a retry of the same reply after the provider failed it", async () => {
    const checker = `pay@customer${unique()}.example`;
    const caseId = await counterpartyCase(FYNBOS, checker);
    let calls = 0;
    fetchSpy.mockImplementation(async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url !== SMTP2GO_URL) throw new Error("no network in this test");
      calls += 1;
      // A definite refusal (not an uncertain 5xx, which may have been delivered and is never sent again under its key).
      if (calls === 1)
        return Response.json({ data: { error_code: "E_ApiResponseCodes.API_EXCEPTION" } }, { status: 400 });
      return Response.json({ data: { succeeded: 1, failed: 0, email_id: "email-1" } });
    });
    const deps = { db, apiKey: `api-${"k".repeat(32)}`, operator: undefined, pause: async () => {} };
    const reply = {
      sendKey: `reply:${caseId}`,
      kind: "reply" as const,
      to: checker,
      from: "IsItLegit <check@isitlegit.co.za>",
      subject: "Re: new banking details",
      text: "What we found.",
      caseId,
    };
    const first = await sendMail(deps, reply);
    expect(first.status).toBe("failed");
    const again = await sendMail(deps, reply);
    expect(again.status).toBe("sent");
    // The same address, on mail naming no case, is still refused.
    const unrelated = await sendMail(deps, { ...reply, sendKey: `other:${unique()}`, caseId: undefined });
    expect(unrelated.status).toBe("refused");
  });
});
