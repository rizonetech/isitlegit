// scripts/deploy-fixtures.ts creates the prefix's vault item from a template op reads off a real pipe: Node gives a
// child a socket, which op neither reads as a template nor opens as /dev/stdin (2026-11-01: a bare "-", then
// `--template /dev/stdin`, left the vault without the item). The value is never an argument.
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { CREATE_COMMAND } from "../../scripts/deploy-fixtures.ts";

describe("the fixtures prefix's vault item", () => {
  it("is created through a pipe op can read, naming no template and no value on the command line", () => {
    expect(CREATE_COMMAND.slice(0, 2)).toEqual(["/bin/sh", "-c"]);
    expect(CREATE_COMMAND[2]).toBe("cat | /usr/bin/op item create --vault Conclave");
    expect(CREATE_COMMAND.join(" ")).not.toMatch(/--template|\s-(\s|$)/);
  });

  it("hands what it is given to the next command as a pipe, which a socket stdin is not", () => {
    // The same shape with `op` swapped for a probe that names its stdin's kind.
    const probe = spawnSync("/bin/sh", ["-c", "cat | sh -c '[ -p /dev/stdin ] && echo pipe || echo other'"], {
      input: "{}",
      encoding: "utf-8",
    });
    expect(probe.stdout.trim()).toBe("pipe");
    const direct = spawnSync("/bin/sh", ["-c", "[ -p /dev/stdin ] && echo pipe || echo other"], {
      input: "{}",
      encoding: "utf-8",
    });
    expect(direct.stdout.trim()).toBe("other");
  });
});
