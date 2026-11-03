// Training copies (D05 T04 §10): the moment a monitor page is labelled, its fetched page is
// copied to R2 under `training/`, where no lifecycle rule deletes it, so Loupe's training store
// can be rebuilt from the copies long after the case's own artefacts are deleted at 30 days.
// The copy is the page the daily run fetched (`<capture_key>screenshot.jpg` and
// `<capture_key>text.txt`), never a walkthrough capture taken after a form was filled or anything
// from a member's own account. Identity is the captured page itself, tenant-scoped by its capture
// key (`monitor/<org>/<host>/<fetchedAt>`); each copy carries its label provenance (`sourceRef`),
// supports human dismissal overrides and restore retractions, and writes `done.json` last so a
// partial copy is never mistaken for a finished one.
export type TrainingLabel = "lure" | "benign";
export type TrainingSource = "pipeline" | "second-look" | "dismissal";
export type StoredTrainingSource = TrainingSource | "restore";

export type TrainingCopy = {
  orgId: string;
  host: string;
  captureKey: string;
  captureUrl: string | null;
  label: TrainingLabel;
  why: string;
  source: TrainingSource;
  sourceRef?: string;
  decisionSeq?: number;
};

export type TrainingHistoryEntry = {
  label: TrainingLabel;
  source: StoredTrainingSource;
  sourceRef: string;
  why: string;
  at: string;
  retracted?: boolean;
};

export type StoredTrainingMeta = {
  trainingId: string;
  orgId: string;
  host: string;
  captureKey: string;
  url: string | null;
  fetchedAt: string;
  label: TrainingLabel;
  why: string;
  source: StoredTrainingSource;
  sourceRef: string;
  copiedAt: string;
  updatedAt: string;
  retracted?: boolean;
  retractedAt?: string;
  decisionSeq?: number;
  history?: TrainingHistoryEntry[];
};

export type CopyOutcome = "copied" | "updated" | "exists" | "missing-source" | "ineligible-source" | "removed";

export type FindingDecision = {
  captureKey: string;
  kind: "dismissal" | "restore";
  reason: string;
  at: string;
  seq?: number;
};

export function latestDismissedCaptureKey(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const firstLine = (raw.split("\n")[0] ?? "").trim();
  if (!firstLine) return null;
  return firstLine.replace(/^restored:/, "");
}

export function parseFindingDecisions(row: {
  status: string;
  capture_key: string;
  dismissed_reason: string | null;
  dismissed_capture_key: string | null;
}): FindingDecision[] {
  const raw = row.dismissed_capture_key;
  if (!raw) {
    if (row.status === "dismissed" && row.dismissed_reason) {
      return [
        {
          captureKey: row.capture_key,
          kind: "dismissal",
          reason: row.dismissed_reason,
          at: "",
        },
      ];
    }
    return [];
  }
  const lines = raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const byCapture = new Map<string, FindingDecision>();
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line?.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(line) as Partial<FindingDecision>;
      if (
        typeof parsed.captureKey === "string" &&
        (parsed.kind === "dismissal" || parsed.kind === "restore") &&
        typeof parsed.reason === "string"
      ) {
        byCapture.set(parsed.captureKey, {
          captureKey: parsed.captureKey,
          kind: parsed.kind,
          reason: parsed.reason,
          at: typeof parsed.at === "string" ? parsed.at : "",
          ...(typeof parsed.seq === "number" ? { seq: parsed.seq } : {}),
        });
      }
    } catch {
      // Ignore malformed trailing line.
    }
  }
  const head = lines[0] ?? "";
  const isHeadRestore = head.startsWith("restored:");
  const headKey = head.replace(/^restored:/, "");
  if (headKey && !byCapture.has(headKey)) {
    if ((isHeadRestore || !row.dismissed_reason) && row.status !== "dismissed") {
      byCapture.set(headKey, {
        captureKey: headKey,
        kind: "restore",
        reason: "finding restored by business",
        at: "",
      });
    } else if (row.dismissed_reason && isBenignDismissalReason(row.dismissed_reason)) {
      byCapture.set(headKey, {
        captureKey: headKey,
        kind: "dismissal",
        reason: row.dismissed_reason,
        at: "",
      });
    }
  }
  return [...byCapture.values()];
}

export function encodeFindingDecision(
  existing: {
    status: string;
    capture_key: string;
    dismissed_reason: string | null;
    dismissed_capture_key: string | null;
  },
  next: FindingDecision,
): string {
  const prior = parseFindingDecisions(existing);
  const byCapture = new Map<string, FindingDecision>();
  let maxSeq = 0;
  for (const item of prior) {
    byCapture.set(item.captureKey, item);
    if (typeof item.seq === "number" && item.seq > maxSeq) maxSeq = item.seq;
  }
  if (maxSeq === 0 && prior.length > 0) maxSeq = prior.length;
  const nextSeq = next.seq ?? maxSeq + 1;
  if (next.kind === "restore" || isBenignDismissalReason(next.reason)) {
    byCapture.set(next.captureKey, { ...next, seq: nextSeq });
  }
  const head = next.kind === "restore" ? `restored:${next.captureKey}` : next.captureKey;
  const serialized = [...byCapture.values()].map((d) => JSON.stringify(d));
  return [head, ...serialized].join("\n");
}

