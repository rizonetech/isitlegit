import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { astraCommand, labelPageAstra, parseAstraAnswer } from "../../scripts/glimmer/codex-astra-label.ts";
import type { StoredPage } from "../../scripts/glimmer/store.ts";

// GPT-6 Astra as a candidate Loupe 1.1 labeler: the exact codex exec command, schema validation before
// storage, and the inherited refusals. `codex exec` is stubbed: no paid call in tests.
const page = (over: Partial<StoredPage> = {}): StoredPage =>
  ({
    id: "p1",
    source: "set",
    origin: "public",
    licence: "CC BY 4.0",
    host: "acme.example",
    template: null,
    south_africa: false,
    labels: { lure: true, lure_type: "credential", brand: "Acme", has_login_form: true, has_payment_form: false },
    label_source: {},
    sha256: { screenshot: "a".repeat(64), text: "b".repeat(64) },
    redacted: false,
    ...over,
  }) as StoredPage;

const VALID = JSON.stringify({ lure: true, lure_type: "credential", capture_valid: true, reasons: ["copied sign-in"] });

describe("codex-astra-label", () => {
  it("builds the exact teacher command", () => {
    expect(astraCommand("/tmp/shot.jpg", "/tmp/answer.json")).toEqual([
      "exec",
      "-m",
      "gpt-6-astra",
      "-c",
      'model_reasoning_effort="medium"',
      "-s",
      "read-only",
      "--skip-git-repo-check",
      "--ephemeral",
      "--json",
      "-i",
      "/tmp/shot.jpg",
      "--output-schema",
      expect.stringContaining("wonder-schema.json"),
      "-o",
      "/tmp/answer.json",
      "-",
    ]);
  });

  it("validates an answer and refuses one with a brand field", () => {
    expect(parseAstraAnswer(VALID).lure).toBe(true);
    expect(() =>
      parseAstraAnswer(
        JSON.stringify({ lure: true, lure_type: "credential", capture_valid: true, reasons: [], brand: "Acme" }),
      ),
    ).toThrow();
    expect(() => parseAstraAnswer("no json here")).toThrow();
  });

  it("stores a valid label with teacher, effort and usage, refuses unredacted samples and samples paths before executing codex exec, and stores nothing from an invalid answer", () => {
    const dir = mkdtempSync(join(tmpdir(), "astra-"));
    const shot = join(dir, "shot.jpg");
    writeFileSync(shot, "x");
    const uncalled = vi.fn(() => ({ jsonl: "" }));
    expect(() =>
      labelPageAstra({
        page: page({ origin: "samples" as never, redacted: false }),
        screenshot: shot,
        text: "Sign in",
        outDir: dir,
        exec: uncalled,
      }),
    ).toThrow(/unredacted/);
    expect(() =>
      labelPageAstra({
        page: page(),
        screenshot: join(dir, "samples", "shot.jpg"),
        text: "Sign in",
        outDir: dir,
        exec: uncalled,
      }),
    ).toThrow(/samples/);
    expect(uncalled).not.toHaveBeenCalled();

    const record = labelPageAstra({
      page: page(),
      screenshot: shot,
      text: "Sign in",
      outDir: dir,
      test: "astra-proof",
      exec: (_argv, _prompt, outFile) => {
        writeFileSync(outFile, VALID);
        return { jsonl: '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":5}}\n' };
      },
      now: () => 1000,
    });
    expect(record.teacher).toBe("codex-astra");
    expect(record.usage).toEqual({ input_tokens: 10, output_tokens: 5 });
    const stored = JSON.parse(readFileSync(join(dir, "p1.json"), "utf-8"));
    expect(stored).toMatchObject({
      lure: true,
      model: "gpt-6-astra",
      effort: "medium",
      test: "astra-proof",
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    expect("brand" in stored).toBe(false);
    const dir2 = mkdtempSync(join(tmpdir(), "astra-"));
    expect(() =>
      labelPageAstra({
        page: page(),
        screenshot: shot,
        text: "Sign in",
        outDir: dir2,
        exec: (_argv, _prompt, outFile) => {
          writeFileSync(outFile, "rubbish");
          return { jsonl: "" };
        },
      }),
    ).toThrow();
    expect(existsSync(join(dir2, "p1.json"))).toBe(false);
  });
});
