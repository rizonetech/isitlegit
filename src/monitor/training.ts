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
  history?: TrainingHistoryEntry[];
};

export type CopyOutcome = "copied" | "updated" | "exists" | "missing-source" | "ineligible-source" | "removed";

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

// A dismissal qualifies as a benign training label only when its reason states the site is not a
// fake, is legitimate, or belongs to / is authorised by the business; operational dismissals
// ("duplicate", "already handled", "expired") do not label the page benign.
export function isBenignDismissalReason(reason: string): boolean {
  const trimmed = reason.trim();
  if (!trimmed) return false;
  return /\b(?:not\s+(?:a\s+)?(?:fake|lure|phish(?:ing)?|scam|impersonat\w*)|our\s+(?:own|site|domain|brand|page)|legitimate|authori[sz]ed|official\s+(?:site|domain|partner)|partner\s+(?:site|domain)|false\s+positive|belong(?:s)?\s+to\s+us)\b/i.test(
    trimmed,
  );
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

async function isRemoved(bucket: R2Bucket, orgId: string, host: string, prefix: string): Promise<boolean> {
  const [hostTombstone, captureTombstone] = await Promise.all([
    bucket.head(hostRemovedKey(orgId, host)).catch(() => null),
    bucket.head(`${prefix}removed.json`).catch(() => null),
  ]);
  return hostTombstone !== null || captureTombstone !== null;
}

async function readExistingMeta(bucket: R2Bucket, prefix: string): Promise<StoredTrainingMeta | null> {
  const obj = await bucket.get(`${prefix}meta.json`).catch(() => null);
  if (!obj) return null;
  try {
    return JSON.parse(await obj.text()) as StoredTrainingMeta;
  } catch {
    return null;
  }
}

export async function copyForTraining(
  bucket: R2Bucket,
  copy: TrainingCopy,
  now: () => Date = () => new Date(),
): Promise<CopyOutcome> {
  const parsed = parseCaptureKey(copy.captureKey, copy.orgId, copy.host);
  if (!parsed) return "ineligible-source";
  const { prefix, trainingId, fetchedAt } = parsed;
  if (await isRemoved(bucket, copy.orgId, copy.host, prefix)) return "removed";

  const [doneHead, shotHead, textHead, existingMeta] = await Promise.all([
    bucket.head(`${prefix}done.json`).catch(() => null),
    bucket.head(`${prefix}screenshot.jpg`).catch(() => null),
    bucket.head(`${prefix}text.txt`).catch(() => null),
    readExistingMeta(bucket, prefix),
  ]);
  const complete = doneHead !== null && shotHead !== null && textHead !== null && existingMeta !== null;
  const sourceRef = copy.sourceRef ?? defaultSourceRef(copy);

  if (complete && existingMeta) {
    // Precedence: a restored (retracted) or dismissed capture is not overwritten by an automated
    // pipeline or second-look retry; only a new qualifying human dismissal updates it.
    if (existingMeta.retracted) {
      if (copy.source !== "dismissal") return "exists";
    } else if (existingMeta.source === "dismissal") {
      if (copy.source !== "dismissal") return "exists";
      if (existingMeta.label === copy.label && existingMeta.why === copy.why) return "exists";
    } else if (existingMeta.source === copy.source && existingMeta.label === copy.label) {
      return "exists";
    }
  }

  let shotBytes: ArrayBuffer | null = null;
  let textBytes: ArrayBuffer | null = null;
  if (!shotHead || !textHead) {
    const [shot, text] = await Promise.all([
      bucket.get(`${copy.captureKey}screenshot.jpg`).catch(() => null),
      bucket.get(`${copy.captureKey}text.txt`).catch(() => null),
    ]);
    if (!shot || !text) return "missing-source";
    [shotBytes, textBytes] = await Promise.all([shot.arrayBuffer(), text.arrayBuffer()]);
  }
  const resolvedUrl =
    copy.captureUrl ??
    existingMeta?.url ??
    (await resolveCaptureUrl(null, bucket, copy.orgId, copy.host, copy.captureKey, null));

  if (shotBytes && textBytes) {
    await bucket.put(`${prefix}screenshot.jpg`, shotBytes, { httpMetadata: { contentType: "image/jpeg" } });
    await bucket.put(`${prefix}text.txt`, textBytes, { httpMetadata: { contentType: "text/plain" } });
  }
  const nowIso = now().toISOString();
  const history: TrainingHistoryEntry[] = existingMeta
    ? [
        ...(existingMeta.history ?? []),
        {
          label: existingMeta.label,
          source: existingMeta.source,
          sourceRef: existingMeta.sourceRef ?? defaultSourceRef({ ...copy, source: "pipeline" }),
          why: existingMeta.why,
          at: existingMeta.updatedAt ?? existingMeta.copiedAt,
          ...(existingMeta.retracted ? { retracted: true } : {}),
        },
      ]
    : [];
  const meta: StoredTrainingMeta = {
    trainingId,
    orgId: copy.orgId,
    host: copy.host,
    captureKey: copy.captureKey,
    url: resolvedUrl,
    fetchedAt,
    label: copy.label,
    why: copy.why,
    source: copy.source,
    sourceRef,
    copiedAt: existingMeta?.copiedAt ?? nowIso,
    updatedAt: nowIso,
    retracted: false,
    ...(history.length ? { history } : {}),
  };
  await bucket.put(`${prefix}meta.json`, JSON.stringify(meta), {
    httpMetadata: { contentType: "application/json" },
  });
  // The completion marker last: a copy without it is partial and is redone, never exported.
  await bucket.put(
    `${prefix}done.json`,
    JSON.stringify({
      at: nowIso,
      label: copy.label,
      source: copy.source,
      sourceRef,
      retracted: false,
    }),
    { httpMetadata: { contentType: "application/json" } },
  );
  return complete ? "updated" : "copied";
}

// Retracts a dismissed capture's training copy when the business restores the finding.
export async function retractTrainingCopy(
  bucket: R2Bucket,
  orgId: string,
  host: string,
  captureKey: string,
  reason = "finding restored by business",
  now: () => Date = () => new Date(),
): Promise<"retracted" | "missing" | "removed"> {
  const parsed = parseCaptureKey(captureKey, orgId, host);
  if (!parsed) return "missing";
  const { prefix } = parsed;
  if (await isRemoved(bucket, orgId, host, prefix)) return "removed";
  const existing = await readExistingMeta(bucket, prefix);
  if (!existing) return "missing";
  if (existing.retracted) return "retracted";
  const nowIso = now().toISOString();
  const sourceRef = `finding:${orgId}:${host}:${captureKey}`;
  const history: TrainingHistoryEntry[] = [
    ...(existing.history ?? []),
    {
      label: existing.label,
      source: existing.source,
      sourceRef: existing.sourceRef ?? sourceRef,
      why: existing.why,
      at: existing.updatedAt ?? existing.copiedAt,
    },
  ];
  const updated: StoredTrainingMeta = {
    ...existing,
    source: "restore",
    sourceRef,
    why: reason,
    updatedAt: nowIso,
    retracted: true,
    retractedAt: nowIso,
    history,
  };
  await bucket.put(`${prefix}meta.json`, JSON.stringify(updated), {
    httpMetadata: { contentType: "application/json" },
  });
  await bucket.put(
    `${prefix}done.json`,
    JSON.stringify({
      at: nowIso,
      label: existing.label,
      source: "restore",
      sourceRef,
      retracted: true,
    }),
    { httpMetadata: { contentType: "application/json" } },
  );
  return "retracted";
}

// Authorised removal procedure (D05 T04 §10): deletes stored training copies for `(orgId, host)` in
// R2 and writes durable `removed.json` tombstones so neither production recovery nor the read-only
// local exporter can re-copy or reimport them.
export async function removeTrainingCopiesForHost(
  bucket: R2Bucket,
  orgId: string,
  host: string,
  reason = "removed at the business's request",
  now: () => Date = () => new Date(),
): Promise<{ removed: string[] }> {
  const basePrefix = `training/monitor/${orgId}/${host}/`;
  const listed = await bucket.list({ prefix: basePrefix }).catch(() => ({ objects: [] as { key: string }[] }));
  const capturePrefixes = new Set<string>();
  for (const obj of listed.objects) {
    const rel = obj.key.slice(basePrefix.length);
    const moment = rel.split("/")[0];
    if (moment && /^\d{4}-\d{2}-\d{2}T/.test(moment)) {
      capturePrefixes.add(`${basePrefix}${moment}/`);
    }
  }
  const nowIso = now().toISOString();
  const removed: string[] = [];
  for (const prefix of [...capturePrefixes].sort()) {
    const trainingId = prefix.replace(/^training\//, "").replace(/\/$/, "");
    await Promise.all([
      bucket.delete(`${prefix}done.json`).catch(() => null),
      bucket.delete(`${prefix}meta.json`).catch(() => null),
      bucket.delete(`${prefix}screenshot.jpg`).catch(() => null),
      bucket.delete(`${prefix}text.txt`).catch(() => null),
    ]);
    await bucket.put(`${prefix}removed.json`, JSON.stringify({ trainingId, orgId, host, reason, removedAt: nowIso }), {
      httpMetadata: { contentType: "application/json" },
    });
    removed.push(trainingId);
  }
  await bucket.put(
    hostRemovedKey(orgId, host),
    JSON.stringify({ orgId, host, reason, removedAt: nowIso, captures: removed }),
    { httpMetadata: { contentType: "application/json" } },
  );
  return { removed };
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
): Promise<{ recovered: number; failed: number }> {
  let recovered = 0;
  let failed = 0;

  const declined = await db
    .prepare("SELECT domain, capture_key FROM monitor_screens WHERE org_id = ? AND second_look = 'declined'")
    .bind(orgId)
    .all<{ domain: string; capture_key: string }>()
    .then((r) => r.results)
    .catch(() => [] as { domain: string; capture_key: string }[]);

  for (const row of declined) {
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
      else if (out === "missing-source") failed++;
    } catch {
      failed++;
    }
  }

  const confirmed = await db
    .prepare(
      "SELECT domain, capture_key, capture_url FROM monitor_investigations WHERE org_id = ? AND state = 'confirmed'",
    )
    .bind(orgId)
    .all<{ domain: string; capture_key: string; capture_url: string | null }>()
    .then((r) => r.results)
    .catch(() => [] as { domain: string; capture_key: string; capture_url: string | null }[]);

  for (const row of confirmed) {
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
      else if (out === "missing-source") failed++;
    } catch {
      failed++;
    }
  }

  const findings = await db
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
    .then((r) => r.results)
    .catch(
      () =>
        [] as {
          host: string;
          status: string;
          capture_key: string;
          dismissed_reason: string | null;
          dismissed_capture_key: string | null;
        }[],
    );

  for (const row of findings) {
    const targetKey = row.dismissed_capture_key ?? row.capture_key;
    try {
      if (row.status === "dismissed" && row.dismissed_reason && isBenignDismissalReason(row.dismissed_reason)) {
        const url = await resolveCaptureUrl(db, bucket, orgId, row.host, targetKey);
        const out = await copyForTraining(
          bucket,
          {
            orgId,
            host: row.host,
            captureKey: targetKey,
            captureUrl: url,
            label: "benign",
            why: `dismissed as not a fake: ${row.dismissed_reason.trim().slice(0, 120)}`,
            source: "dismissal",
            sourceRef: `finding:${orgId}:${row.host}:${targetKey}`,
          },
          now,
        );
        if (out === "copied" || out === "updated") recovered++;
        else if (out === "missing-source") failed++;
      } else if (row.status !== "dismissed" && row.dismissed_capture_key) {
        const parsed = parseCaptureKey(row.dismissed_capture_key, orgId, row.host);
        if (parsed) {
          const meta = await readExistingMeta(bucket, parsed.prefix);
          if (meta && !meta.retracted && meta.source === "dismissal") {
            const out = await retractTrainingCopy(
              bucket,
              orgId,
              row.host,
              row.dismissed_capture_key,
              "finding restored by business",
              now,
            );
            if (out === "retracted") recovered++;
          }
        }
      }
    } catch {
      failed++;
    }
  }

  return { recovered, failed };
}
