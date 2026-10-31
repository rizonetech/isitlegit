// A promotion run as its own process so a test can kill it (D03 T04 §32): argv are the mode, the active file and the
// promotion record. Mode "probe" never gets an answer from the probe; mode "journal" kills itself when it writes the
// record that follows the switch, after the active file has been replaced.
import { createBody, type Deployment } from "../../../scripts/glimmer/deploy.ts";
import { promote, writeJson } from "../../../scripts/glimmer/promote.ts";

const [mode, activeFile, stateFile] = process.argv.slice(2) as [string, string, string];
const ready = (version: string) =>
  ({
    ...createBody(version),
    state: "READY",
    replicaCount: 0,
    acceleratorType: "NVIDIA_H200_141GB",
    acceleratorCount: 1,
  }) as Deployment;
const remote: Record<string, Deployment> = { "isitlegit-loupe": ready("1.0") };
setInterval(() => {}, 1_000);
await promote("1.1", {
  activeFile,
  stateFile,
  gate: () => ({ verdict: "promote", detail: "promote" }),
  deployments: (deployment) => ({
    status: async () => remote[deployment] ?? null,
    ensure: async (version) => {
      remote[deployment] ??= ready(version);
      return { created: true, deployment: remote[deployment] as Deployment };
    },
    waitReady: async () => remote[deployment] as Deployment,
  }),
  probe: mode === "probe" ? () => new Promise(() => {}) : async () => {},
  write: (file, value) => {
    if (mode === "journal" && file === stateFile && (value as { status: string }).status === "promoted")
      process.kill(process.pid, "SIGKILL");
    writeJson(file, value);
  },
});
