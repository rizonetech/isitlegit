#!/usr/bin/env python3
"""Prove isitlegit.co.za is set up as D99 T01 §2 records it, from public DNS (1.1.1.1), not only its nameservers.

    python3 scripts/check-domain.py

Checks, each a refusal when it fails: the two Cloudflare nameservers; Email Routing's three MX hosts and its SPF
include; DMARC `p=reject` reporting to dmarc@isitlegit.co.za; CAA issuers drawn only from the certificate authorities
Cloudflare's Universal SSL uses and including Let's Encrypt, Google Trust Services and SSL.com; the DS record the
registrar holds (key tag 2371, algorithm 13, digest type 2, the recorded digest); and DNSSEC validated (the resolver's
`ad` flag). Prints the number of checks passed and exits 0 only when all pass. Stdlib only; needs `dig`.
"""
import subprocess
import sys

DOMAIN = "isitlegit.co.za"
RESOLVER = "1.1.1.1"
NAMESERVERS = {"carmelo.ns.cloudflare.com.", "paris.ns.cloudflare.com."}
MX_HOSTS = {"route1.mx.cloudflare.net.", "route2.mx.cloudflare.net.", "route3.mx.cloudflare.net."}
SPF_INCLUDE = "include:_spf.mx.cloudflare.net"
DMARC_REPORTS = "rua=mailto:dmarc@isitlegit.co.za"
# Universal SSL's authorities (https://developers.cloudflare.com/ssl/reference/certificate-authorities/); Cloudflare adds
# its own CAA rows for them, so Sectigo (comodoca.com) and DigiCert may appear beside the three the section names.
CLOUDFLARE_CAS = {"letsencrypt.org", "pki.goog", "ssl.com", "comodoca.com", "digicert.com", "sectigo.com"}
REQUIRED_CAS = {"letsencrypt.org", "pki.goog", "ssl.com"}
DS = ("2371", "13", "2", "360CD8AC177997F22F9239EF3EB686AAAEDF101C211B330C684B723928504665")


def dig(*args):
    """dig's answer lines for a query against the resolver, 20 seconds at most."""
    done = subprocess.run(["dig", f"@{RESOLVER}", "+time=5", "+tries=2", *args], capture_output=True, text=True,
                          timeout=20)
    return done.stdout


def answers():
    """Each record set this checks, and the validation flags."""
    def short(kind, name=DOMAIN):
        return [line for line in dig("+short", kind, name).splitlines() if line.strip()]

    flags = next((line for line in dig("+dnssec", "A", DOMAIN).splitlines() if line.startswith(";; flags:")), "")
    return {"NS": short("NS"), "MX": short("MX"), "SPF": short("TXT"), "DMARC": short("TXT", f"_dmarc.{DOMAIN}"),
            "CAA": short("CAA"), "DS": short("DS"), "flags": flags}


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
    need({line.split()[-1] for line in a["MX"] if line.split()} == MX_HOSTS,
         f"MX hosts are {sorted(a['MX'])}, not Email Routing's three")
    need(any("v=spf1" in t and SPF_INCLUDE in t for t in a["SPF"]), f"no SPF record with {SPF_INCLUDE}")
    dmarc = " ".join(a["DMARC"])
    need("v=DMARC1" in dmarc and "p=reject" in dmarc and DMARC_REPORTS in dmarc,
         "DMARC is not p=reject with reports to dmarc@isitlegit.co.za")
    issuers = {line.split('"')[1].split(";")[0].strip() for line in a["CAA"] if " issue" in line and '"' in line}
    need(bool(issuers) and issuers <= CLOUDFLARE_CAS and REQUIRED_CAS <= issuers,
         f"CAA issuers {sorted(issuers)} are not Universal SSL's, with Let's Encrypt, Google and SSL.com")
    ds = [line.split() for line in a["DS"]]
    need(any(r[:3] == list(DS[:3]) and "".join(r[3:]).upper() == DS[3] for r in ds),
         "the DS record at the registry is not key tag 2371, algorithm 13, digest type 2 with the recorded digest")
    need(" ad" in a["flags"] or a["flags"].endswith(" ad;") or " ad;" in a["flags"],
         "the resolver did not validate the zone (no ad flag)")
    return passed, refusals


if __name__ == "__main__":
    try:
        passed, refusals = check(answers())
    except (OSError, subprocess.SubprocessError) as exc:
        print(f"check-domain: dig could not run ({type(exc).__name__}); install dnsutils or retry", file=sys.stderr)
        sys.exit(1)
    for refusal in refusals:
        print(f"check-domain: {refusal}", file=sys.stderr)
    print(f"check-domain: {passed} of 7 checks passed")
    sys.exit(0 if not refusals else 1)
