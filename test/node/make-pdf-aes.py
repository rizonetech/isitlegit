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


def encrypted(revision: int, user: str, metadata: bool = True, packed: bool = False) -> bytes:
    temp = OUT / ".qpdf.tmp"
    with pikepdf.open(SOURCE) as pdf:
        # A classic cross-reference table and no object streams, so an update can follow it; fixed IDs, so a rerun
        # writes the same structure (the AES IVs and the revision 6 file key are random by design).
        pdf.save(
            temp,
            encryption=pikepdf.Encryption(owner="owner", user=user, R=revision, aes=True, metadata=metadata),
            static_id=True,
            # Object streams packed by qpdf for the object-stream files (completion review gap 6), none otherwise.
            object_stream_mode=pikepdf.ObjectStreamMode.generate if packed else pikepdf.ObjectStreamMode.disable,
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


def append_xref_stream_update(base: bytes, objects: dict[int, bytes]) -> bytes:
    """One incremental update after a file whose cross-reference is a stream: the objects redefined, then a new
    cross-reference stream (ISO 32000-1 7.5.8, never encrypted) naming them and the previous one, unfiltered."""
    text = base.decode("latin-1")
    prev = int(re.findall(r"startxref\s+(\d+)", text)[-1])
    last = text[prev:]
    keep = {k: re.search(rf"/{k}\s+(\d+\s+\d+\s+R|\[[^\]]*\]|\d+)", last) for k in ("Root", "Info", "Encrypt", "ID", "Size")}
    if not all(keep.values()):
        raise SystemExit("qpdf's cross-reference stream lacks an entry the update keeps")
    size = int(keep["Size"].group(1))
    out = bytearray(base if base.endswith(b"\n") else base + b"\n")
    offsets: dict[int, int] = {}
    for num, body in sorted(objects.items()):
        offsets[num] = len(out)
        out += f"{num} 0 obj\n".encode() + body + b"\nendobj\n"
    xref_num = size
    offsets[xref_num] = len(out)
    rows = b"".join(bytes([1]) + offsets[n].to_bytes(4, "big") + (0).to_bytes(2, "big") for n in sorted(offsets))
    index = " ".join(f"{n} 1" for n in sorted(offsets))
    entries = " ".join(f"/{k} {keep[k].group(1)}" for k in ("Root", "Info", "Encrypt", "ID"))
    head = f"<< /Type /XRef /Size {size + 1} /Index [{index}] /W [1 4 2] {entries} /Prev {prev} /Length {len(rows)} >>"
    out += f"{xref_num} 0 obj\n{head}\nstream\n".encode() + rows + b"\nendstream\nendobj\n"
    out += f"startxref\n{offsets[xref_num]}\n%%EOF\n".encode()
    return bytes(out)


def packed_resave(base: bytes, revision: int) -> bytes:
    """The object-stream file with one later save writing its Info dictionary (packed by qpdf) again as a direct
    object with its own values, so the earlier definition is the packed one."""
    temp = OUT / ".read.tmp"
    temp.write_bytes(base)
    with pikepdf.open(temp, password="") as pdf:
        key = pdf.encryption.encryption_key
        info_num, info_gen = pdf.trailer.Info.objgen
        info = {str(k).lstrip("/"): str(v) for k, v in pdf.docinfo.items()}
    temp.unlink()
    if not re.search(rb"/Type\s*/ObjStm", base):
        raise SystemExit("qpdf wrote no object stream")
    info_key = object_key(key, revision, info_num, info_gen)
    entries = b" ".join(f"/{k} ".encode() + pdf_string(info_key, v) for k, v in info.items())
    return append_xref_stream_update(base, {info_num: b"<< " + entries + b" >>"})


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


OBJ = re.compile(rb"(?:^|\n)(\d+) 0 obj\n(.*?)\nendobj", re.S)


def aes_open(key: bytes, data: bytes) -> bytes:
    from cryptography.hazmat.primitives.ciphers import Cipher as C

    opener = C(algorithms.AES(key), modes.CBC(data[:16])).decryptor()
    body = opener.update(data[16:]) + opener.finalize()
    unpadder = padding.PKCS7(128).unpadder()
    return unpadder.update(body) + unpadder.finalize()


def rebuild(base: bytes, change) -> bytes:
    """qpdf's single-revision file written again object by object with a new cross-reference table: `change(num,
    body)` returns each object's new body. Used only for the crypt-filter files qpdf cannot write (correction 9)."""
    objects = {int(m.group(1)): m.group(2) for m in OBJ.finditer(base)}
    trailer = re.findall(rb"trailer\s*(<<.*?>>)\s*startxref", base, re.S)[-1]
    out = bytearray(base[: base.index(b"\n") + 1] + b"%\xe2\xe3\xcf\xd3\n")
    offsets: dict[int, int] = {}
    for num in sorted(objects):
        offsets[num] = len(out)
        out += f"{num} 0 obj\n".encode() + change(num, objects[num]) + b"\nendobj\n"
    start = len(out)
    size = max(offsets) + 1
    out += f"xref\n0 {size}\n0000000000 65535 f \n".encode()
    for num in range(1, size):
        out += f"{offsets[num]:010d} 00000 n \n".encode() if num in offsets else b"0000000000 65535 f \n"
    out += b"trailer " + trailer + f"\nstartxref\n{start}\n%%EOF\n".encode()
    return bytes(out)


def stream_parts(body: bytes) -> tuple[bytes, bytes] | None:
    m = re.match(rb"(<<.*>>)\nstream\n", body, re.S)
    if not m:
        return None
    dict_text = m.group(1)
    length = int(re.search(rb"/Length (\d+)", dict_text).group(1))
    return dict_text, body[m.end() : m.end() + length]


def stream_body(dict_text: bytes, data: bytes) -> bytes:
    dict_text = re.sub(rb"/Length \d+", f"/Length {len(data)}".encode(), dict_text)
    return dict_text + b"\nstream\n" + data + b"\nendstream"


def crypt_filter_files(base: bytes) -> dict[str, bytes]:
    """Revision 4 files with crypt filters qpdf does not write: streams stored as is under `/StmF /Identity` while strings
    stay encrypted; one stream with its own `/Crypt` filter naming `/Identity`; and `/StmF` naming a filter `/CF` lacks."""
    temp = OUT / ".read.tmp"
    temp.write_bytes(base)
    with pikepdf.open(temp, password="") as pdf:
        key = pdf.encryption.encryption_key
        content_num = pdf.pages[0].obj.Contents.objgen[0]
        encrypt_num = int(re.search(rb"/Encrypt (\d+) 0 R", base).group(1))
        xref_streams = set()
    temp.unlink()

    def plain_stream(num: int, body: bytes) -> bytes:
        parts = stream_parts(body)
        if not parts:
            return body
        dict_text, data = parts
        return stream_body(dict_text, aes_open(object_key(key, 4, num, 0), data))

    def strings_only(num: int, body: bytes) -> bytes:
        if num == encrypt_num:
            return body.replace(b"/StmF /StdCF", b"/StmF /Identity")
        return plain_stream(num, body) if num not in xref_streams else body

    def crypt_identity(num: int, body: bytes) -> bytes:
        if num != content_num:
            return body
        dict_text, data = stream_parts(body)
        plain = aes_open(object_key(key, 4, num, 0), data)
        dict_text = dict_text.replace(
            b"/Filter /FlateDecode",
            b"/DecodeParms [ << /Type /CryptFilterDecodeParms /Name /Identity >> null ] /Filter [ /Crypt /FlateDecode ]",
        )
        return stream_body(dict_text, plain)

    def unknown_filter(num: int, body: bytes) -> bytes:
        return body.replace(b"/StmF /StdCF", b"/StmF /NoSuchCF") if num == encrypt_num else body

    return {
        "aes-r4-strings-only.pdf": rebuild(base, strings_only),
        "aes-r4-crypt-identity.pdf": rebuild(base, crypt_identity),
        "aes-r4-unknown-filter.pdf": rebuild(base, unknown_filter),
    }


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
        packed = encrypted(revision, "", packed=True)
        place(f"aes-r{revision}-objstm.pdf", packed)
        check(f"aes-r{revision}-objstm.pdf", "", revision)
        place(f"aes-r{revision}-objstm-resaved.pdf", packed_resave(packed, revision))
        check(f"aes-r{revision}-objstm-resaved.pdf", "", revision)
        made += [f"aes-r{revision}{s}.pdf" for s in ("", "-nometa", "-edited", "-resaved", "-objstm", "-objstm-resaved")]
    # The crypt-filter files, each read back by qpdf: the first two to the plain twin's page content.
    base = (OUT / "aes-r4.pdf").read_bytes()
    with pikepdf.open(SOURCE) as twin:
        plain_content = twin.pages[0].obj.Contents.read_bytes()
    for name, data in crypt_filter_files(base).items():
        place(name, data)
        made.append(name)
        if name == "aes-r4-unknown-filter.pdf":
            continue
        check(name, "", 4)
        with pikepdf.open(OUT / name, password="") as pdf:
            if pdf.pages[0].obj.Contents.read_bytes() != plain_content:
                raise SystemExit(f"{name}: qpdf read another page content")
    place("aes-password.pdf", encrypted(6, "secret"))
    check("aes-password.pdf", "secret", 6)
    made.append("aes-password.pdf")
    for name in made:
        print(f"{name}: {(OUT / name).stat().st_size} bytes")
    print(f"pikepdf {pikepdf.__version__}, qpdf {pikepdf.__libqpdf_version__}, cryptography {cryptography.__version__}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
