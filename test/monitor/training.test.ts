// Training copies (D05 T04 §10): tenant-scoped capture identity, sourceRef provenance,
// completion marker written last, declined second-look hook through `screenOwed`, successive
// captures and multi-org isolation, qualifying dismissal overrides and restore retractions,
// durable pending-copy recovery across boundaries, authorised removal tombstones, and boundary
// exclusion of post-form walkthrough and member-account artefacts.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { dismissFinding, findingsFromInvestigations, restoreFinding } from "../../src/monitor/findings";
import { screenOwed } from "../../src/monitor/screen";
import {
  copyForTraining,
  isBenignDismissalReason,
  recoverPendingTrainingCopies,
  removeTrainingCopiesForHost,
  type StoredTrainingMeta,
} from "../../src/monitor/training";
import { runMonitor } from "../../src/monitor/workflow";
import { screened } from "../../src/vision/page-screen";
import type { GlimmerSession } from "../../src/vision/screen";
import { fakeJpeg } from "../fixtures/jpeg";
import { business, runRow, START, world } from "./world";

const bucket = env.ARTEFACTS;
const db = env.DB;
const KEY = "monitor/org-1/fake.example/2026-11-02T03:00:00.000Z/";

async function ensureOrg(orgId: string) {
  await db
    .prepare(`INSERT OR IGNORE INTO "organization" (id, name, slug, "createdAt") VALUES (?, ?, ?, ?)`)
    .bind(orgId, `Org ${orgId}`, orgId, "2026-11-01T00:00:00.000Z")
    .run();
}

async function seedCapture(
  captureKey = KEY,
  url = "https://fake.example/login",
  text = "Sign in to your Fynbos account",
) {
  await bucket.put(`${captureKey}screenshot.jpg`, fakeJpeg(1280, 800, 1000));
  await bucket.put(`${captureKey}text.txt`, text);
  await bucket.put(`${captureKey}url.txt`, url);
}

