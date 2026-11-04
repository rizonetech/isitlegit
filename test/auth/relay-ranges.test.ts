import { afterEach, describe, expect, it } from "vitest";
import { canonicalRelayRanges } from "../../src/auth/relay-ranges";

describe("configured relay ranges", () => {
  it("canonicalizes and deduplicates public networks without widening host bits", () => {
    expect(canonicalRelayRanges(["8.8.8.0/24", "2606:4700:0000::/32", "8.8.8.0/24"])).toEqual([
      "8.8.8.0/24",
      "2606:4700::/32",
    ]);
  });
  it.each([
    "8.8.8.1/24",
    "0.0.0.0/0",
    "8.0.0.0/6",
    "192.0.2.0/24",
    "198.51.100.0/24",
    "203.0.113.0/24",
    "10.0.0.0/8",
    "100.64.0.0/10",
    "224.0.0.0/4",
    "240.0.0.0/4",
    "2001:db8::/32",
    "3fff::/20",
    "::/0",
    "fc00::/7",
    "::ffff:8.8.8.8/128",
    "8.8.8.8",
    "008.8.8.0/24",
    "https://relay.example/24",
  ])("refuses invalid or reserved network %s", (range) => {
    expect(canonicalRelayRanges([range])).toBeNull();
  });
  it("bounds input before deduplication and rejects empty proposals", () => {
    expect(canonicalRelayRanges(Array(65).fill("8.8.8.0/24"))).toBeNull();
    expect(canonicalRelayRanges([])).toBeNull();
  });
});

import { env } from "cloudflare:test";
import {
  discoverRelayBindings,
  mutateRelayBinding,
  pendingRelayBindings,
  type RelayBinding,
  type RelayDeps,
  type RelayPrincipal,
  readRelayBinding,
  relayBindingHistory,
} from "../../src/auth/relay-ranges";

const db = (env as unknown as Env).DB;
const created: { orgId: string; userId: string }[] = [];
afterEach(async () => {
  for (const item of created.splice(0))
    await db.batch([
      db.prepare("DELETE FROM org_domains WHERE org_id=?").bind(item.orgId),
      db.prepare("DELETE FROM organization WHERE id=?").bind(item.orgId),
      db.prepare("DELETE FROM user WHERE id=?").bind(item.userId),
    ]);
});
const NOW = Date.parse("2026-11-04T10:00:00Z");
async function fixture() {
  const orgId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const claimId = crypto.randomUUID();
  created.push({ orgId, userId });
  await db.batch([
    db
      .prepare("INSERT INTO organization(id,name,slug,createdAt) VALUES (?,?,?,?)")
      .bind(orgId, "Juniper Workshop", orgId, NOW),
    db
      .prepare("INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,?,?,?,?,?)")
      .bind(userId, "Fictional Admin", `${userId}@juniper.example`, 1, NOW, NOW),
    db
      .prepare("INSERT INTO member(id,organizationId,userId,role,createdAt) VALUES (?,?,?,?,?)")
      .bind(crypto.randomUUID(), orgId, userId, "owner", NOW),
    db
      .prepare(
        "INSERT INTO org_domains(id,org_id,domain,token,state,method,verified_at,created_at) VALUES (?,?,?,?,'verified','dns',?,?)",
      )
      .bind(
        claimId,
        orgId,
        `${orgId}.example`,
        "t".repeat(32),
        new Date(NOW).toISOString(),
        new Date(NOW).toISOString(),
      ),
  ]);
  const binding: RelayBinding = { orgId, claimId, gateway: "*.mailshield.example", provider: "microsoft" };
  const actor: RelayPrincipal = { kind: "member", userId, orgId };
  const reviewer: RelayPrincipal = { kind: "reviewer", accessEmail: "reviewer@platform.example" };
  const deps: RelayDeps = {
    db,
    now: () => NOW,
    resolve: async (_name, type) =>
      type === "MX" ? ["ingress.mailshield.example"] : type === "TXT" ? ["MS=ms1234567"] : [],
  };
  const propose = (expectedVersion = 0, requestKey = crypto.randomUUID(), cidrs = ["8.8.8.0/24"]) =>
    mutateRelayBinding(deps, actor, { ...binding, action: "propose", expectedVersion, requestKey, cidrs });
  const approve = (expectedVersion = 1, revision = 1, requestKey = crypto.randomUUID()) =>
    mutateRelayBinding(deps, reviewer, {
      ...binding,
      action: "approve",
      expectedVersion,
      revision,
      requestKey,
      source: {
        url: "https://mailshield.example/official-egress",
        digest: "a".repeat(64),
        retrievedAt: new Date(NOW - 1000).toISOString(),
      },
    });
  const rows = async (table: string) =>
    (await db.prepare(`SELECT * FROM ${table} WHERE org_id=?`).bind(orgId).all()).results;
  const cache = () =>
    db
      .prepare(
        "INSERT INTO org_receiving_chains(claim_id,org_id,gateway,provider,status,reason,rules,rules_at,learned_at) VALUES (?,?,?,?,'proven',NULL,'[]',?,?)",
      )
      .bind(claimId, orgId, binding.gateway, binding.provider, new Date(NOW).toISOString(), new Date(NOW).toISOString())
      .run();
  return { binding, actor, reviewer, deps, propose, approve, rows, cache };
}
const success = (result: Awaited<ReturnType<typeof mutateRelayBinding>>) => {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(`expected success, got ${result.kind}`);
  return result.value;
};
function batchIntercept(work: () => Promise<void>, failAfter = false): D1Database {
  return {
    prepare: db.prepare.bind(db),
    batch: async (statements: D1PreparedStatement[]) => {
      await work();
      return db.batch(
        failAfter ? [...statements, db.prepare("SELECT * FROM deliberately_missing_relay_table")] : statements,
      );
    },
  } as D1Database;
}

