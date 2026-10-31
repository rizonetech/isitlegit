// The fictional demo businesses (D07 T07 §1): Fynbos Freight, its courier and three invoice suppliers, seeded as
// organisations flagged `demo` (`organization.metadata`), with a verified domain and accounts address under
// demo.isitlegit.co.za, a protected identity, a logo and an account at the fictional Protea Bank. The identity, logo and
// account go through the functions members use (`setIdentity`, `storeLogo`, `addAccount`); the organisation, its owner
// and the verified domain and address are written directly, because no member path can make them (a demo owner has no
// mailbox to sign up from, and the demo suffix cannot be proven by a member's TXT record).
//
// Fynbos Freight is the live organisation the operator protects (src/auth/protected.ts): it is found by its fixed id,
// never created, and only what is absent is added; nothing it holds is replaced, reset or removed. Every step finds
// its work by a stable key (the organisation's slug, the owner's address, the domain, the account's number), so a rerun
// after an interruption completes what is missing and duplicates nothing.
import { isProtectedAccount, isProtectedOrganisation, PROTECTED_ORGANISATIONS } from "../auth/protected";
import { addAccount, type BankKeys, bankKeys, hmacOf } from "../trust/bank";
import { AccountRefused } from "../trust/errors";
import { getIdentity, setIdentity } from "../trust/identity";
import { storeLogo } from "../trust/logo";

export const SEED_ACTOR = "seed-demo";
export const FYNBOS_ORG_ID = PROTECTED_ORGANISATIONS[0] as string;

export type DemoBusiness = {
  slug: string;
  name: string;
  legalName: string;
  domain: string;
  accounts: string;
  accountNumber: string;
  branchCode: string;
  bankName: string;
  logoSvg: string;
  // Only Fynbos Freight has one: the live organisation's fixed id. Every other business is made.
  existingOrgId?: string;
  ownerEmail: string;
};

export type Step = "organisation" | "domain" | "address" | "identity" | "logo" | "account";
export type Outcome = "created" | "present";
export type BusinessResult = { slug: string; orgId: string; steps: Record<Step, Outcome> };

// The seed stopped on a business at a step; nothing before it is undone, and a rerun resumes there.
export class SeedFailed extends Error {
  readonly business: string;
  readonly step: Step;
  constructor(business: string, step: Step, message: string) {
    super(`${business}: ${step}: ${message}`);
    this.name = "SeedFailed";
    this.business = business;
    this.step = step;
  }
}
// A business in the data would touch a protected organisation or account.
export class ProtectedTarget extends Error {
  readonly code = "PROTECTED_TARGET";
  override name = "ProtectedTarget";
}
// A destination the seed would have to take over: refused, nothing written.
export class SeedConflict extends Error {
  override name = "SeedConflict";
}
// Fynbos Freight is not in this database: the seed never makes it.
export class FynbosMissing extends Error {
  override name = "FynbosMissing";
}

export type SeedEnv = { DB: D1Database; ARTEFACTS: R2Bucket; BANK_KEY?: string; BANK_MATCH_KEY?: string };

// Refuses the data file before anything is written: only Fynbos Freight may name the protected organisation, and no
// business may be owned by a protected account (Fynbos Freight's owner already is one, and stays as it is).
export function refuseProtected(businesses: readonly DemoBusiness[]) {
  const slugs = new Set<string>();
  for (const b of businesses) {
    if (slugs.has(b.slug)) throw new ProtectedTarget(`${b.slug} appears twice`);
    slugs.add(b.slug);
    const isFynbos = b.slug === "fynbos-freight";
    if (isProtectedOrganisation(b.existingOrgId) && !isFynbos)
      throw new ProtectedTarget(`${b.slug} names a protected organisation`);
    if (isFynbos && b.existingOrgId !== FYNBOS_ORG_ID)
      throw new ProtectedTarget("Fynbos Freight must be the protected organisation");
    if (!isFynbos && isProtectedAccount(b.ownerEmail)) throw new ProtectedTarget(`${b.slug} names a protected account`);
  }
}

