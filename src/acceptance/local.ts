import { credentialEnvironmentNames } from "../llms/registry.js";

export interface LocalToolContract {
  name: string;
  inputSchema?: { required?: readonly string[] };
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
  };
}

export function forwardedCredentialEnvironment(
  parentEnvironment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const forwarded: NodeJS.ProcessEnv = {};
  for (const name of credentialEnvironmentNames()) {
    const actualName = Object.keys(parentEnvironment).find(
      (candidate) => candidate.toUpperCase() === name.toUpperCase(),
    );
    const value = actualName === undefined ? undefined : parentEnvironment[actualName];
    if (value !== undefined && value.trim() !== "") forwarded[name] = value;
  }
  return forwarded;
}

function recordOf(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    throw new Error("MCP result is not an object");
  }
  return value as Record<string, unknown>;
}

export function requireStructuredContent(value: unknown): Record<string, unknown> {
  const result = recordOf(value);
  if (typeof result.structuredContent === "object" && result.structuredContent !== null) {
    return result.structuredContent as Record<string, unknown>;
  }
  const message = Array.isArray(result.content)
    ? result.content
        .map((entry) =>
          typeof entry === "object" &&
          entry !== null &&
          (entry as Record<string, unknown>).type === "text" &&
          typeof (entry as Record<string, unknown>).text === "string"
            ? ((entry as Record<string, unknown>).text as string)
            : "",
        )
        .find((entry) => entry !== "")
    : undefined;
  throw new Error(
    message === undefined
      ? "MCP result has no structuredContent"
      : `MCP tool error: ${message.slice(0, 512)}`,
  );
}

function boundedDiagnostics(result: Record<string, unknown>): string {
  return Array.isArray(result.diagnostics)
    ? result.diagnostics
        .filter((entry): entry is string => typeof entry === "string")
        .slice(0, 2)
        .join(" | ")
        .slice(0, 512)
    : "";
}

export function assertLocalToolContract(
  tools: readonly LocalToolContract[],
): void {
  const names = tools.map((tool) => tool.name).sort();
  if (
    JSON.stringify(names) !==
    JSON.stringify(["external_delegate", "external_review"])
  ) {
    throw new Error(`Unexpected MCP tools: ${names.join(", ")}`);
  }
  for (const tool of tools) {
    if (!tool.inputSchema?.required?.includes("llm")) {
      throw new Error(`${tool.name} requires llm`);
    }
  }
  const review = tools.find((tool) => tool.name === "external_review");
  const delegate = tools.find((tool) => tool.name === "external_delegate");
  if (
    review?.annotations?.readOnlyHint !== true ||
    review.annotations.destructiveHint !== false
  ) {
    throw new Error("external_review annotations are unsafe");
  }
  if (
    delegate?.annotations?.readOnlyHint !== false ||
    delegate.annotations.destructiveHint !== true
  ) {
    throw new Error("external_delegate annotations are unsafe");
  }
}

export function assertCompletedReview(
  value: unknown,
  expectedModel: string,
): void {
  const result = recordOf(value);
  if (result.status !== "completed") {
    const diagnostics = boundedDiagnostics(result);
    throw new Error(
      `Review did not complete: ${String(result.status)}${diagnostics === "" ? "" : `; ${diagnostics}`}`,
    );
  }
  if (result.actualModel !== expectedModel) {
    throw new Error(
      `Review model mismatch: expected ${expectedModel}, got ${String(result.actualModel)}`,
    );
  }
  if (!Array.isArray(result.filesChanged) || result.filesChanged.length !== 0) {
    throw new Error("Review changed the workspace");
  }
  if (
    typeof result.review !== "string" ||
    !/(?:empty|zero|length|nan|division|空数组|空输入|零|长度|除零)/iu.test(
      result.review,
    )
  ) {
    throw new Error("Review did not identify the known defect");
  }
}


export function assertCompletedDelegate(
  value: unknown,
  expectedModel: string,
  actualContent: string,
  expectedContent: string,
  expectedFile: string,
): void {
  const result = recordOf(value);
  const filesChanged = Array.isArray(result.filesChanged)
    ? result.filesChanged.filter((entry): entry is string => typeof entry === "string")
    : [];
  const commandsRun = Array.isArray(result.commandsRun)
    ? result.commandsRun.filter((entry): entry is string => typeof entry === "string")
    : [];
  const checks = {
    status: result.status === "completed",
    actualModel: result.actualModel === expectedModel,
    content: actualContent.trim() === expectedContent,
    filesChanged:
      filesChanged.length === 1 &&
      filesChanged[0]!.replaceAll("\\", "/").endsWith(expectedFile),
    commandObserved: commandsRun.length > 0,
  };
  const failed = Object.entries(checks)
    .filter(([, passed]) => !passed)
    .map(([name]) => name);
  if (failed.length > 0) {
    const diagnostics = boundedDiagnostics(result);
    throw new Error(
      `Delegate acceptance failed: ${failed.join(", ")}${diagnostics === "" ? "" : `; ${diagnostics}`}`,
    );
  }
}
