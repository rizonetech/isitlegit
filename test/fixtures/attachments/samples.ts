// Synthetic attachment samples (D02 T04 §1), built here byte by byte from each format's signature: never real files, so no
// program or document is ever stored in the repository.
const bytes = (...parts: (number[] | string | Uint8Array)[]) => {
  const chunks = parts.map((p) =>
    typeof p === "string" ? new TextEncoder().encode(p) : p instanceof Uint8Array ? p : new Uint8Array(p),
  );
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
};
const pad = (n: number, fill = 0x20) => new Uint8Array(n).fill(fill);

// A ZIP local file header naming `name`, its stored data empty.
const zipEntry = (name: string) => {
  const header = new Uint8Array(30);
  header.set([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]);
  header[26] = name.length & 0xff;
  header[27] = name.length >> 8;
  return bytes(header, name);
};

export const samples = {
  pdf: bytes("%PDF-1.7\n%synthetic\n%%EOF\n"),
  zip: bytes(zipEntry("readme.txt"), [0x50, 0x4b, 0x05, 0x06], pad(18, 0)),
  docx: bytes(zipEntry("[Content_Types].xml"), zipEntry("word/document.xml")),
  xlsx: bytes(zipEntry("[Content_Types].xml"), zipEntry("xl/workbook.xml")),
  pptx: bytes(zipEntry("[Content_Types].xml"), zipEntry("ppt/presentation.xml")),
  ole: bytes([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], pad(504, 0)),
  pe: bytes("MZ", pad(62, 0), "This program cannot be run in DOS mode."),
  elf: bytes([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01], pad(57, 0)),
  macho: bytes([0xcf, 0xfa, 0xed, 0xfe], pad(28, 0)),
  rar: bytes("Rar!\x1a\x07\x01\x00", pad(16, 0)),
  "7z": bytes([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0x00, 0x04], pad(24, 0)),
  iso: bytes(pad(32769, 0), "CD001", [0x01], pad(32, 0)),
  png: bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], pad(16, 0)),
  jpeg: bytes([0xff, 0xd8, 0xff, 0xe0], pad(16, 0)),
  gif: bytes("GIF89a", pad(16, 0)),
  webp: bytes("RIFF", [0x24, 0, 0, 0], "WEBPVP8 ", pad(16, 0)),
  html: bytes("\n  <!DOCTYPE html><html><body>Invoice</body></html>"),
  svg: bytes('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"></svg>'),
  lnk: bytes([0x4c, 0, 0, 0, 0x01, 0x14, 0x02, 0x00, 0, 0, 0, 0, 0xc0, 0, 0, 0, 0, 0, 0, 0x46], pad(56, 0)),
  script: bytes("@echo off\r\nstart /b cmd /c echo synthetic\r\n"),
  text: bytes("Invoice 77\nAmount due: R 12 400.00\n"),
} as const;

// More scripts, each by one marker, all inert text.
export const scripts = {
  shebang: bytes("#!/bin/sh\necho synthetic\n"),
  hta: bytes('<html><head><HTA:APPLICATION ID="x"/></head><body>synthetic</body></html>'),
  wsh: bytes('Set s = CreateObject("WScript.Shell")\n'),
  powershell: bytes("powershell -NoProfile -EncodedCommand AAAA\n"),
} as const;
