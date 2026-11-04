// Explicit one-hour production host lease. The ordinary scale-to-zero contract remains unchanged.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { findBurst } from "../../src/vision/glimmer-minutes.ts";
import { API, configureNetwork } from "../fireworks-check.ts";
import {
  checkPriced,
  checkReadBack,
  type Deployment,
  readKey,
  reserveWake,
  settleWake,
  touchWake,
  type Wake,
} from "./deploy.ts";
import { wranglerExec } from "./runtime-ledger.ts";
export const TARGET = "isitlegit-loupe-1-1";
export type Lease = {
  decision: string;
  deployment: string;
  model: string;
  startedAt: string;
  sendCutoff: string;
  restoreAt: string;
  hardDeadline: string;
  rate: number;
  reservedMinutes: number;
  wake: Wake;
  prior: { minReplicaCount: number; maxReplicaCount: number };
  phase: string;
  readback?: Deployment;
  zeroAt?: string;
};
export function validateWarm(read: Deployment, lease: Lease, now = Date.now()): void {
  assert.equal(lease.decision, "OPERATOR-LOUPE11-WARM-HOUR-20261104");
  assert.equal(lease.deployment, TARGET);
  assert.equal(read.name, `${API.replace("https://api.fireworks.ai/v1/", "")}/deployments/${TARGET}`);
  assert.equal(read.baseModel, `accounts/rizonetech/models/${TARGET}`);
  assert.equal(lease.model, `${read.baseModel}#${read.name}`);
  assert(now >= Date.parse(lease.startedAt) && now < Date.parse(lease.sendCutoff), "lease is outside send window");
  assert.equal(Date.parse(lease.sendCutoff) - Date.parse(lease.startedAt), 49 * 60_000);
  assert.equal(lease.restoreAt, lease.sendCutoff);
  assert.equal(Date.parse(lease.hardDeadline) - Date.parse(lease.startedAt), 60 * 60_000);
  assert.equal(read.minReplicaCount, 1);
  assert.equal(read.maxReplicaCount, 1);
  assert.equal(read.state, "READY");
  assert.equal(read.replicaCount, 1);
  checkPriced(read, TARGET);
  assert(
    ["300s", "5m", "300.0s"].includes(read.autoscalingPolicy?.scaleToZeroWindow ?? ""),
    "scale-to-zero policy changed",
  );
}
export const save = (file: string, value: unknown) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, `${JSON.stringify(value, null, 2)}\n`);
  const fd = openSync(`${file}.tmp`, "r");
  fsyncSync(fd);
  closeSync(fd);
  renameSync(`${file}.tmp`, file);
  const directory = openSync(dirname(file), "r");
  fsyncSync(directory);
  closeSync(directory);
};
async function main(mode: string, file: string) {
  configureNetwork();
  const key = readKey("IsItLegit Fireworks Admin");
  const call = async (method = "GET", body?: unknown): Promise<Deployment> => {
    const response = await fetch(`${API}/deployments/${TARGET}`, {
      method,
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(30_000),
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    assert(response.ok, `provider ${method} status ${response.status}`);
    return (await response.json()) as Deployment;
  };
  if (mode === "activate") {
    assert(!existsSync(file), "existing lease must not be overwritten or extended");
    const prior = await call();
    checkReadBack(prior, 1);
    checkPriced(prior, TARGET);
    assert.equal(prior.baseModel, `accounts/rizonetech/models/${TARGET}`);
    const at = new Date();
    const wake = await reserveWake(wranglerExec(), "authorized one-hour warm host", 66, at, undefined, TARGET, 12);
    const lease: Lease = {
      decision: "OPERATOR-LOUPE11-WARM-HOUR-20261104",
      deployment: TARGET,
      model: `accounts/rizonetech/models/${TARGET}#accounts/rizonetech/deployments/${TARGET}`,
      startedAt: at.toISOString(),
      sendCutoff: new Date(+at + 49 * 60_000).toISOString(),
      restoreAt: new Date(+at + 49 * 60_000).toISOString(),
      hardDeadline: new Date(+at + 60 * 60_000).toISOString(),
      rate: 12,
      reservedMinutes: 66,
      wake,
      prior: { minReplicaCount: 0, maxReplicaCount: 1 },
      phase: "reserved",
    };
    touchWake(wake, +at + 60 * 60_000);
    save(file, lease);
    const unit = "isitlegit-loupe-warm-restore";
    const units = `${process.env.HOME}/.config/systemd/user`;
    mkdirSync(units, { recursive: true });
    writeFileSync(
      `${units}/${unit}.service`,
      `[Unit]\nDescription=Restore bounded Loupe warm host lease\n[Service]\nType=oneshot\nWorkingDirectory=${process.cwd()}\nEnvironment=PATH=${process.env.PATH}\nExecStart=${process.execPath} ${resolve(import.meta.filename)} restore ${file}\n`,
    );
    writeFileSync(
      `${units}/${unit}.timer`,
      `[Unit]\nDescription=Check bounded Loupe lease restoration every minute\n[Timer]\nOnCalendar=*-*-* *:*:00\nPersistent=true\nAccuracySec=1s\n[Install]\nWantedBy=timers.target\n`,
    );
    execFileSync("systemctl", ["--user", "daemon-reload"]);
    execFileSync("systemctl", ["--user", "enable", "--now", `${unit}.timer`]);
    assert.equal(
      execFileSync("systemctl", ["--user", "is-active", `${unit}.timer`], { encoding: "utf8" }).trim(),
      "active",
    );
    lease.phase = "activating";
    save(file, lease);
    await call("PATCH", { minReplicaCount: 1, maxReplicaCount: 1 });
    while (Date.now() < Date.parse(lease.sendCutoff)) {
      const read = await call();
      lease.readback = read;
      save(file, lease);
      if (read.state === "READY" && read.replicaCount === 1) {
        validateWarm(read, lease);
        lease.phase = "ready";
        save(file, lease);
        console.log(
          JSON.stringify({
            phase: lease.phase,
            startedAt: lease.startedAt,
            sendCutoff: lease.sendCutoff,
            hardDeadline: lease.hardDeadline,
            file,
          }),
        );
        return;
      }
      await new Promise((r) => setTimeout(r, 15_000));
    }
    throw new Error("warm lease did not become ready before cutoff; timer owns restoration");
  }
  assert.equal(mode, "restore");
  const lease = JSON.parse(readFileSync(file, "utf8")) as Lease;
  if (lease.phase === "settled" || Date.now() < Date.parse(lease.restoreAt)) return;
  assert.equal(lease.deployment, TARGET);
  assert.deepEqual(lease.prior, { minReplicaCount: 0, maxReplicaCount: 1 });
  let read = await call();
  assert.equal(read.name, `accounts/rizonetech/deployments/${TARGET}`);
  assert.equal(read.baseModel, `accounts/rizonetech/models/${TARGET}`);
  if (read.minReplicaCount !== 0 || read.maxReplicaCount !== 1) {
    await call("PATCH", lease.prior);
    read = await call();
  }
  checkReadBack(read, 1);
  checkPriced(read, TARGET);
  lease.phase = "restored";
  lease.readback = read;
  save(file, lease);
  if (read.replicaCount === 0) {
    const zeroAt = new Date();
    await settleWake(wranglerExec(), { ...lease.wake, at: new Date(lease.wake.at) }, { zeroAt });
    const recorded = await findBurst(wranglerExec(), lease.wake.id);
    assert(recorded?.settled, "settlement not verified; reservation retained");
    lease.zeroAt = zeroAt.toISOString();
    lease.phase = "settled";
    save(file, lease);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  assert(process.argv[2] && process.argv[3], "usage: warm-lease.ts activate|restore <lease.json>");
  await main(process.argv[2], resolve(process.argv[3]));
}
