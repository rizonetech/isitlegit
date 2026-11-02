// The Impersonation monitor page's routes (D05 T04 §5; design/SPEC.md M6): `GET /monitor` lists the
// signed-in organisation's findings, `GET /monitor/pack/:host?format=md|pdf` downloads the takedown
// pack built from RDAP and the settled capture, and `POST /monitor/dismiss` / `POST /monitor/restore`
// change a finding. Every read and change is scoped by the session's active organisation, so a
// finding of another organisation is never named, downloaded or changed. The page is
// ./monitor-view.tsx.
import { type Context, Hono } from "hono";
import { readSmallForm } from "../../auth/form";
import { type GateEnv, type SignedIn, sessionGate } from "../../auth/gate";
import { activeMembership } from "../../auth/org";
import { dismissFinding, type Finding, listFindings, restoreFinding } from "../../monitor/findings";
import { rdapContacts } from "../../monitor/rdap-contacts";
import { takedownMarkdown, takedownPdf } from "../../monitor/takedown";
import { dohResolve } from "../../walkthrough/url-policy";
import { errorPage, HEADERS, reference } from "./errors";
import { memberShell } from "./member-shell";
import { type MonitorOutcome, MonitorPage } from "./monitor-view";

export const monitorRoutes = new Hono<GateEnv>();

function outage(why: string) {
  const ref = reference(500);
  console.log(JSON.stringify({ event: "monitor-page", outcome: "unavailable", reference: ref, error: why }));
  return errorPage(500, "", { ref, retry: "/monitor" });
}
const html = (body: unknown, status = 200) => new Response(String(body), { status, headers: HEADERS });

async function memberOf(env: Env, signedIn: SignedIn) {
  const membership = await activeMembership(env, signedIn);
  if (!membership.ok)
    return membership.reason === "unavailable"
      ? { refused: outage("membership") }
      : { refused: errorPage(403, "", { email: signedIn.user.email }) };
  return { org: membership.org };
}

async function draw(
  c: Context<GateEnv>,
  orgId: string,
  outcome: MonitorOutcome | null = null,
  status = 200,
  selected: string | null = null,
) {
  const signedIn = c.get("signedIn");
  const evidence: Record<string, string[]> = {};
  const [findings, shell, lastRun, watched, parked] = await Promise.all([
    listFindings(c.env.DB, orgId),
    memberShell(c.env.DB, signedIn.user, orgId, "monitor"),
    c.env.DB.prepare("SELECT day, outcome FROM monitor_runs WHERE org_id = ? ORDER BY day DESC LIMIT 1")
      .bind(orgId)
      .first<{ day: string; outcome: string }>(),
    c.env.DB.prepare("SELECT COUNT(*) AS n FROM monitor_hosts WHERE org_id = ?").bind(orgId).first<{ n: number }>(),
    c.env.DB.prepare("SELECT COUNT(*) AS n FROM monitor_hosts WHERE org_id = ? AND status = 'parked'")
      .bind(orgId)
      .first<{ n: number }>(),
  ]);
  const shots: Record<string, boolean> = {};
  for (const finding of findings) {
    shots[finding.host] =
      (await c.env.ARTEFACTS.head(`${finding.capture_key}screenshot.jpg`).catch(() => null)) !== null;
    if (!finding.case_id) continue;
    const rows = await c.env.DB.prepare("SELECT summary FROM evidence WHERE case_id = ? ORDER BY seq LIMIT 8")
      .bind(finding.case_id)
      .all<{ summary: string }>();
    evidence[finding.host] = rows.results.map((r) => r.summary).filter(Boolean);
  }
  return html(
    <MonitorPage
      shell={shell}
      findings={findings}
      evidence={evidence}
      shots={shots}
      selected={selected}
      lastRunDay={lastRun?.day ?? null}
      watchedHosts={watched?.n ?? 0}
      parkedHosts={parked?.n ?? 0}
      partialRun={lastRun?.outcome === "partial" || lastRun?.outcome === "failed"}
      outcome={outcome}
    />,
    status,
  );
}

monitorRoutes.get(
  "/monitor",
  sessionGate(() => outage("session")),
  async (c) => {
    const signedIn = c.get("signedIn");
    const who = await memberOf(c.env, signedIn);
    if ("refused" in who) return who.refused;
    try {
      const done = c.req.query("done");
      const outcome: MonitorOutcome | null = done === "dismissed" || done === "restored" ? done : null;
      return await draw(c, who.org.id, outcome, 200, c.req.query("finding") ?? null);
    } catch (error) {
      return outage((error as Error).name);
    }
  },
);

async function change(c: Context<GateEnv>, action: "dismiss" | "restore") {
  const origin = new URL(c.env.APP_URL).origin;
  if (c.req.header("origin") !== origin) return new Response("Forbidden", { status: 403, headers: HEADERS });
  const signedIn = c.get("signedIn");
  const who = await memberOf(c.env, signedIn);
  if ("refused" in who) return who.refused;
  const form = await readSmallForm(c.req.raw, { host: 253, reason: 500 });
  const host = (form?.host ?? "").toLowerCase();
  if (!form || !/^[a-z0-9.-]{3,253}$/.test(host)) return draw(c, who.org.id, "refused", 400);
  try {
    const done =
      action === "dismiss"
        ? await dismissFinding(c.env.DB, who.org.id, host, form.reason ?? "")
        : await restoreFinding(c.env.DB, who.org.id, host);
    if (!done) return draw(c, who.org.id, "refused", 400);
    return new Response(null, {
      status: 303,
      headers: { ...HEADERS, location: `/monitor?done=${action === "dismiss" ? "dismissed" : "restored"}` },
    });
  } catch (error) {
    console.log(JSON.stringify({ event: "monitor-page", outcome: "change-failed", error: (error as Error).name }));
    return draw(c, who.org.id, "failed", 503);
  }
}

