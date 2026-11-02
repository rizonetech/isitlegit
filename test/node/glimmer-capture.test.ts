import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  type ArtefactRow,
  type CaptureSource,
  type CaseDetail,
  type CaseRow,
  captureAll,
  captureCase,
  cleanerFor,
  cleanJson,
  discoverPeople,
  layoutOf,
  type Manifest,
  policyFor,
  recipientOf,
  resolveRoot,
  scrubRecipient,
  sweepInterrupted,
  takeLock,
  verifyRevision,
  verifyStore,
  writeAtomic,
} from "../../scripts/glimmer/capture-cases.ts";
import { d1Rows, openWranglerSource, QUERY } from "../../scripts/glimmer/capture-source.ts";
import { openStore } from "../../scripts/glimmer/store.ts";

// D03 T04 §41: day-zero case capture. Synthetic data only; nothing here reads production or the real store.
const sha = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
const scratch = mkdtempSync(join(tmpdir(), "capture-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let n = 0;
const fresh = () => join(scratch, `store-${n++}`);

const RAW = [
  "From: Pay Support <billing@paypa1-secure.example>",
  "To: Thandi van der Merwe <thandi.vdmerwe@acme.example>",
  "Delivered-To: thandi.vdmerwe@acme.example",
  "Subject: Dear Thandi, verify your account",
  "Authentication-Results: mx.example; spf=fail smtp.mailfrom=paypa1-secure.example; dkim=none; dmarc=fail",
  "MIME-Version: 1.0",
  'Content-Type: text/html; charset="utf-8"',
  "",
  '<p>Dear Thandi, confirm at <a href="https://evil.example/login?u=thandi.vdmerwe%40acme.example">here</a>. ' +
    "Call 082 555 0142. Reply to billing@paypa1-secure.example</p>",
].join("\r\n");

type Spec = { row?: Partial<CaseRow>; detail?: Partial<CaseDetail>; objects?: Record<string, Uint8Array | null> };

function row(extra: Partial<CaseRow> = {}): CaseRow {
  return {
    id: "case1",
    org_id: "org1",
    channel: "email",
    source_kind: "mail",
    status: "done",
    verdict: "malicious",
    run_id: null,
    forwarded_by: "thandi.vdmerwe@acme.example",
    uploaded_by: null,
    original_subject: "Dear Thandi, verify",
    original_from_name: null,
    original_from_address: "billing@paypa1-secure.example",
    upload_name: null,
    upload_media_type: null,
    message_id: null,
    created_at: "2026-10-01T00:00:00Z",
    updated_at: "2026-10-01T00:01:00Z",
    ...extra,
  };
}

function artefacts(): ArtefactRow[] {
  return [
    { r2_key: "case1/raw.eml", kind: "raw", sha256: sha(RAW), media_type: "message/rfc822", bytes: RAW.length },
    { r2_key: "case1/render.jpg", kind: "render", sha256: sha("jpegbytes"), media_type: "image/jpeg", bytes: 9 },
  ];
}

function detail(extra: Partial<CaseDetail> = {}): CaseDetail {
  return {
    artefacts: artefacts(),
    evidence: [
      {
        id: "E1",
        run_id: "case1",
        seq: 1,
        check_name: "sender",
        severity: "high",
        summary: "Sent to Thandi from a look-alike",
        detail_json: JSON.stringify({ spf: "fail", digest: sha("x"), to: "thandi.vdmerwe@acme.example" }),
        artefact_keys_json: "[]",
        created_at: "2026-10-01T00:00:30Z",
      },
    ],
    checks: [{ check_name: "sender", run_id: "case1", seq: 1, outcome: "ran", reason: null, findings: 1 }],
    feedback: [],
    verdict: null,
    members: [{ name: "Thandi van der Merwe", email: "thandi.vdmerwe@acme.example" }],
    ...extra,
  };
}

function source(
  rows: CaseRow[],
  details: Map<string, CaseDetail>,
  objects: Map<string, Uint8Array | null>,
): CaptureSource & { calls: number } {
  const s = {
    calls: 0,
    async cases(after: string | null, limit: number) {
      return rows.filter((r) => after === null || r.id > after).slice(0, limit);
    },
    async row(id: string) {
      return rows.find((r) => r.id === id) ?? null;
    },
    async detail(r: CaseRow) {
      return details.get(r.id) as CaseDetail;
    },
    async object(key: string) {
      s.calls++;
      return objects.get(key) ?? null;
    },
  };
  return s;
}

function one(spec: Spec = {}) {
  const r = row(spec.row);
  const d = detail(spec.detail);
  const objects = new Map<string, Uint8Array | null>([
    ["case1/raw.eml", new TextEncoder().encode(RAW)],
    ["case1/render.jpg", new TextEncoder().encode("jpegbytes")],
    ...Object.entries(spec.objects ?? {}),
  ]);
  return { r, d, objects, src: source([r], new Map([[r.id, d]]), objects) };
}

const allText = (dir: string): string => {
  let out = "";
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, name.name);
    out += name.isDirectory() ? allText(p) : `${name.name}\n${readFileSync(p, "utf-8")}\n`;
  }
  return out;
};

describe("policy", () => {
  it("takes the phishing rule only for malicious without a false alarm", () => {
    expect(policyFor("malicious", [])).toBe("phishing");
    expect(policyFor("malicious", [{ kind: "missed" }])).toBe("phishing");
    expect(policyFor("malicious", [{ kind: "false_alarm" }])).toBe("genuine");
    for (const v of ["safe", "suspicious", null] as const) expect(policyFor(v, [])).toBe("genuine");
  });
});

describe("recipient redaction", () => {
  it("removes the recipient in every URL form and keeps the sender", () => {
    const rec = recipientOf(row(), detail());
    const a = "thandi.vdmerwe@acme.example";
    const text = [
      a,
      encodeURIComponent(a),
      Buffer.from(a).toString("base64"),
      "Thandi",
      "billing@paypa1-secure.example",
    ].join(" ");
    const out = scrubRecipient(text, rec);
    expect(out).not.toMatch(/thandi|vdmerwe|dGhhbmRp/i);
    expect(out).not.toMatch(/%40acme|acme\.example|dGhhbmRp/i);
    expect(out).toContain("billing@paypa1-secure.example");
  });

  it("does not walk hashes or authentication results through the prose redactor", async () => {
    const rec = recipientOf(row(), detail());
    const cleaner = cleanerFor("genuine", rec, null);
    const digit = sha("123456789012345");
    const out = (await cleanJson({ sha256: digit, spf: "pass 0825550142", digest: digit }, cleaner)) as Record<
      string,
      string
    >;
    expect(out.sha256).toBe(digit);
    expect(out.spf).toBe("pass 0825550142");
  });

  it("flags an upload whose uploader record is gone as not certified", () => {
    const rec = recipientOf(row({ channel: "upload", uploaded_by: "u1", forwarded_by: null }), detail({ members: [] }));
    expect(rec.certified).toBe(false);
  });
});