describe("relay lifecycle D1 persistence", () => {
  it("round-trips pending, exact approval, edit retirement, revoke and explicit automatic restoration", async () => {
    const f = await fixture();
    await f.cache();
    expect(success(await f.propose()).state).toBe("pending");
    expect(await f.rows("org_receiving_chains")).toHaveLength(0);
    const verified = success(await f.approve());
    expect(verified).toMatchObject({ state: "verified", version: 2, revision: 1, source: { digest: "a".repeat(64) } });
    expect(success(await readRelayBinding(f.deps, f.actor, f.binding))).toEqual(verified);
    await f.cache();
    expect(success(await f.propose(2)).state).toBe("pending");
    expect(await f.rows("org_receiving_chains")).toHaveLength(0);
    expect((await f.rows("relay_range_revisions")).map((r) => r.revision)).toEqual([1, 3]);
    const revoke = { ...f.binding, action: "revoke", expectedVersion: 3, requestKey: crypto.randomUUID() };
    expect(success(await mutateRelayBinding(f.deps, f.actor, revoke)).state).toBe("revoked");
    expect(await mutateRelayBinding(f.deps, f.actor, revoke)).toMatchObject({
      ok: true,
      replayed: true,
      value: { version: 4 },
    });
    await f.cache();
    const restored = success(
      await mutateRelayBinding(f.deps, f.actor, {
        ...f.binding,
        action: "restore",
        expectedVersion: 4,
        requestKey: crypto.randomUUID(),
      }),
    );
    expect(restored).toMatchObject({ state: "automatic", revision: null, cidrs: [], version: 5 });
    expect(await f.rows("org_receiving_chains")).toHaveLength(0);
    expect(await f.rows("relay_range_actions")).toHaveLength(5);
  });
  it("retains original idempotent outcome after later edits without overwriting current state", async () => {
    const f = await fixture();
    const key = crypto.randomUUID();
    const first = await f.propose(0, key);
    await f.approve();
    await f.propose(2);
    expect(await f.propose(0, key)).toEqual({ ...first, replayed: true });
    expect(success(await readRelayBinding(f.deps, f.actor, f.binding))).toMatchObject({ version: 3, state: "pending" });
    expect(await f.propose(0, key, ["1.1.1.0/24"])).toEqual({ ok: false, kind: "conflict" });
    expect(await f.rows("relay_range_actions")).toHaveLength(3);
  });
  it("admits only one concurrent proposal or exact review and gives stale callers conflict", async () => {
    const f = await fixture();
    const proposals = await Promise.all([f.propose(), f.propose()]);
    expect(proposals.filter((r) => r.ok)).toHaveLength(1);
    expect(proposals.filter((r) => !r.ok)).toEqual([{ ok: false, kind: "conflict" }]);
    const reviews = await Promise.all([f.approve(), f.approve()]);
    expect(reviews.filter((r) => r.ok)).toHaveLength(1);
    expect(reviews.filter((r) => !r.ok)).toEqual([{ ok: false, kind: "conflict" }]);
    expect(await f.rows("relay_range_actions")).toHaveLength(2);
    expect(await f.propose()).toEqual({ ok: false, kind: "conflict" });
  });
  it("rejects spoofed client flags, member approval and reviewer membership in any target-tenant role", async () => {
    const f = await fixture();
    await f.propose();
    const action = {
      ...f.binding,
      action: "approve",
      expectedVersion: 1,
      revision: 1,
      requestKey: crypto.randomUUID(),
      source: {
        url: "https://mailshield.example/official",
        digest: "b".repeat(64),
        retrievedAt: new Date(NOW).toISOString(),
      },
    };
    expect(await mutateRelayBinding(f.deps, f.actor, action)).toEqual({ ok: false, kind: "forbidden" });
    expect(
      await mutateRelayBinding(f.deps, f.actor, {
        ...f.binding,
        action: "propose",
        expectedVersion: 1,
        requestKey: crypto.randomUUID(),
        cidrs: ["8.8.8.0/24"],
        verified: true,
      }),
    ).toEqual({ ok: false, kind: "invalid" });
    await db
      .prepare("UPDATE user SET email=? WHERE id=?")
      .bind("reviewer@platform.example", f.actor.kind === "member" ? f.actor.userId : "")
      .run();
    await db.prepare("UPDATE member SET role='member' WHERE organizationId=?").bind(f.binding.orgId).run();
    expect(await f.approve()).toEqual({ ok: false, kind: "forbidden" });
    expect(await f.rows("relay_range_actions")).toHaveLength(1);
  });
  it("refuses foreign tenant, nonadmin, unverified or closed tenant reads and writes", async () => {
    const f = await fixture();
    const other = await fixture();
    expect(await readRelayBinding(f.deps, other.actor, f.binding)).toEqual({ ok: false, kind: "forbidden" });
    await db.prepare("UPDATE member SET role='member' WHERE organizationId=?").bind(f.binding.orgId).run();
    expect(await f.propose()).toEqual({ ok: false, kind: "forbidden" });
    await db.prepare("UPDATE member SET role='owner' WHERE organizationId=?").bind(f.binding.orgId).run();
    await db.prepare("UPDATE org_domains SET state='pending' WHERE id=?").bind(f.binding.claimId).run();
    expect(await f.propose()).toEqual({ ok: false, kind: "forbidden" });
    await db.prepare("UPDATE org_domains SET state='verified' WHERE id=?").bind(f.binding.claimId).run();
    await db.prepare("UPDATE organization SET closedAt=? WHERE id=?").bind(NOW, f.binding.orgId).run();
    expect(await f.propose()).toEqual({ ok: false, kind: "forbidden" });
    expect(await readRelayBinding(f.deps, f.actor, f.binding)).toEqual({ ok: false, kind: "forbidden" });
    expect(await f.rows("relay_range_actions")).toHaveLength(0);
  });
  it.each(["removed", "unverified", "closed", "membership"])(
    "refuses late approval or proposal after %s before the transaction",
    async (condition) => {
      const f = await fixture();
      await f.propose();
      const deps = {
        ...f.deps,
        db: batchIntercept(async () => {
          if (condition === "removed")
            await db.prepare("DELETE FROM org_domains WHERE id=?").bind(f.binding.claimId).run();
          else if (condition === "unverified")
            await db.prepare("UPDATE org_domains SET state='pending' WHERE id=?").bind(f.binding.claimId).run();
          else if (condition === "closed")
            await db.prepare("UPDATE organization SET closedAt=? WHERE id=?").bind(NOW, f.binding.orgId).run();
          else await db.prepare("DELETE FROM member WHERE organizationId=?").bind(f.binding.orgId).run();
        }),
      };
      const action =
        condition === "membership"
          ? {
              ...f.binding,
              action: "propose",
              expectedVersion: 1,
              requestKey: crypto.randomUUID(),
              cidrs: ["1.1.1.0/24"],
            }
          : {
              ...f.binding,
              action: "approve",
              expectedVersion: 1,
              revision: 1,
              requestKey: crypto.randomUUID(),
              source: {
                url: "https://mailshield.example/official",
                digest: "c".repeat(64),
                retrievedAt: new Date(NOW).toISOString(),
              },
            };
      expect(await mutateRelayBinding(deps, condition === "membership" ? f.actor : f.reviewer, action)).toEqual({
        ok: false,
        kind: "forbidden",
      });
      expect(await f.rows("relay_range_actions")).toHaveLength(condition === "removed" ? 0 : 1);
      expect(await f.rows("relay_range_revisions")).toHaveLength(condition === "removed" ? 0 : 1);
    },
  );
  it("rolls back proposal, current pointer, audit and cache invalidation together on DB failure", async () => {
    const f = await fixture();
    await f.cache();
    const result = await mutateRelayBinding({ ...f.deps, db: batchIntercept(async () => {}, true) }, f.actor, {
      ...f.binding,
      action: "propose",
      expectedVersion: 0,
      requestKey: crypto.randomUUID(),
      cidrs: ["8.8.8.0/24"],
    });
    expect(result).toEqual({ ok: false, kind: "unavailable" });
    expect(await f.rows("relay_range_actions")).toHaveLength(0);
    expect(await f.rows("relay_range_revisions")).toHaveLength(0);
    expect(await f.rows("relay_range_heads")).toHaveLength(0);
    expect(await f.rows("org_receiving_chains")).toHaveLength(1);
  });
  it("rejects stale reviewer after edit at the actual batch boundary", async () => {
    const f = await fixture();
    await f.propose();
    const result = await mutateRelayBinding(
      {
        ...f.deps,
        db: batchIntercept(async () => {
          success(await f.propose(1));
        }),
      },
      f.reviewer,
      {
        ...f.binding,
        action: "approve",
        expectedVersion: 1,
        revision: 1,
        requestKey: crypto.randomUUID(),
        source: {
          url: "https://mailshield.example/official",
          digest: "d".repeat(64),
          retrievedAt: new Date(NOW).toISOString(),
        },
      },
    );
    expect(result).toEqual({ ok: false, kind: "conflict" });
    expect(success(await readRelayBinding(f.deps, f.actor, f.binding))).toMatchObject({
      version: 2,
      revision: 2,
      state: "pending",
    });
    expect(await f.rows("relay_range_actions")).toHaveLength(2);
  });
  it("does not treat stale discovery cache, changed gateway/provider or DNS failure as current binding", async () => {
    const f = await fixture();
    await f.cache();
    const action = {
      ...f.binding,
      action: "propose",
      expectedVersion: 0,
      requestKey: crypto.randomUUID(),
      cidrs: ["8.8.8.0/24"],
    };
    expect(await mutateRelayBinding({ ...f.deps, resolve: async () => [] }, f.actor, action)).toEqual({
      ok: false,
      kind: "conflict",
    });
    expect(
      await mutateRelayBinding(
        { ...f.deps, resolve: async (_n, t) => (t === "MX" ? ["ingress.mailshield.example"] : []) },
        f.actor,
        action,
      ),
    ).toEqual({ ok: false, kind: "conflict" });
    expect(await mutateRelayBinding({ ...f.deps, resolve: async () => null }, f.actor, action)).toEqual({
      ok: false,
      kind: "unavailable",
    });
    expect(await f.rows("relay_range_actions")).toHaveLength(0);
  });
  it("permits safe revoke/restore during DNS failure and rejects missing approval source or wrong revision", async () => {
    const f = await fixture();
    await f.propose();
    expect(await f.approve(1, 9)).toEqual({ ok: false, kind: "conflict" });
    expect(
      await mutateRelayBinding(f.deps, f.reviewer, {
        ...f.binding,
        action: "approve",
        expectedVersion: 1,
        revision: 1,
        requestKey: crypto.randomUUID(),
      }),
    ).toEqual({ ok: false, kind: "invalid" });
    const rejected = await mutateRelayBinding(f.deps, f.reviewer, {
      ...f.binding,
      action: "reject",
      expectedVersion: 1,
      revision: 1,
      requestKey: crypto.randomUUID(),
      reason: "range-mismatch",
    });
    expect(success(rejected).state).toBe("rejected");
    const offline = { ...f.deps, resolve: async () => null };
    expect(
      success(
        await mutateRelayBinding(offline, f.actor, {
          ...f.binding,
          action: "revoke",
          expectedVersion: 2,
          requestKey: crypto.randomUUID(),
        }),
      ).state,
    ).toBe("revoked");
    expect(
      success(
        await mutateRelayBinding(offline, f.actor, {
          ...f.binding,
          action: "restore",
          expectedVersion: 3,
          requestKey: crypto.randomUUID(),
        }),
      ).state,
    ).toBe("automatic");
  });
});

