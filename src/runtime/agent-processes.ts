import { execa } from "execa";

export interface AgentProcessRow {
  processId: number;
  commandLine: string;
  executableName?: string;
}

export interface AgentProcessCounts {
  kimi: { count: number };
  piRpc: { count: number };
  realSmoke: { count: number };
}

export type AgentProcessRunner = (
  platform: NodeJS.Platform,
) => Promise<readonly AgentProcessRow[]>;

export type AgentProcessCommandRunner = (
  command: string,
  args: readonly string[],
) => Promise<{ exitCode: number; stdout: string }>;

export interface ClassifyAgentProcessesOptions {
  platform?: NodeJS.Platform;
  rows?: readonly AgentProcessRow[];
  runner?: AgentProcessRunner;
  commandRunner?: AgentProcessCommandRunner;
}

export class AgentProcessInspectionError extends Error {
  constructor() {
    super("Target process inspection failed");
    this.name = "AgentProcessInspectionError";
  }
}

const REAL_SMOKE_SCRIPTS = [
  "real-kimi-smoke.mjs",
  "real-pi-smoke.mjs",
  "real-ark-smoke.mjs",
] as const;

function isShellProcess(row: AgentProcessRow): boolean {
  const executable = row.executableName?.toLowerCase() ?? "";
  return /^(?:powershell|powershell\.exe|pwsh|pwsh\.exe)$/u.test(executable);
}

