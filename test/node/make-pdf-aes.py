"""AES-encrypted PDF fixtures for D06 T02 §6, encrypted by an independent tool: pikepdf over qpdf.

Run once with a scratch virtual environment holding pikepdf and cryptography (fixture generation only, never a
dependency of the project; `.claude/skills/local-tool-safety`):

    <venv>/bin/python -I test/node/make-pdf-aes.py

The source is Ghostscript's proof of payment, `test/fixtures/pdf-forensics/gs-genuine-pop.pdf`, the document §5's RC4
files hold, so its page text, Info strings and XMP are the ones the tests already know. qpdf writes each encrypted
file; the incremental updates after it (correction 8: an edit drawn over the amount, and a save of the Info
dictionary with its own values) are encrypted here with `cryptography`'s AES-CBC under the file key qpdf reports, so
the earlier revision is always qpdf's own. Each file is written to a temporary name beside its target, moved into
place, and opened again by qpdf to read back what the tests rely on.
"""

from __future__ import annotations

import hashlib
import os
import re
import sys
import zlib
from pathlib import Path

import cryptography
import pikepdf
from cryptography.hazmat.primitives import padding
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

HERE = Path(__file__).resolve().parent
OUT = HERE.parent / "fixtures" / "pdf-encodings"
SOURCE = HERE.parent / "fixtures" / "pdf-forensics" / "gs-genuine-pop.pdf"
TITLE = "Payment INV-2026-0412"
EDIT = "112 450.00"


def place(name: str, data: bytes) -> Path:
    target = OUT / name
    temp = OUT / f".{name}.tmp"
    temp.write_bytes(data)
    os.replace(temp, target)
    return target


def encrypted(revision: int, user: str, metadata: bool = True) -> bytes:
    temp = OUT / ".qpdf.tmp"
    with pikepdf.open(SOURCE) as pdf:
        # A classic cross-reference table and no object streams, so an update can follow it; fixed IDs, so a rerun
        # writes the same structure (the AES IVs and the revision 6 file key are random by design).
        pdf.save(
            temp,
            encryption=pikepdf.Encryption(owner="owner", user=user, R=revision, aes=True, metadata=metadata),
            static_id=True,
            object_stream_mode=pikepdf.ObjectStreamMode.disable,
            compress_streams=True,
            # pikepdf otherwise rewrites the XMP packet to record the PDF version; the metadata stays Ghostscript's.
            fix_metadata_version=False,
        )
    data = temp.read_bytes()
    temp.unlink()
    return data


def aes(key: bytes, plain: bytes) -> bytes:
    iv = os.urandom(16)
    padder = padding.PKCS7(128).padder()
    body = padder.update(plain) + padder.finalize()
    sealer = Cipher(algorithms.AES(key), modes.CBC(iv)).encryptor()
    return iv + sealer.update(body) + sealer.finalize()


def object_key(file_key: bytes, revision: int, num: int, gen: int) -> bytes:
    # ISO 32000-1 7.6.2 algorithm 1 with the AES salt for revision 4; revision 6 uses the file key itself.
    if revision == 6:
        return file_key
    salt = num.to_bytes(3, "little") + gen.to_bytes(2, "little") + b"sAlT"
    return hashlib.md5(file_key + salt).digest()[:16]


def pdf_string(key: bytes, text: str) -> bytes:
    return b"<" + aes(key, text.encode("latin-1")).hex().encode() + b">"


