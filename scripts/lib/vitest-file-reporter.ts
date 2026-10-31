// CI only (vitest.config.ts adds it when CI is set): one line when each test file starts and ends, and every minute
// the files still running, so a shard that goes silent names where it stopped (2026-10-31: Worker shards 2 and 3 went
// quiet between files until the job limit, after test/auth/domains.test.ts, test/intake/email.test.ts and
// test/web/upload-page.test.ts, and the log could not say whether a file or the pool between files was stuck).
// A file is tracked from the moment it is queued, so a hang while it loads (an import or a setup file, before
// onTestModuleStart) is named too, marked `loading`. A heartbeat with files listed is a stuck file; a heartbeat with
// none, after the last end, is the pool.
import { relative } from "node:path";

// The parts of Vitest's TestModule this reporter reads (vitest/node `TestModule`).
export type Module = { moduleId: string; project: { name: string }; state(): string };

export type Options = {
  write?: (line: string) => void;
  now?: () => number;
  everyMs?: number;
  cwd?: string;
};

export default class FileProgressReporter {
  private readonly started = new Map<string, { at: number; phase: "loading" | "running" }>();
  private readonly write: (line: string) => void;
  private readonly now: () => number;
  private readonly everyMs: number;
  private readonly cwd: string;
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly onExit = () => this.unfinished();

  constructor(options: Options = {}) {
    this.write = options.write ?? ((line) => process.stdout.write(`${line}\n`));
    this.now = options.now ?? Date.now;
    this.everyMs = options.everyMs ?? 60_000;
    this.cwd = options.cwd ?? process.cwd();
  }

  onTestRunStart() {
    this.timer = setInterval(() => this.heartbeat(), this.everyMs);
    this.timer.unref?.();
    // A step timeout stops the run before onTestRunEnd: the files still open are printed as the process exits.
    process.once("exit", this.onExit);
  }

  onTestModuleQueued(module: Module) {
    this.started.set(this.key(module), { at: this.now(), phase: "loading" });
  }

  onTestModuleStart(module: Module) {
    const key = this.key(module);
    this.started.set(key, { at: this.started.get(key)?.at ?? this.now(), phase: "running" });
    this.write(`[file start] ${key}`);
  }

  onTestModuleEnd(module: Module) {
    const key = this.key(module);
    const at = this.started.get(key)?.at;
    this.started.delete(key);
    const took = at === undefined ? "" : ` ${Math.round((this.now() - at) / 1000)} s`;
    this.write(`[file end] ${key} ${module.state()}${took}`);
  }

  onTestRunEnd() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    process.removeListener("exit", this.onExit);
  }

  // The files queued or started and not ended, oldest first, with how long each has been open; one still loading
  // (queued, not started) is marked so.
  running(): string[] {
    const now = this.now();
    return [...this.started.entries()]
      .sort((a, b) => a[1].at - b[1].at)
      .map(
        ([key, { at, phase }]) =>
          `${key} (${phase === "loading" ? "loading, " : ""}${Math.round((now - at) / 1000)} s)`,
      );
  }

  heartbeat() {
    const open = this.running();
    this.write(`[files running] ${open.length}${open.length ? `: ${open.join(", ")}` : " (between files)"}`);
  }

  unfinished() {
    const open = this.running();
    if (open.length) this.write(`[files unfinished] ${open.join(", ")}`);
  }

  private key(module: Module) {
    return `${module.project.name} ${relative(this.cwd, module.moduleId)}`;
  }
}
