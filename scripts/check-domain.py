#!/usr/bin/env python3
"""Prove isitlegit.co.za is set up as D99 T01 §2 records it, from public DNS (1.1.1.1), not only its nameservers.

    python3 scripts/check-domain.py

Each record is compared with what §2 published, so any edit to it fails, not only the weakenings someone thought
of: the two Cloudflare nameservers; Email Routing's three MX hosts; exactly one SPF record, byte for byte
`v=spf1 include:_spf.mx.cloudflare.net ~all`; exactly one DMARC record, byte for byte the published one (`p=reject`,
`sp=reject`, relaxed alignment, `fo=1`, reports only to dmarc@isitlegit.co.za), a trailing semicolon allowed; CAA `issue` tags (not `issuewild`) naming only
Universal SSL's authorities and including Let's Encrypt, Google Trust Services and SSL.com (RFC 8659 4.2, 4.3); the
registry's DS (key tag 2371, algorithm 13, digest type 2, the recorded digest); and the zone validated (`ad`).

A lookup that could not be made (no network, a resolver error, a timeout) is reported as that, exit 2, never as a
wrong record. Prints the number of checks passed and exits 0 only when all pass, 1 when a record is wrong. Stdlib
only; needs `dig`.
"""
import re
import subprocess
import sys

DOMAIN = "isitlegit.co.za"
RESOLVER = "1.1.1.1"
NAMESERVERS = {"carmelo.ns.cloudflare.com.", "paris.ns.cloudflare.com."}
MX_HOSTS = {"route1.mx.cloudflare.net.", "route2.mx.cloudflare.net.", "route3.mx.cloudflare.net."}
# The records exactly as §2 published them: a check that names what must be there, not what must not, so a weakening
# nobody foresaw (a tag added, a term reordered) fails too. Changing either record means changing it here as well.
# Compared as text, byte for byte (DMARC's one optional trailing semicolon aside): four review rounds found reorderings,
# repeated or empty tags and extra terms that a parser let through, so nothing is parsed, only matched.
SPF_RECORD = "v=spf1 include:_spf.mx.cloudflare.net ~all"
DMARC_RECORD = "v=DMARC1; p=reject; sp=reject; adkim=r; aspf=r; fo=1; rua=mailto:dmarc@isitlegit.co.za"
# Universal SSL's authorities (https://developers.cloudflare.com/ssl/reference/certificate-authorities/); Cloudflare adds
# its own CAA rows for them, so Sectigo (comodoca.com) and DigiCert may appear beside the three the section names.
CLOUDFLARE_CAS = {"letsencrypt.org", "pki.goog", "ssl.com", "comodoca.com", "digicert.com", "sectigo.com"}
REQUIRED_CAS = {"letsencrypt.org", "pki.goog", "ssl.com"}
DS = ("2371", "13", "2", "360CD8AC177997F22F9239EF3EB686AAAEDF101C211B330C684B723928504665")
CHECKS = 7


class LookupFailed(Exception):
    """A DNS query that could not be answered: the network, the resolver or a timeout, not the zone."""


def dig(kind, name=DOMAIN, dnssec=False):
    """(answer rdata strings, the header's flags line) for one query; LookupFailed when no answer came back."""
    args = ["dig", f"@{RESOLVER}", "+time=5", "+tries=2", "+noall", "+comments", "+answer"]
    try:
        done = subprocess.run([*args, *(["+dnssec"] if dnssec else []), kind, name], capture_output=True, text=True,
                              timeout=30)
    except subprocess.TimeoutExpired:
        raise LookupFailed(f"{kind} {name}: no answer within 30 s") from None
    except OSError as exc:
        raise LookupFailed(f"dig could not run ({exc.strerror}); install dnsutils") from None
    if done.returncode != 0:
        reason = (done.stderr.strip() or done.stdout.strip()).splitlines()[-1:] or ["no reason given"]
        raise LookupFailed(f"{kind} {name}: dig exited {done.returncode} ({reason[0][:120]})")
    status = re.search(r"status: ([A-Z]+)", done.stdout)
    if not status:
        raise LookupFailed(f"{kind} {name}: no DNS response header")
    if status[1] not in ("NOERROR", "NXDOMAIN"):
        raise LookupFailed(f"{kind} {name}: the resolver answered {status[1]}")
    flags = next((line for line in done.stdout.splitlines() if line.startswith(";; flags:")), "")
    rdata = []
    for line in done.stdout.splitlines():
        if not line or line.startswith(";"):
            continue
        parts = line.split(None, 4)
        if len(parts) == 5 and parts[3] == kind:
            rdata.append(parts[4])
    return rdata, flags


