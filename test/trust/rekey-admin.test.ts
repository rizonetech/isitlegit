import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetAccessKeyCache } from "../../src/auth/access";
import { addAccount, bankKeys, matchBankAccount } from "../../src/trust/bank";
import { setIdentity } from "../../src/trust/identity";
import { authEnv, call } from "../auth/helpers";
import { events, protectableOrg } from "./helpers";

// The bank key replacement admin action (D05 T01 §4): behind the admin console's Access guard and same-origin
// check, `rotate` moves a registry from the previous keys to the current ones and audits each organisation it
// moved, and `recover` abandons a lost pair. Every refusal leaves accounts, the key epoch and events untouched.
const TEAM = "team.example.cloudflareaccess.com";
const AUD = "test-aud-tag";
const OPERATOR = "hostmaster@rizonetech.com";
const SIGNIN = "derick@rizonetech.com";
const db = env.DB;
beforeEach(async () => {
  await db.batch(
    [
      "bank_match_counts",
      "bank_accounts",
      "supplier_accounts",
      "bank_key_epoch",
      "trust_events",
      "identities",
      "org_domains",
      "org_addresses",
      "suppliers",
      '"organization"',
    ].map((t) => db.prepare(`DELETE FROM ${t}`)),
  );
});

const b64 = (bytes: number[]) => btoa(String.fromCharCode(...bytes));
const keyPair = (seed: number) => ({
  BANK_KEY: b64(Array.from({ length: 32 }, (_, i) => (i + seed) & 255)),
  BANK_MATCH_KEY: b64(Array.from({ length: 32 }, (_, i) => (i * 7 + seed) & 255)),
});
const OLD = keyPair(5);
const NEW = keyPair(9);
const baseEnv = {
  ...authEnv,
  CF_ACCESS_AUD: AUD,
  CF_ACCESS_TEAM_DOMAIN: TEAM,
  CF_ACCESS_EMAIL: SIGNIN,
  OPERATOR_EMAIL: OPERATOR,
  BANK_KEY: NEW.BANK_KEY,
  BANK_MATCH_KEY: NEW.BANK_MATCH_KEY,
} as unknown as Env;
const withPrevious = (previous: Record<string, string | undefined>) =>
  ({ ...baseEnv, ...previous }) as unknown as Env;
const PREVIOUS = { BANK_KEY_PREVIOUS: OLD.BANK_KEY, BANK_MATCH_KEY_PREVIOUS: OLD.BANK_MATCH_KEY };

const b64url = (bytes: Uint8Array | string) => {
  const raw = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  return btoa(String.fromCharCode(...raw))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
};
type Key = { kid: string; privateKey: CryptoKey; jwk: JsonWebKey };
async function makeKey(kid: string): Promise<Key> {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  return { kid, privateKey: pair.privateKey, jwk: { ...jwk, kid, alg: "RS256", use: "sig" } as JsonWebKey };
}
const key1 = await makeKey("kid-1");
const realFetch = globalThis.fetch;
vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  if (!url.startsWith(`https://${TEAM}/cdn-cgi/access/certs`)) return realFetch(input, init);
  return Response.json({ keys: [key1.jwk] });
});
afterEach(() => resetAccessKeyCache());

async function token() {
  const head = b64url(JSON.stringify({ alg: "RS256", kid: key1.kid, typ: "JWT" }));
  const body = b64url(
    JSON.stringify({
      aud: AUD,
      iss: `https://${TEAM}`,
      exp: Math.floor(Date.now() / 1000) + 600,
      email: SIGNIN,
    }),
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key1.privateKey, new TextEncoder().encode(`${head}.${body}`)),
  );
  return `${head}.${body}.${b64url(sig)}`;
}

const post = async (
  form: Record<string, string>,
  e: Env,
  headers: Record<string, string> = {},
) =>
  call(
    "/admin/bank-keys",
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
      body: new URLSearchParams(form).toString(),
    },
    e,
  );

const account = {
  number: "0620 0441-773",
  branchCode: "250 655",
  bankName: "Kestrel Bank (fictional)",
  holder: "Hadeda Couriers (Pty) Ltd",
};

async function business(name: string, id?: string) {
  if (id) {
    await db
      .prepare(`INSERT INTO "organization" (id, name, slug, "createdAt") VALUES (?, ?, ?, ?)`)
      .bind(id, name, `org-${id.slice(0, 8)}`, new Date().toISOString())
      .run();
    const { addAddress, addDomain } = await import("./helpers");
    await addDomain(id, `${name}.example`);
    await addAddress(id, `money@${name}.example`);
    await setIdentity(db, id, "owner", {
      displayNames: [name],
      financeContact: `money@${name}.example`,
      protected: true,
    });
    return id;
  }
  const orgId = await protectableOrg(`${name}.example`, `money@${name}.example`, name);
  await setIdentity(db, orgId, "owner", {
    displayNames: [name],
    financeContact: `money@${name}.example`,
    protected: true,
  });
  return orgId;
}