const CAPTURE_KEY_PATTERN = /^monitor\/([^/]+)\/([^/]+)\/(\d{4}-\d{2}-\d{2}T[^/]+)\/$/;

export function parseCaptureKey(
  captureKey: string,
  expectedOrgId?: string,
  expectedHost?: string,
): { orgId: string; host: string; fetchedAt: string; trainingId: string; prefix: string } | null {
  if (captureKey.includes("..")) return null;
  const match = CAPTURE_KEY_PATTERN.exec(captureKey);
  if (!match) return null;
  const [, orgId, host, fetchedAt] = match;
  if (!orgId || !host || !fetchedAt) return null;
  if (expectedOrgId !== undefined && orgId !== expectedOrgId) return null;
  if (expectedHost !== undefined && host !== expectedHost) return null;
  const trainingId = `monitor/${orgId}/${host}/${fetchedAt}`;
  return { orgId, host, fetchedAt, trainingId, prefix: `training/${trainingId}/` };
}

export function trainingIdForCapture(captureKey: string): string | null {
  return parseCaptureKey(captureKey)?.trainingId ?? null;
}

export function defaultSourceRef(copy: Pick<TrainingCopy, "orgId" | "host" | "captureKey" | "source">): string {
  switch (copy.source) {
    case "pipeline":
      return `investigation:${copy.orgId}:${copy.captureKey}`;
    case "second-look":
      return `screen:${copy.orgId}:${copy.host}:${copy.captureKey}`;
    case "dismissal":
      return `finding:${copy.orgId}:${copy.host}:${copy.captureKey}`;
  }
}

const ANCHORED_NOT_FAKE_CLAUSE =
  /^(?:(?:this|it)(?:\s+(?:site|domain|page|url|host))?\s+is\s+)?not\s+(?:a\s+|an\s+)?(?:fake|lure|phish(?:ing)?|scam|impersonation|spoof|fraud)(?:\s+(?:site|domain|page))?$/i;

