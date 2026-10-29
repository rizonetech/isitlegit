#!/usr/bin/env python3
"""Prove isitlegit.co.za is set up as D99 T01 §2 records it, from public DNS (1.1.1.1), not only its nameservers.

    python3 scripts/check-domain.py

Each record is compared with what §2 published, so any edit to it fails, not only the weakenings someone thought
of: the two Cloudflare nameservers; Email Routing's three MX hosts; exactly one SPF record, byte for byte
`v=spf1 include:_spf.mx.cloudflare.net ~all`; exactly one DMARC record, byte for byte the published one (`p=reject`,
`sp=reject`, relaxed alignment, `fo=1`, reports only to dmarc@isitlegit.co.za), a trailing semicolon allowed; CAA `issue` tags (not `issuewild`) naming only
Universal SSL's authorities and including Let's Encrypt, Google Trust Services and SSL.com (RFC 8659 4.2, 4.3); the
registry's DS (key tag 2371, algorithm 13, digest type 2, the recorded digest); the zone validated (`ad`); and
Email Routing's own DKIM key published (`cf2024-1._domainkey`, a `v=DKIM1` record with a key: D99 T01 §9).
    python3 scripts/check-domain.py --diagnose
tells a DNSSEC failure from an outage (an ordinary query against one with checking disabled, `+cd`), for the runbook's
emergency procedure (docs/operations.md "Domain recovery").
    python3 scripts/check-domain.py --expect-ns <ns1>,<ns2> --expect-ds "<tag> <alg> <type> <digest>"
checks a planned nameserver move's new values, reviewed on the command line, before they are committed as the
constants below.

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
# its own CAA rows for them, so Sectigo's comodoca.com and DigiCert appear beside the three the section names (all five
# read back from the zone on 2026-10-28); nothing else is allowed.
CLOUDFLARE_CAS = {"letsencrypt.org", "pki.goog", "ssl.com", "comodoca.com", "digicert.com"}
REQUIRED_CAS = {"letsencrypt.org", "pki.goog", "ssl.com"}
DS = ("2371", "13", "2", "360CD8AC177997F22F9239EF3EB686AAAEDF101C211B330C684B723928504665")
CHECKS = 8
# Email Routing's DKIM key (D99 T01 §2 enabled routing, which publishes it), so forwarded mail stays authenticated.
ROUTING_DKIM = f"cf2024-1._domainkey.{DOMAIN}"


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
            "flags": lookup("A", DOMAIN, True)[1], "DKIM": lookup("TXT", ROUTING_DKIM)[0]}


def txt(rdata):
    """A TXT record's text: its quoted strings joined (RFC 7208 3.3)."""
    parts = re.findall(r'"((?:[^"\\]|\\.)*)"', rdata)
    return "".join(parts) if parts else rdata


def check(a, nameservers=None, ds_record=None):
    """(passed checks, refusals) from the answers, against the recorded nameservers and DS unless a planned move's
    reviewed values are given."""
    nameservers = NAMESERVERS if nameservers is None else nameservers
    expected_ds = DS if ds_record is None else ds_record
    passed, refusals = 0, []

    def need(ok, what):
        nonlocal passed
        if ok:
            passed += 1
        else:
            refusals.append(what)

    need(set(a["NS"]) == nameservers, f"nameservers are {sorted(a['NS'])}, not {sorted(nameservers)}")
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

    # Exactly the recorded DS and no other: a second one left from a rollover or a mistyped paste is refused too.
    ds = [line.split() for line in a["DS"]]
    need(len(ds) == 1 and ds[0][:3] == list(expected_ds[:3]) and "".join(ds[0][3:]).upper() == expected_ds[3],
         f"the registry's DS set is not exactly the expected one (key tag {expected_ds[0]}, algorithm "
         f"{expected_ds[1]}, digest type {expected_ds[2]}, its digest); it holds {len(ds)} record(s)"
         + (": the zone is unsigned at the registry (a move in progress, or the DS pulled)" if not ds else ""))
    found = re.search(r"flags:([^;]*);", a["flags"])
    flag_words = found[1].split() if found else []
    need("ad" in flag_words, "the resolver did not validate the zone (no ad flag)")
    dkim = [txt(r) for r in a["DKIM"] if txt(r).lower().startswith("v=dkim1")]
    need(len(dkim) == 1 and re.search(r"(?:^|;)\s*p=[A-Za-z0-9+/=]{100,}", dkim[0]) is not None,
         f"Email Routing's DKIM key ({ROUTING_DKIM}) is not one published key ({len(dkim)} DKIM1 record(s))")
    return passed, refusals


