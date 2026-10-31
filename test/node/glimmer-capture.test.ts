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
  layoutOf,
  type Manifest,
  policyFor,
  recipientOf,
  resolveRoot,
  scrubRecipient,
  sweepInterrupted,
  takeLock,
} from "../../scripts/glimmer/capture-cases.ts";
import { d1Rows, openWranglerSource, QUERY } from "../../scripts/glimmer/capture-source.ts";
import { openStore } from "../../scripts/glimmer/store.ts";

// D03 T04 §34: day-zero case capture. Synthetic data only; nothing here reads production or the real store.
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
    expect(stats.cases_captured).toBe(5);
    expect(stats.by_verdict).toEqual({ malicious: 1, safe: 4 });
    expect(stats.by_category).toEqual({ unknown: 5 });
    expect(readFileSync(root.statsMd, "utf-8")).toContain("Cases seen: 5");
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
    const stats = JSON.parse(readFileSync(layout.stats, "utf-8"));
    expect(stats.cases_captured).toBe(1);
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
    expect(() => QUERY.artefacts("x'; DROP TABLE cases; --")).toThrow(/outside the allowed/);
    for (const sql of [
      QUERY.cases("abc", 50),
      QUERY.artefacts("abc"),
      QUERY.evidence("abc"),
      QUERY.checks("abc"),
      QUERY.feedback("abc"),
      QUERY.verdict("abc"),
      QUERY.members("org", "u1", "a@b.example") ?? "",
    ]) {
      expect(sql).toMatch(/^SELECT /);
      expect(sql).not.toContain(";");
    }
    expect(QUERY.evidence("abc")).toContain("COALESCE((SELECT run_id FROM cases");
    expect(QUERY.members("org", null, "x' OR 1=1 --")).toBeNull();
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