describe("copyForTraining", () => {
  it("copies the fetched page once with tenant-scoped identity and sourceRef, marker last, surviving 30-day artefact deletion", async () => {
    await seedCapture();
    const copy = {
      orgId: "org-1",
      host: "fake.example",
      captureKey: KEY,
      captureUrl: "https://fake.example/",
      label: "lure" as const,
      why: "confirmed",
      source: "pipeline" as const,
    };
    expect(await copyForTraining(bucket, copy)).toBe("copied");
    expect(await copyForTraining(bucket, copy)).toBe("exists");
    const meta = await bucket.get(`training/${KEY}meta.json`);
    expect(meta).not.toBeNull();
    const parsed = JSON.parse(await (meta as NonNullable<typeof meta>).text()) as StoredTrainingMeta;
    expect(parsed.trainingId).toBe("monitor/org-1/fake.example/2026-11-02T03:00:00.000Z");
    expect(parsed.sourceRef).toBe(`investigation:org-1:${KEY}`);
    expect(parsed.label).toBe("lure");
    expect(parsed.host).toBe("fake.example");
    expect(parsed.url).toBe("https://fake.example/");
    expect(parsed.retracted).toBe(false);
    expect(await bucket.head(`training/${KEY}done.json`)).not.toBeNull();
    // The case's own artefacts are deleted at 30 days; the training copy stays.
    await bucket.delete(`${KEY}screenshot.jpg`);
    await bucket.delete(`${KEY}text.txt`);
    expect(await bucket.head(`training/${KEY}screenshot.jpg`)).not.toBeNull();
  });

  it("states a missing source and writes no marker", async () => {
    const missing = await copyForTraining(bucket, {
      orgId: "org-1",
      host: "gone.example",
      captureKey: "monitor/org-1/gone.example/2026-11-02T03:00:00.000Z/",
      captureUrl: null,
      label: "benign",
      why: "dismissed",
      source: "dismissal",
    });
    expect(missing).toBe("missing-source");
    expect(await bucket.head("training/monitor/org-1/gone.example/2026-11-02T03:00:00.000Z/done.json")).toBeNull();
  });

  it("refuses post-form walkthrough captures, member-account artefacts, and mismatched tenant keys", async () => {
    for (const badKey of [
      "walkthrough/case-1/step-2/",
      "art/case-1/page-1/",
      "raw/case-1/mail.eml",
      "monitor/org-2/fake.example/2026-11-02T03:00:00.000Z/",
      "monitor/org-1/other.example/2026-11-02T03:00:00.000Z/",
      "monitor/org-1/fake.example/../2026-11-02T03:00:00.000Z/",
    ]) {
      expect(
        await copyForTraining(bucket, {
          orgId: "org-1",
          host: "fake.example",
          captureKey: badKey,
          captureUrl: null,
          label: "lure",
          why: "confirmed",
          source: "pipeline",
        }),
      ).toBe("ineligible-source");
    }
  });

  it("copies a Spark-declined flag as benign through screenOwed with screen sourceRef", async () => {
    const orgId = "org-screen-decline";
    await ensureOrg(orgId);
    const host = "declined-lookalike.example";
    const captureKey = `monitor/${orgId}/${host}/2026-11-02T04:00:00.000Z/`;
    await seedCapture(captureKey, `https://${host}/welcome`, "Welcome to our benign page");
    const h64 = "b".repeat(64);
    await db
      .prepare(
        `INSERT OR REPLACE INTO monitor_hosts (org_id, domain, resolves, dns_hash, dns_at, content_hash, captured_at, capture_key, captured_dns_hash, capture_url, capture_failures, screen_failures, first_seen, last_seen, status)
         VALUES (?, ?, 1, ?, '2026-11-02T04:00:00.000Z', ?, '2026-11-02T04:00:00.000Z', ?, ?, ?, 0, 0, '2026-11-02T04:00:00.000Z', '2026-11-02T04:00:00.000Z', 'watching')`,
      )
      .bind(orgId, host, h64, h64, captureKey, h64, `https://${host}/welcome`)
      .run();

    const session = { state: "ready", lastRequestEnd: null } as unknown as GlimmerSession;
    const counts = await screenOwed(
      {
        db,
        store: bucket,
        screen: async () => ({
          ok: true,
          screen: screened(
            {
              brand: "Fynbos",
              has_login_form: true,
              has_payment_form: false,
              lure: true,
              lure_type: "credential",
              confidence: 0.91,
            } as never,
            "glimmer",
          ),
          glimmer_reason: null,
          spark_call: null,
          tier: "glimmer",
          escalation: null,
          spark_calls: [],
        }),
        second: async () => ({
          verdict: "declined",
          lureType: "none",
          callId: "call-sec-1",
          logId: "log-sec-1",
        }),
      },
      orgId,
      "run-decline-1",
      session,
      () => new Date("2026-11-02T04:01:00.000Z"),
    );

    expect(counts.screened).toBe(1);
    expect(counts.lures).toBe(0);
    const metaObj = await bucket.get(`training/${captureKey}meta.json`);
    expect(metaObj).not.toBeNull();
    const meta = JSON.parse(await (metaObj as NonNullable<typeof metaObj>).text()) as StoredTrainingMeta;
    expect(meta).toMatchObject({
      trainingId: `monitor/${orgId}/${host}/2026-11-02T04:00:00.000Z`,
      orgId,
      host,
      captureKey,
      url: `https://${host}/welcome`,
      label: "benign",
      source: "second-look",
      sourceRef: `screen:${orgId}:${host}:${captureKey}`,
      retracted: false,
    });
    expect(await bucket.head(`training/${captureKey}done.json`)).not.toBeNull();
  });

  it("isolates successive captures of one host and two organisations sharing a host, and preserves an older capture's URL after host advancement", async () => {
    const org1 = "org-multi-1";
    const org2 = "org-multi-2";
    await ensureOrg(org1);
    await ensureOrg(org2);
    const host = "shared-lookalike.example";
    const cap1 = `monitor/${org1}/${host}/2026-11-01T03:00:00.000Z/`;
    const cap2 = `monitor/${org1}/${host}/2026-11-02T03:00:00.000Z/`;
    const capOrg2 = `monitor/${org2}/${host}/2026-11-01T03:00:00.000Z/`;

    await seedCapture(cap1, `https://${host}/old-redirect`, "First capture text");
    await seedCapture(cap2, `https://${host}/new-landing`, "Second capture text");
    await seedCapture(capOrg2, `https://${host}/org2-landing`, "Org 2 capture text");

    // Advance monitor_hosts for org1 to cap2 before copying cap1: cap1 must still keep its own URL.
    const h64 = "c".repeat(64);
    await db
      .prepare(
        `INSERT OR REPLACE INTO monitor_hosts (org_id, domain, resolves, dns_hash, dns_at, content_hash, captured_at, capture_key, captured_dns_hash, capture_url, capture_failures, screen_failures, first_seen, last_seen, status)
         VALUES (?, ?, 1, ?, '2026-11-02T03:00:00.000Z', ?, '2026-11-02T03:00:00.000Z', ?, ?, ?, 0, 0, '2026-11-01T03:00:00.000Z', '2026-11-02T03:00:00.000Z', 'watching')`,
      )
      .bind(org1, host, h64, h64, cap2, h64, `https://${host}/new-landing`)
      .run();

    expect(
      await copyForTraining(bucket, {
        orgId: org1,
        host,
        captureKey: cap1,
        captureUrl: null,
        label: "lure",
        why: "confirmed first capture",
        source: "pipeline",
      }),
    ).toBe("copied");
    expect(
      await copyForTraining(bucket, {
        orgId: org1,
        host,
        captureKey: cap2,
        captureUrl: null,
        label: "lure",
        why: "confirmed second capture",
        source: "pipeline",
      }),
    ).toBe("copied");
    expect(
      await copyForTraining(bucket, {
        orgId: org2,
        host,
        captureKey: capOrg2,
        captureUrl: null,
        label: "benign",
        why: "declined for org 2",
        source: "second-look",
      }),
    ).toBe("copied");

    const meta1 = JSON.parse(
      (await (await bucket.get(`training/${cap1}meta.json`))?.text()) ?? "{}",
    ) as StoredTrainingMeta;
    const meta2 = JSON.parse(
      (await (await bucket.get(`training/${cap2}meta.json`))?.text()) ?? "{}",
    ) as StoredTrainingMeta;
    const metaOrg2 = JSON.parse(
      (await (await bucket.get(`training/${capOrg2}meta.json`))?.text()) ?? "{}",
    ) as StoredTrainingMeta;

    expect(meta1.url).toBe(`https://${host}/old-redirect`);
    expect(meta2.url).toBe(`https://${host}/new-landing`);
    expect(metaOrg2.url).toBe(`https://${host}/org2-landing`);
    expect(meta1.trainingId).not.toBe(meta2.trainingId);
    expect(meta1.trainingId).not.toBe(metaOrg2.trainingId);
    expect(meta1.label).toBe("lure");
    expect(metaOrg2.label).toBe("benign");
  });

  it("enforces qualifying dismissal semantics, label precedence (confirmation -> dismissal -> restore), and ignores non-qualifying reasons", async () => {
    expect(isBenignDismissalReason("duplicate alert already handled")).toBe(false);
    expect(isBenignDismissalReason("expired domain")).toBe(false);
    expect(isBenignDismissalReason("not legitimate")).toBe(false);
    expect(isBenignDismissalReason("not our site")).toBe(false);
    expect(isBenignDismissalReason("not authorized")).toBe(false);
    expect(isBenignDismissalReason("not a false positive")).toBe(false);
    expect(isBenignDismissalReason("does not belong to us")).toBe(false);
    expect(isBenignDismissalReason("This impersonates our site, already reported")).toBe(false);
    expect(isBenignDismissalReason("Clones our domain, takedown filed")).toBe(false);
    expect(isBenignDismissalReason("I am not sure this is our site")).toBe(false);
    expect(isBenignDismissalReason("This is anything but a legitimate site")).toBe(false);
    expect(isBenignDismissalReason("Maybe our site?")).toBe(false);
    expect(isBenignDismissalReason("Not a fake, this is our own campaign site")).toBe(true);
    expect(isBenignDismissalReason("legitimate partner domain")).toBe(true);

    const orgId = "org-precedence";
    await ensureOrg(orgId);
    const host = "precedence.example";
    const captureKey = `monitor/${orgId}/${host}/2026-11-02T05:00:00.000Z/`;
    await seedCapture(captureKey, `https://${host}/`, "Sign in to Fynbos");

    await db
      .prepare(
        `INSERT OR REPLACE INTO monitor_investigations (org_id, domain, capture_key, case_id, capture_url, state, evidence_refs, created_at, updated_at)
         VALUES (?, ?, ?, 'case-prec-1', ?, 'confirmed', '["E1"]', '2026-11-02T05:01:00.000Z', '2026-11-02T05:01:00.000Z')`,
      )
      .bind(orgId, host, captureKey, `https://${host}/`)
      .run();

    await copyForTraining(bucket, {
      orgId,
      host,
      captureKey,
      captureUrl: `https://${host}/`,
      label: "lure",
      why: "the full pipeline confirmed this page as a lure",
      source: "pipeline",
    });

    await findingsFromInvestigations(db, orgId, { mail: null, appUrl: "https://app.isitlegit.co.za" });

    // 1. Non-qualifying dismissal ("duplicate") leaves the R2 copy labelled "lure".
    expect(
      await dismissFinding(db, orgId, host, "duplicate ticket", () => new Date("2026-11-02T05:05:00.000Z"), bucket),
    ).toBe(true);
    const afterNonQualifying = JSON.parse(
      (await (await bucket.get(`training/${captureKey}meta.json`))?.text()) ?? "{}",
    ) as StoredTrainingMeta;
    expect(afterNonQualifying.label).toBe("lure");
    expect(afterNonQualifying.source).toBe("pipeline");

    // Restore and then dismiss with a qualifying benign reason.
    await restoreFinding(db, orgId, host, () => new Date("2026-11-02T05:06:00.000Z"), bucket);
    expect(
      await dismissFinding(
        db,
        orgId,
        host,
        "Not a fake, this is our own test site",
        () => new Date("2026-11-02T05:10:00.000Z"),
        bucket,
      ),
    ).toBe(true);

    const afterDismissal = JSON.parse(
      (await (await bucket.get(`training/${captureKey}meta.json`))?.text()) ?? "{}",
    ) as StoredTrainingMeta;
    expect(afterDismissal.label).toBe("benign");
    expect(afterDismissal.source).toBe("dismissal");
    expect(afterDismissal.sourceRef).toBe(`finding:${orgId}:${host}:${captureKey}`);
    expect(afterDismissal.retracted).toBe(false);
    expect(afterDismissal.history?.[0]?.label).toBe("lure");

    // Automated pipeline retry cannot overwrite a human dismissal.
    expect(
      await copyForTraining(bucket, {
        orgId,
        host,
        captureKey,
        captureUrl: `https://${host}/`,
        label: "lure",
        why: "pipeline retry",
        source: "pipeline",
      }),
    ).toBe("exists");
    const stillDismissed = JSON.parse(
      (await (await bucket.get(`training/${captureKey}meta.json`))?.text()) ?? "{}",
    ) as StoredTrainingMeta;
    expect(stillDismissed.label).toBe("benign");

    // Automatic reopening on a newer confirmed capture B leaves capture A benign (unretracted) across recovery,
    // while copying capture B as a confirmed lure.
    const captureKeyB = `monitor/${orgId}/${host}/2026-11-02T05:12:00.000Z/`;
    await seedCapture(captureKeyB, `https://${host}/new-phish`, "New confirmed lure after benign dismissal");
    await db
      .prepare(
        `INSERT OR REPLACE INTO monitor_investigations (org_id, domain, capture_key, case_id, capture_url, state, evidence_refs, created_at, updated_at)
         VALUES (?, ?, ?, 'case-prec-2', ?, 'confirmed', '["E2"]', '2026-11-02T05:12:30.000Z', '2026-11-02T05:12:30.000Z')`,
      )
      .bind(orgId, host, captureKeyB, `https://${host}/new-phish`)
      .run();
    const reopened = await findingsFromInvestigations(
      db,
      orgId,
      { mail: null, appUrl: "https://app.isitlegit.co.za" },
      () => new Date("2026-11-02T05:13:00.000Z"),
      bucket,
    );
    expect(reopened.reopened).toBe(1);
    const metaA = JSON.parse(
      (await (await bucket.get(`training/${captureKey}meta.json`))?.text()) ?? "{}",
    ) as StoredTrainingMeta;
    const metaB = JSON.parse(
      (await (await bucket.get(`training/${captureKeyB}meta.json`))?.text()) ?? "{}",
    ) as StoredTrainingMeta;
    expect(metaA.label).toBe("benign");
    expect(metaA.retracted).toBe(false);
    expect(metaA.source).toBe("dismissal");
    expect(metaB.label).toBe("lure");
    expect(metaB.retracted).toBe(false);
    expect(metaB.source).toBe("pipeline");

    // Re-dismiss the finding on capture B and then explicitly restore it via restoreFinding.
    expect(
      await dismissFinding(
        db,
        orgId,
        host,
        "Not a fake, this is our own test site",
        () => new Date("2026-11-02T05:14:00.000Z"),
        bucket,
      ),
    ).toBe(true);

    // Restore retracts the training copy in R2, and automated retries still cannot un-retract it.
    expect(await restoreFinding(db, orgId, host, () => new Date("2026-11-02T05:15:00.000Z"), bucket)).toBe(true);
    const afterRestore = JSON.parse(
      (await (await bucket.get(`training/${captureKeyB}meta.json`))?.text()) ?? "{}",
    ) as StoredTrainingMeta;
    expect(afterRestore.retracted).toBe(true);
    expect(afterRestore.source).toBe("restore");
    expect(
      await copyForTraining(bucket, {
        orgId,
        host,
        captureKey: captureKeyB,
        captureUrl: `https://${host}/new-phish`,
        label: "lure",
        why: "pipeline retry",
        source: "pipeline",
      }),
    ).toBe("exists");
  });

  it("recovers pending and partial R2 copies across crash boundaries without changing settled outcomes", async () => {
    const orgId = "org-recovery";
    await ensureOrg(orgId);
    const hostConfirmed = "crash-confirmed.example";
    const hostPartial = "crash-partial.example";
    const keyConfirmed = `monitor/${orgId}/${hostConfirmed}/2026-11-02T06:00:00.000Z/`;
    const keyPartial = `monitor/${orgId}/${hostPartial}/2026-11-02T06:05:00.000Z/`;
    await seedCapture(keyConfirmed, `https://${hostConfirmed}/`, "Confirmed lure text");
    await seedCapture(keyPartial, `https://${hostPartial}/`, "Partial R2 write lure text");

    // Boundary 1: D1 settled confirmed, but zero R2 training files were written before crash.
    await db
      .prepare(
        `INSERT OR REPLACE INTO monitor_investigations (org_id, domain, capture_key, case_id, capture_url, state, evidence_refs, created_at, updated_at)
         VALUES (?, ?, ?, 'case-rec-1', ?, 'confirmed', '["E1"]', '2026-11-02T06:01:00.000Z', '2026-11-02T06:01:00.000Z')`,
      )
      .bind(orgId, hostConfirmed, keyConfirmed, `https://${hostConfirmed}/`)
      .run();

    // Boundary 2: D1 settled confirmed, and R2 wrote screenshot.jpg and meta.json but crashed before done.json.
    await db
      .prepare(
        `INSERT OR REPLACE INTO monitor_investigations (org_id, domain, capture_key, case_id, capture_url, state, evidence_refs, created_at, updated_at)
         VALUES (?, ?, ?, 'case-rec-2', ?, 'confirmed', '["E2"]', '2026-11-02T06:06:00.000Z', '2026-11-02T06:06:00.000Z')`,
      )
      .bind(orgId, hostPartial, keyPartial, `https://${hostPartial}/`)
      .run();
    await bucket.put(`training/${keyPartial}screenshot.jpg`, fakeJpeg(1280, 800, 1000));
    await bucket.put(
      `training/${keyPartial}meta.json`,
      JSON.stringify({
        trainingId: `monitor/${orgId}/${hostPartial}/2026-11-02T06:05:00.000Z`,
        orgId,
        host: hostPartial,
        captureKey: keyPartial,
        url: `https://${hostPartial}/`,
        fetchedAt: "2026-11-02T06:05:00.000Z",
        label: "lure",
        why: "confirmed",
        source: "pipeline",
        sourceRef: `investigation:${orgId}:${keyPartial}`,
        copiedAt: "2026-11-02T06:06:00.000Z",
        updatedAt: "2026-11-02T06:06:00.000Z",
      }),
    );

    const recovery = await recoverPendingTrainingCopies(db, bucket, orgId, () => new Date("2026-11-02T06:10:00.000Z"));
    expect(recovery).toEqual({ recovered: 2, failed: 0 });
    expect(await bucket.head(`training/${keyConfirmed}done.json`)).not.toBeNull();
    expect(await bucket.head(`training/${keyPartial}done.json`)).not.toBeNull();
    expect(await bucket.head(`training/${keyPartial}text.txt`)).not.toBeNull();

    // A second recovery run sees both complete and recovers nothing again.
    expect(await recoverPendingTrainingCopies(db, bucket, orgId, () => new Date("2026-11-02T06:11:00.000Z"))).toEqual({
      recovered: 0,
      failed: 0,
    });

    // Boundary 3: A qualifying dismissal written before done.json, followed by restore and automated recovery,
    // preserves the retraction rather than being overwritten by pipeline recovery.
    const hostRestored = "crash-restored.example";
    const keyRestored = `monitor/${orgId}/${hostRestored}/2026-11-02T06:20:00.000Z/`;
    await seedCapture(keyRestored, `https://${hostRestored}/`, "Restored after partial dismissal");
    await db
      .prepare(
        `INSERT OR REPLACE INTO monitor_investigations (org_id, domain, capture_key, case_id, capture_url, state, evidence_refs, created_at, updated_at)
         VALUES (?, ?, ?, 'case-rec-3', ?, 'confirmed', '["E3"]', '2026-11-02T06:21:00.000Z', '2026-11-02T06:21:00.000Z')`,
      )
      .bind(orgId, hostRestored, keyRestored, `https://${hostRestored}/`)
      .run();
    await findingsFromInvestigations(db, orgId, { mail: null, appUrl: "https://app.isitlegit.co.za" });
    await dismissFinding(
      db,
      orgId,
      hostRestored,
      "Not a fake, this is our own site",
      () => new Date("2026-11-02T06:22:00.000Z"),
      bucket,
    );
    // Simulate crash before done.json during dismissal, then restore in D1 without R2 write.
    await bucket.delete(`training/${keyRestored}done.json`);
    await restoreFinding(db, orgId, hostRestored, () => new Date("2026-11-02T06:23:00.000Z"));
    await bucket.put(
      `training/${keyRestored}meta.json`,
      JSON.stringify({
        trainingId: `monitor/${orgId}/${hostRestored}/2026-11-02T06:20:00.000Z`,
        orgId,
        host: hostRestored,
        captureKey: keyRestored,
        url: `https://${hostRestored}/`,
        fetchedAt: "2026-11-02T06:20:00.000Z",
        label: "benign",
        why: "dismissed as not a fake: Not a fake, this is our own site",
        source: "dismissal",
        sourceRef: `finding:${orgId}:${hostRestored}:${keyRestored}`,
        copiedAt: "2026-11-02T06:22:00.000Z",
        updatedAt: "2026-11-02T06:22:00.000Z",
        retracted: false,
      }),
    );
    await recoverPendingTrainingCopies(db, bucket, orgId, () => new Date("2026-11-02T06:25:00.000Z"));
    const restoredMeta = JSON.parse(
      (await (await bucket.get(`training/${keyRestored}meta.json`))?.text()) ?? "{}",
    ) as StoredTrainingMeta;
    expect(restoredMeta.retracted).toBe(true);
    expect(restoredMeta.source).toBe("restore");
    expect(await bucket.head(`training/${keyRestored}done.json`)).not.toBeNull();

    // Boundary 4: Transient meta.json read failure after restore throws rather than overwriting retraction.
    let failMetaRead = true;
    const flakyMetaBucket = new Proxy(bucket, {
      get(target, prop, receiver) {
        if (prop === "get") {
          return async (key: string) => {
            if (failMetaRead && key === `training/${keyRestored}meta.json`) {
              throw new Error("transient R2 meta read failure");
            }
            return target.get(key);
          };
        }
        const val = Reflect.get(target, prop, receiver);
        return typeof val === "function" ? val.bind(target) : val;
      },
    });
    await expect(
      copyForTraining(flakyMetaBucket, {
        orgId,
        host: hostRestored,
        captureKey: keyRestored,
        captureUrl: `https://${hostRestored}/`,
        label: "lure",
        why: "pipeline retry",
        source: "pipeline",
      }),
    ).rejects.toThrow(/transient R2 meta read failure/);
    failMetaRead = false;
    const stillRetracted = JSON.parse(
      (await (await bucket.get(`training/${keyRestored}meta.json`))?.text()) ?? "{}",
    ) as StoredTrainingMeta;
    expect(stillRetracted.retracted).toBe(true);
    expect(stillRetracted.source).toBe("restore");
  });

  it("removes training copies for a host with durable tombstones and prevents re-copying", async () => {
    const orgId = "org-removal";
    await ensureOrg(orgId);
    const host = "remove-me.example";
    const captureKey = `monitor/${orgId}/${host}/2026-11-02T07:00:00.000Z/`;
    await seedCapture(captureKey, `https://${host}/`, "Remove this page");

    expect(
      await copyForTraining(bucket, {
        orgId,
        host,
        captureKey,
        captureUrl: `https://${host}/`,
        label: "lure",
        why: "confirmed",
        source: "pipeline",
      }),
    ).toBe("copied");

    // A failed delete must not report removal or write tombstones while screenshot.jpg remains.
    let failDelete = true;
    const failingBucket = new Proxy(bucket, {
      get(target, prop, receiver) {
        if (prop === "delete") {
          return async (key: string | string[]) => {
            if (failDelete && typeof key === "string" && key.endsWith("screenshot.jpg")) {
              throw new Error("R2 delete failed");
            }
            return target.delete(key);
          };
        }
        const val = Reflect.get(target, prop, receiver);
        return typeof val === "function" ? val.bind(target) : val;
      },
    });
    await expect(
      removeTrainingCopiesForHost(
        failingBucket,
        orgId,
        host,
        "requested by business owner",
        () => new Date("2026-11-02T07:59:00.000Z"),
      ),
    ).rejects.toThrow(/failed to remove/);
    expect(await bucket.head(`training/${captureKey}screenshot.jpg`)).not.toBeNull();
    expect(await bucket.head(`training/${captureKey}removed.json`)).toBeNull();
    failDelete = false;

    const removed = await removeTrainingCopiesForHost(
      bucket,
      orgId,
      host,
      "requested by business owner",
      () => new Date("2026-11-02T08:00:00.000Z"),
    );
    expect(removed.removed).toEqual([`monitor/${orgId}/${host}/2026-11-02T07:00:00.000Z`]);
    expect(await bucket.head(`training/${captureKey}done.json`)).toBeNull();
    expect(await bucket.head(`training/${captureKey}screenshot.jpg`)).toBeNull();
    expect(await bucket.head(`training/${captureKey}removed.json`)).not.toBeNull();
    expect(await bucket.head(`training/monitor/${orgId}/${host}/removed.json`)).not.toBeNull();

    // Attempting to copy again returns "removed" and writes no files.
    expect(
      await copyForTraining(bucket, {
        orgId,
        host,
        captureKey,
        captureUrl: `https://${host}/`,
        label: "lure",
        why: "confirmed",
        source: "pipeline",
      }),
    ).toBe("removed");
    expect(await bucket.head(`training/${captureKey}done.json`)).toBeNull();

    // Concurrent interleaving: an in-flight copy paused during source read while removal runs must not
    // recreate removed data after removal completes.
    const raceHost = "race-remove.example";
    const raceKey = `monitor/${orgId}/${raceHost}/2026-11-02T07:30:00.000Z/`;
    await seedCapture(raceKey, `https://${raceHost}/`, "Concurrent removal race");
    let releaseGet!: () => void;
    const getGate = new Promise<void>((resolve) => {
      releaseGet = resolve;
    });
    let notifyPaused!: () => void;
    const paused = new Promise<void>((resolve) => {
      notifyPaused = resolve;
    });
    const racingBucket = new Proxy(bucket, {
      get(target, prop, receiver) {
        if (prop === "get") {
          return async (key: string) => {
            if (key === `${raceKey}screenshot.jpg`) {
              notifyPaused();
              await getGate;
            }
            return target.get(key);
          };
        }
        const val = Reflect.get(target, prop, receiver);
        return typeof val === "function" ? val.bind(target) : val;
      },
    });
    const copyPromise = copyForTraining(racingBucket, {
      orgId,
      host: raceHost,
      captureKey: raceKey,
      captureUrl: `https://${raceHost}/`,
      label: "lure",
      why: "confirmed",
      source: "pipeline",
    });
    await paused;
    const removePromise = removeTrainingCopiesForHost(
      bucket,
      orgId,
      raceHost,
      "requested during copy",
      () => new Date("2026-11-02T08:05:00.000Z"),
    );
    releaseGet();
    const [, removeOut] = await Promise.all([copyPromise, removePromise]);
    expect(removeOut.removed).toEqual([`monitor/${orgId}/${raceHost}/2026-11-02T07:30:00.000Z`]);
    expect(await bucket.head(`training/${raceKey}screenshot.jpg`)).toBeNull();
    expect(await bucket.head(`training/${raceKey}done.json`)).toBeNull();
    expect(await bucket.head(`training/monitor/${orgId}/${raceHost}/removed.json`)).not.toBeNull();

    // Cross-context interleaving without shared in-memory locks: removal lists while a separate isolate's
    // copy resumes from source read; the pre-list host tombstone and per-put checks prevent any object
    // from surviving removal.
    const crossHost = "cross-context-remove.example";
    const crossKey = `monitor/${orgId}/${crossHost}/2026-11-02T07:45:00.000Z/`;
    await seedCapture(crossKey, `https://${crossHost}/`, "Cross-context removal race");
    const lockSym = Symbol.for("isitlegit.monitor.training.hostLocks");
    let releaseCrossGet!: () => void;
    const crossGetGate = new Promise<void>((resolve) => {
      releaseCrossGet = resolve;
    });
    let notifyCrossGetPaused!: () => void;
    const crossGetPaused = new Promise<void>((resolve) => {
      notifyCrossGetPaused = resolve;
    });
    let releaseCrossList!: () => void;
    const crossListGate = new Promise<void>((resolve) => {
      releaseCrossList = resolve;
    });
    let notifyCrossListPaused!: () => void;
    const crossListPaused = new Promise<void>((resolve) => {
      notifyCrossListPaused = resolve;
    });
    const copyIsolateBucket = {
      head: (k: string) => bucket.head(k),
      get: async (k: string) => {
        if (k === `${crossKey}screenshot.jpg`) {
          notifyCrossGetPaused();
          await crossGetGate;
        }
        return bucket.get(k);
      },
      put: (k: string, v: ArrayBuffer | string, o?: R2PutOptions) => bucket.put(k, v, o),
      delete: (k: string | string[]) => bucket.delete(k),
      list: (o?: R2ListOptions) => bucket.list(o),
    } as unknown as R2Bucket;
    let firstList = true;
    const removeIsolateBucket = {
      head: (k: string) => bucket.head(k),
      get: (k: string) => bucket.get(k),
      put: (k: string, v: ArrayBuffer | string, o?: R2PutOptions) => bucket.put(k, v, o),
      delete: (k: string | string[]) => bucket.delete(k),
      list: async (o?: R2ListOptions) => {
        const res = await bucket.list(o);
        if (firstList) {
          firstList = false;
          notifyCrossListPaused();
          await crossListGate;
        }
        return res;
      },
    } as unknown as R2Bucket;
    const crossCopyPromise = copyForTraining(copyIsolateBucket, {
      orgId,
      host: crossHost,
      captureKey: crossKey,
      captureUrl: `https://${crossHost}/`,
      label: "lure",
      why: "confirmed",
      source: "pipeline",
    });
    await crossGetPaused;
    // Simulate a separate execution context by replacing the global lock map before starting removal.
    Reflect.deleteProperty(globalThis, lockSym);
    const crossRemovePromise = removeTrainingCopiesForHost(
      removeIsolateBucket,
      orgId,
      crossHost,
      "requested across isolates",
      () => new Date("2026-11-02T08:10:00.000Z"),
    );
    await crossListPaused;
    releaseCrossGet();
    const copyOut = await crossCopyPromise;
    releaseCrossList();
    await crossRemovePromise;
    expect(copyOut).toBe("removed");
    expect(await bucket.head(`training/${crossKey}screenshot.jpg`)).toBeNull();
    expect(await bucket.head(`training/${crossKey}done.json`)).toBeNull();
    expect(await bucket.head(`training/monitor/${orgId}/${crossHost}/removed.json`)).not.toBeNull();

    // Delayed screenshot write landing after removal completes, with failing post-write tombstone head
    // and failing cleanup delete, followed by retry and durable recovery reconciliation.
    const residualHost = "residual-remove.example";
    const residualKey = `monitor/${orgId}/${residualHost}/2026-11-02T07:50:00.000Z/`;
    await seedCapture(residualKey, `https://${residualHost}/`, "Residual removal race");
    await db
      .prepare(
        `INSERT OR REPLACE INTO monitor_investigations (org_id, domain, capture_key, case_id, capture_url, state, evidence_refs, created_at, updated_at)
         VALUES (?, ?, ?, 'case-res-1', ?, 'confirmed', '["E1"]', '2026-11-02T07:51:00.000Z', '2026-11-02T07:51:00.000Z')`,
      )
      .bind(orgId, residualHost, residualKey, `https://${residualHost}/`)
      .run();
    let releaseResidualPut!: () => void;
    const residualPutGate = new Promise<void>((resolve) => {
      releaseResidualPut = resolve;
    });
    let notifyResidualPutPaused!: () => void;
    const residualPutPaused = new Promise<void>((resolve) => {
      notifyResidualPutPaused = resolve;
    });
    let failPostPutHead = false;
    let blockResidualDelete = false;
    const delayedWriterBucket = {
      head: async (k: string) => {
        if (failPostPutHead && k.endsWith("/removed.json")) {
          throw new Error("post-write tombstone head failed");
        }
        return bucket.head(k);
      },
      get: (k: string) => bucket.get(k),
      put: async (k: string, v: ArrayBuffer | string, o?: R2PutOptions) => {
        if (k === `training/${residualKey}screenshot.jpg`) {
          notifyResidualPutPaused();
          await residualPutGate;
          failPostPutHead = true;
          blockResidualDelete = true;
        }
        return bucket.put(k, v, o);
      },
      delete: async (k: string | string[]) => {
        if (blockResidualDelete) {
          throw new Error("cleanup delete failed");
        }
        return bucket.delete(k);
      },
      list: (o?: R2ListOptions) => bucket.list(o),
    } as unknown as R2Bucket;
    const delayedCopy = copyForTraining(delayedWriterBucket, {
      orgId,
      host: residualHost,
      captureKey: residualKey,
      captureUrl: `https://${residualHost}/`,
      label: "lure",
      why: "confirmed",
      source: "pipeline",
    });
    await residualPutPaused;
    Reflect.deleteProperty(globalThis, lockSym);
    await removeTrainingCopiesForHost(
      bucket,
      orgId,
      residualHost,
      "removed before delayed put finishes",
      () => new Date("2026-11-02T08:15:00.000Z"),
    );
    releaseResidualPut();
    await expect(delayedCopy).rejects.toThrow(/post-write tombstone head failed/);
    failPostPutHead = false;
    // Because cleanup delete was also blocked during the fault, screenshot.jpg landed after removal.
    expect(await bucket.head(`training/${residualKey}screenshot.jpg`)).not.toBeNull();
    // While delete remains blocked, retry and recovery must fail rather than reporting "removed" with residual data.
    await expect(
      copyForTraining(delayedWriterBucket, {
        orgId,
        host: residualHost,
        captureKey: residualKey,
        captureUrl: `https://${residualHost}/`,
        label: "lure",
        why: "confirmed",
        source: "pipeline",
      }),
    ).rejects.toThrow(/failed to clean up removed R2 training objects/);
    const failedRec = await recoverPendingTrainingCopies(
      db,
      delayedWriterBucket,
      orgId,
      () => new Date("2026-11-02T08:16:00.000Z"),
    );
    expect(failedRec.failed).toBeGreaterThanOrEqual(1);
    expect(await bucket.head(`training/${residualKey}screenshot.jpg`)).not.toBeNull();

    // Once delete succeeds, recovery (or copyForTraining retry) reconciles the tombstoned capture and deletes screenshot.jpg.
    blockResidualDelete = false;
    const okRec = await recoverPendingTrainingCopies(db, bucket, orgId, () => new Date("2026-11-02T08:17:00.000Z"));
    expect(okRec).toEqual({ recovered: 1, failed: 0 });
    expect(await bucket.head(`training/${residualKey}screenshot.jpg`)).toBeNull();
    expect(await bucket.head(`training/${residualKey}removed.json`)).not.toBeNull();
    expect(
      await copyForTraining(bucket, {
        orgId,
        host: residualHost,
        captureKey: residualKey,
        captureUrl: `https://${residualHost}/`,
        label: "lure",
        why: "confirmed",
        source: "pipeline",
      }),
    ).toBe("removed");
  });

  it("preserves per-capture dismissals and restores across later captures during an R2 outage and surfaces recovery errors", async () => {
    const orgId = "org-multi-decision";
    await ensureOrg(orgId);
    const host = "multi-outage.example";
    const captureA = `monitor/${orgId}/${host}/2026-11-02T09:00:00.000Z/`;
    const captureB = `monitor/${orgId}/${host}/2026-11-02T09:10:00.000Z/`;
    await seedCapture(captureA, `https://${host}/a`, "Outage capture A");
    await seedCapture(captureB, `https://${host}/b`, "Outage capture B");

    await db
      .prepare(
        `INSERT OR REPLACE INTO monitor_investigations (org_id, domain, capture_key, case_id, capture_url, state, evidence_refs, created_at, updated_at)
         VALUES (?, ?, ?, 'case-mo-a', ?, 'confirmed', '["E1"]', '2026-11-02T09:01:00.000Z', '2026-11-02T09:01:00.000Z')`,
      )
      .bind(orgId, host, captureA, `https://${host}/a`)
      .run();

    const failingBucket = {
      head: async () => {
        throw new Error("R2 outage head");
      },
      get: async () => {
        throw new Error("R2 outage get");
      },
      put: async () => {
        throw new Error("R2 outage put");
      },
      delete: async () => {
        throw new Error("R2 outage delete");
      },
      list: async () => {
        throw new Error("R2 outage list");
      },
    } as unknown as R2Bucket;

    // Settle finding on capture A while R2 is down: surfaces trainingRecoveryFailed without blocking D1 settlement.
    const settledA = await findingsFromInvestigations(
      db,
      orgId,
      { mail: null, appUrl: "https://app.isitlegit.co.za" },
      () => new Date("2026-11-02T09:02:00.000Z"),
      failingBucket,
    );
    expect(settledA.created).toBe(1);
    expect(settledA.trainingRecoveryFailed).toBeGreaterThanOrEqual(1);
    expect(settledA.trainingRecoveryErrors?.[0]).toContain("R2 outage");

    // Dismiss capture A while R2 is still down.
    expect(
      await dismissFinding(
        db,
        orgId,
        host,
        "Not a fake, this is our own staging site",
        () => new Date("2026-11-02T09:03:00.000Z"),
        failingBucket,
      ),
    ).toBe(true);

    // Newer confirmed capture B arrives while R2 is still down: reopens the finding, then member dismisses and restores B.
    await db
      .prepare(
        `INSERT OR REPLACE INTO monitor_investigations (org_id, domain, capture_key, case_id, capture_url, state, evidence_refs, created_at, updated_at)
         VALUES (?, ?, ?, 'case-mo-b', ?, 'confirmed', '["E2"]', '2026-11-02T09:11:00.000Z', '2026-11-02T09:11:00.000Z')`,
      )
      .bind(orgId, host, captureB, `https://${host}/b`)
      .run();
    const reopenedB = await findingsFromInvestigations(
      db,
      orgId,
      { mail: null, appUrl: "https://app.isitlegit.co.za" },
      () => new Date("2026-11-02T09:12:00.000Z"),
      failingBucket,
    );
    expect(reopenedB.reopened).toBe(1);
    expect(reopenedB.trainingRecoveryFailed).toBeGreaterThanOrEqual(1);

    expect(
      await dismissFinding(
        db,
        orgId,
        host,
        "Not a fake, this is our own regional site",
        () => new Date("2026-11-02T09:13:00.000Z"),
        failingBucket,
      ),
    ).toBe(true);
    expect(await restoreFinding(db, orgId, host, () => new Date("2026-11-02T09:14:00.000Z"), failingBucket)).toBe(true);

    // When R2 recovers, recoverPendingTrainingCopies materialises capture A as benign dismissal and capture B as retracted restore!
    const recovered = await recoverPendingTrainingCopies(db, bucket, orgId, () => new Date("2026-11-02T09:15:00.000Z"));
    expect(recovered.failed).toBe(0);
    expect(recovered.recovered).toBeGreaterThanOrEqual(2);

    const metaA = JSON.parse(
      (await (await bucket.get(`training/${captureA}meta.json`))?.text()) ?? "{}",
    ) as StoredTrainingMeta;
    const metaB = JSON.parse(
      (await (await bucket.get(`training/${captureB}meta.json`))?.text()) ?? "{}",
    ) as StoredTrainingMeta;
    expect(metaA.label).toBe("benign");
    expect(metaA.source).toBe("dismissal");
    expect(metaA.retracted).toBe(false);
    expect(metaA.why).toContain("our own staging site");
    expect(metaB.retracted).toBe(true);
    expect(metaB.source).toBe("restore");

    // 1. Non-qualifying dismissal ("duplicate ticket") after a restore during an R2 outage must NOT erase the pending restore.
    const hostNonQual = "nonqual-after-restore.example";
    const captureC = `monitor/${orgId}/${hostNonQual}/2026-11-02T09:20:00.000Z/`;
    await seedCapture(captureC, `https://${hostNonQual}/c`, "Non-qualifying after restore");
    await db
      .prepare(
        `INSERT OR REPLACE INTO monitor_investigations (org_id, domain, capture_key, case_id, capture_url, state, evidence_refs, created_at, updated_at)
         VALUES (?, ?, ?, 'case-mo-c', ?, 'confirmed', '["E3"]', '2026-11-02T09:21:00.000Z', '2026-11-02T09:21:00.000Z')`,
      )
      .bind(orgId, hostNonQual, captureC, `https://${hostNonQual}/c`)
      .run();
    await findingsFromInvestigations(
      db,
      orgId,
      { mail: null, appUrl: "https://app.isitlegit.co.za" },
      () => new Date("2026-11-02T09:22:00.000Z"),
      bucket,
    );
    expect(
      await dismissFinding(
        db,
        orgId,
        hostNonQual,
        "Not a fake, this is our own regional site",
        () => new Date("2026-11-02T09:23:00.000Z"),
        bucket,
      ),
    ).toBe(true);
    // Restore during R2 outage, then dismiss with non-qualifying reason "duplicate ticket" while R2 is still down.
    expect(
      await restoreFinding(db, orgId, hostNonQual, () => new Date("2026-11-02T09:24:00.000Z"), failingBucket),
    ).toBe(true);
    expect(
      await dismissFinding(
        db,
        orgId,
        hostNonQual,
        "duplicate ticket",
        () => new Date("2026-11-02T09:25:00.000Z"),
        failingBucket,
      ),
    ).toBe(true);
    await recoverPendingTrainingCopies(db, bucket, orgId, () => new Date("2026-11-02T09:26:00.000Z"));
    const metaC = JSON.parse(
      (await (await bucket.get(`training/${captureC}meta.json`))?.text()) ?? "{}",
    ) as StoredTrainingMeta;
    expect(metaC.retracted).toBe(true);
    expect(metaC.source).toBe("restore");

    // 2. Legacy pending restore row (status = 'watching', dismissed_reason = NULL, unprefixed dismissed_capture_key) recovers after upgrade.
    const hostLegacy = "legacy-restore.example";
    const captureD = `monitor/${orgId}/${hostLegacy}/2026-11-02T09:30:00.000Z/`;
    await seedCapture(captureD, `https://${hostLegacy}/d`, "Legacy restore capture");
    await copyForTraining(bucket, {
      orgId,
      host: hostLegacy,
      captureKey: captureD,
      captureUrl: `https://${hostLegacy}/d`,
      label: "benign",
      why: "dismissed as not a fake: Not a fake",
      source: "dismissal",
    });
    await db
      .prepare(
        `INSERT OR REPLACE INTO monitor_findings (org_id, host, status, first_seen, capture_key, case_id, outcome, evidence_refs, dismissed_reason, dismissed_at, dismissed_capture_key, created_at, updated_at)
         VALUES (?, ?, 'watching', '2026-11-02T09:30:00.000Z', ?, 'case-mo-d', 'confirmed', '["E4"]', NULL, NULL, ?, '2026-11-02T09:30:00.000Z', '2026-11-02T09:31:00.000Z')`,
      )
      .bind(orgId, hostLegacy, captureD, captureD)
      .run();
    await recoverPendingTrainingCopies(db, bucket, orgId, () => new Date("2026-11-02T09:32:00.000Z"));
    const metaD = JSON.parse(
      (await (await bucket.get(`training/${captureD}meta.json`))?.text()) ?? "{}",
    ) as StoredTrainingMeta;
    expect(metaD.retracted).toBe(true);
    expect(metaD.source).toBe("restore");

    // 3. Concurrent non-qualifying dismissal paused after SELECT while restore completes must retry CAS and preserve the restore decision.
    const hostConcurrent = "concurrent-cas.example";
    const captureE = `monitor/${orgId}/${hostConcurrent}/2026-11-02T09:40:00.000Z/`;
    await seedCapture(captureE, `https://${hostConcurrent}/e`, "Concurrent CAS capture");
    await db
      .prepare(
        `INSERT OR REPLACE INTO monitor_investigations (org_id, domain, capture_key, case_id, capture_url, state, evidence_refs, created_at, updated_at)
         VALUES (?, ?, ?, 'case-mo-e', ?, 'confirmed', '["E5"]', '2026-11-02T09:41:00.000Z', '2026-11-02T09:41:00.000Z')`,
      )
      .bind(orgId, hostConcurrent, captureE, `https://${hostConcurrent}/e`)
      .run();
    await findingsFromInvestigations(
      db,
      orgId,
      { mail: null, appUrl: "https://app.isitlegit.co.za" },
      () => new Date("2026-11-02T09:42:00.000Z"),
      bucket,
    );
    expect(
      await dismissFinding(
        db,
        orgId,
        hostConcurrent,
        "Not a fake, this is our own regional site",
        () => new Date("2026-11-02T09:43:00.000Z"),
        bucket,
      ),
    ).toBe(true);

    let pauseFirstSelect = true;
    let notifySelectPaused!: () => void;
    const selectPaused = new Promise<void>((resolve) => {
      notifySelectPaused = resolve;
    });
    let releaseSelect!: () => void;
    const selectGate = new Promise<void>((resolve) => {
      releaseSelect = resolve;
    });
    const interceptedDb = {
      prepare: (sql: string) => {
        const stmt = db.prepare(sql);
        if (pauseFirstSelect && sql.startsWith("SELECT status, capture_key")) {
          pauseFirstSelect = false;
          return {
            bind: (...args: unknown[]) => {
              const bound = stmt.bind(...args);
              return {
                first: async <T>() => {
                  const row = await bound.first<T>();
                  notifySelectPaused();
                  await selectGate;
                  return row;
                },
              };
            },
          };
        }
        return stmt;
      },
    } as unknown as D1Database;

    const concurrentDismiss = dismissFinding(
      interceptedDb,
      orgId,
      hostConcurrent,
      "duplicate ticket",
      () => new Date("2026-11-02T09:44:00.000Z"),
      failingBucket,
    );
    await selectPaused;
    expect(
      await restoreFinding(db, orgId, hostConcurrent, () => new Date("2026-11-02T09:44:30.000Z"), failingBucket),
    ).toBe(true);
    releaseSelect();
    expect(await concurrentDismiss).toBe(true);

    await recoverPendingTrainingCopies(db, bucket, orgId, () => new Date("2026-11-02T09:45:00.000Z"));
    const metaE = JSON.parse(
      (await (await bucket.get(`training/${captureE}meta.json`))?.text()) ?? "{}",
    ) as StoredTrainingMeta;
    expect(metaE.retracted).toBe(true);
    expect(metaE.source).toBe("restore");

    // 4. In-flight qualifying dismissal delayed during URL lookup while restore completes must NOT overwrite the retraction in R2.
    let pauseUrlGet = true;
    let notifyUrlGetPaused!: () => void;
    const urlGetPaused = new Promise<void>((resolve) => {
      notifyUrlGetPaused = resolve;
    });
    let releaseUrlGet!: () => void;
    const urlGetGate = new Promise<void>((resolve) => {
      releaseUrlGet = resolve;
    });
    const delayedUrlBucket = {
      head: (k: string) => bucket.head(k),
      get: async (k: string) => {
        if (pauseUrlGet && k === `${captureE}url.txt`) {
          pauseUrlGet = false;
          notifyUrlGetPaused();
          await urlGetGate;
        }
        return bucket.get(k);
      },
      put: (k: string, v: ArrayBuffer | string, o?: R2PutOptions) => bucket.put(k, v, o),
      delete: (k: string | string[]) => bucket.delete(k),
      list: (o?: R2ListOptions) => bucket.list(o),
    } as unknown as R2Bucket;

    const delayedQualifyingDismiss = dismissFinding(
      db,
      orgId,
      hostConcurrent,
      "Not a fake, this is our own regional site",
      () => new Date("2026-11-02T09:46:00.000Z"),
      delayedUrlBucket,
    );
    await urlGetPaused;
    expect(await restoreFinding(db, orgId, hostConcurrent, () => new Date("2026-11-02T09:46:30.000Z"), bucket)).toBe(
      true,
    );
    releaseUrlGet();
    expect(await delayedQualifyingDismiss).toBe(true);

    const metaAfterRace = JSON.parse(
      (await (await bucket.get(`training/${captureE}meta.json`))?.text()) ?? "{}",
    ) as StoredTrainingMeta;
    expect(metaAfterRace.retracted).toBe(true);
    expect(metaAfterRace.source).toBe("restore");

    // 5. Recovery failures in later stages (pipeline and findings) persist outcome = 'partial' and training: errors on monitor_runs.
    const wfOrg = await business();
    const w = world(START);
    const stepRunner = {
      do: async (_name: string, _opts: unknown, work: () => Promise<unknown>) => work(),
    } as unknown as Parameters<typeof runMonitor>[0];
    const wfDeps = {
      ...w.deps,
      heldSince: async () => null,
    };
    const wfSummary = await runMonitor(
      stepRunner,
      wfDeps,
      wfOrg.orgId,
      "run-wf-partial",
      async () => ({
        investigated: 0,
        trainingRecoveryFailed: 1,
        trainingRecoveryErrors: ["pipeline R2 outage"],
      }),
      async () => ({
        created: 0,
        alerted: 0,
        reopened: 0,
        trainingRecoveryFailed: 1,
        trainingRecoveryErrors: ["findings R2 outage"],
      }),
    );
    expect(wfSummary.outcome).toBe("partial");
    expect(wfSummary.errors).toContain("training:pipeline R2 outage");
    expect(wfSummary.errors).toContain("training:findings R2 outage");
    const persistedRun = await runRow(wfOrg.orgId);
    expect(persistedRun?.outcome).toBe("partial");
    const persistedErrors = JSON.parse(String(persistedRun?.errors_json ?? "[]")) as string[];
    expect(persistedErrors).toContain("training:pipeline R2 outage");
    expect(persistedErrors).toContain("training:findings R2 outage");
  });
});
