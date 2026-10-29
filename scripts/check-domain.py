#!/usr/bin/env python3
"""Prove isitlegit.co.za is set up as D99 T01 §2 records it, from public DNS (1.1.1.1), not only its nameservers.

    python3 scripts/check-domain.py

Each record is compared with what §2 published, so any edit to it fails, not only the weakenings someone thought
of: the two Cloudflare nameservers; Email Routing's three MX hosts; exactly one SPF record, byte for byte
`v=spf1 include:_spf.mx.cloudflare.net ~all`; exactly one DMARC record, byte for byte the published one (`p=reject`,
`sp=reject`, relaxed alignment, `fo=1`, reports only to dmarc@isitlegit.co.za), a trailing semicolon allowed; CAA `issue` tags (not `issuewild`) naming only
Universal SSL's authorities and including Let's Encrypt, Google Trust Services and SSL.com (RFC 8659 4.2, 4.3); the
registry's DS (key tag 2371, algorithm 13, digest type 2, the recorded digest); the zone validated (`ad`); and
Email Routing's own DKIM record published (`cf2024-1._domainkey`: one record, byte for byte the one Cloudflare
published, by its digest: D99 T01 §9); and the demo subdomain's own MX hosts and SPF record. Each lookup is announced on stderr before it starts.
    python3 scripts/check-domain.py --diagnose
tells five states apart from the zone's SOA, an ordinary query against one with checking disabled (`+cd`), for the
runbook's emergency procedure (docs/operations.md "Domain recovery"): authenticated (exit 0), a confirmed DNSSEC
failure (1), inconclusive, a local fault, a timeout or both failing (2), unsigned but resolving (3), and no SOA (4).
    python3 scripts/check-domain.py --expect-ns <ns1>,<ns2> --expect-ds "<tag> <alg> <type> <digest>"
checks a planned nameserver move's new values, reviewed on the command line, before they are committed as the
constants below.

A lookup that could not be made (no network, a resolver error, a timeout) is reported as that, exit 2, never as a
wrong record; an interrupted run exits 130 and judges nothing. Prints the number of checks passed and exits 0 only when all pass, 1 when a record is wrong. Stdlib
only; needs `dig`.
"""
import hashlib
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
CHECKS = 9
# The demo subdomain routes its own mail (D01 T02 §4): its own three MX hosts and SPF record.
DEMO = f"demo.{DOMAIN}"
# Email Routing's DKIM record (D99 T01 §2 enabled routing, which publishes it), so forwarded mail stays authenticated:
# pinned byte for byte as Cloudflare published it, like SPF and DMARC, by the SHA-256 of its text (its quoted strings
# joined) as read back on 2026-10-29, since the key is long. Any edit to any tag or to the key fails (round 2: checking
# tags one by one missed `h=` and `s=`); a key Cloudflare rotates is a reviewed commit of the new digest.
ROUTING_DKIM = f"cf2024-1._domainkey.{DOMAIN}"
ROUTING_DKIM_SHA256 = "7edf37256212f306d474921bcabff1e6abea831924737f785c040c8e6b5e8241"


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


def answers(lookup=dig, say=lambda line: None):
    """Each record set this checks, and the validation flags, each lookup announced before it starts."""
    def ask(label, *args):
        say(f"check-domain: looking up {label}")
        return lookup(*args)

    return {"NS": ask("NS", "NS")[0], "MX": ask("MX", "MX")[0], "TXT": ask("SPF", "TXT")[0],
            "DMARC": ask("DMARC", "TXT", f"_dmarc.{DOMAIN}")[0], "CAA": ask("CAA", "CAA")[0],
            "DS": ask("DS", "DS")[0], "flags": ask("validation", "A", DOMAIN, True)[1],
            "DKIM": ask("routing DKIM", "TXT", ROUTING_DKIM)[0], "DEMO_MX": ask("demo MX", "MX", DEMO)[0],
            "DEMO_TXT": ask("demo SPF", "TXT", DEMO)[0]}


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
    # Any record that begins like a DKIM record counts, so a mistyped version is refused rather than skipped.
    dkim = [txt(r) for r in a["DKIM"] if txt(r).strip().lower().startswith("v=dkim")]
    need(len(dkim) == 1 and hashlib.sha256(dkim[0].strip().encode()).hexdigest() == ROUTING_DKIM_SHA256,
         f"Email Routing's DKIM key ({ROUTING_DKIM}) is not the record Cloudflare published ({len(dkim)} DKIM "
         "record(s); its text must match the recorded digest byte for byte)")
    demo_spf = [txt(r) for r in a["DEMO_TXT"] if txt(r).lower().startswith("v=spf1")]
    need({line.split()[-1] for line in a["DEMO_MX"] if line.split()} == MX_HOSTS
         and len(a["DEMO_MX"]) == len(MX_HOSTS) and demo_spf == [SPF_RECORD],
         f"{DEMO} does not route through Email Routing (MX {sorted(a['DEMO_MX'])}, {len(demo_spf)} SPF record(s))")
    return passed, refusals