describe("relay console service reads", () => {
  it("compares source retrieval times as instants, including an exact second without fractional digits", async () => {
    const f = await fixture();
    await f.propose();
    const result = await mutateRelayBinding(f.deps, f.reviewer, {
      ...f.binding,
      action: "approve",
      expectedVersion: 1,
      revision: 1,
      requestKey: crypto.randomUUID(),
      source: {
        url: "https://mailshield.example/official",
        digest: "e".repeat(64),
        retrievedAt: "2026-11-04T10:00:00Z",
      },
    });
    expect(success(result).state).toBe("verified");
  });
  it("reads exact immutable audit outcomes with tenant authorization and bounded pagination", async () => {
    const f = await fixture();
    await f.propose();
    await f.approve();
    await f.propose(2);
    const first = await relayBindingHistory(f.deps, f.actor, { ...f.binding, limit: 2 });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("audit failed");
    expect(first.value.items.map((s) => [s.version, s.state])).toEqual([
      [1, "pending"],
      [2, "verified"],
    ]);
    const last = await relayBindingHistory(f.deps, f.actor, { ...f.binding, after: first.value.nextCursor });
    expect(last.ok).toBe(true);
    if (!last.ok) throw new Error("audit failed");
    expect(last.value.items.map((s) => [s.version, s.state])).toEqual([[3, "pending"]]);
    const foreign = await fixture();
    expect(await relayBindingHistory(f.deps, foreign.actor, f.binding)).toEqual({ ok: false, kind: "forbidden" });
    expect(await relayBindingHistory(f.deps, f.actor, { ...f.binding, limit: 51 })).toEqual({
      ok: false,
      kind: "invalid",
    });
  });
  it("discovers only verified owned gateway/provider choices, with explicit failures", async () => {
    const f = await fixture();
    const query = { orgId: f.binding.orgId, claimId: f.binding.claimId };
    expect(await discoverRelayBindings(f.deps, f.actor, query)).toEqual({ ok: true, value: [f.binding] });
    expect(await discoverRelayBindings({ ...f.deps, resolve: async () => null }, f.actor, query)).toEqual({
      ok: false,
      kind: "unavailable",
    });
    const other = await fixture();
    expect(await discoverRelayBindings(f.deps, other.actor, query)).toEqual({ ok: false, kind: "forbidden" });
    expect(await discoverRelayBindings({ ...f.deps, resolve: async () => [] }, f.actor, query)).toEqual({
      ok: true,
      value: [],
    });
  });
  it("paginates pending revisions and excludes tenant reviewers, removed claims and closed tenants", async () => {
    const first = await fixture();
    const second = await fixture();
    const third = await fixture();
    await first.propose();
    await second.propose();
    await third.propose();
    const page = await pendingRelayBindings(first.deps, first.reviewer, { limit: 2 });
    expect(page.ok).toBe(true);
    if (!page.ok) throw new Error("queue failed");
    expect(page.value.items).toHaveLength(2);
    expect(page.value.nextCursor).not.toBeNull();
    const last = await pendingRelayBindings(first.deps, first.reviewer, { after: page.value.nextCursor, limit: 2 });
    expect(last.ok).toBe(true);
    if (!last.ok) throw new Error("queue failed");
    expect(last.value.items).toHaveLength(1);
    expect(last.value.nextCursor).toBeNull();
    expect(new Set([...page.value.items, ...last.value.items].map((i) => i.orgId)).size).toBe(3);
    expect(await pendingRelayBindings(first.deps, first.actor, {})).toEqual({ ok: false, kind: "forbidden" });
    expect(await pendingRelayBindings(first.deps, first.reviewer, { limit: 51 })).toEqual({
      ok: false,
      kind: "invalid",
    });
    await db
      .prepare("UPDATE user SET email='reviewer@platform.example' WHERE id=?")
      .bind(first.actor.kind === "member" ? first.actor.userId : "")
      .run();
    await db.prepare("UPDATE organization SET closedAt=? WHERE id=?").bind(NOW, second.binding.orgId).run();
    await db.prepare("DELETE FROM org_domains WHERE id=?").bind(third.binding.claimId).run();
    expect(await pendingRelayBindings(first.deps, first.reviewer, {})).toEqual({
      ok: true,
      value: { items: [], nextCursor: null },
    });
  });
  it("reports storage failure instead of empty state, and never auto-verifies supplied source data", async () => {
    const f = await fixture();
    const broken = {
      ...f.deps,
      db: {
        prepare: () => {
          throw new Error("simulated storage outage");
        },
      } as unknown as D1Database,
    };
    expect(await readRelayBinding(broken, f.actor, f.binding)).toEqual({ ok: false, kind: "unavailable" });
    expect(await pendingRelayBindings(broken, f.reviewer, {})).toEqual({ ok: false, kind: "unavailable" });
    expect(
      await discoverRelayBindings(broken, f.actor, { orgId: f.binding.orgId, claimId: f.binding.claimId }),
    ).toEqual({ ok: false, kind: "unavailable" });
    const proposed = success(await f.propose());
    expect(proposed.source).toBeNull();
    expect(proposed.state).toBe("pending");
    expect(
      await mutateRelayBinding(f.deps, f.reviewer, {
        ...f.binding,
        action: "approve",
        expectedVersion: 1,
        revision: 1,
        requestKey: crypto.randomUUID(),
        source: {
          url: "https://mailshield.example/official",
          digest: "a".repeat(64),
          retrievedAt: new Date(NOW + 1000).toISOString(),
        },
      }),
    ).toEqual({ ok: false, kind: "invalid" });
  });
});