const epoch = async () =>
  (await db.prepare("SELECT key_id, match_key_id FROM bank_key_epoch WHERE id = 1").first<{ key_id: string; match_key_id: string }>()) ??
  null;
const keyIds = async () =>
  (await db.prepare("SELECT key_id FROM bank_accounts ORDER BY id").all<{ key_id: string }>()).results.map((r) => r.key_id);

describe("the bank key admin action", () => {
  it("refuses without Access and with a foreign origin, changing nothing", async () => {
    const orgId = await business("hadeda");
    const old = await bankKeys(OLD);
    await addAccount(db, old, orgId, "owner", account);
    const before = { epoch: await epoch(), keys: await keyIds(), events: await events(orgId) };

    expect((await post({ operation: "rotate" }, withPrevious(PREVIOUS))).status).toBe(403);
    const jwt = await token();
    expect(
      (
        await post({ operation: "rotate" }, withPrevious(PREVIOUS), {
          "cf-access-jwt-assertion": jwt,
          origin: "https://evil.example",
        })
      ).status,
    ).toBe(403);

    expect(await epoch()).toEqual(before.epoch);
    expect(await keyIds()).toEqual(before.keys);
    expect(await events(orgId)).toEqual(before.events);
  });

  it("refuses rotation when the previous keys are absent, half-present or malformed, changing nothing", async () => {
    const orgId = await business("hadeda");
    const old = await bankKeys(OLD);
    await addAccount(db, old, orgId, "owner", account);
    const jwt = await token();
    const headers = { "cf-access-jwt-assertion": jwt };

    expect((await post({ operation: "rotate" }, withPrevious({}), headers)).status).toBe(409);
    expect(
      (await post({ operation: "rotate" }, withPrevious({ BANK_KEY_PREVIOUS: OLD.BANK_KEY }), headers)).status,
    ).toBe(409);
    expect(
      (
        await post(
          { operation: "rotate" },
          withPrevious({ BANK_KEY_PREVIOUS: "not-base64!", BANK_MATCH_KEY_PREVIOUS: OLD.BANK_MATCH_KEY }),
          headers,
        )
      ).status,
    ).toBe(422);
    expect((await post({ operation: "sideways" }, withPrevious(PREVIOUS), headers)).status).toBe(422);

    expect(await keyIds()).toEqual([old.id]);
    expect((await events(orgId)).filter((e) => e.kind === "bank.rekeyed")).toEqual([]);
  });

  it("rotates a registry, audits each organisation once, matches under the new keys, and is a no-op the second time", async () => {
    const a = await business("hadeda");
    const b = await business("ibis");
    const old = await bankKeys(OLD);
    await addAccount(db, old, a, "owner", account);
    await addAccount(db, old, b, "owner", { ...account, number: "12345678" });
    const jwt = await token();
    const headers = { "cf-access-jwt-assertion": jwt };

    const res = await post({ operation: "rotate" }, withPrevious(PREVIOUS), headers);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ operation: "rotate", moved: 2, unreadable: 0, organisations: 2 });
    expect(JSON.stringify(body)).not.toContain("06200441773");

    const next = await bankKeys(NEW);
    for (const orgId of [a, b]) {
      const rekeyed = (await events(orgId)).filter((e) => e.kind === "bank.rekeyed");
      expect(rekeyed).toEqual([{ kind: "bank.rekeyed", actor: SIGNIN, detail: { moved: 1 } }]);
    }
    const checker = await business("checker");
    expect(
      await matchBankAccount(db, next, { orgId: checker }, a, { number: "06200441773", branchCode: "250655" }),
    ).toEqual({ match: true });

    const again = await post({ operation: "rotate" }, withPrevious(PREVIOUS), headers);
    expect(((await again.json()) as Record<string, unknown>).moved).toBe(0);
    for (const orgId of [a, b])
      expect((await events(orgId)).filter((e) => e.kind === "bank.rekeyed")).toHaveLength(1);
  });

  it("refuses recovery without its confirmation, then deletes ordinary accounts and keeps the protected ones", async () => {
    const ordinary = await business("hadeda");
    const protectedOrg = await business("fynbos", "ZF5SufztotybeXIWVncExFAVu9GYZ8Fu");
    const old = await bankKeys(OLD);
    await addAccount(db, old, ordinary, "owner", account);
    await addAccount(db, old, protectedOrg, "owner", { ...account, number: "12345678" });
    const jwt = await token();
    const headers = { "cf-access-jwt-assertion": jwt };

    expect((await post({ operation: "recover" }, withPrevious({}), headers)).status).toBe(422);
    expect(await keyIds()).toHaveLength(2);

    const res = await post({ operation: "recover", confirm: "recover" }, withPrevious({}), headers);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ operation: "recover", deleted: 1, kept: 1 });
    expect(String(body.note)).toContain("identity page");
    expect(String(body.note)).toContain("supplier ledger");
    expect(await keyIds()).toEqual([old.id]);
    expect(
      (await db.prepare("SELECT org_id FROM bank_accounts").all<{ org_id: string }>()).results,
    ).toEqual([{ org_id: protectedOrg }]);
  });
});
