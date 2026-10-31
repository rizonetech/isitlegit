// RTF fixtures for D02 T04 §9: documents with embedded OLE 1.0 objects (MS-OLEDS 2.2), a `Package` object's native data
// laid out as oletools' `OleNativeStream` reads it, each read back by oletools 0.60.2 (`rtfobj`, then `oleobj` for a
// package) before it is kept: the extracted class, file name and bytes must equal what was packed. Written as base64
// into test/fixtures/attachments/rtf.ts. Every file inside is fictional; the "program" is a DOS header and filler.
//
//   node scripts/fixtures/make-rtf.ts --python <a Python with oletools 0.60.2> [--out <file>]
//
// Nothing here installs oletools; give the interpreter of an environment that has it.
import { execFileSync } from "node:child_process";
import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { makeDecoyCompoundFile, renameEntry } from "./msg-builder.ts";

const enc = (text: string) => new TextEncoder().encode(text);
const join8 = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};
const u32 = (v: number) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, v, true);
  return b;
};
const prefixed = (text: string) => (text ? join8(u32(text.length + 1), enc(text), Uint8Array.of(0)) : u32(0));
const cstring = (text: string) => join8(enc(text), Uint8Array.of(0));

// MS-OLEDS 2.2.4 ObjectHeader (OLEVersion 0x0501) and 2.2.5 EmbeddedObject's native data.
export const oleEmbedded = (className: string, native: Uint8Array) =>
  join8(u32(0x0501), u32(2), prefixed(className), prefixed(""), prefixed(""), u32(native.length), native);
const oleLinked = (className: string) =>
  join8(u32(0x0501), u32(1), prefixed(className), prefixed("C:\\fictional\\link.doc"), prefixed(""));
// The Packager's native data, as oletools reads it: header, name, source path, two 4-byte fields, temporary path, size,
// the data.
export const packaged = (name: string, data: Uint8Array) =>
  join8(
    Uint8Array.of(2, 0),
    cstring(name),
    cstring(`C:\\fictional\\${name}`),
    u32(0x00030000),
    u32(0),
    cstring(`C:\\Temp\\${name}`),
    u32(data.length),
    data,
  );
const hex = (bytes: Uint8Array) => {
  const digits = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  // Lines of 128 digits, as word processors write them: the reader ignores the breaks.
  return digits.replace(/(.{128})/g, "$1\r\n");
};
const PROGRAM = join8(
  enc("MZ"),
  new Uint8Array(60).fill(0x90),
  enc("This program cannot be run in DOS mode (a test fixture)."),
  new Uint8Array(4000),
);
const CABINET = join8(enc("MSCF"), new Uint8Array(4), new Uint8Array(200).fill(0x20));
const objectGroup = (body: string) =>
  `{\\object\\objemb{\\*\\objclass Package}\\objw100\\objh100{\\*\\objdata ${body}}}`;
const rtf = (...parts: string[]) =>
  enc(
    `{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 Arial;}}\\pard Fictional letter from Karoo Fresh Produce (example).\\par ${parts.join("\\par ")}}`,
  );
// `\bin N` followed by N raw bytes, written into the RTF text as they are.
const binGroup = (bytes: Uint8Array) =>
  join8(enc(`{\\object\\objemb{\\*\\objdata \\bin${bytes.length} `), bytes, enc("}}"));

type Expect =
  | { kind: "package"; name: string; data: Uint8Array }
  | { kind: "embedded"; className: string; data: Uint8Array }
  | { kind: "linked" }
  | { kind: "none" };