DS_RECORD = re.compile(r"^(\d{1,5}) (\d{1,3}) (\d{1,3}) ([0-9A-Fa-f]{40,128})$")
NS_NAME = re.compile(r"^(?=.{1,253}\.$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+$")


def expected(ns_text, ds_text):
    """A planned move's reviewed values, or ValueError naming what is malformed."""
    nameservers = None
    if ns_text is not None:
        names = [n.strip().lower() for n in ns_text.split(",") if n.strip()]
        names = [n if n.endswith(".") else n + "." for n in names]
        if len(names) < 2 or not all(NS_NAME.match(n) for n in names):
            raise ValueError("--expect-ns names at least two nameservers, comma-separated")
        nameservers = set(names)
    ds_record = None
    if ds_text is not None:
        found = DS_RECORD.match(" ".join(ds_text.split()[:3] + ["".join(ds_text.split()[3:])]))
        if not found:
            raise ValueError("--expect-ds is the DS as the registry shows it: key tag, algorithm, digest type, digest")
        ds_record = (found[1], found[2], found[3], found[4].upper())
    return nameservers, ds_record


def status_of(kind, name, checking_disabled, run_dig=subprocess.run):
    """The DNS status a resolver answers (NOERROR, SERVFAIL, ...), or None when no answer came back at all."""
    args = ["dig", f"@{RESOLVER}", "+time=5", "+tries=2", "+noall", "+comments",
            *(["+cd"] if checking_disabled else []), kind, name]
    try:
        done = run_dig(args, capture_output=True, text=True, timeout=30)
    except (subprocess.TimeoutExpired, OSError):
        return None
    found = re.search(r"status: ([A-Z]+)", done.stdout or "")
    return found[1] if found else None


def diagnose(run_dig=subprocess.run):
    """(exit code, line): resolving (0); a DNSSEC failure, the ordinary query failing while one with checking
    disabled answers (1); an outage, both failing (2). Only the second is a reason to pull the DS."""
    plain = status_of("A", DOMAIN, False, run_dig)
    unchecked = status_of("A", DOMAIN, True, run_dig)
    if plain == "NOERROR":
        return 0, "check-domain: the domain resolves and validates; no DNSSEC failure"
    if plain == "SERVFAIL" and unchecked == "NOERROR":
        return 1, ("check-domain: a DNSSEC failure (SERVFAIL, but NOERROR with checking disabled): follow the "
                   "emergency procedure, docs/operations.md \"Domain recovery\" (b)")
    return 2, (f"check-domain: an outage, not DNSSEC (status {plain or 'no answer'}, {unchecked or 'no answer'} with "
               "checking disabled): do not touch the DS; wait for Cloudflare (https://www.cloudflarestatus.com)")


def run(lookup=dig, nameservers=None, ds_record=None):
    """(exit code, lines to print)."""
    try:
        passed, refusals = check(answers(lookup), nameservers, ds_record)
    except LookupFailed as exc:
        return 2, [f"check-domain: a lookup failed, so nothing was judged: {exc}"]
    return (0 if not refusals else 1), [*(f"check-domain: {r}" for r in refusals),
                                        f"check-domain: {passed} of {CHECKS} checks passed"]


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Check isitlegit.co.za's records against D99 T01 §2.")
    parser.add_argument("--diagnose", action="store_true", help="tell a DNSSEC failure from an outage")
    parser.add_argument("--expect-ns", help="a planned move's new nameservers, comma-separated")
    parser.add_argument("--expect-ds", help="a planned move's new DS, as the registry shows it")
    options = parser.parse_args()
    if options.diagnose:
        code, line = diagnose()
        print(line, file=sys.stderr if code else sys.stdout)
        sys.exit(code)
    try:
        nameservers, ds_record = expected(options.expect_ns, options.expect_ds)
    except ValueError as exc:
        parser.error(str(exc))
    code, lines = run(dig, nameservers, ds_record)
    for line in lines:
        print(line, file=sys.stderr if code and "checks passed" not in line else sys.stdout)
    sys.exit(code)
