import type {
  AdapterRunRequest,
  AdapterRunResult,
  ExternalAgentAdapter,
} from "../adapter.js";
import { buildChildEnvironment } from "../../runtime/environment.js";
import { runKimiAcp, type KimiAcpRunRequest } from "./client.js";
import { locateKimi } from "./locator.js";

export interface KimiAdapterDependencies {
  locateExecutable?: () => Promise<string>;
  runClient?: (request: KimiAcpRunRequest) => Promise<AdapterRunResult>;
}

export class KimiAdapter implements ExternalAgentAdapter {
  public readonly runtime = "kimi-acp" as const;
  readonly #locateExecutable: () => Promise<string>;
  readonly #runClient: (
    request: KimiAcpRunRequest,
  ) => Promise<AdapterRunResult>;

  public constructor(dependencies: KimiAdapterDependencies = {}) {
    this.#locateExecutable = dependencies.locateExecutable ?? locateKimi;
    this.#runClient = dependencies.runClient ?? runKimiAcp;
  }

  public async run(request: AdapterRunRequest): Promise<AdapterRunResult> {
    if (request.profile.runtime !== this.runtime) {
      throw new Error(
        `KimiAdapter cannot run runtime ${request.profile.runtime}`,
      );
    }
    const executable = await this.#locateExecutable();
    const childEnvironment = buildChildEnvironment(
      request.profile,
      request.parentEnvironment,
    );
    const secretValues = request.profile.credentialEnv
      .map((name) => request.parentEnvironment[name])
      .filter((value): value is string => value !== undefined && value !== "");
    const clientRequest: KimiAcpRunRequest = {
      executable,
      args: ["acp"],
      task: request.task,
      cwd: request.cwd,
      prompt: request.prompt,
      model: request.profile.model,
      environment: childEnvironment,
      secretValues,
    };
    if (request.timeoutMs !== undefined) {
      clientRequest.timeoutMs = request.timeoutMs;
    }
    if (request.signal !== undefined) clientRequest.signal = request.signal;
    if (request.sessionId !== undefined) {
      clientRequest.sessionId = request.sessionId;
    }
    if (request.onProgress !== undefined) {
      clientRequest.onProgress = request.onProgress;
    }
    return this.#runClient(clientRequest);
  }
}