function build(): Record<string, { bytes: Uint8Array; expect: Expect[] }> {
  const decoyMacros = renameEntry(makeDecoyCompoundFile(), "WordDocument", "_VBA_PROJECT");
  const byName = oleEmbedded("Package", packaged("setup.exe", enc("echo fictional")));
  const byBytes = oleEmbedded("Package", packaged("invoice.pdf", PROGRAM));
  const braced = join8(PROGRAM, enc("{\\}}{"));
  const binObject = oleEmbedded("Package", packaged("invoice.pdf", braced));
  const macroPackage = oleEmbedded("Package", packaged("invoice.doc", decoyMacros));
  const wordObject = oleEmbedded("Word.Document.8", decoyMacros);
  const half = Math.floor(byBytes.length / 2);
  // A header with FormatID 7, which is neither embedded nor linked: no reader takes it as an object.
  const damaged = byName.slice();
  damaged.set(u32(7), 4);
  return {
    plain: { bytes: rtf("No objects here."), expect: [] },
    programByName: {
      bytes: rtf(objectGroup(hex(byName))),
      expect: [{ kind: "package", name: "setup.exe", data: enc("echo fictional") }],
    },
    programByBytes: {
      bytes: rtf(objectGroup(hex(byBytes))),
      expect: [{ kind: "package", name: "invoice.pdf", data: PROGRAM }],
    },
    programInBin: {
      bytes: join8(rtf("Binary object:").subarray(0, -1), binGroup(binObject), enc("}")),
      expect: [{ kind: "package", name: "invoice.pdf", data: braced }],
    },
    programMixed: {
      bytes: join8(
        rtf("Mixed object:").subarray(0, -1),
        enc(`{\\object\\objemb{\\*\\objdata ${hex(byBytes.subarray(0, half))}\\bin${byBytes.length - half} `),
        byBytes.subarray(half),
        enc("}}}"),
      ),
      expect: [{ kind: "package", name: "invoice.pdf", data: PROGRAM }],
    },
    macroPackage: {
      bytes: rtf(objectGroup(hex(macroPackage))),
      expect: [{ kind: "package", name: "invoice.doc", data: decoyMacros }],
    },
    macroDocument: {
      bytes: rtf(`{\\object\\objemb{\\*\\objclass Word.Document.8}{\\*\\objdata ${hex(wordObject)}}}`),
      expect: [{ kind: "embedded", className: "Word.Document.8", data: decoyMacros }],
    },
    linked: {
      bytes: rtf(`{\\object\\objlink{\\*\\objdata ${hex(oleLinked("Word.Document.8"))}}}`),
      expect: [{ kind: "linked" }],
    },
    // A damaged object before, and after, a packaged program: the program is still found.
    damagedThenProgram: {
      bytes: rtf(objectGroup(hex(damaged)), objectGroup(hex(byBytes))),
      expect: [{ kind: "none" }, { kind: "package", name: "invoice.pdf", data: PROGRAM }],
    },
    programThenDamaged: {
      bytes: rtf(objectGroup(hex(byBytes)), objectGroup(hex(damaged))),
      expect: [{ kind: "package", name: "invoice.pdf", data: PROGRAM }, { kind: "none" }],
    },
    // The completion review's cases: a class name padded with NULs, a vertical tab and a form feed in the hex, and a
    // packaged cabinet named as a PDF (a cabinet's header and filler, no real members).
    paddedClass: {
      bytes: rtf(objectGroup(hex(oleEmbedded("Package\u0000\u0000", packaged("setup.exe", enc("echo fictional")))))),
      expect: [{ kind: "package", name: "setup.exe", data: enc("echo fictional") }],
    },
    verticalTab: {
      bytes: rtf(objectGroup(`\u000b${hex(byBytes).replace(/(.{40})/, "$1\u000b")}`)),
      expect: [{ kind: "package", name: "invoice.pdf", data: PROGRAM }],
    },
    formFeed: {
      bytes: rtf(objectGroup(hex(byBytes).replace(/(.{40})/, "$1\u000c"))),
      expect: [{ kind: "package", name: "invoice.pdf", data: PROGRAM }],
    },
    packagedCab: {
      bytes: rtf(objectGroup(hex(oleEmbedded("Package", packaged("invoice.pdf", CABINET))))),
      expect: [{ kind: "package", name: "invoice.pdf", data: CABINET }],
    },
    // A header whose data size is larger than the data that follows.
    truncated: { bytes: rtf(objectGroup(hex(byBytes.subarray(0, byBytes.length - 100)))), expect: [{ kind: "none" }] },
  };
}

// oletools' reading of one document, as JSON: per object, its format, class, package name and the data's hex.
const CHECK = String.raw`
import sys, json
from oletools import rtfobj
p = rtfobj.RtfObjParser(open(sys.argv[1], "rb").read())
p.parse()
out = []
for o in p.objects:
    out.append({"is_ole": bool(o.is_ole), "format_id": o.format_id, "class": (o.class_name or b"").rstrip(b"\0").decode("latin1"),
                "package": bool(o.is_package), "name": o.filename,
                "data": (o.olepkgdata if o.is_package else o.oledata or b"").hex()})
print(json.dumps(out))
`;

function verified(python: string, name: string, bytes: Uint8Array, expect: Expect[], dir: string) {
  const path = join(dir, `${name}.rtf`);
  writeFileSync(path, bytes);
  const read = JSON.parse(execFileSync(python, ["-I", "-c", CHECK, path], { encoding: "utf8" })) as {
    is_ole: boolean;
    format_id: number | null;
    class: string;
    package: boolean;
    name: string | null;
    data: string;
  }[];
  const hexOf = (b: Uint8Array) => Buffer.from(b).toString("hex");
  if (read.length !== expect.length)
    throw new Error(`${name}: oletools read ${read.length} objects, expected ${expect.length}`);
  expect.forEach((e, i) => {
    const r = read[i];
    if (!r) throw new Error(`${name}: object ${i + 1} missing`);
    const ok =
      e.kind === "none"
        ? !r.is_ole
        : e.kind === "linked"
          ? r.format_id === 1 // oletools records the FormatID, then stops: a linked object has no data to hash
          : e.kind === "package"
            ? r.package && r.name === e.name && r.data === hexOf(e.data)
            : r.is_ole && !r.package && r.class === e.className && r.data === hexOf(e.data);
    if (!ok) throw new Error(`${name}: object ${i + 1} does not read back as ${e.kind}`);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({
    options: { python: { type: "string" }, out: { type: "string", default: "test/fixtures/attachments/rtf.ts" } },
  });
  if (!values.python) throw new Error("give a Python with oletools 0.60.2 with --python");
  const dir = mkdtempSync(join(tmpdir(), "make-rtf-"));
  const fixtures = build();
  try {
    for (const [name, f] of Object.entries(fixtures)) verified(values.python, name, f.bytes, f.expect, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const text = [
    "// Generated by scripts/fixtures/make-rtf.ts (D02 T04 §9); do not edit. RTF documents with embedded OLE 1.0",
    "// objects, each read back by oletools 0.60.2 before keeping (the truncated and damaged objects as not OLE). Fictional.",
    ...Object.entries(fixtures).map(
      ([name, f]) => `export const ${name}Rtf =\n  "${Buffer.from(f.bytes).toString("base64")}";`,
    ),
    "",
  ].join("\n");
  const out = values.out as string;
  writeFileSync(`${out}.tmp`, text);
  renameSync(`${out}.tmp`, out);
  console.log(`wrote ${out}`);
}
