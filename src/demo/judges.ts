// The judge demo organisation's five cases, read back (D07 T07 §2). Read-only in checkJudges; seedJudgePack marks a
// judge organisation and submits the five synthetic fixtures in data/demo/judge/ through the real intake and pipeline.

import manifest from "../../data/demo/judge/fixtures.json" with { type: "json" };
import pack from "../../data/demo/judge/pack.json" with { type: "json" };

// The invite code label that makes a fresh organisation a judge demo organisation (coordinator, 2026-11-02).
export const JUDGE_CODE_LABEL = "meta-hackathon-2026";
const PLACEHOLDER_URL = "https://karoomutual.demo.isitlegit.co.za/login?ref=judge001";

type PackEntry = { encoding: "hex" | "utf8"; data: string };

export function judgeFixtureBytes(file: string, fixturesPrefix?: string): Uint8Array {
  const entry = (pack as Record<string, PackEntry | undefined>)[file];
  if (!entry) throw new Error(`unknown judge fixture file: ${file}`);
  if (entry.encoding === "hex") {
    const out = new Uint8Array(entry.data.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(entry.data.slice(i * 2, i * 2 + 2), 16);
    return out;
  }
  const text =
    file === "walkthrough-phishing.eml" && fixturesPrefix && fixturesPrefix.length >= 16
      ? entry.data.replace(PLACEHOLDER_URL, `https://fixtures.isitlegit.co.za/${fixturesPrefix}/fynbos-lookalike/`)
      : entry.data;
  return new TextEncoder().encode(text);
}

// Marks the organisation a judge signup just created: merges the judgeDemo flag into its metadata, keeping
// what is already there (the demo flag included). Returns false when the organisation does not exist.
export async function markJudgeOrg(db: D1Database, orgId: string): Promise<boolean> {
  const row = await db
    .prepare('SELECT metadata FROM "organization" WHERE id = ?')
    .bind(orgId)
    .first<{ metadata: string | null }>();
  if (!row) return false;
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(row.metadata ?? "{}") as Record<string, unknown>;
  } catch {
    parsed = {};
  }
  await db
    .prepare('UPDATE "organization" SET metadata = ? WHERE id = ?')
    .bind(JSON.stringify({ ...parsed, judgeDemo: true }), orgId)
    .run();
  return true;
}

export type JudgeCaseSpec = {
  name: string;
  file?: string;
  kind: "mail" | "upload";
  sender?: string;
  subject?: string;
  uploadName?: string;
  expectedVerdict: string;
};

export type JudgePackEnv = Pick<Env, "DB" | "ARTEFACTS" | "ANALYSIS"> & { FIXTURES_PREFIX?: string };

// Marks the organisation and admits the five judge demo fixtures through the real intake and analysis workflow.
// Idempotent per fixture (matched by subject or upload name), so a retried signup resumes without duplicating cases.
export async function seedJudgePack(env: JudgePackEnv, orgId: string, userId: string): Promise<string[]> {
  await markJudgeOrg(env.DB, orgId);
  const [{ setOriginalHeader }, { admitDelivery, sha256Hex }, { sniff }, { putAttachment, putRaw }] = await Promise.all(
    [import("../db/cases"), import("../intake/admit"), import("../intake/sniff"), import("../intake/store")],
  );
  const uploadKey = async (bytes: Uint8Array, name: string, type: string): Promise<string> =>
    `sha256:${await sha256Hex(new TextEncoder().encode(`${await sha256Hex(bytes)}\u0000${name}\u0000${type}`))}`;
  const specs = manifest.cases as readonly JudgeCaseSpec[];
  const ids: string[] = [];
  const store = { bucket: env.ARTEFACTS, db: env.DB };
  for (const spec of specs) {
    const file = spec.file ?? spec.uploadName ?? "";
    const existing =
      spec.kind === "mail"
        ? await env.DB.prepare(
            "SELECT id FROM cases WHERE org_id = ? AND original_subject = ? ORDER BY created_at DESC LIMIT 1",
          )
            .bind(orgId, spec.subject ?? "")
            .first<{ id: string }>()
        : await env.DB.prepare(
            "SELECT id FROM cases WHERE org_id = ? AND upload_name = ? ORDER BY created_at DESC LIMIT 1",
          )
            .bind(orgId, spec.uploadName ?? file)
            .first<{ id: string }>();
    if (existing) {
      ids.push(existing.id);
      continue;
    }
    const bytes = judgeFixtureBytes(file, env.FIXTURES_PREFIX);
    const sniffed = sniff(bytes);
    if ("refused" in sniffed) throw new Error(`judge fixture ${spec.name}: ${sniffed.refused}`);
    const mediaType = sniffed.mediaType;
    const uploadName = spec.uploadName ?? file;
    const admitted = await admitDelivery(env as unknown as Env, {
      orgId,
      key: await uploadKey(bytes, uploadName, mediaType),
      channel: "upload",
      uploadedBy: userId,
      uploadName,
      uploadMediaType: mediaType,
      sourceKind: sniffed.kind,
      headersAvailable: sniffed.kind === "mail" && sniffed.headersAvailable,
      store: async (caseId) => {
        if (sniffed.kind === "mail") {
          await putRaw(store, caseId, bytes, mediaType);
          await setOriginalHeader(env.DB, caseId, {
            subject: spec.subject ?? null,
            fromName: null,
            fromAddress: spec.sender ?? null,
          });
        } else {
          await putAttachment(store, caseId, uploadName, bytes, mediaType);
        }
      },
    });
    if (admitted.kind === "capped" || !admitted.caseId)
      throw new Error(`judge fixture ${spec.name}: could not admit (${admitted.kind})`);
    ids.push(admitted.caseId);
  }
  return ids;
}

export type JudgeCheck = {
  name: string;
  caseId: string | null;
  status: string | null;
  verdict: string | null;
  problems: string[];
};

type CaseRow = { id: string; status: string; verdict: string | null };

// Matches one manifest case to the organisation's own rows only: mail by its subject, an upload by its file name.
export async function checkJudges(
  db: D1Database,
  orgId: string,
  specs: readonly JudgeCaseSpec[],
): Promise<JudgeCheck[]> {
  const out: JudgeCheck[] = [];
  for (const spec of specs) {
    const row =
      spec.kind === "mail"
        ? await db
            .prepare(
              "SELECT id, status, verdict FROM cases WHERE org_id = ? AND original_subject = ? ORDER BY created_at DESC",
            )
            .bind(orgId, spec.subject ?? "")
            .first<CaseRow>()
        : await db
            .prepare(
              "SELECT id, status, verdict FROM cases WHERE org_id = ? AND upload_name = ? ORDER BY created_at DESC",
            )
            .bind(orgId, spec.uploadName ?? "")
            .first<CaseRow>();
    if (!row) {
      out.push({ name: spec.name, caseId: null, status: null, verdict: null, problems: ["the case is missing"] });
      continue;
    }
    const problems: string[] = [];
    if (row.status !== "done") problems.push(`the case is ${row.status}, not done`);
    if (row.verdict !== spec.expectedVerdict)
      problems.push(`the verdict is ${row.verdict ?? "none"}, not ${spec.expectedVerdict}`);
    out.push({ name: spec.name, caseId: row.id, status: row.status, verdict: row.verdict, problems });
  }
  return out;
}