describe("captureCase", () => {
  it("keeps the phishing signals and removes the recipient everywhere", async () => {
    const dir = resolveRoot(fresh());
    const layout = layoutOf(dir);
    const { r, src } = one();
    const out = await captureCase(src, layout, r);
    expect(out.result).toBe("added");
    const text = allText(layout.root);
    expect(text).not.toMatch(/thandi|vdmerwe/i);
    expect(text).toContain("paypa1-secure.example");
    expect(text).toContain("evil.example");
    expect(text).toContain("spf=fail");
    expect(text).toContain("082 555 0142");
  });

  it("applies the full rule to genuine mail but keeps sender domains and authentication", async () => {
    const dir = resolveRoot(fresh());
    const layout = layoutOf(dir);
    const { r, src } = one({ row: { verdict: "safe" } });
    await captureCase(src, layout, r);
    const text = allText(layout.root);
    expect(text).not.toMatch(/thandi|vdmerwe|082 555 0142/i);
    expect(text).toContain("paypa1-secure.example");
    expect(text).toContain("spf=fail");
  });

  it("withholds binary and raster artefacts with their hash, type and size, and says so", async () => {
    const dir = resolveRoot(fresh());
    const layout = layoutOf(dir);
    const { r, src } = one();
    const out = await captureCase(src, layout, r);
    if (out.result !== "added") throw new Error("not added");
    const m = JSON.parse(readFileSync(join(layout.cases, r.id, out.fingerprint, "manifest.json"), "utf-8")) as Manifest;
    const image = m.payloads.find((p) => p.key === "case1/render.jpg");
    expect(image).toMatchObject({
      status: "withheld",
      source_sha256: sha("jpegbytes"),
      media_type: "image/jpeg",
      bytes: 9,
    });
    expect(out.withheld).toBe(1);
    expect(src.calls).toBeGreaterThan(0);
    expect(allText(layout.root)).not.toContain("jpegbytes");
  });

  it("reads each object once per case", async () => {
    const dir = resolveRoot(fresh());
    const layout = layoutOf(dir);
    const { r, src } = one();
    await captureCase(src, layout, r);
    expect(src.calls).toBe(1);
  });

  it("withholds every payload of a case it cannot certify", async () => {
    const dir = resolveRoot(fresh());
    const layout = layoutOf(dir);
    const { r, src } = one({
      row: { channel: "upload", uploaded_by: "u1", forwarded_by: null },
      detail: { members: [] },
    });
    const out = await captureCase(src, layout, r);
    if (out.result !== "added") throw new Error("not added");
    expect(out.kept).toBe(0);
  });

  it("adds nothing on an unchanged rerun and a new revision when feedback changes", async () => {
    const dir = resolveRoot(fresh());
    const layout = layoutOf(dir);
    const { r, d, src } = one();
    expect((await captureCase(src, layout, r)).result).toBe("added");
    expect((await captureCase(src, layout, r)).result).toBe("unchanged");
    d.feedback = [
      {
        id: "f1",
        user_id: "u1",
        kind: "missed",
        note: "it was Thandi's bank",
        providers_json: "[]",
        created_at: "t",
        updated_at: "t",
      },
    ];
    expect((await captureCase(src, layout, r)).result).toBe("added");
    expect(readdirSync(join(layout.cases, r.id)).filter((x) => !x.startsWith(".") && x !== "LATEST.json")).toHaveLength(
      2,
    );
    expect(allText(layout.root)).not.toMatch(/thandi/i);
  });

  it("redacts earlier revisions in place when a false alarm arrives and leaves no unredacted copy", async () => {
    const dir = resolveRoot(fresh());
    const layout = layoutOf(dir);
    const { r, d, src } = one();
    const first = await captureCase(src, layout, r);
    if (first.result !== "added") throw new Error("not added");
    expect(allText(layout.root)).toContain("evil.example");
    d.feedback = [
      {
        id: "f1",
        user_id: "u1",
        kind: "false_alarm",
        note: null,
        providers_json: "[]",
        created_at: "t",
        updated_at: "t",
      },
    ];
    const second = await captureCase(src, layout, r);
    expect(second).toMatchObject({ result: "added", policy: "genuine" });
    const old = JSON.parse(
      readFileSync(join(layout.cases, r.id, first.fingerprint, "manifest.json"), "utf-8"),
    ) as Manifest;
    expect(old.policy).toBe("genuine");
    expect(old.redacted_in_place).toMatchObject({ reason: "false_alarm", from_policy: "phishing" });
    expect(old.payloads.find((p) => p.key === "case1/raw.eml")).toMatchObject({ source_sha256: sha(RAW) });
    expect(allText(layout.root)).not.toMatch(/thandi|vdmerwe|082 555 0142/i);
    expect(readdirSync(join(layout.cases, r.id)).filter((x) => x.startsWith(".tmp"))).toEqual([]);
  });

  it("keeps a missing object retryable and publishes nothing for the case", async () => {
    const dir = resolveRoot(fresh());
    const layout = layoutOf(dir);
    const { r, src } = one({ objects: { "case1/raw.eml": null } });
    const out = await captureCase(src, layout, r);
    expect(out.result).toBe("retry");
    expect(existsSync(join(layout.cases, r.id, "LATEST.json"))).toBe(false);
  });

  it("keeps a missing non-mail object retryable too", async () => {
    const dir = resolveRoot(fresh());
    const layout = layoutOf(dir);
    const { r, d, src } = one();
    d.artefacts.push({
      r2_key: "case1/page.html",
      kind: "page",
      sha256: sha("<p>x</p>"),
      media_type: "text/html",
      bytes: 8,
    });
    const out = await captureCase(src, layout, r);
    expect(out.result).toBe("retry");
    expect(existsSync(join(layout.cases, r.id, "LATEST.json"))).toBe(false);
  });

  it("fails a case whose object digest does not match, without publishing it", async () => {
    const dir = resolveRoot(fresh());
    const layout = layoutOf(dir);
    const { r, src } = one({ objects: { "case1/raw.eml": new TextEncoder().encode("tampered") } });
    expect((await captureCase(src, layout, r)).result).toBe("failed");
    expect(existsSync(join(layout.cases, r.id, "LATEST.json"))).toBe(false);
  });
});

describe("captureAll", () => {
  it("pages through every case, reconciles the stats and keeps category and lure type null", async () => {
    const dir = fresh();
    const rows = ["c1", "c2", "c3", "c4", "c5"].map((id) => row({ id, verdict: id === "c1" ? "malicious" : "safe" }));
    const details = new Map(rows.map((r) => [r.id, detail({ artefacts: [] })]));
    const summary = await captureAll(source(rows, details, new Map()), dir, { pageSize: 2 });
    expect(summary).toMatchObject({ seen: 5, added: 5, unchanged: 0, retry: 0, failed: 0 });
    const root = layoutOf(resolveRoot(dir));
    const stats = JSON.parse(readFileSync(root.stats, "utf-8"));
    expect(stats.store.cases).toBe(5);
    expect(stats.production).toMatchObject({ seen: 5, captured_now: 5 });
    expect(stats.by_verdict).toEqual({ malicious: 1, safe: 4 });
    expect(stats.by_category).toEqual({ unknown: 5 });
    expect(readFileSync(root.statsMd, "utf-8")).toContain("seen 5");
    const again = await captureAll(source(rows, details, new Map()), dir, { pageSize: 2 });
    expect(again).toMatchObject({ added: 0, unchanged: 5 });
  });

  it("covers both channels", async () => {
    const dir = fresh();
    const rows = [row({ id: "e1" }), row({ id: "u1", channel: "upload", uploaded_by: "usr", forwarded_by: null })];
    const details = new Map(rows.map((r) => [r.id, detail({ artefacts: [] })]));
    await captureAll(source(rows, details, new Map()), dir);
    const stats = JSON.parse(readFileSync(layoutOf(resolveRoot(dir)).stats, "utf-8"));
    expect(stats.by_channel).toEqual({ email: 1, upload: 1 });
  });

  it("recovers from an interrupted write without losing a prior capture", async () => {
    const dir = fresh();
    const rows = [row({ id: "c1" })];
    const details = new Map([["c1", detail({ artefacts: [] })]]);
    await captureAll(source(rows, details, new Map()), dir);
    const layout = layoutOf(resolveRoot(dir));
    const stale = join(layout.cases, "c1", ".tmp-2147483646-abcdef");
    mkdirSync(stale);
    writeFileSync(join(stale, "record.json"), "{}");
    expect(sweepInterrupted(layout)).toBe(1);
    expect(existsSync(stale)).toBe(false);
    // The prior capture itself is still there and still verifies, not only the report that counted it.
    const latest = JSON.parse(readFileSync(join(layout.cases, "c1", "LATEST.json"), "utf-8")).fingerprint;
    expect(verifyRevision(join(layout.cases, "c1", latest))).toBeNull();
    expect(verifyStore(layout)).toEqual([]);
  });

  it("records a read failure as retryable and carries on with the next case", async () => {
    const dir = fresh();
    const rows = [row({ id: "c1" }), row({ id: "c2" })];
    const details = new Map(rows.map((r) => [r.id, detail({ artefacts: [] })]));
    const base = source(rows, details, new Map());
    const failing: CaptureSource = {
      ...base,
      detail: async (r) => {
        if (r.id === "c1") throw new Error("network down");
        return base.detail(r);
      },
    };
    const summary = await captureAll(failing, dir);
    expect(summary).toMatchObject({ added: 1, retry: 1 });
    const status = JSON.parse(readFileSync(layoutOf(resolveRoot(dir)).status, "utf-8"));
    expect(JSON.stringify(status)).not.toMatch(/thandi/i);
  });

  it("refuses an overlapping run and a lock whose owner is gone is taken over", () => {
    const layout = layoutOf(resolveRoot(fresh()));
    const release = takeLock(layout);
    expect(() => takeLock(layout)).toThrow(/another capture/);
    release();
    writeFileSync(layout.lock, "2147483646");
    const again = takeLock(layout);
    again();
  });
});