const now = () => new Date();
const isDemoFlag = (metadata: string | null) => {
  try {
    return (JSON.parse(metadata ?? "{}") as { demo?: unknown }).demo === true;
  } catch {
    return false;
  }
};

async function organisationOf(db: D1Database, b: DemoBusiness): Promise<{ id: string; created: boolean }> {
  if (b.existingOrgId) {
    const row = await db
      .prepare(`SELECT id, metadata FROM "organization" WHERE id = ?`)
      .bind(b.existingOrgId)
      .first<{ id: string; metadata: string | null }>();
    if (!row) throw new FynbosMissing(`${b.name} is not in this database; the seed never makes it`);
    // Only an absent flag is added: a metadata value already set is left as found.
    if (!row.metadata)
      await db
        .prepare(`UPDATE "organization" SET metadata = ? WHERE id = ? AND metadata IS NULL`)
        .bind(JSON.stringify({ demo: true }), row.id)
        .run();
    return { id: row.id, created: false };
  }
  const slug = `demo-${b.slug}`;
  const found = await db
    .prepare(`SELECT id, metadata FROM "organization" WHERE slug = ?`)
    .bind(slug)
    .first<{ id: string; metadata: string | null }>();
  // An occupied slug is ours only when it is flagged demo and is not a protected organisation: anything else (an
  // organisation made through the ordinary member path under the same slug) is a conflict, refused before any write.
  if (found && isProtectedOrganisation(found.id))
    throw new ProtectedTarget(`${slug} resolves to a protected organisation`);
  if (found && !isDemoFlag(found.metadata))
    throw new SeedConflict(`${slug} is taken by an organisation that is not a demo one`);
  const at = now().toISOString();
  let userId = (
    await db
      .prepare(`SELECT id FROM "user" WHERE lower(email) = ?`)
      .bind(b.ownerEmail.toLowerCase())
      .first<{ id: string }>()
  )?.id;
  const statements: D1PreparedStatement[] = [];
  if (!userId) {
    userId = crypto.randomUUID();
    statements.push(
      db
        .prepare(
          `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") VALUES (?, ?, ?, 1, ?, ?)`,
        )
        .bind(userId, b.legalName, b.ownerEmail.toLowerCase(), at, at),
    );
  }
  const orgId = found?.id ?? crypto.randomUUID();
  if (!found)
    statements.push(
      db
        .prepare(`INSERT INTO "organization" (id, name, slug, "createdAt", metadata) VALUES (?, ?, ?, ?, ?)`)
        .bind(orgId, b.name, slug, at, JSON.stringify({ demo: true })),
    );
  statements.push(
    db
      .prepare(
        `INSERT INTO member (id, "organizationId", "userId", role, "createdAt") VALUES (?, ?, ?, 'owner', ?)
         ON CONFLICT ("organizationId", "userId") DO NOTHING`,
      )
      .bind(crypto.randomUUID(), orgId, userId, at),
  );
  await db.batch(statements);
  return { id: orgId, created: !found };
}

async function domainOf(db: D1Database, orgId: string, domain: string): Promise<Outcome> {
  const row = await db
    .prepare(`SELECT state FROM org_domains WHERE org_id = ? AND domain = ?`)
    .bind(orgId, domain)
    .first<{ state: string }>();
  const at = now().toISOString();
  if (row?.state === "verified") return "present";
  if (row)
    await db
      .prepare(
        `UPDATE org_domains SET state = 'verified', method = 'dns', verified_at = ? WHERE org_id = ? AND domain = ?`,
      )
      .bind(at, orgId, domain)
      .run();
  else
    await db
      .prepare(
        `INSERT INTO org_domains (id, org_id, domain, token, state, method, verified_at, created_at)
         VALUES (?, ?, ?, ?, 'verified', 'dns', ?, ?)`,
      )
      .bind(crypto.randomUUID(), orgId, domain, "demo-seed-".padEnd(32, "0"), at, at)
      .run();
  return "created";
}

