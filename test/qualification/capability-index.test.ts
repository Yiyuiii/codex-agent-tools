import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  capabilityRuntimeInputRoots,
  collectCapabilityRuntimeInputs,
  computeCapabilityRuntimeFingerprint,
  fingerprintCapabilitySnapshot,
} from "../../src/qualification/capability-index.js";

const temporaryDirectories: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "codex-agent-capability-index-"),
  );
  temporaryDirectories.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("capability qualification runtime fingerprint", () => {
  it("uses code-owned runtime input roots and excludes mutable gate metadata", () => {
    const piRoots = capabilityRuntimeInputRoots("pi-rpc");
    const kimiRoots = capabilityRuntimeInputRoots("kimi-acp");

    expect(piRoots).toContain("src/adapters/pi");
    expect(piRoots).toContain("src/qualification");
    expect(kimiRoots).toContain("src/adapters/kimi");
    expect(kimiRoots).toContain("src/qualification");
    expect(piRoots).not.toContain("src/llms/registry.ts");
    expect(kimiRoots).not.toContain("src/llms/registry.ts");
    expect(piRoots.some((entry) => entry.startsWith("docs/"))).toBe(false);
    expect(kimiRoots.some((entry) => entry.startsWith("docs/"))).toBe(false);
    expect(Object.isFrozen(piRoots)).toBe(true);
    expect(Object.isFrozen(kimiRoots)).toBe(true);
  });

  it("fingerprints normalized profile identity, task, paths, and contents", () => {
    const base = {
      llm: "ark-coding-plan",
      task: "review" as const,
      profile: {
        id: "ark-coding-plan",
        runtime: "pi-rpc" as const,
        provider: "ark-coding-plan",
        model: "ark-code-latest",
        network: "direct" as const,
        credentialEnv: [
          "ARK_API_KEY",
          "VOLCENGINE_API_KEY",
          "API_KEY_DOUBAO_CODING",
        ],
        credentialTargetEnv: "CODEX_AGENT_ARK_CODING_KEY",
        timeoutMs: 900_000,
        maxConcurrency: 1,
        concurrencyKey: "ark-coding-plan",
      },
      inputs: [
        { path: "src/a.ts", content: "export const a = 1;\r\n" },
        { path: "src/b.ts", content: "export const b = 2;\n" },
      ],
    };

    const fingerprint = fingerprintCapabilitySnapshot(base);
    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(
      fingerprintCapabilitySnapshot({
        ...base,
        inputs: [
          { path: "src/a.ts", content: "export const a = 1;\n" },
          { path: "src/b.ts", content: "export const b = 2;\n" },
        ],
      }),
    ).toBe(fingerprint);
    expect(
      fingerprintCapabilitySnapshot({ ...base, task: "delegate" }),
    ).not.toBe(fingerprint);
    expect(
      fingerprintCapabilitySnapshot({
        ...base,
        profile: { ...base.profile, model: "changed-model" },
      }),
    ).not.toBe(fingerprint);
    expect(
      fingerprintCapabilitySnapshot({
        ...base,
        inputs: [
          { path: "src/a.ts", content: "export const a = 9;\n" },
          { path: "src/b.ts", content: "export const b = 2;\n" },
        ],
      }),
    ).not.toBe(fingerprint);
  });

  it("computes deterministic and task-scoped fingerprints for current inputs", async () => {
    const repositoryRoot = process.cwd();

    const first = await computeCapabilityRuntimeFingerprint({
      repositoryRoot,
      llm: "ark-coding-plan",
      task: "review",
    });
    const second = await computeCapabilityRuntimeFingerprint({
      repositoryRoot,
      llm: "ark-coding-plan",
      task: "review",
    });
    const delegate = await computeCapabilityRuntimeFingerprint({
      repositoryRoot,
      llm: "ark-coding-plan",
      task: "delegate",
    });
    const kimi = await computeCapabilityRuntimeFingerprint({
      repositoryRoot,
      llm: "kimi-k3",
      task: "review",
    });

    expect(first).toMatch(/^[a-f0-9]{64}$/u);
    expect(second).toBe(first);
    expect(delegate).not.toBe(first);
    expect(kimi).not.toBe(first);
  });

  it("collects files in stable repository-relative order and normalizes line endings", async () => {
    const root = await temporaryRoot();
    await mkdir(path.join(root, "inputs", "nested"), { recursive: true });
    await writeFile(path.join(root, "inputs", "z.ts"), "z\r\n", "utf8");
    await writeFile(
      path.join(root, "inputs", "nested", "a.ts"),
      "a\n",
      "utf8",
    );

    await expect(
      collectCapabilityRuntimeInputs({
        repositoryRoot: root,
        roots: ["inputs"],
      }),
    ).resolves.toEqual([
      { path: "inputs/nested/a.ts", content: "a\n" },
      { path: "inputs/z.ts", content: "z\n" },
    ]);
  });

  it("fails closed for unsafe, missing, binary, or symbolic-link inputs", async () => {
    const root = await temporaryRoot();
    await mkdir(path.join(root, "inputs"), { recursive: true });
    await writeFile(path.join(root, "inputs", "safe.ts"), "safe\n", "utf8");
    await writeFile(
      path.join(root, "inputs", "binary.ts"),
      Buffer.from([0x66, 0x6f, 0x80]),
    );

    await expect(
      collectCapabilityRuntimeInputs({
        repositoryRoot: root,
        roots: ["../outside"],
      }),
    ).rejects.toThrow(/capability runtime inputs/iu);
    await expect(
      collectCapabilityRuntimeInputs({
        repositoryRoot: root,
        roots: ["missing"],
      }),
    ).rejects.toThrow(/capability runtime inputs/iu);
    await expect(
      collectCapabilityRuntimeInputs({
        repositoryRoot: root,
        roots: ["inputs"],
      }),
    ).rejects.toThrow(/capability runtime inputs/iu);

    await rm(path.join(root, "inputs", "binary.ts"));
    const linkPath = path.join(root, "inputs", "linked.ts");
    try {
      await symlink(path.join(root, "inputs", "safe.ts"), linkPath);
    } catch {
      return;
    }
    await expect(
      collectCapabilityRuntimeInputs({
        repositoryRoot: root,
        roots: ["inputs"],
      }),
    ).rejects.toThrow(/capability runtime inputs/iu);
  });
});