describe("the external root", () => {
  it("refuses a store inside a git work tree and a symlink into one", () => {
    expect(() => resolveRoot(join(process.cwd(), "build", "capture-test"))).toThrow(/git work tree/);
    const link = join(scratch, "link");
    symlinkSync(process.cwd(), link);
    expect(() => resolveRoot(link)).toThrow(/git work tree/);
  });

  it("stays out of the page store, so the page enumerator and dataset builder never see a capture", async () => {
    const dir = fresh();
    const rows = [row({ id: "c1" })];
    await captureAll(source(rows, new Map([["c1", detail({ artefacts: [] })]]), new Map()), dir);
    const store = openStore(resolveRoot(dir));
    expect(store.manifest()).toEqual([]);
    expect(readdirSync(resolveRoot(dir))).toEqual(["capture"]);
  });
});

describe("the D1 and R2 reader", () => {
  it("refuses an id that could carry SQL and builds only single SELECT statements", () => {
    expect(() =>
      QUERY.detail({ id: "x'; DROP TABLE cases; --", org_id: "o", uploaded_by: null, forwarded_by: null }),
    ).toThrow(/outside the allowed/);
    for (const sql of [
      QUERY.cases("abc", 50),
      QUERY.detail({ id: "abc", org_id: "org", uploaded_by: "u1", forwarded_by: "a@b.example" }),
    ]) {
      expect(sql).toMatch(/^SELECT /);
      expect(sql).not.toContain(";");
    }
    expect(QUERY.detail({ id: "abc", org_id: "o", uploaded_by: null, forwarded_by: null })).toContain(
      "COALESCE((SELECT run_id FROM cases",
    );
    expect(QUERY.detail({ id: "abc", org_id: "o", uploaded_by: null, forwarded_by: "x' OR 1=1 --" })).not.toContain(
      "OR 1=1",
    );
  });

  it("passes a statement and key to Wrangler by argument only, never a payload, and treats a failed read as retryable", async () => {
    const seen: string[][] = [];
    const src = openWranglerSource(join(scratch, "reader"), (args) => {
      seen.push(args);
      if (args[0] === "d1")
        return { status: 0, stdout: JSON.stringify([{ success: true, results: [{ id: "a" }] }]), stderr: "" };
      return { status: 1, stdout: "", stderr: "secret body" };
    });
    expect(await src.cases(null, 10)).toEqual([{ id: "a" }]);
    expect(await src.object("case1/raw.eml")).toBeNull();
    await expect(src.object("../etc/passwd")).rejects.toThrow(/outside the allowed/);
    expect(seen[0]).toContain("--remote");
    expect(seen[1]).toContain("--remote");
    expect(() => d1Rows("[]")).toThrow(/unexpected/);
  });

  it("does not echo Wrangler's output when a read fails", async () => {
    const src = openWranglerSource(join(scratch, "reader2"), () => ({
      status: 1,
      stdout: "",
      stderr: "SELECT secret FROM cases",
    }));
    await expect(src.cases(null, 1)).rejects.toThrow(/status 1/);
    await expect(src.cases(null, 1)).rejects.not.toThrow(/secret/);
  });
});

describe("the local runner", () => {
  const runner = join(process.cwd(), "scripts/glimmer/capture-run.sh");
  const home = join(scratch, "runner-home");
  const run = (env: Record<string, string>) =>
    spawnSync("bash", [runner], { env: { ...process.env, GLIMMER_DATA_DIR: home, ...env }, encoding: "utf-8" });
  const status = () => JSON.parse(readFileSync(join(home, "capture/1.1/runner-status.json"), "utf-8"));

  it("defers under 3000 MB available memory and says so without content", () => {
    const meminfo = join(scratch, "meminfo-low");
    writeFileSync(meminfo, "MemAvailable:    2048000 kB\n");
    const done = run({ CAPTURE_MEMINFO: meminfo, CAPTURE_COMMAND: "false" });
    expect(done.status).toBe(75);
    expect(status()).toMatchObject({ state: "deferred" });
  });

  it("records a failed command and passes its status on, and a good one as ok", () => {
    const meminfo = join(scratch, "meminfo-ok");
    writeFileSync(meminfo, "MemAvailable:    8192000 kB\n");
    expect(run({ CAPTURE_MEMINFO: meminfo, CAPTURE_COMMAND: "false" }).status).toBe(1);
    expect(status()).toMatchObject({ state: "failed" });
    expect(run({ CAPTURE_MEMINFO: meminfo, CAPTURE_COMMAND: "true" }).status).toBe(0);
    expect(status()).toMatchObject({ state: "ok" });
  });

  it("refuses to overlap a running instance", () => {
    const meminfo = join(scratch, "meminfo-ok");
    const holder = spawn("bash", ["-c", `exec 9> "${home}/capture/1.1/.runner.lock"; flock -n 9 && sleep 3`]);
    const wait = Date.now() + 2000;
    while (Date.now() < wait && !existsSync(join(home, "capture/1.1/.runner.lock"))) {
      /* wait for the holder to create its lock file */
    }
    spawnSync("sleep", ["0.3"]);
    const done = run({ CAPTURE_MEMINFO: meminfo, CAPTURE_COMMAND: "true" });
    holder.kill();
    expect(done.status).toBe(75);
    expect(status().detail).toMatch(/another capture runner/);
  });
});

// The gaps the completion review found (D03 T04 §41), each as a failing regression.
const INNER = [
  "From: attacker@evil.example",
  "To: Lerato Mokoena <lerato.m@third.example>",
  "Subject: inner",
  "",
  "inner body",
].join("\r\n");
const MIME_NESTED = [
  "From: Lindiwe Zulu <lindiwe.z@acme.example>",
  "To: Thandi <thandi.vdmerwe@acme.example>",
  "Subject: fwd",
  'Content-Type: multipart/mixed; boundary="B"',
  "",
  "--B",
  "Content-Type: text/plain",
  "",
  "See below.\r\nTo: Sipho Dlamini <sipho.d@other.example>\r\nFrom: attacker@evil.example",
  "--B",
  "Content-Type: message/rfc822",
  'Content-Disposition: attachment; filename="inner.eml"',
  "Content-Transfer-Encoding: base64",
  "",
  Buffer.from(INNER).toString("base64"),
  "--B--",
  "",
].join("\r\n");