def append_update(base: bytes, objects: dict[int, bytes]) -> bytes:
    """One incremental update (ISO 32000-1 7.5.6): the objects redefined, a cross-reference section for them, and a
    trailer naming the previous one."""
    text = base.decode("latin-1")
    prev = int(re.findall(r"startxref\s+(\d+)", text)[-1])
    trailer = re.findall(r"trailer\s*<<(.*?)>>\s*startxref", text, re.S)[-1]
    keep = {k: re.search(rf"/{k}\s+(\d+\s+\d+\s+R|\[[^\]]*\]|\d+)", trailer) for k in ("Size", "Root", "Info", "Encrypt", "ID")}
    if not all(keep.values()):
        raise SystemExit("qpdf's trailer lacks an entry the update keeps")
    out = bytearray(base if base.endswith(b"\n") else base + b"\n")
    offsets: dict[int, int] = {}
    for num, body in sorted(objects.items()):
        offsets[num] = len(out)
        out += f"{num} 0 obj\n".encode() + body + b"\nendobj\n"
    start = len(out)
    out += b"xref\n"
    for num in sorted(offsets):
        out += f"{num} 1\n{offsets[num]:010d} 00000 n \n".encode()
    entries = " ".join(f"/{k} {m.group(1)}" for k, m in keep.items() if m)
    out += f"trailer\n<< {entries} /Prev {prev} >>\nstartxref\n{start}\n%%EOF\n".encode()
    return bytes(out)


def updates(base: bytes, revision: int) -> tuple[bytes, bytes]:
    """The edited twin (the page content with the amount drawn over) and the resaved one (the Info dictionary written
    again with its own values), each one update after qpdf's file."""
    temp = OUT / ".read.tmp"
    temp.write_bytes(base)
    with pikepdf.open(temp, password="") as pdf:
        key = pdf.encryption.encryption_key
        page = pdf.pages[0].obj
        contents = page.Contents
        num, gen = contents.objgen
        content = contents.read_bytes()
        font = str(next(iter(page.Resources.Font.keys()))).lstrip("/")
        info_num, info_gen = pdf.trailer.Info.objgen
        info = {str(k).lstrip("/"): str(v) for k, v in pdf.docinfo.items()}
    temp.unlink()
    edited_content = content + f"\nq 1 0 0 1 0 0 cm BT /{font} 11 Tf 120 620 Td ({EDIT}) Tj ET Q".encode()
    sealed = aes(object_key(key, revision, num, gen), zlib.compress(edited_content))
    stream = f"<< /Filter /FlateDecode /Length {len(sealed)} >>\nstream\n".encode() + sealed + b"\nendstream"
    edited = append_update(base, {num: stream})
    info_key = object_key(key, revision, info_num, info_gen)
    entries = b" ".join(f"/{k} ".encode() + pdf_string(info_key, v) for k, v in info.items())
    resaved = append_update(base, {info_num: b"<< " + entries + b" >>"})
    return edited, resaved


def check(name: str, user: str, revision: int, page_has: str | None = None) -> None:
    with pikepdf.open(OUT / name, password=user) as pdf:
        if not pdf.is_encrypted or pdf.encryption.R != revision:
            raise SystemExit(f"{name}: read back as revision {pdf.encryption.R}")
        if str(pdf.docinfo.get("/Title")) != TITLE:
            raise SystemExit(f"{name}: the Title did not read back")
        if page_has and page_has.encode() not in pdf.pages[0].obj.Contents.read_bytes():
            raise SystemExit(f"{name}: the page content did not read back")


def main() -> int:
    made: list[str] = []
    for revision in (4, 6):
        base = encrypted(revision, "")
        place(f"aes-r{revision}.pdf", base)
        check(f"aes-r{revision}.pdf", "", revision)
        place(f"aes-r{revision}-nometa.pdf", encrypted(revision, "", metadata=False))
        check(f"aes-r{revision}-nometa.pdf", "", revision)
        edited, resaved = updates(base, revision)
        place(f"aes-r{revision}-edited.pdf", edited)
        check(f"aes-r{revision}-edited.pdf", "", revision, page_has=EDIT)
        place(f"aes-r{revision}-resaved.pdf", resaved)
        check(f"aes-r{revision}-resaved.pdf", "", revision)
        made += [f"aes-r{revision}{s}.pdf" for s in ("", "-nometa", "-edited", "-resaved")]
    place("aes-password.pdf", encrypted(6, "secret"))
    check("aes-password.pdf", "secret", 6)
    made.append("aes-password.pdf")
    for name in made:
        print(f"{name}: {(OUT / name).stat().st_size} bytes")
    print(f"pikepdf {pikepdf.__version__}, qpdf {pikepdf.__libqpdf_version__}, cryptography {cryptography.__version__}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
