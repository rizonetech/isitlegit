// A small PDF writer for the forensics tests (D06 T02 §1): synthetic documents of fictional banks and suppliers, built
// to the structures ISO 32000-1 names (cross-reference tables and streams, object streams, incremental updates, a
// linearized layout), so each reader path and each finding has a file that exercises it. Every document it makes says
// "SYNTHETIC TEST DOCUMENT". It runs in workerd and in Node (test/node/make-pdf-forensics.ts).

export type Obj = string | { dict: string; stream: string | Uint8Array; compress?: boolean };
export type Objects = Record<number, Obj>;
export type XrefStyle = "table" | "stream" | "stream-predictor" | "stream-tiff" | "hybrid";

export const latin1 = (bytes: Uint8Array) => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return s;
};
export const toBytes = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);

export async function deflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = bytesStream(data).pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function body(num: number, obj: Obj): Promise<string> {
  if (typeof obj === "string") return `${num} 0 obj\n${obj}\nendobj\n`;
  let data = typeof obj.stream === "string" ? toBytes(obj.stream) : obj.stream;
  let dict = obj.dict;
  if (obj.compress) {
    data = await deflate(data);
    dict = dict.replace(/>>\s*$/, " /Filter /FlateDecode>>");
  }
  dict = dict.replace(/>>\s*$/, ` /Length ${data.length}>>`);
  return `${num} 0 obj\n${dict}\nstream\n${latin1(data)}\nendstream\nendobj\n`;
}

type Section = { text: string; offsets: Map<number, number>; packed: Map<number, [number, number]> };

// The objects written at `base` (the length of what precedes them), packing plain objects into one object stream
// numbered `objStm` when asked.
async function writeObjects(objects: Objects, base: number, objStm?: number): Promise<Section> {
  const offsets = new Map<number, number>();
  const packed = new Map<number, [number, number]>();
  let text = "";
  const nums = Object.keys(objects)
    .map(Number)
    .sort((a, b) => a - b);
  const plain = objStm ? nums.filter((n) => typeof objects[n] === "string") : [];
  for (const n of nums) {
    if (plain.includes(n)) continue;
    offsets.set(n, base + text.length);
    text += await body(n, objects[n] as Obj);
  }
  if (objStm && plain.length) {
    let header = "";
    let content = "";
    plain.forEach((n, i) => {
      header += `${n} ${content.length} `;
      content += `${objects[n]}\n`;
      packed.set(n, [objStm, i]);
    });
    offsets.set(objStm, base + text.length);
    text += await body(objStm, {
      dict: `<</Type /ObjStm /N ${plain.length} /First ${header.length}>>`,
      stream: header + content,
      compress: true,
    });
  }
  return { text, offsets, packed };
}

function table(entries: Map<number, number>, freed: number[]): string {
  const all = new Map<number, string>();
  for (const [n, off] of entries) all.set(n, `${String(off).padStart(10, "0")} 00000 n\r\n`);
  for (const n of freed) all.set(n, "0000000000 00001 f\r\n");
  const nums = [...all.keys()].sort((a, b) => a - b);
  let out = "xref\n";
  // One subsection per run of consecutive numbers.
  for (let i = 0; i < nums.length; ) {
    let j = i;
    while (j + 1 < nums.length && (nums[j + 1] as number) === (nums[j] as number) + 1) j++;
    out += `${nums[i]} ${j - i + 1}\n`;
    for (let k = i; k <= j; k++) out += all.get(nums[k] as number);
    i = j + 1;
  }
  return out;
}

