// The explicitly authorized untuned control owns only this temporary target, never production.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { findBurst } from "../../src/vision/glimmer-minutes.ts";
import { API, configureNetwork } from "../fireworks-check.ts";
import { checkPriced, type Deployment, readKey, reserveWake, settleWake, touchWake } from "./deploy.ts";
import { wranglerExec } from "./runtime-ledger.ts";
import { finishTimer, type Lease, save } from "./warm-lease.ts";
export const BASE_TARGET = "isitlegit-untuned-control-20261104";
export const BASE_MODEL = "accounts/fireworks/models/muse-glimmer-30b";
export function validateBase(read: Deployment, lease: Lease, now = Date.now()) {
  assert.equal(lease.decision, "OPERATOR-LOUPE11-BASE-CONTROL-20261104");
  assert.equal(lease.deployment, BASE_TARGET);
  assert.equal(read.name, `accounts/rizonetech/deployments/${BASE_TARGET}`);
  assert.equal(read.baseModel, BASE_MODEL);
  const config = read as Deployment & { enableAddons?: boolean; precision?: string };
  assert.equal(config.enableAddons, false);
  assert.equal(config.precision, "BF16");
  assert.equal(lease.model, `${BASE_MODEL}#${read.name}`);
  assert(now >= Date.parse(lease.startedAt) && now < Date.parse(lease.sendCutoff), "outside original send window");
  assert(Date.parse(lease.hardDeadline) - Date.parse(lease.startedAt) <= 3600000, "hour cannot restart");
  assert(
    Date.parse(lease.sendCutoff) <= Date.parse(lease.hardDeadline) - 10 * 60_000,
    "closure window must remain reserved",
  );
  assert.equal(read.minReplicaCount, 1);
  assert.equal(read.maxReplicaCount, 1);
  assert.equal(read.replicaCount, 1);
  assert.equal(read.state, "READY");
  checkPriced(read, BASE_TARGET);
}
async function main(mode: string, file: string, parentFile?: string) {
  if (mode === "cleanup") {
    const recorded = JSON.parse(readFileSync(file, "utf8")) as Lease;
    if (recorded.phase === "settled") {
      await finishTimer(recorded);
      return;
    }
    if (Date.now() < Date.parse(recorded.restoreAt)) return;
  }
  configureNetwork();
  const key = readKey("IsItLegit Fireworks Admin");
  const call = async (method = "GET", body?: unknown): Promise<Deployment | null> => {
    const url =
      method === "POST"
        ? `${API}/deployments?deploymentId=${BASE_TARGET}`
        : `${API}/deployments/${BASE_TARGET}${method === "DELETE" ? "?ignoreChecks=true" : ""}`;
    const r = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(30000),
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (r.status === 404 && method === "GET") return null;
    assert(r.ok, `base management ${method} status ${r.status}`);
    const text = await r.text();
    return text ? JSON.parse(text) : null;
  };
  if (mode === "activate") {
    assert(parentFile);
    assert(!existsSync(file), "never overwrite existing control lease");
    assert.equal(await call(), null, "temporary target must not preexist");
    const parent = JSON.parse(readFileSync(parentFile, "utf8")) as Lease;
    assert.equal(parent.decision, "OPERATOR-LOUPE11-WARM-HOUR-20261104");
    assert(Date.now() < Date.parse(parent.sendCutoff));
    const now = new Date();
    const minutes = (Date.parse(parent.hardDeadline) - +now) / 60000 + 6;
    assert(minutes > 6 && minutes <= 66);
    const wake = await reserveWake(
      wranglerExec(),
      "authorized untuned base control",
      minutes,
      now,
      undefined,
      BASE_TARGET,
      12,
    );
    touchWake(wake, Date.parse(parent.hardDeadline));
    const lease: Lease = {
      ...parent,
      decision: "OPERATOR-LOUPE11-BASE-CONTROL-20261104",
      deployment: BASE_TARGET,
      model: `${BASE_MODEL}#accounts/rizonetech/deployments/${BASE_TARGET}`,
      wake,
      rate: 12,
      reservedMinutes: minutes,
      phase: "reserved",
    };
    delete lease.readback;
    delete lease.zeroAt;
    save(file, lease);
    const units = `${process.env.HOME}/.config/systemd/user`;
    mkdirSync(units, { recursive: true });
    const unit = "isitlegit-loupe-base-cleanup";
    writeFileSync(
      `${units}/${unit}.service`,
      `[Unit]\nDescription=Delete owned bounded untuned control\n[Service]\nType=oneshot\nWorkingDirectory=${process.cwd()}\nEnvironment=PATH=${process.env.PATH}\nExecStart=${process.execPath} ${resolve(import.meta.filename)} cleanup ${file}\n`,
    );
    writeFileSync(
      `${units}/${unit}.timer`,
      `[Unit]\nDescription=Bound untuned control lifetime\n[Timer]\nOnCalendar=*-*-* *:*:00\nPersistent=true\nAccuracySec=1s\n[Install]\nWantedBy=timers.target\n`,
    );
    execFileSync("systemctl", ["--user", "daemon-reload"]);
    execFileSync("systemctl", ["--user", "enable", "--now", `${unit}.timer`]);
    assert.equal(
      execFileSync("systemctl", ["--user", "is-active", `${unit}.timer`], { encoding: "utf8" }).trim(),
      "active",
    );
    lease.phase = "creating";
    save(file, lease);
    await call("POST", {
      baseModel: BASE_MODEL,
      deploymentShape: "accounts/fireworks/deploymentShapes/dkuwotf7/versions/vtcy28lv",
      minReplicaCount: 1,
      maxReplicaCount: 1,
      autoscalingPolicy: { scaleToZeroWindow: "300s" },
      enableAddons: false,
    });
    while (Date.now() < Date.parse(lease.sendCutoff)) {
      const d = await call();
      assert(d);
      lease.readback = d;
      save(file, lease);
      if (d.state === "READY" && d.replicaCount === 1) {
        validateBase(d, lease);
        lease.phase = "ready";
        save(file, lease);
        console.log(JSON.stringify({ phase: "ready", file, model: lease.model, sendCutoff: lease.sendCutoff }));
        return;
      }
      await new Promise((r) => setTimeout(r, 15000));
    }
    throw new Error("base missed original cutoff; cleanup timer owns closure");
  }
  assert.equal(mode, "cleanup");
  const lease = JSON.parse(readFileSync(file, "utf8")) as Lease;
  if (lease.phase === "settled" || Date.now() < Date.parse(lease.restoreAt)) return;
  assert.equal(lease.decision, "OPERATOR-LOUPE11-BASE-CONTROL-20261104");
  assert.equal(lease.deployment, BASE_TARGET);
  let d = await call();
  if (d) {
    assert.equal(d.name, `accounts/rizonetech/deployments/${BASE_TARGET}`);
    assert.equal(d.baseModel, BASE_MODEL);
    if (d.state !== "DELETED") {
      await call("DELETE");
      d = await call();
    }
  }
  lease.phase = "deleting";
  if (d) lease.readback = d;
  save(file, lease);
  if (d?.state === "DELETED" && d.replicaCount === 0) {
    const zeroAt = new Date();
    await settleWake(wranglerExec(), { ...lease.wake, at: new Date(lease.wake.at) }, { zeroAt });
    assert((await findBurst(wranglerExec(), lease.wake.id))?.settled);
    lease.phase = "settled";
    lease.zeroAt = zeroAt.toISOString();
    save(file, lease);
    await finishTimer(lease);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  assert(process.argv[2] && process.argv[3]);
  await main(process.argv[2], resolve(process.argv[3]), process.argv[4]);
}