function hasArgument(
  commandLine: string,
  flag: string,
  value: string,
): boolean {
  const tokens = commandLine.match(/"[^"]*"|'[^']*'|\S+/gu) ?? [];
  for (let index = 0; index < tokens.length - 1; index += 1) {
    const token = tokens[index]?.replace(/^["']|["']$/gu, "");
    const next = tokens[index + 1]?.replace(/^["']|["']$/gu, "");
    if (token === flag && next === value) return true;
  }
  return false;
}

function isKimiAcp(row: AgentProcessRow): boolean {
  if (isShellProcess(row)) return false;
  const executable = row.executableName?.toLowerCase();
  const commandLine = row.commandLine;
  return (
    (executable === undefined
      ? /^(?:"[^"]*[\\/]kimi(?:\.exe)?"|kimi(?:\.exe)?)(?:\s|$)/iu.test(
          commandLine.trim(),
        )
      : /^(?:kimi|kimi\.exe)$/u.test(executable)) &&
    /(?:^|\s)acp(?:\s|$)/iu.test(commandLine)
  );
}

function isPiRpc(row: AgentProcessRow): boolean {
  if (isShellProcess(row)) return false;
  const executable = row.executableName?.toLowerCase() ?? "";
  const command = row.commandLine.trim();
  const piExecutable =
    /^(?:pi|pi\.exe|node|node\.exe)$/u.test(executable) ||
    /^(?:"[^"]*[\\/](?:pi|pi\.exe|node|node\.exe)"|(?:pi|pi\.exe|node|node\.exe))(?:\s|$)/iu.test(
      command,
    );
  return (
    piExecutable &&
    /(?:^|[\\/\s"'])(?:pi|pi-coding-agent)(?:\.exe)?(?:$|[\\/\s"'])/iu.test(
      command,
    ) &&
    hasArgument(row.commandLine, "--mode", "rpc") &&
    hasArgument(row.commandLine, "--name", "codex-external-agents")
  );
}

function isRealSmoke(row: AgentProcessRow): boolean {
  if (isShellProcess(row)) return false;
  const executable = row.executableName?.toLowerCase();
  const command = row.commandLine.trim();
  const nodeLike =
    executable === undefined
      ? /^(?:"[^"]*[\\/]node(?:\.exe)?"|node(?:\.exe)?)(?:\s|$)/iu.test(command)
      : /^(?:node|node\.exe)$/u.test(executable);
  return (
    nodeLike &&
    REAL_SMOKE_SCRIPTS.some((script) =>
      new RegExp(
        `(?:^|[\\\\/\\s"'])${script.replace(".", "\\.")}(?:$|\\s|["'])`,
        "iu",
      ).test(command),
    )
  );
}

function validateRows(rows: readonly AgentProcessRow[]): void {
  for (const row of rows) {
    if (
      typeof row !== "object" ||
      row === null ||
      !Number.isSafeInteger(row.processId) ||
      row.processId <= 0 ||
      typeof row.commandLine !== "string" ||
      (row.executableName !== undefined &&
        typeof row.executableName !== "string")
    ) {
      throw new AgentProcessInspectionError();
    }
  }
}

function parseWindowsRows(stdout: string): AgentProcessRow[] {
  if (stdout.trim() === "") return [];
  const parsed: unknown = JSON.parse(stdout);
  const values = Array.isArray(parsed) ? parsed : [parsed];
  return values.map((value) => {
    if (typeof value !== "object" || value === null) {
      throw new AgentProcessInspectionError();
    }
    const record = value as Record<string, unknown>;
    return {
      processId: record.ProcessId as number,
      commandLine: record.CommandLine as string,
      executableName: record.Name as string,
    };
  });
}

function parseUnixRows(stdout: string): AgentProcessRow[] {
  const rows: AgentProcessRow[] = [];
  for (const line of stdout.split(/\r?\n/u)) {
    if (line.trim() === "") continue;
    const match = /^\s*(\d+)\s+(\S+)\s+(.*)$/u.exec(line);
    if (match === null) throw new AgentProcessInspectionError();
    const row: AgentProcessRow = {
      processId: Number(match[1]),
      commandLine: match[3] ?? "",
    };
    if (match[2] !== undefined) row.executableName = match[2];
    rows.push(row);
  }
  return rows;
}

const defaultCommandRunner: AgentProcessCommandRunner = async (
  command,
  args,
) => {
  const result = await execa(command, [...args], {
    reject: false,
    timeout: 30_000,
    windowsHide: true,
  });
  return { exitCode: result.exitCode ?? -1, stdout: result.stdout };
};

async function collectRows(
  platform: NodeJS.Platform,
  commandRunner: AgentProcessCommandRunner,
): Promise<readonly AgentProcessRow[]> {
  if (platform === "win32") {
    const pipeline = [
      "Get-CimInstance Win32_Process",
      "Where-Object { $_.CommandLine }",
      "Select-Object ProcessId,Name,CommandLine",
      "ConvertTo-Json -Compress",
    ].join(" | ");
    const script =
      `$ErrorActionPreference = 'Stop'; ` +
      pipeline.replace(
        "Get-CimInstance Win32_Process",
        "Get-CimInstance Win32_Process -ErrorAction Stop",
      );
    const result = await commandRunner("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      script,
    ]);
    if (result.exitCode !== 0) throw new AgentProcessInspectionError();
    return parseWindowsRows(result.stdout);
  }
  const result = await commandRunner("ps", ["-ww", "-eo", "pid=,comm=,args="]);
  if (result.exitCode !== 0) throw new AgentProcessInspectionError();
  return parseUnixRows(result.stdout);
}

export async function classifyAgentProcesses(
  options: ClassifyAgentProcessesOptions = {},
): Promise<AgentProcessCounts> {
  try {
    const platform = options.platform ?? process.platform;
    if (
      options.rows !== undefined &&
      (options.runner !== undefined || options.commandRunner !== undefined)
    ) {
      throw new AgentProcessInspectionError();
    }
    if (options.runner !== undefined && options.commandRunner !== undefined) {
      throw new AgentProcessInspectionError();
    }
    const rows =
      options.rows ??
      (options.runner === undefined
        ? await collectRows(
            platform,
            options.commandRunner ?? defaultCommandRunner,
          )
        : await options.runner(platform));
    validateRows(rows);
    let kimi = 0;
    let piRpc = 0;
    let realSmoke = 0;
    for (const row of rows) {
      if (isKimiAcp(row)) kimi += 1;
      if (isPiRpc(row)) piRpc += 1;
      if (isRealSmoke(row)) realSmoke += 1;
    }
    return Object.freeze({
      kimi: Object.freeze({ count: kimi }),
      piRpc: Object.freeze({ count: piRpc }),
      realSmoke: Object.freeze({ count: realSmoke }),
    });
  } catch {
    throw new AgentProcessInspectionError();
  }
}