monitorRoutes.post(
  "/monitor/dismiss",
  sessionGate(() => outage("session")),
  (c) => change(c, "dismiss"),
);
monitorRoutes.post(
  "/monitor/restore",
  sessionGate(() => outage("session")),
  (c) => change(c, "restore"),
);

// The settled capture's screenshot for one of the organisation's findings, for the detail panel.
monitorRoutes.get(
  "/monitor/shot/:host{[a-z0-9.-]{3,253}}",
  sessionGate(() => outage("session")),
  async (c) => {
    const signedIn = c.get("signedIn");
    const who = await memberOf(c.env, signedIn);
    if ("refused" in who) return who.refused;
    const host = c.req.param("host").toLowerCase();
    const finding = (await listFindings(c.env.DB, who.org.id)).find((f) => f.host === host);
    if (!finding) return errorPage(404, "", { email: signedIn.user.email });
    const shot = await c.env.ARTEFACTS.get(`${finding.capture_key}screenshot.jpg`).catch(() => null);
    if (!shot) return errorPage(404, "", { email: signedIn.user.email });
    return new Response(await shot.arrayBuffer(), {
      headers: { ...HEADERS, "content-type": "image/jpeg", "cache-control": "private, no-store" },
    });
  },
);

// The takedown pack for one of the organisation's findings. RDAP facts are read live; a lookup
// that fails states itself in the pack. The screenshot comes from the settled capture in R2; a
// capture that cannot be read states itself too.
monitorRoutes.get(
  "/monitor/pack/:host{[a-z0-9.-]{3,253}}",
  sessionGate(() => outage("session")),
  async (c) => {
    const signedIn = c.get("signedIn");
    const who = await memberOf(c.env, signedIn);
    if ("refused" in who) return who.refused;
    const host = c.req.param("host").toLowerCase();
    const finding = (await listFindings(c.env.DB, who.org.id)).find((f) => f.host === host);
    if (!finding) return errorPage(404, "", { email: signedIn.user.email });
    try {
      const pack = await buildPack(c, finding);
      const format = c.req.query("format") === "pdf" ? "pdf" : "md";
      if (format === "pdf")
        return new Response(pack.pdf as BodyInit, {
          headers: {
            ...HEADERS,
            "content-type": "application/pdf",
            "content-disposition": `attachment; filename="takedown-${host}.pdf"`,
          },
        });
      return new Response(pack.markdown, {
        headers: {
          ...HEADERS,
          "content-type": "text/markdown; charset=utf-8",
          "content-disposition": `attachment; filename="takedown-${host}.md"`,
        },
      });
    } catch (error) {
      return outage((error as Error).name);
    }
  },
);

async function buildPack(c: Context<GateEnv>, finding: Finding) {
  const db = c.env.DB;
  const summaries: string[] = [];
  if (finding.case_id) {
    const rows = await db
      .prepare("SELECT summary FROM evidence WHERE case_id = ? ORDER BY seq LIMIT 20")
      .bind(finding.case_id)
      .all<{ summary: string }>();
    for (const row of rows.results) if (row.summary) summaries.push(row.summary);
  }
  if (!summaries.length && finding.evidence_refs)
    for (const ref of JSON.parse(finding.evidence_refs) as string[])
      summaries.push(`Evidence ${ref} on the case record.`);
  const shot = await c.env.ARTEFACTS.get(`${finding.capture_key}screenshot.jpg`).catch(() => null);
  const screenshotJpeg = shot ? new Uint8Array(await shot.arrayBuffer()) : null;
  const bootstrap = await fetch("https://data.iana.org/rdap/dns.json", {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(5_000),
  })
    .then(async (r) => (r.ok ? (((await r.json()) as { services?: [string[], string[]][] }).services ?? null) : null))
    .catch(() => null);
  const resolved = await dohResolve()(finding.host).catch(() => null);
  const ip = Array.isArray(resolved) ? (resolved[0] ?? null) : null;
  const contacts = await rdapContacts(fetch, { domain: finding.host, bootstrap, ip });
  const brandingConfirmed = finding.case_id
    ? (await db
        .prepare(
          `SELECT 1 AS ok FROM evidence WHERE case_id = ? AND "check" = 'vision.logo_match' AND severity IN ('high', 'critical') LIMIT 1`,
        )
        .bind(finding.case_id)
        .first<{ ok: number }>()
        .catch(() => null)) !== null
    : false;
  const input = {
    finding,
    contacts,
    evidenceSummaries: summaries,
    brandingConfirmed,
    screenshotName: screenshotJpeg ? "screenshot.jpg (embedded in the PDF pack)" : null,
  };
  return { markdown: takedownMarkdown(input), pdf: takedownPdf({ ...input, screenshotJpeg }) };
}