describe("identity discovery", () => {
  it("finds recipients in the outer headers, a nested message and a forward written into the body", async () => {
    const people = await discoverPeople(new TextEncoder().encode(MIME_NESTED));
    const mails = people.map((p) => p.email);
    expect(mails).toContain("thandi.vdmerwe@acme.example");
    expect(mails).toContain("sipho.d@other.example");
    expect(mails).toContain("lerato.m@third.example");
    expect(mails).toContain("lindiwe.z@acme.example");
    // The forwarder is the outer From; the inner From is the sender being checked and is not a recipient.
    expect(mails).not.toContain("attacker@evil.example");
  });

  it("removes every one of them from the capture", async () => {
    const dir = resolveRoot(fresh());
    const layout = layoutOf(dir);
    const raw = new TextEncoder().encode(MIME_NESTED);
    const { r, d, src } = one({ objects: { "case1/raw.eml": raw } });
    d.artefacts = [
      { r2_key: "case1/raw.eml", kind: "raw", sha256: sha(raw), media_type: "message/rfc822", bytes: raw.length },
    ];
    await captureCase(src, layout, r);
    const text = allText(layout.root);
    expect(text).not.toMatch(/sipho|lerato|dlamini|mokoena|thandi|lindiwe|zulu/i);
    expect(text).toContain("evil.example");
  });

  it("does not certify a case whose checker cannot be identified, and keeps none of its payloads", async () => {
    const dir = resolveRoot(fresh());
    const layout = layoutOf(dir);
    const { r, src } = one({ row: { forwarded_by: null }, detail: { members: [] } });
    // Its raw message has no recipient headers either.
    const bare = new TextEncoder().encode("Subject: x\r\n\r\nbody");
    src.object = async () => bare;
    const detailBare = detail({ members: [] });
    detailBare.artefacts = [
      { r2_key: "k", kind: "raw", sha256: sha(bare), media_type: "message/rfc822", bytes: bare.length },
    ];
    const s2 = source([r], new Map([[r.id, detailBare]]), new Map([["k", bare]]));
    const out = await captureCase(s2, layout, r);
    if (out.result !== "added") throw new Error("not added");
    expect(out.kept).toBe(0);
    const m = JSON.parse(readFileSync(join(layout.cases, r.id, out.fingerprint, "manifest.json"), "utf-8")) as Manifest;
    expect(m.certified).toBe(false);
  });

  it("treats the demo account like any other checker", async () => {
    const dir = resolveRoot(fresh());
    const layout = layoutOf(dir);
    const demo = { name: "Demo User", email: "demo@rizonetech.com" };
    const { r, src } = one({ row: { forwarded_by: demo.email }, detail: { members: [demo] } });
    await captureCase(src, layout, r);
    expect(allText(layout.root)).not.toMatch(/demo@rizonetech|Demo User/i);
  });
});

