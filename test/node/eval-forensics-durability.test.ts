import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { build, ROOT, SET } from "../../eval/forensics/build.ts";
import { loadManifest, parseManifest } from "../../eval/forensics/score.ts";

const interception = vi.hoisted(() => ({ after: null as null | ((name: string, args: unknown[]) => void) }));
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  const wrapped = { ...fs };
  for (const name of ["mkdirSync", "mkdtempSync", "writeFileSync", "renameSync", "rmSync", "fsyncSync"] as const) {
    const operation = fs[name] as unknown as (...args: unknown[]) => unknown;
    Object.assign(wrapped, {
      [name]: (...args: unknown[]) => {
        const result = operation(...args);
        interception.after?.(name, args);
        return result;
      },
    });
  }
  return wrapped;
});
const real = await vi.importActual<typeof import("node:fs")>("node:fs");
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("missing expected test evidence");
  return value;
}
const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "corpus-durability-"));
  roots.push(root);
  for (const path of [SET, "test/fixtures/pdf-forensics", "test/fixtures/payment-docs"])
    cpSync(join(ROOT, path), join(root, path), { recursive: true });
  return root;
}
afterEach(() => {
  interception.after = null;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("corpus durable recovery", () => {
  it.each(["manifest.json", "invoice-genuine.pdf"])(
    "restores backup despite damaged %s before generating anything",
    async (damaged) => {
      const root = fixture();
      const parent = join(root, "eval/forensics/sets");
      cpSync(join(root, SET), join(parent, ".pdf-forensics-previous"), { recursive: true });
      writeFileSync(join(root, SET, damaged), "damaged live evidence");
      await expect(
        build(root, {
          write() {
            throw new Error("generation deliberately stopped");
          },
        }),
      ).rejects.toThrow("generation deliberately stopped");
      expect(loadManifest(root).documents).toHaveLength(14);
      const archives = readdirSync(parent).filter((name) => name.startsWith(".pdf-forensics-damaged-"));
      expect(archives).toHaveLength(1);
      expect(readFileSync(join(parent, required(archives[0]), "generation", damaged), "utf8")).toBe(
        "damaged live evidence",
      );
    },
  );

  it("retains both damaged generations and refuses before new writes", async () => {
    const root = fixture();
    const saved = join(root, "eval/forensics/sets/.pdf-forensics-previous");
    cpSync(join(root, SET), saved, { recursive: true });
    writeFileSync(join(root, SET, "manifest.json"), "bad live");
    writeFileSync(join(saved, "manifest.json"), "bad saved");
    await expect(build(root)).rejects.toThrow();
    expect(readFileSync(join(root, SET, "manifest.json"), "utf8")).toBe("bad live");
    expect(readFileSync(join(saved, "manifest.json"), "utf8")).toBe("bad saved");
    expect(existsSync(saved)).toBe(true);
  });
});

// A storage image has independent inode data and per-directory persisted names.
// Unsynchronized bytes/names are discarded on restart, not copied from the OS cache.
// This is an executable model, not a physical power-loss experiment.
type Node = { kind: "file"; bytes: Buffer } | { kind: "dir"; entries: [string, string][] };
type Image = Map<string, Node>;
class Storage {
  durable: Image = new Map();
  images: { label: string; image: Image }[] = [];
  syncs: string[] = [];
  rootId: string;
  omitted: number | undefined;
  readonly root: string;
  readonly writeback: "loss" | "names" | "bytes";
  constructor(root: string, omitted?: number, writeback: "loss" | "names" | "bytes" = "loss") {
    this.root = root;
    this.writeback = writeback;
    this.omitted = omitted;
    this.rootId = this.id(root);
    this.scan(true);
  }
  id(path: string) {
    const s = real.statSync(path, { bigint: true });
    return `${s.dev}:${s.ino}:${s.birthtimeNs}`;
  }
  scan(initial = false): Map<string, { path: string; node: Node }> {
    const current = new Map<string, { path: string; node: Node }>();
    const visit = (path: string): string => {
      const id = this.id(path);
      const node: Node = real.statSync(path).isDirectory()
        ? { kind: "dir", entries: real.readdirSync(path).map((name) => [name, visit(join(path, name))]) }
        : { kind: "file", bytes: real.readFileSync(path) };
      current.set(id, { path, node });
      if (!this.durable.has(id))
        this.durable.set(
          id,
          initial
            ? node
            : node.kind === "dir"
              ? { kind: "dir", entries: [] }
              : { kind: "file", bytes: Buffer.alloc(0) },
        );
      return id;
    };
    visit(this.root);
    return current;
  }
  start() {
    interception.after = (name, args) => {
      const current = this.scan();
      // Independent early writeback can persist names without data, or data without names.
      for (const [id, { node }] of current) {
        if ((this.writeback === "names" && node.kind === "dir") || (this.writeback === "bytes" && node.kind === "file"))
          this.durable.set(id, node);
      }
      let label = name;
      if (name === "fsyncSync") {
        const s = real.fstatSync(args[0] as number, { bigint: true });
        const id = `${s.dev}:${s.ino}:${s.birthtimeNs}`;
        const entry = current.get(id);
        if (!entry) return; // Ancestors above the test-owned root already exist durably.
        label = entry.path.slice(this.root.length + 1) || ".";
        this.syncs.push(label);
        if (this.syncs.length - 1 !== this.omitted) this.durable.set(id, entry.node);
      }
      this.images.push({ label, image: new Map(this.durable) });
    };
  }
  stop() {
    interception.after = null;
  }
  restore(image: Image) {
    this.stop();
    const visit = (id: string, path: string) => {
      const node = image.get(id);
      if (!node) throw new Error("storage model has a dangling inode");
      if (node.kind === "file") real.writeFileSync(path, node.bytes);
      else {
        real.mkdirSync(path, { recursive: true });
        for (const [name, child] of node.entries) visit(child, join(path, name));
      }
    };
    real.rmSync(this.root, { recursive: true, force: true });
    visit(this.rootId, this.root);
  }
}
function ownedBytes(root: string, relative: string): string | null {
  try {
    const path = join(root, relative);
    const manifest = parseManifest(JSON.parse(real.readFileSync(join(path, "manifest.json"), "utf8")));
    // Check restored owned bytes before any regeneration; external fixtures are unchanged.
    const raw = real.readFileSync(join(path, "manifest.json"), "utf8");
    for (const document of manifest.documents.filter((d: { path: string }) => d.path.startsWith(`${SET}/`))) {
      const name = document.path.slice(SET.length + 1);
      const bytes = real.readFileSync(join(path, name));
      if (createHash("sha256").update(bytes).digest("hex") !== document.sha256) return null;
    }
    return raw;
  } catch {
    return null;
  }
}
const SAVED = "eval/forensics/sets/.pdf-forensics-previous";
function distinguishPrior(root: string) {
  const path = join(root, SET, "manifest.json");
  const prior = JSON.parse(real.readFileSync(path, "utf8"));
  prior.documents[0].generator = "persisted-prior-generation";
  real.writeFileSync(path, JSON.stringify(prior));
  return real.readFileSync(path, "utf8");
}

describe("persistence boundary model", () => {
  it.each(["loss", "names", "bytes"] as const)(
    "keeps verified bytes before regeneration with %s writeback at every boundary",
    async (writeback) => {
      const root = fixture();
      const prior = distinguishPrior(root);
      const storage = new Storage(root, undefined, writeback);
      storage.start();
      try {
        await build(root);
      } finally {
        storage.stop();
      }
      const latest = real.readFileSync(join(root, SET, "manifest.json"), "utf8");
      expect(latest).not.toBe(prior);
      expect(storage.images.length).toBeGreaterThan(25);
      for (const { label, image } of storage.images) {
        storage.restore(image);
        const live = ownedBytes(root, SET);
        const saved = ownedBytes(root, SAVED);
        expect([live, saved], label).toContain(live === latest ? latest : prior);
        // Stop at the first generation write: recovery cannot hide missing persisted bytes.
        await expect(
          build(root, {
            write() {
              throw new Error("stop before regeneration");
            },
          }),
        ).rejects.toThrow("stop before regeneration");
        expect(loadManifest(root).documents).toHaveLength(14);
      }
      storage.restore(required(storage.images.at(-1)).image);
      expect(ownedBytes(root, SET)).toBe(latest);
    },
  );

  it("detects removal of every stage file sync, stage directory sync and publication sync", async () => {
    const baseline = fixture();
    const storage = new Storage(baseline);
    storage.start();
    try {
      await build(baseline);
    } finally {
      storage.stop();
    }
    const necessary = storage.syncs
      .map((path, index) => ({ path, index }))
      .filter(({ path, index }) => path.includes(".pdf-forensics-stage-") || index === storage.syncs.length - 1);
    expect(necessary).toHaveLength(9); // Six PDFs, manifest, stage directory, final parent.
    for (const { path, index } of necessary) {
      const root = fixture();
      distinguishPrior(root);
      const mutant = new Storage(root, index);
      mutant.start();
      try {
        await build(root);
      } finally {
        mutant.stop();
      }
      const latest = real.readFileSync(join(root, SET, "manifest.json"), "utf8");
      mutant.restore(required(mutant.images.at(-1)).image);
      expect(ownedBytes(root, SET), `omitted fsync ${path}`).not.toBe(latest);
    }
  });

  it("persists newly created directory ancestry; omitting each ancestor sync loses acknowledged output", async () => {
    const baseline = fixture();
    real.rmSync(join(baseline, "eval"), { recursive: true });
    const storage = new Storage(baseline);
    storage.start();
    try {
      await build(baseline);
    } finally {
      storage.stop();
    }
    const latest = real.readFileSync(join(baseline, SET, "manifest.json"), "utf8");
    storage.restore(required(storage.images.at(-1)).image);
    expect(ownedBytes(baseline, SET)).toBe(latest);
    for (const ancestor of ["eval/forensics", "eval", "."]) {
      const root = fixture();
      real.rmSync(join(root, "eval"), { recursive: true });
      const index = storage.syncs.indexOf(ancestor);
      expect(index).toBeGreaterThanOrEqual(0);
      const mutant = new Storage(root, index);
      mutant.start();
      try {
        await build(root);
      } finally {
        mutant.stop();
      }
      mutant.restore(required(mutant.images.at(-1)).image);
      expect(ownedBytes(root, SET), ancestor).toBeNull();
    }
  });
});

describe("recovery durability and synchronization failures", () => {
  it("retains the saved generation throughout damaged-live recovery and persists diagnostic bytes", async () => {
    const root = fixture();
    cpSync(join(root, SET), join(root, SAVED), { recursive: true });
    writeFileSync(join(root, SET, "manifest.json"), "damaged diagnosis");
    const prior = ownedBytes(root, SAVED);
    const storage = new Storage(root);
    storage.start();
    try {
      await expect(
        build(root, {
          write() {
            throw new Error("stop generation");
          },
        }),
      ).rejects.toThrow("stop generation");
    } finally {
      storage.stop();
    }
    for (const { label, image } of storage.images) {
      storage.restore(image);
      expect([ownedBytes(root, SET), ownedBytes(root, SAVED)], label).toContain(prior);
      await expect(
        build(root, {
          write() {
            throw new Error("stop generation");
          },
        }),
      ).rejects.toThrow("stop generation");
      expect(loadManifest(root).documents).toHaveLength(14);
    }
    storage.restore(required(storage.images.at(-1)).image);
    const parent = join(root, "eval/forensics/sets");
    const archives = real.readdirSync(parent).filter((name) => name.startsWith(".pdf-forensics-damaged-"));
    expect(archives).toHaveLength(1);
    expect(real.readFileSync(join(parent, required(archives[0]), "generation/manifest.json"), "utf8")).toBe(
      "damaged diagnosis",
    );
  });

  it("preserves an invalid saved generation when live bytes are valid", async () => {
    const root = fixture();
    cpSync(join(root, SET), join(root, SAVED), { recursive: true });
    writeFileSync(join(root, SAVED, "manifest.json"), "saved diagnosis");
    await build(root);
    expect(loadManifest(root).documents).toHaveLength(14);
    const parent = join(root, "eval/forensics/sets");
    const archives = readdirSync(parent).filter((name) => name.startsWith(".pdf-forensics-damaged-"));
    expect(readFileSync(join(parent, required(archives[0]), "generation/manifest.json"), "utf8")).toBe(
      "saved diagnosis",
    );
  });

  it("propagates every synchronization failure without deleting the recoverable generation", async () => {
    const baseline = fixture();
    const storage = new Storage(baseline);
    storage.start();
    try {
      await build(baseline);
    } finally {
      storage.stop();
    }
    for (let failed = 0; failed < storage.syncs.length; failed++) {
      const root = fixture();
      const prior = distinguishPrior(root);
      let count = 0;
      interception.after = (name, args) => {
        if (name !== "fsyncSync") return;
        const path = real.readlinkSync(`/proc/self/fd/${args[0]}`);
        if (!path.startsWith(`${root}/`) && path !== root) return;
        if (count++ === failed) throw new Error("injected sync failure");
      };
      try {
        await expect(build(root)).rejects.toThrow("injected sync failure");
      } finally {
        interception.after = null;
      }
      expect([ownedBytes(root, SET), ownedBytes(root, SAVED)], `sync ${failed}`).toContain(prior);
      await expect(
        build(root, {
          write() {
            throw new Error("stop generation");
          },
        }),
      ).rejects.toThrow("stop generation");
      expect(loadManifest(root).documents).toHaveLength(14);
    }
  });
});
