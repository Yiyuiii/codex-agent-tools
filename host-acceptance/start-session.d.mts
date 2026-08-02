export const HOST_ACCEPTANCE_PLUGIN_PATHS: readonly string[];

export interface HostAcceptanceSessionPlan {
  readonly nonce: string;
  readonly completionMarkerId: string;
  readonly completionMarkerPath: string;
  readonly descriptorBytes: Buffer;
  readonly descriptorPath: string;
  readonly sessionRoot: string;
  readonly delegateWorkspace: string;
  readonly installedPluginRoot: string;
  readonly receiptPath: string;
  readonly observerPath: string;
  readonly request: Readonly<{
    llm: "kimi-k3";
    prompt: string;
    cwd: string;
    timeoutMs: null;
    sessionId: null;
  }>;
}

export function buildHostAcceptanceSession(input: any): HostAcceptanceSessionPlan;

export function buildNpmViewInvocation(
  nodeExecutable: string,
  version: string,
): Readonly<{
  command: string;
  npmCliPath: string;
  args: readonly string[];
}>;

export function prepareHostAcceptanceDirectories(
  plan: HostAcceptanceSessionPlan,
): Promise<void>;

export function consumeObserverLifecycle(input: Readonly<{
  lines: AsyncIterable<string>;
  exitCode: Promise<number>;
  publishDescriptor(): Promise<unknown>;
  removeDescriptor(): Promise<unknown>;
  announce(message: string, phase?: string): unknown;
}>): Promise<void>;
