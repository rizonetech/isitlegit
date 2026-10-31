"""ZIP fixtures for D02 T04 §8: real archives written by Python's own zipfile (deflated and stored members with their
right methods, sizes and CRCs, fixed times, so the same bytes every run), tested with 7-Zip (`7zz t`) before they are
kept, then written as base64 into test/fixtures/attachments/zips.ts. Two are made damaged on purpose after 7-Zip has
tested them whole: a nested ZIP whose declared size is below its real one, and a member whose deflated data is
corrupted. Every file inside is fictional.

    python3 scripts/fixtures/make-zips.py --7zz <path to 7-Zip's 7zz> [--out <file>]
"""

import argparse
import base64
import io
import os
import struct
import subprocess
import tempfile
import zipfile

WHEN = (2026, 10, 31, 12, 0, 0)
PDF = b"%PDF-1.7\n% Fictional invoice INV-0042 from Karoo Fresh Produce (example)\n" + b"0" * 2000 + b"\n%%EOF\n"
# A program's first bytes: the DOS header's "MZ", then room, as a renamed Windows program begins.
PROGRAM = b"MZ" + b"\x90\x00" * 30 + b"This program cannot be run in DOS mode (a test fixture)." + b"\x00" * 4000


def zipped(members, method=zipfile.ZIP_DEFLATED):
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w") as z:
        for name, data in members:
            info = zipfile.ZipInfo(name, WHEN)
            info.compress_type = method
            info.external_attr = 0o644 << 16
            z.writestr(info, data)
    return out.getvalue()


def tested(zz, name, data):
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, name)
        with open(path, "wb") as f:
            f.write(data)
        out = subprocess.run([zz, "t", "-bd", path], capture_output=True, text=True)
        if "Everything is Ok" not in out.stdout:
            raise SystemExit(f"7-Zip did not pass {name}: {out.stdout[-300:]}")
    return data


def patch_declared_size(data, member, size):
    """Writes `size` as `member`'s uncompressed size in its local and central headers (the CRC left as it is)."""
    out = bytearray(data)
    name = member.encode()
    at = 0
    while True:
        at = out.find(b"PK\x03\x04", at)
        if at < 0:
            break
        n = struct.unpack_from("<H", out, at + 26)[0]
        if bytes(out[at + 30 : at + 30 + n]) == name:
            struct.pack_into("<I", out, at + 22, size)
        at += 4
    at = 0
    while True:
        at = out.find(b"PK\x01\x02", at)
        if at < 0:
            break
        n = struct.unpack_from("<H", out, at + 28)[0]
        if bytes(out[at + 46 : at + 46 + n]) == name:
            struct.pack_into("<I", out, at + 24, size)
        at += 4
    return bytes(out)


def corrupt_member(data, member):
    """Overwrites the start of `member`'s deflated data with bytes no deflate stream begins with."""
    out = bytearray(data)
    name = member.encode()
    at = out.find(b"PK\x03\x04")
    while at >= 0:
        n, x = struct.unpack_from("<HH", out, at + 26)
        if bytes(out[at + 30 : at + 30 + n]) == name:
            start = at + 30 + n + x
            out[start : start + 8] = b"\xff" * 8
            return bytes(out)
        at = out.find(b"PK\x03\x04", at + 4)
    raise SystemExit(f"no member {member}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--7zz", dest="zz", required=True)
    parser.add_argument("--out", default="test/fixtures/attachments/zips.ts")
    args = parser.parse_args()
    zz = args.zz
    inner_program = zipped([("payment.pdf", PROGRAM)])
    fixtures = {
        "renamedProgram": tested(zz, "a.zip", zipped([("invoice.pdf", PDF), ("statement.pdf", PROGRAM)])),
        "renamedProgramStored": tested(
            zz, "b.zip", zipped([("invoice.pdf", PDF), ("statement.pdf", PROGRAM)], zipfile.ZIP_STORED)
        ),
        "pdfs": tested(zz, "c.zip", zipped([("invoice.pdf", PDF), ("statement.pdf", PDF)])),
        "nestedProgram": tested(zz, "d.zip", zipped([("readme.pdf", PDF), ("inner.zip", inner_program)])),
        "nestedPdfs": tested(zz, "e.zip", zipped([("inner.zip", zipped([("invoice.pdf", PDF)]))])),
        "thirdLevel": tested(
            zz, "f.zip", zipped([("level2.zip", zipped([("level3.zip", zipped([("deep.pdf", PROGRAM)]))]))])
        ),
    }
    # A nested ZIP of 9 MiB (its zeros stored, the outer ZIP deflating it to a few KiB), its declared size then made
    # 1,000 bytes.
    # The zeros are stored inside inner.zip, so inner.zip itself is 9 MiB when the outer ZIP's deflate is undone.
    big = zipped([("inner.zip", zipped([("zeros.pdf", b"\x00" * (9 * 1024 * 1024))], zipfile.ZIP_STORED))])
    tested(zz, "g.zip", big)
    fixtures["understatedNested"] = patch_declared_size(big, "inner.zip", 1000)
    # Three nested ZIPs of 6 MiB of zeros each: the third passes the 16 MiB inflated in all, shared by both levels.
    six = zipped([("zeros.pdf", b"\x00" * (6 * 1024 * 1024))], zipfile.ZIP_STORED)
    fixtures["budgetAcrossLevels"] = tested(zz, "i.zip", zipped([("a.zip", six), ("b.zip", six), ("c.zip", six)]))
    # A damaged first member, then a renamed program the reader must still reach.
    fixtures["damagedThenProgram"] = corrupt_member(
        tested(zz, "h.zip", zipped([("broken.pdf", PDF), ("statement.pdf", PROGRAM)])), "broken.pdf"
    )
    lines = [
        "// Generated by scripts/fixtures/make-zips.py (D02 T04 §8); do not edit. ZIP archives Python's zipfile wrote",
        "// (deflated unless named stored), tested with 7-Zip before keeping; understatedNested and damagedThenProgram",
        "// are made damaged on purpose after that test. Fictional files.",
    ]
    for name, data in fixtures.items():
        lines.append(f'export const {name}Zip = "{base64.b64encode(data).decode()}";')
    tmp = args.out + ".tmp"
    with open(tmp, "w") as f:
        f.write("\n".join(lines) + "\n")
    os.replace(tmp, args.out)
    print(f"wrote {args.out}")


if __name__ == "__main__":
    main()