async function xrefStream(
  num: number,
  offsets: Map<number, number>,
  packed: Map<number, [number, number]>,
  freed: number[],
  self: number,
  trailer: string,
  predictor: false | "png" | "tiff",
): Promise<string> {
  const rows = new Map<number, number[]>();
  for (const [n, off] of offsets) rows.set(n, [1, off, 0]);
  for (const [n, [s, i]] of packed) rows.set(n, [2, s, i]);
  for (const n of freed) rows.set(n, [0, 0, 1]);
  rows.set(num, [1, self, 0]);
  const nums = [...rows.keys()].sort((a, b) => a - b);
  const index: number[] = [];
  for (let i = 0; i < nums.length; ) {
    let j = i;
    while (j + 1 < nums.length && (nums[j + 1] as number) === (nums[j] as number) + 1) j++;
    index.push(nums[i] as number, j - i + 1);
    i = j + 1;
  }
  const width = 7;
  const plainRows = nums.map((n) => {
    const [t, a, b] = rows.get(n) as number[];
    return [
      t as number,
      (a as number) >>> 24,
      ((a as number) >> 16) & 255,
      ((a as number) >> 8) & 255,
      (a as number) & 255,
      ((b as number) >> 8) & 255,
      (b as number) & 255,
    ];
  });
  let data: number[];
  if (predictor === "tiff") {
    // TIFF predictor 2 (7.4.4.4): each byte of a row stored as its difference from the byte before it in the row.
    data = plainRows.flatMap((row) => row.map((v, i) => (v - (i > 0 ? (row[i - 1] as number) : 0)) & 255));
  } else if (predictor) {
    // PNG Up prediction (RFC 2083), as most writers use for cross-reference streams.
    data = [];
    plainRows.forEach((row, r) => {
      data.push(2);
      row.forEach((v, i) => {
        data.push((v - (r > 0 ? ((plainRows[r - 1] as number[])[i] as number) : 0)) & 255);
      });
    });
  } else data = plainRows.flat();
  const parms =
    predictor === "tiff"
      ? ` /DecodeParms <</Predictor 2 /Colors 1 /BitsPerComponent 8 /Columns ${width}>>`
      : predictor
        ? ` /DecodeParms <</Predictor 12 /Columns ${width}>>`
        : "";
  return body(num, {
    dict: `<</Type /XRef /W [1 4 2] /Index [${index.join(" ")}]${parms} ${trailer}>>`,
    stream: Uint8Array.from(data),
    compress: predictor !== false,
  });
}

export type BuildOptions = {
  objects: Objects;
  root: number;
  info?: number | undefined;
  size: number;
  xref?: XrefStyle | undefined;
  freed?: number[];
  linearized?: boolean | undefined;
  trailerExtra?: string;
};

// A whole file. With `linearized`, object 1 is replaced by a linearization dictionary and a first-page cross-reference
// section follows it, its /Prev naming the main section at the end (Annex F's layout, without hint streams).
export async function buildPdf(o: BuildOptions): Promise<Uint8Array> {
  const style = o.xref ?? "table";
  let out = "%PDF-1.7\n%\xe2\xe3\xcf\xd3\n";
  const infoRef = o.info ? ` /Info ${o.info} 0 R` : "";
  const trailerCore = `/Size ${o.size} /Root ${o.root} 0 R${infoRef}${o.trailerExtra ?? ""}`;
  if (o.linearized) {
    // Placeholder linearization and first-page section, patched once the main section's offset is known.
    const lin = (len: number) =>
      `1 0 obj\n<</Linearized 1 /L ${String(len).padStart(10, "0")} /E 0000000400 /N 1>>\nendobj\n`;
    const firstAt = out.length + lin(0).length;
    const objects = { ...o.objects };
    delete objects[1];
    const firstSection = (prev: number) =>
      `xref\n1 1\n${String(out.length).padStart(10, "0")} 00000 n\r\ntrailer\n<<${trailerCore} /Prev ${String(prev).padStart(10, "0")}>>\nstartxref\n${firstAt}\n%%EOF\n`;
    const head = out + lin(0) + firstSection(0);
    const sec = await writeObjects(objects, head.length);
    const mainAt = head.length + sec.text.length;
    const main = `${table(sec.offsets, o.freed ?? [])}trailer\n<<${trailerCore}>>\nstartxref\n${mainAt}\n%%EOF\n`;
    const total = head.length + sec.text.length + main.length;
    const final = out + lin(total) + firstSection(mainAt) + sec.text + main;
    // The file ends at the main section, but its last startxref names the first-page section, as Annex F has it.
    return toBytes(final.replace(/startxref\n\d+\n%%EOF\n$/, `startxref\n${firstAt}\n%%EOF\n`));
  }
  const objStm = style === "table" ? undefined : o.size;
  const sec = await writeObjects(
    o.objects,
    out.length,
    style === "stream" || style === "stream-predictor" || style === "stream-tiff" ? objStm : undefined,
  );
  out += sec.text;
  const xrefAt = out.length;
  if (style === "table") out += `${table(sec.offsets, o.freed ?? [])}trailer\n<<${trailerCore}>>\n`;
  else if (style === "hybrid") {
    const xs = await xrefStream(o.size, new Map(), new Map(), [], xrefAt, `/Size ${o.size + 1}`, false);
    out += xs;
    const tableAt = out.length;
    out += `${table(sec.offsets, o.freed ?? [])}trailer\n<<${trailerCore.replace(`/Size ${o.size}`, `/Size ${o.size + 1}`)} /XRefStm ${xrefAt}>>\n`;
    return toBytes(`${out}startxref\n${tableAt}\n%%EOF\n`);
  } else {
    const size = o.size + 2;
    out += await xrefStream(
      o.size + 1,
      sec.offsets,
      sec.packed,
      o.freed ?? [],
      xrefAt,
      trailerCore.replace(`/Size ${o.size}`, `/Size ${size}`),
      style === "stream-predictor" ? "png" : style === "stream-tiff" ? "tiff" : false,
    );
  }
  return toBytes(`${out}startxref\n${xrefAt}\n%%EOF\n`);
}

