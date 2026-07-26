import { randomUUID } from "node:crypto";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

export type IsolatedReportMode = "check" | "update";

export type IsolatedReportErrorCode =
  | "invalid_arguments"
  | "render_failed"
  | "check_failed"
  | "report_drift"
  | "update_failed";

const errorMessages: Readonly<Record<IsolatedReportErrorCode, string>> =
  Object.freeze({
    invalid_arguments: "Invalid isolated report arguments",
    render_failed: "Isolated plugin report rendering failed",
    check_failed: "Isolated plugin report check failed",
    report_drift: "Isolated plugin report differs from committed report",
    update_failed: "Isolated plugin report update failed",
  });

export class IsolatedReportError extends Error {
  readonly code: IsolatedReportErrorCode;

  constructor(code: IsolatedReportErrorCode) {
    super(errorMessages[code]);
    this.name = "IsolatedReportError";
    this.code = code;
  }
}

export interface IsolatedReportFileSystem {
  readFile(filePath: string): Promise<Uint8Array>;
  writeFile(
    filePath: string,
    contents: string,
    options: {
      encoding: "utf8";
      flag: "wx";
    },
  ): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  unlink(filePath: string): Promise<void>;
}

export interface SynchronizeIsolatedReportOptions {
  mode: IsolatedReportMode;
  reportPath: string;
  render: () => string | Promise<string>;
  fileSystem?: IsolatedReportFileSystem;
  createNonce?: () => string;
}

export interface SynchronizeIsolatedReportResult {
  status: "unchanged" | "updated";
}

const productionFileSystem: IsolatedReportFileSystem = {
  readFile: async (filePath: string) => readFile(filePath),
  writeFile: async (
    filePath: string,
    contents: string,
    options: { encoding: "utf8"; flag: "wx" },
  ) => writeFile(filePath, contents, options),
  rename: async (from: string, to: string) => rename(from, to),
  unlink: async (filePath: string) => unlink(filePath),
};

export function parseIsolatedReportArguments(args: readonly string[]): {
  mode: IsolatedReportMode;
} {
  if (args.length === 0) {
    return { mode: "update" };
  }
  if (args.length === 1 && args[0] === "--check-report") {
    return { mode: "check" };
  }
  throw new IsolatedReportError("invalid_arguments");
}

async function renderCompleteReport(
  render: () => string | Promise<string>,
): Promise<string> {
  try {
    const rendered = await render();
    if (typeof rendered !== "string") {
      throw new TypeError("Report renderer did not return a string");
    }
    return rendered;
  } catch {
    throw new IsolatedReportError("render_failed");
  }
}

function stagingPath(reportPath: string, nonce: string): string {
  if (!/^[A-Za-z0-9-]+$/u.test(nonce)) {
    throw new IsolatedReportError("update_failed");
  }
  return path.join(
    path.dirname(reportPath),
    `.${path.basename(reportPath)}.${nonce}.tmp`,
  );
}

export async function synchronizeIsolatedReport(
  options: SynchronizeIsolatedReportOptions,
): Promise<SynchronizeIsolatedReportResult> {
  if (options.mode !== "check" && options.mode !== "update") {
    throw new IsolatedReportError("invalid_arguments");
  }
  const rendered = await renderCompleteReport(options.render);
  const renderedBytes = Buffer.from(rendered, "utf8");
  const fileSystem = options.fileSystem ?? productionFileSystem;

  if (options.mode === "check") {
    let committedBytes: Uint8Array;
    try {
      committedBytes = await fileSystem.readFile(options.reportPath);
    } catch {
      throw new IsolatedReportError("check_failed");
    }
    if (
      committedBytes.byteLength !== renderedBytes.byteLength ||
      !Buffer.from(committedBytes).equals(renderedBytes)
    ) {
      throw new IsolatedReportError("report_drift");
    }
    return { status: "unchanged" };
  }

  let temporaryPath: string;
  try {
    temporaryPath = stagingPath(
      options.reportPath,
      (options.createNonce ?? randomUUID)(),
    );
  } catch {
    throw new IsolatedReportError("update_failed");
  }

  let committed = false;
  let removeTemporaryOnFailure = true;
  try {
    await fileSystem.writeFile(temporaryPath, rendered, {
      encoding: "utf8",
      flag: "wx",
    });
    await fileSystem.rename(temporaryPath, options.reportPath);
    committed = true;
    return { status: "updated" };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      removeTemporaryOnFailure = false;
    }
    throw new IsolatedReportError("update_failed");
  } finally {
    if (!committed && removeTemporaryOnFailure) {
      await fileSystem.unlink(temporaryPath).catch(() => undefined);
    }
  }
}