DS_RECORD = re.compile(r"^(\d{1,5}) (\d{1,3}) (\d{1,3}) ([0-9A-Fa-f]{40,128})$")
# A DS digest's length for its type (RFC 4509, RFC 6605, the IANA registry): SHA-1 40, SHA-256 64, SHA-384 96.
DIGEST_LENGTHS = {"1": 40, "2": 64, "4": 96}
# DNSSEC algorithms a DS may name today (RSA/SHA-1 through Ed448, IANA's registry).
DS_ALGORITHMS = {"5", "7", "8", "10", "13", "14", "15", "16"}
NS_NAME = re.compile(r"^(?=.{1,253}\.$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+$")


def expected(ns_text, ds_text):
    """A planned move's reviewed values, or ValueError naming what is malformed."""
    nameservers = None
    if ns_text is not None:
        names = [n.strip().lower() for n in ns_text.split(",") if n.strip()]
        names = [n if n.endswith(".") else n + "." for n in names]
        if len(set(names)) < 2 or len(set(names)) != len(names) or not all(NS_NAME.match(n) for n in names):
            raise ValueError("--expect-ns names at least two different nameservers, comma-separated")
        nameservers = set(names)
    ds_record = None
    if ds_text is not None:
        found = DS_RECORD.match(" ".join(ds_text.split()[:3] + ["".join(ds_text.split()[3:])]))
        if (not found or not 0 <= int(found[1]) <= 65535 or found[2] not in DS_ALGORITHMS
                or DIGEST_LENGTHS.get(found[3]) != len(found[4])):
            raise ValueError("--expect-ds is the DS as the registry shows it: key tag (0 to 65535), a DNSSEC algorithm, "
                             "digest type 1, 2 or 4, and a digest of that type's length")
        ds_record = (found[1], found[2], found[3], found[4].upper())
    return nameservers, ds_record


def probe(kind, name, checking_disabled, run_dig=subprocess.run):
    """What one query showed: ("local", reason) when dig could not run or answer here; else (status, ad flag, answer
    count) from the resolver's reply."""
    args = ["dig", f"@{RESOLVER}", "+time=5", "+tries=2", "+dnssec", "+noall", "+comments",
            *(["+cd"] if checking_disabled else []), kind, name]
    try:
        done = run_dig(args, capture_output=True, text=True, timeout=30)
    except subprocess.TimeoutExpired:
        return ("timeout", None, 0)
    except OSError as exc:
        return ("local", f"dig could not run ({exc.strerror})", 0)
    found = re.search(r"status: ([A-Z]+)", done.stdout or "")
    if not found:
        return ("timeout" if "timed out" in (done.stdout or "") + (done.stderr or "") else "local",
                "no DNS response header", 0)
    flags = re.search(r";; flags:([^;]*);", done.stdout)
    count = re.search(r"ANSWER: (\d+)", done.stdout)
    return (found[1], "ad" in (flags[1].split() if flags else []), int(count[1]) if count else 0)


# The five states the emergency procedure tells apart, and what to do in each (docs/operations.md "Domain recovery").
def diagnose(run_dig=subprocess.run):
    """(exit code, line): authenticated (0); unsigned but resolving (3); resolving with no SOA (4); a confirmed
    DNSSEC failure, the ordinary query failing while one with checking disabled answers (1); inconclusive, a local
    fault, a timeout or both queries failing (2). Only a confirmed DNSSEC failure is a reason to pull the DS."""
    # The zone's SOA, which every zone answers (the apex has no address of its own; the site is app.isitlegit.co.za).
    plain = probe("SOA", DOMAIN, False, run_dig)
    if plain[0] == "local":
        return 2, (f"check-domain: inconclusive, a local fault ({plain[1]}): this machine could not ask; fix that "
                   "before judging the domain")
    unchecked = probe("SOA", DOMAIN, True, run_dig)
    if plain[0] == "NOERROR" and plain[2] > 0 and plain[1]:
        return 0, "check-domain: the domain resolves and validates (an authenticated answer); no DNSSEC failure"
    if plain[0] == "NOERROR" and plain[2] > 0:
        return 3, ("check-domain: the domain resolves but is not validated (no ad flag): unsigned, as after the DS is "
                   "pulled or mid-move; publish the DS when signing is ready (Domain recovery (b) 3 to 5)")
    if plain[0] in ("NOERROR", "NXDOMAIN"):
        return 4, (f"check-domain: the resolver answered {plain[0]} with no SOA: the zone is missing, not a "
                   "DNSSEC failure; restore the zone, do not touch the DS")
    if plain[0] == "SERVFAIL" and unchecked[0] == "NOERROR":
        return 1, ("check-domain: a DNSSEC failure (SERVFAIL, but NOERROR with checking disabled): follow the "
                   "emergency procedure, docs/operations.md \"Domain recovery\" (b)")
    return 2, (f"check-domain: inconclusive (status {plain[0]}, {unchecked[0]} with checking disabled): an outage or "
               "the network, not shown to be DNSSEC; do not touch the DS; check https://www.cloudflarestatus.com and "
               "the network, then try again")


def run(lookup=dig, nameservers=None, ds_record=None, say=lambda line: None):
    """(exit code, lines to print)."""
    try:
        passed, refusals = check(answers(lookup, say), nameservers, ds_record)
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
    try:
        code, lines = run(dig, nameservers, ds_record, say=lambda line: print(line, file=sys.stderr, flush=True))
    except KeyboardInterrupt:
        print("check-domain: interrupted, so nothing was judged", file=sys.stderr)
        sys.exit(130)
    for line in lines:
        print(line, file=sys.stderr if code and "checks passed" not in line else sys.stdout)
    sys.exit(code)
