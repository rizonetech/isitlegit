#!/usr/bin/env python3
"""Prove isitlegit.co.za is set up as D99 T01 §2 records it, from public DNS (1.1.1.1), not only its nameservers.

    python3 scripts/check-domain.py

Each record is parsed as its standard defines it, so an edit that weakens it fails rather than passing on a
substring: the two Cloudflare nameservers; Email Routing's three MX hosts; exactly one SPF record whose
`include:_spf.mx.cloudflare.net` comes before any `all` (RFC 7208 4.5, 5.1); exactly one DMARC record with `p=reject`
and reports going only to dmarc@isitlegit.co.za (RFC 7489 6.3, 6.4); CAA `issue` tags (not `issuewild`) naming only
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
SPF_INCLUDE = "include:_spf.mx.cloudflare.net"
DMARC_REPORTS = {"mailto:dmarc@isitlegit.co.za"}
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

    spf = [txt(r) for r in a["TXT"] if txt(r).lower().startswith("v=spf1 ") or txt(r).lower() == "v=spf1"]
    terms = spf[0].split()[1:] if len(spf) == 1 else []
    reach = next((i for i, t in enumerate(terms) if t.lstrip("+-~?").lower() == "all"), len(terms))
    need(len(spf) == 1 and SPF_INCLUDE in [t.lstrip("+").lower() for t in terms[:reach]],
         "SPF is not one record whose include:_spf.mx.cloudflare.net comes before any all"
         + (f" ({len(spf)} SPF records)" if len(spf) != 1 else ""))

    dmarc = [txt(r) for r in a["DMARC"] if txt(r).startswith("v=DMARC1")]
    tags = {}
    if len(dmarc) == 1:
        for part in dmarc[0].split(";"):
            key, _, value = part.strip().partition("=")
            if key:
                tags[key.strip().lower()] = value.strip()
    reports = {re.sub(r"!\d+[kmgt]?$", "", r.strip(), flags=re.I).lower() for r in tags.get("rua", "").split(",") if r.strip()}
    need(len(dmarc) == 1 and tags.get("p", "").lower() == "reject" and reports == DMARC_REPORTS,
         "DMARC is not one record with p=reject and reports only to dmarc@isitlegit.co.za"
         + (f" ({len(dmarc)} DMARC records)" if len(dmarc) != 1 else ""))

    issuers = set()
    for line in a["CAA"]:
        parts = line.split(None, 2)
        if len(parts) == 3 and parts[1].lower() == "issue":
            issuers.add(txt(parts[2]).split(";")[0].strip().lower())
    need(bool(issuers) and issuers <= CLOUDFLARE_CAS and REQUIRED_CAS <= issuers,
         f"CAA issue tags {sorted(issuers)} are not Universal SSL's, with Let's Encrypt, Google and SSL.com")

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
