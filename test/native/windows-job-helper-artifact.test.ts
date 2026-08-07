import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "..", "..");
const artifactRoot = resolve(
  repositoryRoot,
  "plugins",
  "codex-external-agents",
  "native",
  "win32-x64",
);
const executableName = "codex-agent-job-helper.exe";
const executablePath = resolve(artifactRoot, executableName);
const manifestPath = resolve(artifactRoot, `${executableName}.sha256`);

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

describe("Windows job helper artifact", () => {
  it("keeps one canonical x64 managed PE with an exact lowercase SHA manifest", () => {
    expect(existsSync(executablePath)).toBe(true);
    expect(existsSync(manifestPath)).toBe(true);
    expect(readdirSync(artifactRoot).sort()).toEqual([
      executableName,
      `${executableName}.sha256`,
    ]);

    const executable = readFileSync(executablePath);
    const digest = sha256(executable);
    expect(readFileSync(manifestPath, "utf8")).toBe(
      `${digest}  ${executableName}\n`,
    );

    expect(executable.subarray(0, 2).toString("ascii")).toBe("MZ");
    const peOffset = executable.readUInt32LE(0x3c);
    expect(executable.subarray(peOffset, peOffset + 4).toString("binary")).toBe(
      "PE\0\0",
    );
    expect(executable.readUInt16LE(peOffset + 4)).toBe(0x8664);
    expect(executable.readUInt16LE(peOffset + 24)).toBe(0x20b);
    const clrDirectory = peOffset + 24 + 112 + 14 * 8;
    expect(executable.readUInt32LE(clrDirectory)).not.toBe(0);
    expect(executable.readUInt32LE(clrDirectory + 4)).not.toBe(0);
  });
});