describe("what a capture keeps of the recipient", () => {
  const LEAKY = [
    "From: Pay <billing@paypa1-secure.example>",
    "To: Thandi <thandi.vdmerwe@acme.example>",
    "Subject: x",
    "Authentication-Results: mx.example; spf=pass smtp.mailto=thandi.vdmerwe@acme.example",
    'Content-Type: multipart/mixed; boundary="B"',
    "",
    "--B",
    "Content-Type: text/html",
    "",
    '<p>Hello Th&#97;ndi</p><img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk">',
    "--B",
    'Content-Type: application/pdf; name="Thandi-invoice.pdf"',
    'Content-Disposition: attachment; filename="Thandi-invoice.pdf"',
    "Content-Transfer-Encoding: base64",
    "",
    "JVBERi0xLjQK",
    "--B--",
    "",
  ].join("\r\n");

  it("removes it from authentication values, filenames, encoded names, embedded images and the sender field", async () => {
    const dir = resolveRoot(fresh());
    const layout = layoutOf(dir);
    const raw = new TextEncoder().encode(LEAKY);
    const { r, d, src } = one({
      row: { original_from_address: "thandi.vdmerwe@acme.example" },
      objects: { "case1/raw.eml": raw },
    });
    d.artefacts = [
      {
        r2_key: "case1/Thandi-invoice.eml",
        kind: "raw",
        sha256: sha(raw),
        media_type: "message/rfc822",
        bytes: raw.length,
      },
    ];
    const objects = new Map([["case1/Thandi-invoice.eml", raw]]);
    await captureCase(source([r], new Map([[r.id, d]]), objects), layout, r);
    const text = allText(layout.root);
    expect(text).not.toMatch(/thandi|vdmerwe/i);
    expect(text).not.toContain("iVBORw0KGgo");
    expect(text).toContain("spf=pass");
    expect(text).toContain("data:withheld");
    expect(src.calls).toBe(0);
  });

  it("processes a JSON artefact structurally: hashes and authentication values stay, the recipient goes", async () => {
    const dir = resolveRoot(fresh());
    const layout = layoutOf(dir);
    const body = new TextEncoder().encode(
      JSON.stringify({
        digest: sha("z"),
        to: "thandi.vdmerwe@acme.example",
        spf: "pass",
        note: "Th&#97;ndi paid",
        token: Buffer.from("thandi.vdmerwe@acme.example").toString("hex"),
      }),
    );
    const { r, d } = one();
    d.artefacts = [
      {
        r2_key: "case1/parsed.json",
        kind: "attachment",
        sha256: sha(body),
        media_type: "application/json",
        bytes: body.length,
      },
    ];
    await captureCase(source([r], new Map([[r.id, d]]), new Map([["case1/parsed.json", body]])), layout, r);
    const text = allText(layout.root);
    expect(text).toContain(sha("z"));
    expect(text).not.toMatch(/thandi|vdmerwe/i);
    expect(text).not.toMatch(/Th&#97;ndi/);
    expect(text).not.toContain(Buffer.from("thandi.vdmerwe@acme.example").toString("hex"));
    expect(text).toContain('"json":');
  });
});

describe("the guarantee after cleaning", () => {
  it("withholds a field in which a look-alike spelling of the recipient survives, and keeps the rest of the case", async () => {
    const dir = resolveRoot(fresh());
    const layout = layoutOf(dir);
    const raw = new TextEncoder().encode(RAW.replace("Dear Thandi,", "Dear Th\u0430ndi,"));
    const { r, d } = one();
    d.artefacts = [{ r2_key: "k", kind: "raw", sha256: sha(raw), media_type: "message/rfc822", bytes: raw.length }];
    const out = await captureCase(source([r], new Map([[r.id, d]]), new Map([["k", raw]])), layout, r);
    expect(out.result).toBe("added");
    const text = allText(layout.root);
    expect(text).not.toContain("Th\u0430ndi");
    expect(text).toContain("[withheld: recipient identifier survived cleaning]");
    expect(text).toContain("evil.example");
  });

  it("reads percent escapes and HTML inside JSON as a reader would", async () => {
    const dir = resolveRoot(fresh());
    const layout = layoutOf(dir);
    const raw = new TextEncoder().encode(
      [
        "From: x <billing@paypa1-secure.example>",
        "To: Alice <alice@example.com>",
        "Subject: x",
        "Content-Type: text/plain",
        "",
        "https://evil.example/?email=%41lice%40Example.com",
      ].join("\r\n"),
    );
    const json = new TextEncoder().encode(
      JSON.stringify({ html: "<p>Al<span>ice</span> Smith</p>", ok: "https://evil.example" }),
    );
    const { r, d } = one({
      row: { forwarded_by: "alice@example.com" },
      detail: { members: [{ name: "Alice Smith", email: "alice@example.com" }] },
    });
    d.artefacts = [
      { r2_key: "k", kind: "raw", sha256: sha(raw), media_type: "message/rfc822", bytes: raw.length },
      { r2_key: "j", kind: "attachment", sha256: sha(json), media_type: "application/json", bytes: json.length },
    ];
    const out = await captureCase(
      source(
        [r],
        new Map([[r.id, d]]),
        new Map([
          ["k", raw],
          ["j", json],
        ]),
      ),
      layout,
      r,
    );
    expect(out.result).toBe("added");
    const text = allText(layout.root);
    expect(text).not.toMatch(/%41lice|Alice@Example|Al<span>ice/i);
    expect(text).toContain("evil.example");
  });
});

describe("a case that changes while it is collected", () => {
  it("is read again, and retried when it will not settle", async () => {
    const dir = resolveRoot(fresh());
    const layout = layoutOf(dir);
    const { r, d, objects } = one();
    let reads = 0;
    const base = source([r], new Map([[r.id, d]]), objects);
    const moving: CaptureSource = {
      ...base,
      // Every second look at the case sees new feedback, as if a member answered while the objects downloaded.
      detail: async () => {
        reads++;
        return {
          ...d,
          feedback: [
            {
              id: `f${reads}`,
              user_id: "u",
              kind: "missed",
              note: null,
              providers_json: "[]",
              created_at: "t",
              updated_at: `t${reads}`,
            },
          ],
        };
      },
    };
    expect((await captureCase(moving, layout, r)).result).toBe("retry");
    expect(existsSync(join(layout.cases, r.id, "LATEST.json"))).toBe(false);
  });

  it("settles when the change happens once", async () => {
    const dir = resolveRoot(fresh());
    const layout = layoutOf(dir);
    const { r, d, objects } = one();
    let reads = 0;
    const base = source([r], new Map([[r.id, d]]), objects);
    const once: CaptureSource = {
      ...base,
      detail: async () => {
        reads++;
        return reads <= 2
          ? {
              ...d,
              feedback: [
                {
                  id: "f1",
                  user_id: "u",
                  kind: "missed",
                  note: null,
                  providers_json: "[]",
                  created_at: "t",
                  updated_at: reads === 1 ? "t1" : "t2",
                },
              ],
            }
          : {
              ...d,
              feedback: [
                {
                  id: "f1",
                  user_id: "u",
                  kind: "missed",
                  note: null,
                  providers_json: "[]",
                  created_at: "t",
                  updated_at: "t2",
                },
              ],
            };
      },
    };
    expect((await captureCase(once, layout, r)).result).toBe("added");
  });
});

describe("a false alarm, redacted in place", () => {
  const alarm = {
    id: "f1",
    user_id: "u1",
    kind: "false_alarm" as const,
    note: null,
    providers_json: "[]",
    created_at: "t",
    updated_at: "t",
  };

  it("keeps each earlier revision's own record and evidence rather than the newest", async () => {
    const dir = resolveRoot(fresh());
    const layout = layoutOf(dir);
    const { r, d, src } = one();
    (d.evidence[0] as { summary: string }).summary = "Called 082 555 0142 about a look-alike";
    const first = await captureCase(src, layout, r);
    if (first.result !== "added") throw new Error("not added");
    (d.evidence[0] as { summary: string }).summary = "A later summary about a different look-alike";
    d.feedback = [alarm];
    await captureCase(src, layout, r);
    const old = JSON.parse(readFileSync(join(layout.cases, r.id, first.fingerprint, "record.json"), "utf-8"));
    expect(old.evidence[0].summary).toContain("look-alike");
    expect(old.evidence[0].summary).not.toContain("different");
    expect(old.feedback).toEqual([]);
    expect(old.evidence[0].summary).not.toContain("0142");
    expect(allText(join(layout.cases, r.id, first.fingerprint))).not.toMatch(/thandi|vdmerwe/i);
  });

  for (const stop of ["pending-written", "revision-published", "pointer-moved", "revision-redacted"]) {
    it(`is finished by the next run when it stops at ${stop}`, async () => {
      const dir = resolveRoot(fresh());
      const layout = layoutOf(dir);
      const { r, d, src } = one();
      const first = await captureCase(src, layout, r);
      if (first.result !== "added") throw new Error("not added");
      d.feedback = [alarm];
      await expect(
        captureCase(src, layout, r, {
          step: (name) => {
            if (name === stop) throw new Error("power cut");
          },
        }),
      ).rejects.toThrow(/power cut/);
      const done = await captureCase(src, layout, r);
      expect(["added", "unchanged"]).toContain(done.result);
      const old = JSON.parse(
        readFileSync(join(layout.cases, r.id, first.fingerprint, "manifest.json"), "utf-8"),
      ) as Manifest;
      expect(old.policy).toBe("genuine");
      expect(existsSync(join(layout.cases, r.id, "PENDING-REDACTION.json"))).toBe(false);
      expect(verifyRevision(join(layout.cases, r.id, first.fingerprint))).toBeNull();
    });
  }
});

describe("recovery and verification", () => {
  it("removes a download an earlier run left in the scratch folder", async () => {
    const dir = fresh();
    const layout = layoutOf(resolveRoot(dir));
    mkdirSync(layout.scratch, { recursive: true });
    writeFileSync(join(layout.scratch, "object-1-2"), "unredacted mail for thandi");
    const r = row({ id: "c1" });
    await captureAll(source([r], new Map([["c1", detail({ artefacts: [] })]]), new Map()), dir);
    expect(readdirSync(layout.scratch)).toEqual([]);
  });

  it("detects a damaged payload and repairs it from production", async () => {
    const dir = fresh();
    const { r, d, objects } = one();
    const src = source([r], new Map([[r.id, d]]), objects);
    await captureAll(src, dir);
    const layout = layoutOf(resolveRoot(dir));
    const latest = JSON.parse(readFileSync(join(layout.cases, r.id, "LATEST.json"), "utf-8")).fingerprint;
    writeFileSync(join(layout.cases, r.id, latest, "p0.json"), "{}");
    expect(verifyRevision(join(layout.cases, r.id, latest))).toBe("payload");
    const again = await captureAll(src, dir);
    expect(again).toMatchObject({ added: 1, unchanged: 0, integrity: 0 });
    expect(verifyStore(layout)).toEqual([]);
  });

  it("reports damage it cannot repair, because production no longer holds the case", async () => {
    const dir = fresh();
    const { r, d, objects } = one();
    await captureAll(source([r], new Map([[r.id, d]]), objects), dir);
    const layout = layoutOf(resolveRoot(dir));
    const latest = JSON.parse(readFileSync(join(layout.cases, r.id, "LATEST.json"), "utf-8")).fingerprint;
    rmSync(join(layout.cases, r.id, latest, "record.json"));
    const summary = await captureAll(source([], new Map(), new Map()), dir);
    expect(summary.integrity).toBe(1);
    expect(JSON.parse(readFileSync(layout.stats, "utf-8")).store.integrity_failures).toBe(1);
  });

  it("downloads nothing for an unchanged case", async () => {
    const dir = fresh();
    const { r, d, objects } = one();
    const src = source([r], new Map([[r.id, d]]), objects);
    await captureAll(src, dir);
    const before = src.calls;
    expect(await captureAll(src, dir)).toMatchObject({ unchanged: 1, added: 0 });
    expect(src.calls).toBe(before);
  });
});

describe("coverage figures", () => {
  it("keeps the store's cases apart from this scan's production population", async () => {
    const dir = fresh();
    const rows = [row({ id: "old" }), row({ id: "new" })];
    const details = new Map(rows.map((x) => [x.id, detail({ artefacts: [] })]));
    await captureAll(source(rows, details, new Map()), dir);
    // Production has since expired "old".
    await captureAll(source(rows.slice(1), details, new Map()), dir);
    const stats = JSON.parse(readFileSync(layoutOf(resolveRoot(dir)).stats, "utf-8"));
    expect(stats.production).toMatchObject({ seen: 1, captured_now: 1 });
    expect(stats.store).toMatchObject({ cases: 2, historical_only: 1 });
  });

  it("counts an unreadable object as missing for this scan and groups payloads by channel and verdict", async () => {
    const dir = fresh();
    const { r, d } = one({ objects: { "case1/raw.eml": null } });
    await captureAll(source([r], new Map([[r.id, d]]), new Map()), dir);
    const stats = JSON.parse(readFileSync(layoutOf(resolveRoot(dir)).stats, "utf-8"));
    expect(stats.payloads.missing_in_scan).toBe(1);
    expect(stats.production.waiting_to_retry).toBe(1);
    const ok = one();
    await captureAll(ok.src, fresh());
    const dir2 = fresh();
    await captureAll(ok.src, dir2);
    const s2 = JSON.parse(readFileSync(layoutOf(resolveRoot(dir2)).stats, "utf-8"));
    expect(s2.payloads_by_channel_verdict["email/malicious"]).toEqual({ kept: 1, withheld: 1 });
  });

  it("writes content-free progress", async () => {
    const dir = fresh();
    const { src } = one();
    await captureAll(src, dir);
    const text = readFileSync(layoutOf(resolveRoot(dir)).progress, "utf-8");
    expect(JSON.parse(text)).toMatchObject({ state: "finished", seen: 1 });
    expect(text).not.toMatch(/thandi|case1/i);
  });
});

describe("the command line and the runner's destination", () => {
  const cli = (args: string[], env: Record<string, string> = {}) =>
    spawnSync("node", ["scripts/glimmer/capture-cases.ts", ...args], {
      env: { ...process.env, ...env },
      encoding: "utf-8",
    });

  it("refuses an invalid or zero --limit and an unknown flag", () => {
    for (const bad of [["--limit", "0"], ["--limit", "abc"], ["--limit"], ["--nope"]]) expect(cli(bad).status).toBe(2);
  });

  it("prints the validated root without writing, and refuses a destination inside a git work tree", () => {
    const store = join(scratch, "cli-store");
    const ok = cli(["--print-root"], { GLIMMER_DATA_DIR: store });
    expect(ok.status).toBe(0);
    expect(ok.stdout.trim()).toBe(store);
    expect(existsSync(store)).toBe(false);
    expect(cli(["--print-root"], { GLIMMER_DATA_DIR: join(process.cwd(), "build", "cap") }).status).not.toBe(0);
  });

  it("shows a run that never happened", () => {
    const store = join(scratch, "cli-status");
    expect(cli(["--status"], { GLIMMER_DATA_DIR: store }).stdout).toContain("never run");
  });

  it("makes the runner write nothing when the destination is refused, and expands ~ as the collector does", () => {
    const runner = join(process.cwd(), "scripts/glimmer/capture-run.sh");
    const inside = join(process.cwd(), "build", "runner-refused");
    rmSync(inside, { recursive: true, force: true });
    const refused = spawnSync("bash", [runner], {
      env: { ...process.env, GLIMMER_DATA_DIR: inside, CAPTURE_COMMAND: "true" },
      encoding: "utf-8",
    });
    expect(refused.status).toBe(78);
    expect(existsSync(inside)).toBe(false);
    const home = join(scratch, "home-for-tilde");
    mkdirSync(home, { recursive: true });
    const meminfo = join(scratch, "meminfo-tilde");
    writeFileSync(meminfo, "MemAvailable:    8192000 kB\n");
    const ok = spawnSync("bash", [runner], {
      env: {
        ...process.env,
        HOME: home,
        GLIMMER_DATA_DIR: "~/data",
        CAPTURE_COMMAND: "true",
        CAPTURE_MEMINFO: meminfo,
      },
      encoding: "utf-8",
    });
    expect(ok.status).toBe(0);
    expect(existsSync(join(home, "data/capture/1.1/runner-status.json"))).toBe(true);
  });
});

describe("the reader's deadlines", () => {
  it("gives every Wrangler call a deadline", async () => {
    const seen: (number | undefined)[] = [];
    const src = openWranglerSource(join(scratch, "deadline"), (args, timeout) => {
      seen.push(timeout);
      return args[0] === "d1"
        ? { status: 0, stdout: JSON.stringify([{ success: true, results: [] }]), stderr: "" }
        : { status: 1, stdout: "", stderr: "" };
    });
    await src.cases(null, 1);
    await src.object("case1/raw.eml");
    expect(seen.every((t) => typeof t === "number" && t > 0)).toBe(true);
  });

  it("builds the second metadata read as a single SELECT", () => {
    expect(QUERY.row("abc")).toMatch(/^SELECT .* FROM cases WHERE id = 'abc'$/);
  });
});

describe("the one-call case reader", () => {
  it("reads a whole case in a single Wrangler call and parses its parts", async () => {
    let calls = 0;
    const src = openWranglerSource(join(scratch, "one-call"), () => {
      calls++;
      const row = {
        artefacts: JSON.stringify([{ r2_key: "k", kind: "raw", sha256: "s", media_type: "message/rfc822", bytes: 1 }]),
        evidence: "[]",
        checks: "[]",
        feedback: JSON.stringify([
          { id: "f", user_id: "u", kind: "missed", note: null, providers_json: "[]", created_at: "t", updated_at: "t" },
        ]),
        verdict: null,
        members: JSON.stringify([{ name: "A B", email: "a@b.example" }]),
      };
      return { status: 0, stdout: JSON.stringify([{ success: true, results: [row] }]), stderr: "" };
    });
    const got = await src.detail(row());
    expect(calls).toBe(1);
    expect(got.artefacts).toHaveLength(1);
    expect(got.feedback[0]?.kind).toBe("missed");
    expect(got.verdict).toBeNull();
    expect(got.members[0]?.email).toBe("a@b.example");
  });
});

// Round 1 of the independent review (D03 T04 §41).
describe("markup that hides the recipient", () => {
  const html = (body: string) => {
    const raw = new TextEncoder().encode(
      [
        "From: Pay <billing@paypa1-secure.example>",
        "To: Alice <alice@acme.example>",
        "Subject: x",
        "Content-Type: text/html",
        "",
        body,
      ].join("\r\n"),
    );
    return raw;
  };
  const run = async (body: string) => {
    const dir = resolveRoot(fresh());
    const layout = layoutOf(dir);
    const raw = html(body);
    const { r, d } = one({
      row: { forwarded_by: "alice@acme.example" },
      detail: { members: [{ name: "Alice Smith", email: "alice@acme.example" }] },
    });
    d.artefacts = [{ r2_key: "k", kind: "raw", sha256: sha(raw), media_type: "message/rfc822", bytes: raw.length }];
    const out = await captureCase(source([r], new Map([[r.id, d]]), new Map([["k", raw]])), layout, r);
    return { out, text: allText(layout.root) };
  };

  it("does not keep markup that reads as the recipient's name once its tags are dropped", async () => {
    const { out, text } = await run('<p>Hello Al<span>ice</span> Smith</p> <a href="https://evil.example/x">go</a>');
    expect(out.result).toBe("added");
    expect(text).not.toMatch(/Al<span>ice/);
    expect(text).toContain("recipient identifier split across markup");
    expect(text).toContain("evil.example");
  });

  it("withholds every embedded data URI, not only base64 images", async () => {
    const { text } = await run(
      '<img src="data:image/svg+xml,%3Csvg%3EAlice%3C/svg%3E"><a href="data:text/html,<b>x</b>">y</a>',
    );
    expect(text).not.toContain("svg+xml");
    expect(text).not.toContain("text/html,<b>");
    expect(text).toContain("data:withheld");
  });
});

describe("a stored page that hides the recipient", () => {
  it("withholds an HTML page whose tags split the recipient's name", async () => {
    const dir = resolveRoot(fresh());
    const layout = layoutOf(dir);
    const page = new TextEncoder().encode('<p>Dear Al<b>ice</b>, welcome</p><a href="https://evil.example">x</a>');
    const { r, d } = one({
      row: { forwarded_by: "alice@acme.example" },
      detail: { members: [{ name: "Alice Smith", email: "alice@acme.example" }] },
    });
    d.artefacts = [{ r2_key: "k", kind: "page", sha256: sha(page), media_type: "text/html", bytes: page.length }];
    await captureCase(source([r], new Map([[r.id, d]]), new Map([["k", page]])), layout, r);
    const text = allText(layout.root);
    expect(text).not.toMatch(/Al<b>ice/);
    expect(text).toContain("recipient identifier split across markup");
  });
});

describe("an interrupted false alarm, finished without production", () => {
  it("is completed from its marker alone when the case and its raw mail are gone", async () => {
    const dir = fresh();
    const layout = layoutOf(resolveRoot(dir));
    const { r, d, src } = one();
    const first = await captureCase(src, layout, r);
    if (first.result !== "added") throw new Error("not added");
    d.feedback = [
      {
        id: "f1",
        user_id: "u1",
        kind: "false_alarm",
        note: null,
        providers_json: "[]",
        created_at: "t",
        updated_at: "t",
      },
    ];
    await expect(
      captureCase(src, layout, r, {
        step: (n) => {
          if (n === "pointer-moved") throw new Error("power cut");
        },
      }),
    ).rejects.toThrow(/power cut/);
    // Production has since expired the case: the next run never sees it.
    const summary = await captureAll(source([], new Map(), new Map()), dir);
    expect(summary.integrity).toBe(0);
    const old = JSON.parse(
      readFileSync(join(layout.cases, r.id, first.fingerprint, "manifest.json"), "utf-8"),
    ) as Manifest;
    expect(old.policy).toBe("genuine");
    expect(allText(join(layout.cases, r.id, first.fingerprint))).not.toMatch(/thandi|vdmerwe|082 555 0142/i);
    expect(existsSync(join(layout.cases, r.id, "PENDING-REDACTION.json"))).toBe(false);
  });

  it("checks every stored revision, not only the latest", async () => {
    const dir = fresh();
    const layout = layoutOf(resolveRoot(dir));
    const { r, d, src } = one();
    const first = await captureCase(src, layout, r);
    if (first.result !== "added") throw new Error("not added");
    d.feedback = [
      { id: "f1", user_id: "u1", kind: "missed", note: null, providers_json: "[]", created_at: "t", updated_at: "t" },
    ];
    await captureCase(src, layout, r);
    rmSync(join(layout.cases, r.id, first.fingerprint, "record.json"));
    expect(verifyStore(layout)).toEqual([r.id]);
  });
});

describe("uploads and unusual keys", () => {
  it("keeps the sender of an uploaded original message, which is the lure and not a forwarder", async () => {
    const dir = resolveRoot(fresh());
    const layout = layoutOf(dir);
    const raw = new TextEncoder().encode("From: Fraud Desk <lure@attacker.example>\r\nSubject: pay now\r\n\r\nbody");
    const { r, d } = one({ row: { channel: "upload", uploaded_by: "u1", forwarded_by: null } });
    d.artefacts = [{ r2_key: "k", kind: "raw", sha256: sha(raw), media_type: "message/rfc822", bytes: raw.length }];
    await captureCase(source([r], new Map([[r.id, d]]), new Map([["k", raw]])), layout, r);
    const text = allText(layout.root);
    expect(text).toContain("lure@attacker.example");
    expect(text).toContain("Fraud Desk");
  });

  it("reads a key with spaces and non-ASCII letters, and still refuses traversal", async () => {
    const src = openWranglerSource(join(scratch, "keys"), () => ({ status: 1, stdout: "", stderr: "" }));
    await expect(src.object("case1/invoice details.txt")).resolves.toBeNull();
    await expect(src.object("case1/résumé.txt")).resolves.toBeNull();
    await expect(src.object("case1/../x")).rejects.toThrow(/outside the allowed/);
    await expect(src.object("/etc/passwd")).rejects.toThrow(/outside the allowed/);
    await expect(src.object("case1/a\nb")).rejects.toThrow(/outside the allowed/);
  });
});

describe("coverage is not overstated", () => {
  it("does not count a case whose refresh failed as captured now", async () => {
    const dir = fresh();
    const { r, d, objects } = one();
    await captureAll(source([r], new Map([[r.id, d]]), objects), dir);
    d.feedback = [
      { id: "f1", user_id: "u1", kind: "missed", note: null, providers_json: "[]", created_at: "t", updated_at: "t" },
    ];
    await captureAll(source([r], new Map([[r.id, d]]), new Map()), dir);
    const stats = JSON.parse(readFileSync(layoutOf(resolveRoot(dir)).stats, "utf-8"));
    expect(stats.production).toMatchObject({ seen: 1, captured_now: 0, waiting_to_retry: 1 });
    expect(stats.store.cases).toBe(1);
  });

  it("does not count the payloads of a damaged revision as kept", async () => {
    const dir = fresh();
    const { r, d, objects } = one();
    await captureAll(source([r], new Map([[r.id, d]]), objects), dir);
    const layout = layoutOf(resolveRoot(dir));
    const latest = JSON.parse(readFileSync(join(layout.cases, r.id, "LATEST.json"), "utf-8")).fingerprint;
    rmSync(join(layout.cases, r.id, latest, "p0.json"));
    await captureAll(source([], new Map(), new Map()), dir);
    const stats = JSON.parse(readFileSync(layout.stats, "utf-8"));
    expect(stats.store.integrity_failures).toBe(1);
    expect(stats.payloads.kept).toBe(0);
  });
});

// Round 2 of the independent review (D03 T04 §41).
describe("names hidden in encoded words, keys and half-written files", () => {
  it("finds a recipient name written as a MIME encoded word", async () => {
    const dir = resolveRoot(fresh());
    const layout = layoutOf(dir);
    const raw = new TextEncoder().encode(
      [
        "From: x <billing@paypa1-secure.example>",
        "To: =?UTF-8?B?QWxpY2UgU21pdGg=?= <alice@recipient.example>",
        "Subject: =?UTF-8?Q?Hi_Alice_Smith?=",
        "",
        "body",
      ].join("\r\n"),
    );
    const { r, d } = one({
      row: { forwarded_by: "alice@recipient.example" },
      detail: { members: [{ name: "Alice Smith", email: "alice@recipient.example" }] },
    });
    d.artefacts = [{ r2_key: "k", kind: "raw", sha256: sha(raw), media_type: "message/rfc822", bytes: raw.length }];
    await captureCase(source([r], new Map([[r.id, d]]), new Map([["k", raw]])), layout, r);
    const text = allText(layout.root);
    expect(text).not.toMatch(/QWxpY2UgU21pdGg|Alice|Smith/i);
  });

  it("cleans and checks JSON property names", async () => {
    const dir = resolveRoot(fresh());
    const layout = layoutOf(dir);
    const body = new TextEncoder().encode(JSON.stringify({ "alice@recipient.example": { recipient: "Alice Smith" } }));
    const { r, d } = one({
      row: { forwarded_by: "alice@recipient.example" },
      detail: { members: [{ name: "Alice Smith", email: "alice@recipient.example" }] },
    });
    d.artefacts = [
      { r2_key: "k", kind: "attachment", sha256: sha(body), media_type: "application/json", bytes: body.length },
    ];
    await captureCase(source([r], new Map([[r.id, d]]), new Map([["k", body]])), layout, r);
    expect(allText(layout.root)).not.toMatch(/alice|smith/i);
  });

  it("removes a half-written marker or record, which holds identifiers, at the start of the next run", async () => {
    const dir = fresh();
    const layout = layoutOf(resolveRoot(dir));
    const caseDir = join(layout.cases, "c1");
    mkdirSync(caseDir, { recursive: true });
    writeFileSync(join(caseDir, "PENDING-REDACTION.json.tmp-424242-abcd1234"), '{"recipient":{"names":["Alice"]}}');
    mkdirSync(join(caseDir, "rev1"));
    writeFileSync(join(caseDir, "rev1", "record.json.tmp-1-ab"), "Alice");
    const r = row({ id: "c1" });
    await captureAll(source([r], new Map([["c1", detail({ artefacts: [] })]]), new Map()), dir);
    expect(allText(layout.root)).not.toMatch(/Alice/);
  });

  it("leaves no temporary file when a write fails", () => {
    const dir = resolveRoot(fresh());
    const target = join(dir, "a", "b.json");
    mkdirSync(target, { recursive: true });
    expect(() => writeAtomic(target, "x")).toThrow();
    expect(readdirSync(join(dir, "a")).filter((n) => n.includes(".tmp-"))).toEqual([]);
  });
});

// Round 3 of the independent review (D03 T04 §41).
describe("addresses encoded in another letter case", () => {
  it("removes a base64 or hex token that decodes to the recipient's address, whatever its case", async () => {
    const dir = resolveRoot(fresh());
    const layout = layoutOf(dir);
    const raw = new TextEncoder().encode(
      [
        "From: x <billing@paypa1-secure.example>",
        "To: Alice <Alice@Example.com>",
        "Subject: x",
        "Content-Type: text/plain",
        "",
        `https://evil.example/verify?email=${Buffer.from("Alice@Example.com").toString("base64")}&h=${Buffer.from("ALICE@EXAMPLE.COM").toString("hex")}&u=${Buffer.from("Alice@Example.com").toString("base64url")}`,
      ].join("\r\n"),
    );
    const { r, d } = one({
      row: { forwarded_by: "alice@example.com" },
      detail: { members: [{ name: "Alice", email: "alice@example.com" }] },
    });
    d.artefacts = [{ r2_key: "k", kind: "raw", sha256: sha(raw), media_type: "message/rfc822", bytes: raw.length }];
    const out = await captureCase(source([r], new Map([[r.id, d]]), new Map([["k", raw]])), layout, r);
    expect(out.result).toBe("added");
    const text = allText(layout.root);
    expect(text).not.toContain(Buffer.from("Alice@Example.com").toString("base64"));
    expect(text).not.toContain(Buffer.from("ALICE@EXAMPLE.COM").toString("hex"));
    expect(text).toContain("evil.example");
  });
});

describe("rules that change", () => {
  it("re-cleans an older revision in place, under its own policy, when a newer one is captured", async () => {
    const dir = resolveRoot(fresh());
    const layout = layoutOf(dir);
    const { r, d, src } = one();
    const first = await captureCase(src, layout, r);
    if (first.result !== "added") throw new Error("not added");
    const revision = join(layout.cases, r.id, first.fingerprint);
    // Make it a revision cleaned under older rules that left an address behind.
    const p0 = JSON.parse(readFileSync(join(revision, "p0.json"), "utf-8"));
    p0.text = "left behind thandi.vdmerwe@acme.example";
    const body = JSON.stringify(p0);
    writeFileSync(join(revision, "p0.json"), body);
    const manifest = JSON.parse(readFileSync(join(revision, "manifest.json"), "utf-8"));
    manifest.policy_key = "capture-policy-1";
    manifest.payloads = manifest.payloads.map((p: { file?: string }) =>
      p.file === "p0.json" ? { ...p, sha256: sha(body) } : p,
    );
    writeFileSync(join(revision, "manifest.json"), JSON.stringify(manifest));
    d.feedback = [
      { id: "f1", user_id: "u1", kind: "missed", note: null, providers_json: "[]", created_at: "t", updated_at: "t" },
    ];
    await captureCase(src, layout, r);
    const after = JSON.parse(readFileSync(join(revision, "manifest.json"), "utf-8"));
    expect(after.policy).toBe("phishing");
    expect(after.redacted_in_place).toMatchObject({ reason: "policy_update", from_policy: "phishing" });
    expect(allText(revision)).not.toMatch(/thandi|vdmerwe/i);
    expect(verifyRevision(revision)).toBeNull();
  });

  it("never gives an older genuine revision the weaker phishing rule", async () => {
    const dir = resolveRoot(fresh());
    const layout = layoutOf(dir);
    const { r, src } = one({ row: { verdict: "safe" } });
    const first = await captureCase(src, layout, r);
    if (first.result !== "added") throw new Error("not added");
    const revision = join(layout.cases, r.id, first.fingerprint);
    const manifest = JSON.parse(readFileSync(join(revision, "manifest.json"), "utf-8"));
    manifest.policy_key = "capture-policy-1";
    writeFileSync(join(revision, "manifest.json"), JSON.stringify(manifest));
    // The case is now judged malicious: the newer revision is phishing, the older stays genuine.
    r.verdict = "malicious";
    await captureCase(src, layout, r);
    expect(JSON.parse(readFileSync(join(revision, "manifest.json"), "utf-8")).policy).toBe("genuine");
  });
});

describe("production admission to a training build (§46)", () => {
  const jpeg = async (seed: number) =>
    new Uint8Array(
      await (await import("sharp"))
        .default({ create: { width: 64, height: 64, channels: 3, background: { r: seed * 40, g: 20, b: 30 } } })
        .jpeg()
        .toBuffer(),
    );
  const LABELS = {
    brand: null,
    has_login_form: true,
    has_payment_form: false,
    lure: true,
    lure_type: "credential" as const,
  };
  const put = async (store: ReturnType<typeof openStore>, seed: number, text: string) =>
    store.putPage("production", {
      screenshot: await jpeg(seed),
      text,
      origin: "production",
      licence: "private",
      host: "lure.example",
      template: null,
      south_africa: false,
      labels: LABELS,
      label_source: Object.fromEntries(Object.keys(LABELS).map((k) => [k, "ground-truth"])),
      redacted: false,
    });

  it("trains only admitted production pages, and counts the unadmitted and the withheld", async () => {
    const { buildDataset, NO_FLOORS } = await import("../../scripts/glimmer/build-dataset.ts");
    const store = openStore(fresh());
    const admitted = await put(store, 1, "Sign in to your account now");
    const benignIds: string[] = [];
    for (let i = 0; i < 4; i++) {
      const id = await store.putPage("production", {
        screenshot: await jpeg(10 + i),
        text: `A plain company page number ${i} with opening hours and directions`,
        origin: "production",
        licence: "private",
        host: "plain.example",
        template: null,
        south_africa: false,
        labels: { brand: null, has_login_form: false, has_payment_form: false, lure: false, lure_type: "none" },
        label_source: Object.fromEntries(
          ["brand", "has_login_form", "has_payment_form", "lure", "lure_type"].map((k) => [k, "ground-truth"]),
        ),
        redacted: false,
      });
      benignIds.push(id);
    }
    const unadmitted = await put(store, 2, "Sign in to your account today");
    const withheld = await put(store, 3, "Contact derick@example.com to sign in");
    writeFileSync(
      join(store.dir, "production-admission.json"),
      JSON.stringify({ admitted: [admitted, ...benignIds, withheld], by: "test", at: "2026-11-02T17:40:00Z" }),
    );
    const built = await buildDataset({
      store,
      version: "9.1",
      mode: "text-only",
      seed: 3,
      floors: NO_FLOORS,
      referenceSize: 0,
      protectedTerms: [],
    });
    expect(built.dropped.unadmitted).toBe(1);
    expect(built.dropped.withheldProduction).toBe(1);
    const meta = readFileSync(join(built.dir, "train.meta.jsonl"), "utf-8");
    const evalMeta = readFileSync(join(built.dir, "eval.meta.jsonl"), "utf-8");
    expect([admitted, ...benignIds].some((id) => meta.includes(id))).toBe(true);
    expect(meta).not.toContain(unadmitted);
    expect(meta).not.toContain(withheld);
    expect(evalMeta).not.toContain(unadmitted);
    expect(evalMeta).not.toContain(withheld);
  });
});