async function addressOf(db: D1Database, orgId: string, address: string): Promise<Outcome> {
  const row = await db
    .prepare(`SELECT state FROM org_addresses WHERE org_id = ? AND address = ?`)
    .bind(orgId, address)
    .first<{ state: string }>();
  const at = now().toISOString();
  if (row?.state === "verified") return "present";
  if (row)
    await db
      .prepare(`UPDATE org_addresses SET state = 'verified', verified_at = ? WHERE org_id = ? AND address = ?`)
      .bind(at, orgId, address)
      .run();
  else
    await db
      .prepare(
        `INSERT INTO org_addresses (id, org_id, address, state, verified_at, created_at) VALUES (?, ?, ?, 'verified', ?, ?)`,
      )
      .bind(crypto.randomUUID(), orgId, address, at, at)
      .run();
  return "created";
}

async function step<T>(b: DemoBusiness, name: Step, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof ProtectedTarget || error instanceof FynbosMissing || error instanceof SeedConflict)
      throw error;
    throw new SeedFailed(b.slug, name, error instanceof Error ? error.message : String(error));
  }
}

export async function seedBusiness(env: SeedEnv, keys: BankKeys, b: DemoBusiness): Promise<BusinessResult> {
  const { DB: db } = env;
  const org = await step(b, "organisation", () => organisationOf(db, b));
  const steps = {} as Record<Step, Outcome>;
  steps.organisation = org.created ? "created" : "present";
  steps.domain = await step(b, "domain", () => domainOf(db, org.id, b.domain));
  steps.address = await step(b, "address", () => addressOf(db, org.id, b.accounts));
  steps.identity = await step(b, "identity", async () => {
    // An identity already set is left exactly as found, whatever it says (the operator's own, for Fynbos Freight).
    if (await getIdentity(db, org.id)) return "present" as const;
    await setIdentity(db, org.id, SEED_ACTOR, {
      displayNames: [...new Set([b.name, b.legalName])],
      financeContact: b.accounts,
      protected: true,
    });
    return "created" as const;
  });
  steps.logo = await step(b, "logo", async () => {
    const identity = await getIdentity(db, org.id);
    if (identity?.logo) return "present" as const;
    await storeLogo(env.ARTEFACTS, db, org.id, SEED_ACTOR, new TextEncoder().encode(b.logoSvg), "image/svg+xml");
    return "created" as const;
  });
  steps.account = await step(b, "account", async () => {
    try {
      await addAccount(db, keys, org.id, SEED_ACTOR, {
        number: b.accountNumber,
        branchCode: b.branchCode,
        bankName: b.bankName,
        holder: b.legalName,
      });
      return "created" as const;
    } catch (error) {
      // The same account already registered is a rerun; any other refusal is a failure.
      if (error instanceof AccountRefused && /already registered/.test(error.message)) return "present" as const;
      throw error;
    }
  });
  return { slug: b.slug, orgId: org.id, steps };
}

export async function seedDemo(
  env: SeedEnv,
  businesses: readonly DemoBusiness[],
  onProgress: (result: BusinessResult) => void = () => {},
): Promise<BusinessResult[]> {
  refuseProtected(businesses);
  const keys = await bankKeys(env);
  const results: BusinessResult[] = [];
  // Fynbos Freight first: when it is missing nothing else is written.
  const ordered = [...businesses].sort((a, b) => Number(!!b.existingOrgId) - Number(!!a.existingOrgId));
  if (ordered[0]?.existingOrgId) {
    const there = await env.DB.prepare(`SELECT 1 AS n FROM "organization" WHERE id = ?`)
      .bind(ordered[0].existingOrgId)
      .first();
    if (!there) throw new FynbosMissing(`${ordered[0].name} is not in this database; the seed never makes it`);
  }
  for (const b of ordered) {
    const result = await seedBusiness(env, keys, b);
    results.push(result);
    onProgress(result);
  }
  return results;
}