// An incremental update (7.5.6): the new and changed objects appended with a section whose /Prev names the last one.
export async function appendUpdate(
  base: Uint8Array,
  o: {
    objects: Objects;
    root: number;
    info?: number | undefined;
    size: number;
    freed?: number[];
    xref?: "table" | "stream";
    // More trailer entries, such as an encrypted file's /Encrypt and /ID, which every update's trailer repeats (7.6.1).
    trailerExtra?: string;
  },
): Promise<Uint8Array> {
  const prior = latin1(base);
  const m = /startxref\s+(\d+)\s+%%EOF\s*$/.exec(prior);
  if (!m) throw new Error("no startxref to update");
  let out = prior.endsWith("\n") ? prior : `${prior}\n`;
  const sec = await writeObjects(o.objects, out.length);
  out += sec.text;
  const at = out.length;
  const infoRef = o.info ? ` /Info ${o.info} 0 R` : "";
  if (o.xref === "stream")
    out += await xrefStream(
      o.size,
      sec.offsets,
      new Map(),
      o.freed ?? [],
      at,
      `/Size ${o.size + 1} /Root ${o.root} 0 R${infoRef}${o.trailerExtra ?? ""} /Prev ${m[1]}`,
      false,
    );
  else
    out += `${table(sec.offsets, o.freed ?? [])}trailer\n<</Size ${o.size} /Root ${o.root} 0 R${infoRef}${o.trailerExtra ?? ""} /Prev ${m[1]}>>\n`;
  return toBytes(`${out}startxref\n${at}\n%%EOF\n`);
}

// A PDF literal string for text in a content stream.
export const pdfText = (s: string) => `(${s.replace(/[\\()]/g, (c) => `\\${c}`)})`;
export type TextLine = { font: string; size: number; x: number; y: number; text: string };
export const contentOf = (lines: TextLine[], extra = "") =>
  `${lines.map((l) => `BT /${l.font} ${l.size} Tf ${l.x} ${l.y} Td ${pdfText(l.text)} Tj ET`).join("\n")}\n${extra}`;

// One chunk of bytes as a stream, for a (de)compression stream to read (a Blob of a Uint8Array view does not type-check
// under Node's lib, which the fixture maker uses).
// The bytes are always over an ArrayBuffer here (read from a file or decoded), which the cast states.
function bytesStream(data: Uint8Array): ReadableStream<Uint8Array<ArrayBuffer>> {
  return new ReadableStream<Uint8Array<ArrayBuffer>>({
    start(controller) {
      controller.enqueue(data as Uint8Array<ArrayBuffer>);
      controller.close();
    },
  });
}
