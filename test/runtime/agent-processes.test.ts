import { describe, expect, it } from "vitest";

import {
  AgentProcessInspectionError,
  classifyAgentProcesses,
  type AgentProcessRow,
} from "../../src/runtime/agent-processes.js";

const secret = "SECRET_CREDENTIAL_SENTINEL";

describe("target agent process classification", () => {
  it.each(["win32", "linux"] as const)(
    "classifies only fixed agent identities on %s",
    async (platform) => {
      const rows: AgentProcessRow[] = [
        {
          processId: 11,
          commandLine: `kimi${platform === "win32" ? ".exe" : ""} acp`,
        },
        {
          processId: 12,
          commandLine:
            "node pi --mode rpc --name codex-external-agents --model x",
        },
        { processId: 13, commandLine: "node scripts/real-kimi-smoke.mjs" },
        { processId: 14, commandLine: "node scripts/real-pi-smoke.mjs" },
        { processId: 15, commandLine: "node scripts/real-ark-smoke.mjs" },
        { processId: 16, commandLine: "node server.mjs" },
        { processId: 17, commandLine: "codex --mode rpc" },
        {
          processId: 18,
          executableName: platform === "win32" ? "powershell.exe" : "pwsh",
          commandLine:
            'powershell -Command "kimi.exe acp; node pi --mode rpc --name codex-external-agents; node scripts/real-kimi-smoke.mjs"',
        },
        { processId: 19, commandLine: "kimi chat" },
        { processId: 20, commandLine: `node other.mjs ${secret}` },
        {
          processId: 21,
          executableName: platform === "win32" ? "codex.exe" : "codex",
          commandLine:
            "codex kimi acp node pi --mode rpc --name codex-external-agents real-ark-smoke.mjs",
        },
      ];

      const result = await classifyAgentProcesses({ platform, rows });

      expect(result).toEqual({
        kimi: { count: 1 },
        piRpc: { count: 1 },
        realSmoke: { count: 3 },
      });
      expect(Object.keys(result).sort()).toEqual([
        "kimi",
        "piRpc",
        "realSmoke",
      ]);
      const json = JSON.stringify(result);
      expect(json).not.toContain(secret);
      expect(json).not.toMatch(/command|processId|pid/iu);
      expect(json).not.toContain("11");
    },
  );

  it("uses an injected runner and sanitizes collection failures", async () => {
    const runner = async () => {
      throw new Error(`failed ${secret}`);
    };

    let failure: unknown;
    try {
      await classifyAgentProcesses({ platform: "win32", runner });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(AgentProcessInspectionError);
    expect((failure as Error).message).toBe("Target process inspection failed");
    expect(JSON.stringify(failure)).not.toContain(secret);
  });

  it("fails closed on malformed process rows", async () => {
    await expect(
      classifyAgentProcesses({
        platform: "linux",
        rows: [{ processId: 1, commandLine: null } as never],
      }),
    ).rejects.toThrow("Target process inspection failed");
  });

  it.each([
    [
      "win32" as const,
      '[{"ProcessId":"bad","Name":"node.exe","CommandLine":"node x"}]',
    ],
    ["linux" as const, "not-a-pid node node real-kimi-smoke.mjs"],
  ])(
    "fails closed when %s process output cannot be parsed",
    async (platform, stdout) => {
      await expect(
        classifyAgentProcesses({
          platform,
          commandRunner: async () => ({ exitCode: 0, stdout }),
        }),
      ).rejects.toThrow("Target process inspection failed");
    },
  );

  it("forces Windows CIM errors to terminate instead of reporting an empty snapshot", async () => {
    let command = "";
    await classifyAgentProcesses({
      platform: "win32",
      commandRunner: async (_executable, args) => {
        command = args.at(-1) ?? "";
        return { exitCode: 0, stdout: "" };
      },
    });
    expect(command).toContain("$ErrorActionPreference = 'Stop'");
    expect(command).toContain(
      "Get-CimInstance Win32_Process -ErrorAction Stop",
    );
  });

  it.each([
    {
      platform: "win32" as const,
      stdout: JSON.stringify([
        {
          ProcessId: 10,
          Name: "kimi.exe",
          CommandLine: '"C:\\Tools\\kimi.exe" acp',
        },
        {
          ProcessId: 11,
          Name: "node.exe",
          CommandLine:
            '"C:\\Node\\node.exe" C:\\pi-coding-agent\\index.js --mode rpc --name codex-external-agents',
        },
      ]),
    },
    {
      platform: "linux" as const,
      stdout:
        "10 kimi /usr/local/bin/kimi acp\n" +
        "11 node /usr/bin/node /opt/pi-coding-agent/index.js --mode rpc --name codex-external-agents\n",
    },
  ])(
    "parses a successful $platform production snapshot",
    async ({ platform, stdout }) => {
      await expect(
        classifyAgentProcesses({
          platform,
          commandRunner: async () => ({ exitCode: 0, stdout }),
        }),
      ).resolves.toEqual({
        kimi: { count: 1 },
        piRpc: { count: 1 },
        realSmoke: { count: 0 },
      });
    },
  );

  it("requests unlimited-width Unix commands and classifies markers beyond legacy columns", async () => {
    let args: readonly string[] = [];
    const longPrefix = `/opt/${"nested/".repeat(24)}pi-coding-agent/index.js`;
    const result = await classifyAgentProcesses({
      platform: "linux",
      commandRunner: async (_command, receivedArgs) => {
        args = receivedArgs;
        return {
          exitCode: 0,
          stdout:
            `42 node /usr/bin/node ${longPrefix} ` +
            "--mode rpc --name codex-external-agents\n",
        };
      },
    });
    expect(args).toEqual(["-ww", "-eo", "pid=,comm=,args="]);
    expect(result.piRpc.count).toBe(1);
  });
});