export type BusinessCheck = {
  slug: string;
  orgId: string | null;
  protected: boolean;
  problems: string[];
};

// Read-only: every part from the persisted records, and what is missing or in conflict. Writes nothing.
export async function checkDemo(env: SeedEnv, businesses: readonly DemoBusiness[]): Promise<BusinessCheck[]> {
  refuseProtected(businesses);
  const { DB: db } = env;
  const out: BusinessCheck[] = [];
  for (const b of businesses) {
    const problems: string[] = [];
    const org = b.existingOrgId
      ? await db
          .prepare(`SELECT id, metadata FROM "organization" WHERE id = ?`)
          .bind(b.existingOrgId)
          .first<{ id: string; metadata: string | null }>()
      : await db
          .prepare(`SELECT id, metadata FROM "organization" WHERE slug = ?`)
          .bind(`demo-${b.slug}`)
          .first<{ id: string; metadata: string | null }>();
    if (!org) {
      out.push({ slug: b.slug, orgId: null, protected: false, problems: ["the organisation is missing"] });
      continue;
    }
    const flag = isDemoFlag(org.metadata);
    if (!flag) problems.push("the organisation is not flagged demo");
    const owner = await db
      .prepare(
        `SELECT 1 AS n FROM member m JOIN "user" u ON u.id = m."userId"
         WHERE m."organizationId" = ? AND m.role = 'owner' AND lower(u.email) = ?`,
      )
      .bind(org.id, b.ownerEmail.toLowerCase())
      .first();
    if (!owner) problems.push(`${b.ownerEmail} is not the owner of the organisation`);
    const domain = await db
      .prepare(`SELECT state FROM org_domains WHERE org_id = ? AND domain = ?`)
      .bind(org.id, b.domain)
      .first<{ state: string }>();
    if (domain?.state !== "verified") problems.push(`the domain ${b.domain} is not verified`);
    const address = await db
      .prepare(`SELECT state FROM org_addresses WHERE org_id = ? AND address = ?`)
      .bind(org.id, b.accounts)
      .first<{ state: string }>();
    if (address?.state !== "verified") problems.push(`the address ${b.accounts} is not verified`);
    const identity = await getIdentity(db, org.id);
    if (!identity) problems.push("the identity is missing");
    else {
      if (!identity.protected) problems.push("the identity is not protected (left as found; the operator decides)");
      if (!identity.displayNames.includes(b.name))
        problems.push(`the identity's names do not include ${b.name} (left as found; the operator decides)`);
      if (identity.financeContact?.toLowerCase() !== b.accounts)
        problems.push("the finance contact is not the accounts address");
      if (!identity.logo) problems.push("the logo is missing");
      else if (!(await env.ARTEFACTS.head(identity.logo.key))) problems.push("the logo object is missing from storage");
    }
    const keys = await bankKeys(env);
    const acct = await db
      .prepare(`SELECT branch_code, key_id, match_key_id FROM bank_accounts WHERE org_id = ? AND number_hmac = ?`)
      .bind(org.id, await hmacOf(keys, b.accountNumber))
      .first<{ branch_code: string; key_id: string; match_key_id: string }>();
    if (!acct) problems.push("the Protea Bank account is not registered under the current keys");
    else {
      if (acct.branch_code !== b.branchCode)
        problems.push(`the account is on branch ${acct.branch_code}, not ${b.branchCode}`);
      if (acct.key_id !== keys.id || acct.match_key_id !== keys.matchId)
        problems.push("the account is sealed under other keys than the ones given");
    }
    out.push({ slug: b.slug, orgId: org.id, protected: identity?.protected === true, problems });
  }
  return out;
}