def answers(lookup=dig):
    """Each record set this checks, and the validation flags."""
    return {"NS": lookup("NS")[0], "MX": lookup("MX")[0], "TXT": lookup("TXT")[0],
            "DMARC": lookup("TXT", f"_dmarc.{DOMAIN}")[0], "CAA": lookup("CAA")[0], "DS": lookup("DS")[0],
            "flags": lookup("A", DOMAIN, True)[1]}


def txt(rdata):
    """A TXT record's text: its quoted strings joined (RFC 7208 3.3)."""
    parts = re.findall(r'"((?:[^"\\]|\\.)*)"', rdata)
    return "".join(parts) if parts else rdata


def check(a):
    """(passed checks, refusals) from the answers."""
    passed, refusals = 0, []

    def need(ok, what):
        nonlocal passed
        if ok:
            passed += 1
        else:
            refusals.append(what)

    need(set(a["NS"]) == NAMESERVERS, f"nameservers are {sorted(a['NS'])}, not {sorted(NAMESERVERS)}")
    need({line.split()[-1] for line in a["MX"] if line.split()} == MX_HOSTS and len(a["MX"]) == len(MX_HOSTS),
         f"MX hosts are {sorted(a['MX'])}, not Email Routing's three")

    spf = [txt(r) for r in a["TXT"] if txt(r).lower().startswith("v=spf1")]
    need(spf == [SPF_RECORD],
         f"SPF is not the one published record, {SPF_RECORD!r}"
         + (f" ({len(spf)} SPF records)" if len(spf) != 1 else f" (it reads {spf[0]!r})"))

    # Any record that begins like a DMARC record counts, so a mistyped version is refused rather than skipped.
    dmarc = [txt(r) for r in a["DMARC"] if txt(r).lower().startswith("v=dmarc")]
    need(len(dmarc) == 1 and dmarc[0].strip() in (DMARC_RECORD, DMARC_RECORD + ";"),
         f"DMARC is not the one published record, {DMARC_RECORD!r}"
         + (f" ({len(dmarc)} DMARC records)" if len(dmarc) != 1 else f" (it reads {dmarc[0]!r})"))

    issuers, wild = set(), set()
    for line in a["CAA"]:
        parts = line.split(None, 2)
        if len(parts) == 3 and parts[1].lower() in ("issue", "issuewild"):
            (issuers if parts[1].lower() == "issue" else wild).add(txt(parts[2]).split(";")[0].strip().lower())
    # issue authorizes ordinary certificates, issuewild wildcard ones (RFC 8659 4.2, 4.3): both only Universal SSL's.
    need(bool(issuers) and issuers <= CLOUDFLARE_CAS and REQUIRED_CAS <= issuers and wild <= CLOUDFLARE_CAS,
         f"CAA issue {sorted(issuers)} and issuewild {sorted(wild)} are not Universal SSL's only, with Let's Encrypt, "
         "Google and SSL.com issuing")

    ds = [line.split() for line in a["DS"]]
    need(any(r[:3] == list(DS[:3]) and "".join(r[3:]).upper() == DS[3] for r in ds),
         "the DS record at the registry is not key tag 2371, algorithm 13, digest type 2 with the recorded digest")
    found = re.search(r"flags:([^;]*);", a["flags"])
    flag_words = found[1].split() if found else []
    need("ad" in flag_words, "the resolver did not validate the zone (no ad flag)")
    return passed, refusals


def run(lookup=dig):
    """(exit code, lines to print)."""
    try:
        passed, refusals = check(answers(lookup))
    except LookupFailed as exc:
        return 2, [f"check-domain: a lookup failed, so nothing was judged: {exc}"]
    return (0 if not refusals else 1), [*(f"check-domain: {r}" for r in refusals),
                                        f"check-domain: {passed} of {CHECKS} checks passed"]


if __name__ == "__main__":
    code, lines = run()
    for line in lines:
        print(line, file=sys.stderr if code and "checks passed" not in line else sys.stdout)
    sys.exit(code)
