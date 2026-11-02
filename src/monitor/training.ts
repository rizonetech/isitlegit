// Training copies (D05 T04 §10): the moment a monitor page is labelled, its fetched page is
// copied to R2 under `training/`, where no lifecycle rule deletes it, so Loupe's training store
// can be rebuilt from the copies long after the case's own artefacts are deleted at 30 days.
// The copy is the page the daily run fetched (its screenshot and visible text under the capture
// key), never a walkthrough capture or anything from a member's account. Identity is the
// captured page itself, tenant-scoped by its capture key (`monitor/<org>/<host>/<moment>/`);
// each copy carries its label's provenance, and a completion marker is written last, so a
// partial copy is never mistaken for a finished one.
export type TrainingLabel = "lure" | "benign";
export type TrainingSource = "pipeline" | "second-look" | "dismissal";

export type TrainingCopy = {
  orgId: string;
  host: string;
  captureKey: string;
  captureUrl: string | null;
  label: TrainingLabel;
  why: string;
  source: TrainingSource;
};

export type CopyOutcome = "copied" | "exists" | "missing-source";

const trainingPrefix = (captureKey: string) => `training/${captureKey.replace(/\/$/, "")}/`;

export async function copyForTraining(
  bucket: R2Bucket,
  copy: TrainingCopy,
  now: () => Date = () => new Date(),
): Promise<CopyOutcome> {
  const prefix = trainingPrefix(copy.captureKey);
  if (await bucket.head(`${prefix}done.json`).catch(() => null)) return "exists";
  const [shot, text] = await Promise.all([
    bucket.get(`${copy.captureKey}screenshot.jpg`).catch(() => null),
    bucket.get(`${copy.captureKey}text.txt`).catch(() => null),
  ]);
  if (!shot || !text) return "missing-source";
  const [shotBytes, textBytes] = await Promise.all([shot.arrayBuffer(), text.arrayBuffer()]);
  await bucket.put(`${prefix}screenshot.jpg`, shotBytes, { httpMetadata: { contentType: "image/jpeg" } });
  await bucket.put(`${prefix}text.txt`, textBytes, { httpMetadata: { contentType: "text/plain" } });
  await bucket.put(
    `${prefix}meta.json`,
    JSON.stringify({
      orgId: copy.orgId,
      host: copy.host,
      captureKey: copy.captureKey,
      url: copy.captureUrl,
      fetchedAt: copy.captureKey.split("/").at(3) ?? null,
      label: copy.label,
      why: copy.why,
      source: copy.source,
      copiedAt: now().toISOString(),
    }),
    { httpMetadata: { contentType: "application/json" } },
  );
  // The completion marker last: a copy without it is partial and is redone, never exported.
  await bucket.put(`${prefix}done.json`, JSON.stringify({ at: now().toISOString() }), {
    httpMetadata: { contentType: "application/json" },
  });
  return "copied";
}