const ANCHORED_BENIGN_CLAUSE =
  /^(?:(?:(?:this|it)(?:\s+(?:site|domain|page|url|host))?\s+is\s+)?(?:(?:our|the\s+business'?s)\s+(?:own\s+)?(?:(?:legitimate|official|authori[sz]ed|valid|real|genuine|approved|known|test|campaign|marketing|staging|regional|secondary|partner)\s+){0,2}(?:site|domain|brand|page|url|host|property|portal|landing\s+page)|(?:a\s+|an\s+)?(?:legitimate|official|authori[sz]ed|valid|real|genuine|approved|known|partner)\s+(?:(?:partner|vendor|agency|brand|company|business|campaign|test|marketing|staging|regional)\s+){0,2}(?:site|domain|page|url|host|portal)|(?:legitimate|official|authori[sz]ed)|(?:a\s+)?false\s+positive|owned\s+by\s+us)|(?:(?:this|it)(?:\s+(?:site|domain|page|url|host))?\s+)?belong(?:s|ing)?\s+to\s+us)$/i;

// A dismissal qualifies as a benign training label only when every clause is an anchored,
// unambiguous affirmative benign classification (not a fake, false positive, or the business's
// own / authorised / legitimate site), rejecting any uncertainty, negation, question, or
// operational-triage statement.
export function isBenignDismissalReason(reason: string): boolean {
  const trimmed = reason.trim();
  if (!trimmed || trimmed.includes("?")) return false;
  const clauses = trimmed
    .split(/[,;:.!\n]+/)
    .map((c) => c.trim())
    .filter(Boolean);
  if (clauses.length === 0) return false;
  return clauses.every((clause) => ANCHORED_NOT_FAKE_CLAUSE.test(clause) || ANCHORED_BENIGN_CLAUSE.test(clause));
}

// Reads the immutable final URL captured with `captureKey`: explicit caller value first, then the
// capture's own `<capture_key>url.txt` in R2, then `monitor_investigations.capture_url` for that
// capture, and finally `monitor_hosts.capture_url` only if `monitor_hosts.capture_key` still names
// `captureKey` (never a later capture's overwritten URL).
export async function resolveCaptureUrl(
  db: D1Database | null,
  bucket: R2Bucket,
  orgId: string,
  host: string,
  captureKey: string,
  explicitUrl: string | null = null,
): Promise<string | null> {
  if (explicitUrl) return explicitUrl;
  const fromR2 = await bucket
    .get(`${captureKey}url.txt`)
    .then(async (obj) => (obj ? (await obj.text()).trim() || null : null))
    .catch(() => null);
  if (fromR2) return fromR2;
  if (!db) return null;
  const fromInv = await db
    .prepare("SELECT capture_url FROM monitor_investigations WHERE org_id = ? AND capture_key = ?")
    .bind(orgId, captureKey)
    .first<{ capture_url: string | null }>()
    .then((row) => row?.capture_url ?? null)
    .catch(() => null);
  if (fromInv) return fromInv;
  const fromHost = await db
    .prepare("SELECT capture_url FROM monitor_hosts WHERE org_id = ? AND domain = ? AND capture_key = ?")
    .bind(orgId, host, captureKey)
    .first<{ capture_url: string | null }>()
    .then((row) => row?.capture_url ?? null)
    .catch(() => null);
  return fromHost;
}

const hostRemovedKey = (orgId: string, host: string) => `training/monitor/${orgId}/${host}/removed.json`;

const HOST_LOCKS_SYMBOL = Symbol.for("isitlegit.monitor.training.hostLocks");

function getLockMap(holder: unknown): Map<string, Promise<unknown>> | null {
  if (!holder || (typeof holder !== "object" && typeof holder !== "function")) return null;
  const record = holder as Record<symbol, Map<string, Promise<unknown>> | undefined>;
  let map = record[HOST_LOCKS_SYMBOL];
  if (!map) {
    map = new Map<string, Promise<unknown>>();
    try {
      record[HOST_LOCKS_SYMBOL] = map;
    } catch {
      return null;
    }
  }
  return record[HOST_LOCKS_SYMBOL] ?? null;
}

function getHostLockMaps(bucket: R2Bucket): Map<string, Promise<unknown>>[] {
  const maps: Map<string, Promise<unknown>>[] = [];
  const bucketMap = getLockMap(bucket);
  if (bucketMap) maps.push(bucketMap);
  const globalMap = getLockMap(globalThis);
  if (globalMap && !maps.includes(globalMap)) maps.push(globalMap);
  return maps;
}

async function withHostLock<T>(bucket: R2Bucket, orgId: string, host: string, fn: () => Promise<T>): Promise<T> {
  const maps = getHostLockMaps(bucket);
  const key = `${orgId}\0${host}`;
  const prevs = maps.map((m) => m.get(key) ?? Promise.resolve());
  const prevAll = Promise.all(prevs.map((p) => p.catch(() => null)));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chain = prevAll.then(
    () => gate,
    () => gate,
  );
  for (const m of maps) {
    m.set(key, chain);
  }
  try {
    await prevAll;
    return await fn();
  } finally {
    release();
    for (const m of maps) {
      if (m.get(key) === chain) {
        m.delete(key);
      }
    }
  }
}

async function isRemoved(bucket: R2Bucket, orgId: string, host: string, prefix: string): Promise<boolean> {
  const [hostTombstone, captureTombstone] = await Promise.all([
    bucket.head(hostRemovedKey(orgId, host)),
    bucket.head(`${prefix}removed.json`),
  ]);
  return hostTombstone !== null || captureTombstone !== null;
}

const CAPTURE_OBJECT_FILES = ["done.json", "meta.json", "screenshot.jpg", "text.txt"] as const;

async function cleanupCaptureObjects(bucket: R2Bucket, prefix: string, extraKeys: string[] = []): Promise<boolean> {
  const keys = [...new Set<string>([...CAPTURE_OBJECT_FILES.map((name) => `${prefix}${name}`), ...extraKeys])];
  const existingBefore = await Promise.all(keys.map((key) => bucket.head(key).catch(() => ({}) as R2Object)));
  const hadResidual = existingBefore.some((res) => res !== null);
  let deleteFailed = false;
  for (const key of keys) {
    try {
      await bucket.delete(key);
    } catch {
      deleteFailed = true;
    }
  }
  const remainingAfter = await Promise.all(
    keys.map((key) =>
      bucket
        .head(key)
        .then((res) => res !== null)
        .catch(() => true),
    ),
  );
  if (deleteFailed || remainingAfter.some(Boolean)) {
    throw new Error(`failed to clean up removed R2 training objects under ${prefix}`);
  }
  return hadResidual;
}

async function putChecked(
  bucket: R2Bucket,
  orgId: string,
  host: string,
  prefix: string,
  key: string,
  value: ArrayBuffer | string,
  options: R2PutOptions,
): Promise<boolean> {
  if (await isRemoved(bucket, orgId, host, prefix)) {
    await cleanupCaptureObjects(bucket, prefix);
    return false;
  }
  await bucket.put(key, value, options);
  let removedAfterPut = false;
  try {
    removedAfterPut = await isRemoved(bucket, orgId, host, prefix);
  } catch (err) {
    await cleanupCaptureObjects(bucket, prefix).catch(() => null);
    throw err;
  }
  if (removedAfterPut) {
    await cleanupCaptureObjects(bucket, prefix);
    return false;
  }
  return true;
}

async function readExistingMeta(bucket: R2Bucket, prefix: string): Promise<StoredTrainingMeta | null> {
  const obj = await bucket.get(`${prefix}meta.json`);
  if (!obj) return null;
  return JSON.parse(await obj.text()) as StoredTrainingMeta;
}

export async function copyForTraining(
  bucket: R2Bucket,
  copy: TrainingCopy,
  now: () => Date = () => new Date(),
): Promise<CopyOutcome> {
  const parsed = parseCaptureKey(copy.captureKey, copy.orgId, copy.host);
  if (!parsed) return "ineligible-source";
  const { prefix, trainingId, fetchedAt } = parsed;
  return withHostLock(bucket, copy.orgId, copy.host, async () => {
    if (await isRemoved(bucket, copy.orgId, copy.host, prefix)) {
      await cleanupCaptureObjects(bucket, prefix);
      return "removed";
    }

    const [doneHead, shotHead, textHead, existingMeta] = await Promise.all([
      bucket.head(`${prefix}done.json`),
      bucket.head(`${prefix}screenshot.jpg`),
      bucket.head(`${prefix}text.txt`),
      readExistingMeta(bucket, prefix),
    ]);
    const complete = doneHead !== null && shotHead !== null && textHead !== null && existingMeta !== null;

    let effectiveCopy: TrainingCopy = copy;
    if (existingMeta) {
      if (
        existingMeta.decisionSeq !== undefined &&
        copy.decisionSeq !== undefined &&
        copy.decisionSeq < existingMeta.decisionSeq
      ) {
        if (existingMeta.retracted || existingMeta.source === "restore") {
          if (doneHead !== null) return "exists";
          const nowIso = now().toISOString();
          const ok = await putChecked(
            bucket,
            copy.orgId,
            copy.host,
            prefix,
            `${prefix}done.json`,
            JSON.stringify({
              at: existingMeta.updatedAt ?? existingMeta.copiedAt ?? nowIso,
              label: existingMeta.label,
              source: "restore",
              sourceRef: existingMeta.sourceRef ?? `finding:${copy.orgId}:${copy.host}:${copy.captureKey}`,
              retracted: true,
            }),
            { httpMetadata: { contentType: "application/json" } },
          );
          return ok ? "updated" : "removed";
        }
        return "exists";
      }
      // Precedence: restore (retracted) > human dismissal > automated pipeline / second-look.
      // Precedence holds even when an earlier write was interrupted before done.json or before the
      // page bytes landed: automated recovery repairs missing objects without downgrading a human
      // dismissal or retraction.
      if (existingMeta.retracted || existingMeta.source === "restore") {
        if (
          copy.source !== "dismissal" ||
          (existingMeta.decisionSeq !== undefined &&
            copy.decisionSeq !== undefined &&
            copy.decisionSeq <= existingMeta.decisionSeq)
        ) {
          if (doneHead !== null) return "exists";
          const nowIso = now().toISOString();
          const ok = await putChecked(
            bucket,
            copy.orgId,
            copy.host,
            prefix,
            `${prefix}done.json`,
            JSON.stringify({
              at: existingMeta.updatedAt ?? existingMeta.copiedAt ?? nowIso,
              label: existingMeta.label,
              source: "restore",
              sourceRef: existingMeta.sourceRef ?? `finding:${copy.orgId}:${copy.host}:${copy.captureKey}`,
              retracted: true,
            }),
            { httpMetadata: { contentType: "application/json" } },
          );
          return ok ? "updated" : "removed";
        }
      } else if (existingMeta.source === "dismissal") {
        if (copy.source !== "dismissal") {
          if (complete) return "exists";
          effectiveCopy = {
            ...copy,
            label: existingMeta.label,
            why: existingMeta.why,
            source: "dismissal",
            sourceRef: existingMeta.sourceRef ?? `finding:${copy.orgId}:${copy.host}:${copy.captureKey}`,
            captureUrl: existingMeta.url ?? copy.captureUrl ?? null,
            ...(existingMeta.decisionSeq !== undefined ? { decisionSeq: existingMeta.decisionSeq } : {}),
          };
        } else if (
          complete &&
          existingMeta.label === copy.label &&
          existingMeta.why === copy.why &&
          (copy.decisionSeq === undefined || existingMeta.decisionSeq === copy.decisionSeq)
        ) {
          return "exists";
        }
      } else if (complete && existingMeta.source === copy.source && existingMeta.label === copy.label) {
        return "exists";
      }
    }
    const effectiveSourceRef = effectiveCopy.sourceRef ?? defaultSourceRef(effectiveCopy);

    let shotBytes: ArrayBuffer | null = null;
    let textBytes: ArrayBuffer | null = null;
    if (!shotHead || !textHead) {
      const [shot, text] = await Promise.all([
        bucket.get(`${effectiveCopy.captureKey}screenshot.jpg`).catch(() => null),
        bucket.get(`${effectiveCopy.captureKey}text.txt`).catch(() => null),
      ]);
      if (!shot || !text) return "missing-source";
      [shotBytes, textBytes] = await Promise.all([shot.arrayBuffer(), text.arrayBuffer()]);
    }
    const resolvedUrl =
      effectiveCopy.captureUrl ??
      existingMeta?.url ??
      (await resolveCaptureUrl(null, bucket, effectiveCopy.orgId, effectiveCopy.host, effectiveCopy.captureKey, null));

    if (await isRemoved(bucket, copy.orgId, copy.host, prefix)) {
      await cleanupCaptureObjects(bucket, prefix);
      return "removed";
    }
    if (shotBytes && textBytes) {
      if (
        !(await putChecked(bucket, copy.orgId, copy.host, prefix, `${prefix}screenshot.jpg`, shotBytes, {
          httpMetadata: { contentType: "image/jpeg" },
        }))
      ) {
        return "removed";
      }
      if (
        !(await putChecked(bucket, copy.orgId, copy.host, prefix, `${prefix}text.txt`, textBytes, {
          httpMetadata: { contentType: "text/plain" },
        }))
      ) {
        return "removed";
      }
    }
    const nowIso = now().toISOString();
    const sameMetaAsExisting =
      existingMeta !== null &&
      !existingMeta.retracted &&
      existingMeta.source === effectiveCopy.source &&
      existingMeta.label === effectiveCopy.label &&
      existingMeta.why === effectiveCopy.why;
    const history: TrainingHistoryEntry[] =
      existingMeta && !sameMetaAsExisting
        ? [
            ...(existingMeta.history ?? []),
            {
              label: existingMeta.label,
              source: existingMeta.source,
              sourceRef: existingMeta.sourceRef ?? defaultSourceRef({ ...effectiveCopy, source: "pipeline" }),
              why: existingMeta.why,
              at: existingMeta.updatedAt ?? existingMeta.copiedAt,
              ...(existingMeta.retracted ? { retracted: true } : {}),
            },
          ]
        : (existingMeta?.history ?? []);
    const meta: StoredTrainingMeta = {
      trainingId,
      orgId: effectiveCopy.orgId,
      host: effectiveCopy.host,
      captureKey: effectiveCopy.captureKey,
      url: resolvedUrl,
      fetchedAt,
      label: effectiveCopy.label,
      why: effectiveCopy.why,
      source: effectiveCopy.source,
      sourceRef: effectiveSourceRef,
      copiedAt: existingMeta?.copiedAt ?? nowIso,
      updatedAt: sameMetaAsExisting ? (existingMeta?.updatedAt ?? nowIso) : nowIso,
      retracted: false,
      ...(effectiveCopy.decisionSeq !== undefined
        ? { decisionSeq: effectiveCopy.decisionSeq }
        : existingMeta?.decisionSeq !== undefined
          ? { decisionSeq: existingMeta.decisionSeq }
          : {}),
      ...(history.length ? { history } : {}),
    };
    if (
      !(await putChecked(bucket, copy.orgId, copy.host, prefix, `${prefix}meta.json`, JSON.stringify(meta), {
        httpMetadata: { contentType: "application/json" },
      }))
    ) {
      return "removed";
    }
    // The completion marker last: a copy without it is partial and is redone, never exported.
    if (
      !(await putChecked(
        bucket,
        copy.orgId,
        copy.host,
        prefix,
        `${prefix}done.json`,
        JSON.stringify({
          at: meta.updatedAt,
          label: effectiveCopy.label,
          source: effectiveCopy.source,
          sourceRef: effectiveSourceRef,
          retracted: false,
        }),
        { httpMetadata: { contentType: "application/json" } },
      ))
    ) {
      return "removed";
    }
    return complete ? "updated" : "copied";
  });
}

// Retracts a dismissed capture's training copy when the business restores the finding.
export async function retractTrainingCopy(
  bucket: R2Bucket,
  orgId: string,
  host: string,
  captureKey: string,
  reason = "finding restored by business",
  now: () => Date = () => new Date(),
  decisionSeq?: number,
): Promise<"retracted" | "missing" | "removed"> {
  const cleanKey = captureKey.replace(/^restored:/, "");
  const parsed = parseCaptureKey(cleanKey, orgId, host);
  if (!parsed) return "missing";
  const { prefix, trainingId, fetchedAt } = parsed;
  return withHostLock(bucket, orgId, host, async () => {
    if (await isRemoved(bucket, orgId, host, prefix)) {
      await cleanupCaptureObjects(bucket, prefix);
      return "removed";
    }
    const [existing, doneHead] = await Promise.all([
      readExistingMeta(bucket, prefix),
      bucket.head(`${prefix}done.json`),
    ]);
    const nowIso = now().toISOString();
    const sourceRef = `finding:${orgId}:${host}:${cleanKey}`;
    if (existing?.decisionSeq !== undefined && decisionSeq !== undefined && decisionSeq < existing.decisionSeq) {
      return "retracted";
    }
    if (existing?.retracted && (decisionSeq === undefined || existing.decisionSeq === decisionSeq)) {
      if (!doneHead) {
        const ok = await putChecked(
          bucket,
          orgId,
          host,
          prefix,
          `${prefix}done.json`,
          JSON.stringify({
            at: existing.updatedAt ?? existing.copiedAt ?? nowIso,
            label: existing.label,
            source: "restore",
            sourceRef,
            retracted: true,
          }),
          { httpMetadata: { contentType: "application/json" } },
        );
        if (!ok) return "removed";
      }
      return "retracted";
    }
    const history: TrainingHistoryEntry[] = existing
      ? [
          ...(existing.history ?? []),
          {
            label: existing.label,
            source: existing.source,
            sourceRef: existing.sourceRef ?? sourceRef,
            why: existing.why,
            at: existing.updatedAt ?? existing.copiedAt,
          },
        ]
      : [];
    const nextSeq = decisionSeq ?? existing?.decisionSeq;
    const updated: StoredTrainingMeta = existing
      ? {
          ...existing,
          source: "restore",
          sourceRef,
          why: reason,
          updatedAt: nowIso,
          retracted: true,
          retractedAt: nowIso,
          ...(nextSeq !== undefined ? { decisionSeq: nextSeq } : {}),
          ...(history.length ? { history } : {}),
        }
      : {
          trainingId,
          orgId,
          host,
          captureKey: cleanKey,
          url: await resolveCaptureUrl(null, bucket, orgId, host, cleanKey, null),
          fetchedAt,
          label: "lure",
          why: reason,
          source: "restore",
          sourceRef,
          copiedAt: nowIso,
          updatedAt: nowIso,
          retracted: true,
          retractedAt: nowIso,
          ...(nextSeq !== undefined ? { decisionSeq: nextSeq } : {}),
        };
    if (
      !(await putChecked(bucket, orgId, host, prefix, `${prefix}meta.json`, JSON.stringify(updated), {
        httpMetadata: { contentType: "application/json" },
      }))
    ) {
      return "removed";
    }
    if (
      !(await putChecked(
        bucket,
        orgId,
        host,
        prefix,
        `${prefix}done.json`,
        JSON.stringify({
          at: nowIso,
          label: updated.label,
          source: "restore",
          sourceRef,
          retracted: true,
        }),
        { httpMetadata: { contentType: "application/json" } },
      ))
    ) {
      return "removed";
    }
    return "retracted";
  });
}

// Authorised removal procedure (D05 T04 §10): writes the host tombstone first so any concurrent
// copy across isolates observes it, deletes stored training copies for `(orgId, host)` in R2
// across all pages, verifies deletion of every object, and records durable `removed.json`
// tombstones so neither production recovery nor the read-only local exporter can re-copy or reimport
// them.
export async function removeTrainingCopiesForHost(
  bucket: R2Bucket,
  orgId: string,
  host: string,
  reason = "removed at the business's request",
  now: () => Date = () => new Date(),
): Promise<{ removed: string[] }> {
  return withHostLock(bucket, orgId, host, async () => {
    const basePrefix = `training/monitor/${orgId}/${host}/`;
    const nowIso = now().toISOString();
    const hadHostTombstone = (await bucket.head(hostRemovedKey(orgId, host))) !== null;
    // Publish the host tombstone BEFORE listing so any concurrent writer in another execution
    // context either lands its writes before our list or sees this tombstone on its post-put check.
    await bucket.put(
      hostRemovedKey(orgId, host),
      JSON.stringify({ orgId, host, reason, removedAt: nowIso, captures: [] }),
      { httpMetadata: { contentType: "application/json" } },
    );

    const listAllUnderHost = async () => {
      const out: { key: string }[] = [];
      let cursor: string | undefined;
      while (true) {
        const listed = await bucket.list({ prefix: basePrefix, ...(cursor ? { cursor } : {}) });
        out.push(...listed.objects);
        if (!listed.truncated) break;
        cursor = listed.cursor;
        if (!cursor) break;
      }
      return out;
    };

    const removedSet = new Set<string>();
    const failedSet = new Set<string>();
    for (let pass = 0; pass < 2; pass++) {
      const allObjects = await listAllUnderHost();
      const capturePrefixes = new Set<string>();
      const extraKeysByPrefix = new Map<string, string[]>();
      for (const obj of allObjects) {
        const rel = obj.key.slice(basePrefix.length);
        const moment = rel.split("/")[0];
        if (moment && /^\d{4}-\d{2}-\d{2}T/.test(moment)) {
          const prefix = `${basePrefix}${moment}/`;
          capturePrefixes.add(prefix);
          if (!obj.key.endsWith("/removed.json")) {
            const list = extraKeysByPrefix.get(prefix) ?? [];
            list.push(obj.key);
            extraKeysByPrefix.set(prefix, list);
          }
        }
      }
      for (const prefix of [...capturePrefixes].sort()) {
        const trainingId = prefix.replace(/^training\//, "").replace(/\/$/, "");
        const extraKeys = extraKeysByPrefix.get(prefix) ?? [];
        if (pass > 0 && extraKeys.length === 0 && removedSet.has(trainingId)) {
          continue;
        }
        const keysToDelete = [
          ...new Set<string>([
            `${prefix}done.json`,
            `${prefix}meta.json`,
            `${prefix}screenshot.jpg`,
            `${prefix}text.txt`,
            ...extraKeys,
          ]),
        ];
        let deleteFailed = false;
        for (const key of keysToDelete) {
          try {
            await bucket.delete(key);
          } catch {
            deleteFailed = true;
          }
        }
        const verifyHeads = await Promise.all(
          keysToDelete.map((key) =>
            bucket
              .head(key)
              .then((res) => res !== null)
              .catch(() => true),
          ),
        );
        if (deleteFailed || verifyHeads.some(Boolean)) {
          failedSet.add(trainingId);
          continue;
        }
        await bucket.put(
          `${prefix}removed.json`,
          JSON.stringify({ trainingId, orgId, host, reason, removedAt: nowIso }),
          {
            httpMetadata: { contentType: "application/json" },
          },
        );
        failedSet.delete(trainingId);
        removedSet.add(trainingId);
      }
    }
    const failedCaptures = [...failedSet];
    if (failedCaptures.length > 0) {
      if (!hadHostTombstone) {
        await bucket.delete(hostRemovedKey(orgId, host)).catch(() => null);
      }
      throw new Error(`failed to remove R2 training objects for: ${failedCaptures.join(", ")}`);
    }
    const removed = [...removedSet].sort();
    await bucket.put(
      hostRemovedKey(orgId, host),
      JSON.stringify({ orgId, host, reason, removedAt: nowIso, captures: removed }),
      { httpMetadata: { contentType: "application/json" } },
    );
    return { removed };
  });
}

// Durable pending-copy recovery (D05 T04 §10): scans settled labels in D1 (`monitor_screens` with
// `second_look = 'declined'`, `monitor_investigations` with `state = 'confirmed'`, and
// `monitor_findings` with a qualifying dismissal or restore) and repairs any missing, partial or
// stale R2 `training/` copy before the 30-day source expiry, without changing investigation outcomes.
export async function recoverPendingTrainingCopies(
  db: D1Database,
  bucket: R2Bucket,
  orgId: string,
  now: () => Date = () => new Date(),
): Promise<{ recovered: number; failed: number; errors?: string[] }> {
  let recovered = 0;
  let failed = 0;
  const errors: string[] = [];

  // Reconcile any tombstoned hosts or captures in R2 that still have residual objects from an
  // interrupted or failed post-write check.
  const orgPrefix = `training/monitor/${orgId}/`;
  const failedRemovedPrefixes = new Set<string>();
  if (typeof bucket.list === "function") {
    try {
      const allOrgObjects: { key: string }[] = [];
      let cursor: string | undefined;
      while (true) {
        const listed = await bucket.list({ prefix: orgPrefix, ...(cursor ? { cursor } : {}) });
        allOrgObjects.push(...listed.objects);
        if (!listed.truncated) break;
        cursor = listed.cursor;
        if (!cursor) break;
      }
      const removedHosts = new Set<string>();
      const removedCapturePrefixes = new Set<string>();
      const residualByPrefix = new Map<string, { host: string; keys: string[] }>();
      for (const obj of allOrgObjects) {
        const rel = obj.key.slice(orgPrefix.length);
        const parts = rel.split("/");
        const host = parts[0];
        if (!host) continue;
        if (parts.length === 2 && parts[1] === "removed.json") {
          removedHosts.add(host);
          continue;
        }
        const moment = parts[1];
        if (moment && /^\d{4}-\d{2}-\d{2}T/.test(moment)) {
          const prefix = `${orgPrefix}${host}/${moment}/`;
          if (parts.length === 3 && parts[2] === "removed.json") {
            removedCapturePrefixes.add(prefix);
          } else {
            const entry = residualByPrefix.get(prefix) ?? { host, keys: [] };
            entry.keys.push(obj.key);
            residualByPrefix.set(prefix, entry);
          }
        }
      }
      for (const [prefix, info] of residualByPrefix.entries()) {
        if (removedHosts.has(info.host) || removedCapturePrefixes.has(prefix)) {
          try {
            const cleaned = await cleanupCaptureObjects(bucket, prefix, info.keys);
            if (!removedCapturePrefixes.has(prefix)) {
              const trainingId = prefix.replace(/^training\//, "").replace(/\/$/, "");
              await bucket.put(
                `${prefix}removed.json`,
                JSON.stringify({
                  trainingId,
                  orgId,
                  host: info.host,
                  reason: "reconciled after host removal",
                  removedAt: now().toISOString(),
                }),
                { httpMetadata: { contentType: "application/json" } },
              );
            }
            if (cleaned || info.keys.length > 0) recovered++;
          } catch (err) {
            failedRemovedPrefixes.add(prefix);
            failed++;
            errors.push(`reconcile-removed:${prefix}:${(err as Error).message || "failed"}`);
          }
        }
      }
    } catch (err) {
      failed++;
      errors.push(`list-org:${(err as Error).message || "failed"}`);
    }
  }

  let declined: { domain: string; capture_key: string }[] = [];
  try {
    declined = (
      await db
        .prepare("SELECT domain, capture_key FROM monitor_screens WHERE org_id = ? AND second_look = 'declined'")
        .bind(orgId)
        .all<{ domain: string; capture_key: string }>()
    ).results;
  } catch (err) {
    failed++;
    errors.push(`query-screens:${(err as Error).message || "failed"}`);
  }

  for (const row of declined) {
    if (failedRemovedPrefixes.has(`training/${row.capture_key}`)) continue;
    try {
      const url = await resolveCaptureUrl(db, bucket, orgId, row.domain, row.capture_key);
      const out = await copyForTraining(
        bucket,
        {
          orgId,
          host: row.domain,
          captureKey: row.capture_key,
          captureUrl: url,
          label: "benign",
          why: "Muse Spark second look declined Loupe's lure flag",
          source: "second-look",
          sourceRef: `screen:${orgId}:${row.domain}:${row.capture_key}`,
        },
        now,
      );
      if (out === "copied" || out === "updated") recovered++;
      else if (out === "missing-source") {
        failed++;
        errors.push(`missing-source:${row.capture_key}`);
      }
    } catch (err) {
      failed++;
      errors.push(`copy-declined:${row.capture_key}:${(err as Error).message || "failed"}`);
    }
  }

  let confirmed: { domain: string; capture_key: string; capture_url: string | null }[] = [];
  try {
    confirmed = (
      await db
        .prepare(
          "SELECT domain, capture_key, capture_url FROM monitor_investigations WHERE org_id = ? AND state = 'confirmed'",
        )
        .bind(orgId)
        .all<{ domain: string; capture_key: string; capture_url: string | null }>()
    ).results;
  } catch (err) {
    failed++;
    errors.push(`query-investigations:${(err as Error).message || "failed"}`);
  }

  for (const row of confirmed) {
    if (failedRemovedPrefixes.has(`training/${row.capture_key}`)) continue;
    try {
      const url = await resolveCaptureUrl(db, bucket, orgId, row.domain, row.capture_key, row.capture_url);
      const out = await copyForTraining(
        bucket,
        {
          orgId,
          host: row.domain,
          captureKey: row.capture_key,
          captureUrl: url,
          label: "lure",
          why: "the full pipeline confirmed this page as a lure",
          source: "pipeline",
          sourceRef: `investigation:${orgId}:${row.capture_key}`,
        },
        now,
      );
      if (out === "copied" || out === "updated") recovered++;
      else if (out === "missing-source") {
        failed++;
        errors.push(`missing-source:${row.capture_key}`);
      }
    } catch (err) {
      failed++;
      errors.push(`copy-confirmed:${row.capture_key}:${(err as Error).message || "failed"}`);
    }
  }

  let findings: {
    host: string;
    status: string;
    capture_key: string;
    dismissed_reason: string | null;
    dismissed_capture_key: string | null;
  }[] = [];
  try {
    findings = (
      await db
        .prepare(
          "SELECT host, status, capture_key, dismissed_reason, dismissed_capture_key FROM monitor_findings WHERE org_id = ? AND (status = 'dismissed' OR dismissed_capture_key IS NOT NULL)",
        )
        .bind(orgId)
        .all<{
          host: string;
          status: string;
          capture_key: string;
          dismissed_reason: string | null;
          dismissed_capture_key: string | null;
        }>()
    ).results;
  } catch (err) {
    failed++;
    errors.push(`query-findings:${(err as Error).message || "failed"}`);
  }

  for (const row of findings) {
    const decisions = parseFindingDecisions(row);
    for (const decision of decisions) {
      const targetKey = decision.captureKey;
      if (failedRemovedPrefixes.has(`training/${targetKey}`)) continue;
      try {
        if (decision.kind === "restore") {
          const parsed = parseCaptureKey(targetKey, orgId, row.host);
          if (parsed) {
            const [removedNow, meta, doneHead] = await Promise.all([
              isRemoved(bucket, orgId, row.host, parsed.prefix),
              readExistingMeta(bucket, parsed.prefix),
              bucket.head(`${parsed.prefix}done.json`),
            ]);
            if (removedNow || !meta?.retracted || !doneHead) {
              const out = await retractTrainingCopy(
                bucket,
                orgId,
                row.host,
                targetKey,
                decision.reason,
                now,
                decision.seq,
              );
              if (out === "retracted") recovered++;
            }
          }
        } else if (decision.reason && isBenignDismissalReason(decision.reason)) {
          const url = await resolveCaptureUrl(db, bucket, orgId, row.host, targetKey);
          const out = await copyForTraining(
            bucket,
            {
              orgId,
              host: row.host,
              captureKey: targetKey,
              captureUrl: url,
              label: "benign",
              why: `dismissed as not a fake: ${decision.reason.trim().slice(0, 120)}`,
              source: "dismissal",
              sourceRef: `finding:${orgId}:${row.host}:${targetKey}`,
              ...(decision.seq !== undefined ? { decisionSeq: decision.seq } : {}),
            },
            now,
          );
          if (out === "copied" || out === "updated") recovered++;
          else if (out === "missing-source") {
            failed++;
            errors.push(`missing-source:${targetKey}`);
          }
        }
      } catch (err) {
        failed++;
        errors.push(`finding-decision:${targetKey}:${(err as Error).message || "failed"}`);
      }
    }
  }

  return failed > 0 ? { recovered, failed, errors } : { recovered, failed };
}
