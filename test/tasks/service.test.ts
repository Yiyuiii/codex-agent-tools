import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  AdapterExecutionTelemetry,
  AdapterRunRequest,
  AdapterRunResult,
  ExternalAgentAdapter,
} from "../../src/adapters/adapter.js";
import type { LlmProfile, TaskKind } from "../../src/domain/types.js";
import { createLlmRegistry, resolveLlm } from "../../src/llms/registry.js";
import { KeyedLimiter } from "../../src/runtime/limiter.js";
import type { CommandObservation } from "../../src/tasks/command-observations.js";
import type { PiCommandLifecycleObservation } from "../../src/tasks/pi-command-lifecycle.js";
import { ExternalAgentService } from "../../src/tasks/service.js";

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(path.join(os.tmpdir(), "codex-agent-service-"));
  await execa("git", ["init"], { cwd });
  await execa("git", ["config", "user.email", "test@example.com"], { cwd });
  await execa("git", ["config", "user.name", "Test"], { cwd });
  await writeFile(path.join(cwd, "tracked.txt"), "original", "utf8");
  await execa("git", ["add", "tracked.txt"], { cwd });
  await execa("git", ["commit", "-m", "initial"], { cwd });
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

function enabledProfile(id = "kimi-k3", tasks: TaskKind[] = ["review", "delegate"]): LlmProfile {
  const original = resolveLlm(id);
  return {
    ...original,
    capabilities: {
      review: tasks.includes("review"),
      delegate: tasks.includes("delegate"),
    },
    qualityGates: {
      review: tasks.includes("review")
        ? { status: "passed", evidence: "test" }
        : { status: "pending" },
      delegate: tasks.includes("delegate")
        ? { status: "passed", evidence: "test" }
        : { status: "pending" },
    },
  };
}

function completed(overrides: Partial<AdapterRunResult> = {}): AdapterRunResult {
  return {
    status: "completed",
    text: "adapter result",
    actualModel: "kimi-code/k3",
    sessionId: "session-1",
    elapsedMs: 10,
    events: [],
    diagnostics: [],
    executionTelemetry: {
      adapterClientInvocationCount: 1,
      adapterRetryCount: 0,
      runtimeReportedAutoRetryCount: 0,
      adapterReportedFallbackUsed: false,
      source: "kimi-acp-observable",
    },
    ...overrides,
  };
}

function createService(
  run: (request: AdapterRunRequest) => Promise<AdapterRunResult>,
  profiles: LlmProfile[] = [enabledProfile()],
) {
  const adapter: ExternalAgentAdapter = { runtime: "kimi-acp", run };
  return new ExternalAgentService({
    registry: createLlmRegistry(profiles),
    adapters: new Map([["kimi-acp", adapter]]),
    parentEnvironment: { PATH: process.env.PATH },
  });
}

function createPiService(
  run: (request: AdapterRunRequest) => Promise<AdapterRunResult>,
) {
  const adapter: ExternalAgentAdapter = { runtime: "pi-rpc", run };
  return new ExternalAgentService({
    registry: createLlmRegistry([enabledProfile("ark-agent-plan")]),
    adapters: new Map([["pi-rpc", adapter]]),
    parentEnvironment: { PATH: process.env.PATH },
  });
}

describe("ExternalAgentService", () => {
  it.each(["review", "delegate"] as const)(
    "reports %s adapter telemetry only through the internal observer",
    async (task) => {
      const telemetry: AdapterExecutionTelemetry = {
        adapterClientInvocationCount: 1,
        adapterRetryCount: 0,
        runtimeReportedAutoRetryCount: 0,
        adapterReportedFallbackUsed: false,
        source: "kimi-acp-observable",
      };
      const observed: Array<AdapterExecutionTelemetry | null> = [];
      const service = createService(async () =>
        completed({ executionTelemetry: telemetry }),
      );

      const result =
        task === "review"
          ? await service.review(
              {
                llm: "kimi-k3",
                task: "review_diff",
                prompt: "Review",
                cwd,
              },
              { onExecutionTelemetry: (value) => observed.push(value) },
            )
          : await service.delegate(
              {
                llm: "kimi-k3",
                prompt: "Delegate",
                cwd,
              },
              { onExecutionTelemetry: (value) => observed.push(value) },
            );

      expect(observed).toEqual([telemetry]);
      expect(result).not.toHaveProperty("executionTelemetry");
      expect(JSON.stringify(result)).not.toContain("adapterClientInvocationCount");
    },
  );

  it.each(["review", "delegate"] as const)(
    "reports null telemetry when the %s adapter throws",
    async (task) => {
      const observed: Array<AdapterExecutionTelemetry | null> = [];
      const service = createService(async () => {
        throw new Error("adapter failed");
      });

      if (task === "review") {
        await service.review(
          {
            llm: "kimi-k3",
            task: "review_diff",
            prompt: "Review",
            cwd,
          },
          { onExecutionTelemetry: (value) => observed.push(value) },
        );
      } else {
        await service.delegate(
          { llm: "kimi-k3", prompt: "Delegate", cwd },
          { onExecutionTelemetry: (value) => observed.push(value) },
        );
      }

      expect(observed).toEqual([null]);
    },
  );

  it("shares one concurrency slot between logical LLMs in the same provider pool", async () => {
    const profiles = [
      enabledProfile("ark-agent-plan"),
      enabledProfile("ark-agent-deepseek-v4-flash"),
    ];
    let releaseFirst!: () => void;
    let signalFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      signalFirstStarted = resolve;
    });
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let active = 0;
    let maximumActive = 0;
    const run = vi.fn(async (request: AdapterRunRequest) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      if (run.mock.calls.length === 1) {
        signalFirstStarted();
        await firstGate;
      }
      active -= 1;
      return completed({ actualModel: request.profile.model });
    });
    const service = new ExternalAgentService({
      registry: createLlmRegistry(profiles),
      adapters: new Map([["pi-rpc", { runtime: "pi-rpc", run }]]),
    });

    const first = service.delegate({
      llm: "ark-agent-plan",
      prompt: "first",
      cwd,
    });
    await firstStarted;
    const second = service.delegate({
      llm: "ark-agent-deepseek-v4-flash",
      prompt: "second",
      cwd,
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(run).toHaveBeenCalledTimes(1);
    releaseFirst();
    await Promise.all([first, second]);
    expect(run).toHaveBeenCalledTimes(2);
    expect(maximumActive).toBe(1);
  });

  it("uses independent limiter keys for Coding Plan and Agent Plan", async () => {
    const profiles = [
      enabledProfile("ark-coding-plan"),
      enabledProfile("ark-agent-plan"),
    ];
    const limiter = new KeyedLimiter(() => 1);
    const limiterRun = vi.spyOn(limiter, "run");
    const run = vi.fn(async (request: AdapterRunRequest) => {
      return completed({ actualModel: request.profile.model });
    });
    const service = new ExternalAgentService({
      registry: createLlmRegistry(profiles),
      adapters: new Map([["pi-rpc", { runtime: "pi-rpc", run }]]),
      limiter,
    });

    await Promise.all([
      service.delegate({
        llm: "ark-coding-plan",
        prompt: "coding",
        cwd,
      }),
      service.delegate({
        llm: "ark-agent-plan",
        prompt: "agent",
        cwd,
      }),
    ]);

    expect(run).toHaveBeenCalledTimes(2);
    expect(
      run.mock.calls.map(([request]) => request.profile.id).sort(),
    ).toEqual(["ark-agent-plan", "ark-coding-plan"]);
    expect(limiterRun.mock.calls.map(([key]) => key).sort()).toEqual([
      "ark-agent-plan",
      "ark-coding-plan",
    ]);
  });

  it("rejects retired Gemini before starting any adapter", async () => {
    const kimiRun = vi.fn(async () => completed());
    const piRun = vi.fn(async () =>
      completed({ actualModel: "deepseek-v4-flash" }),
    );
    const service = new ExternalAgentService({
      registry: createLlmRegistry([
        enabledProfile(),
        enabledProfile("ark-agent-deepseek-v4-flash"),
        enabledProfile("ark-agent-plan"),
        enabledProfile("ark-coding-plan"),
      ]),
      adapters: new Map([
        ["kimi-acp", { runtime: "kimi-acp", run: kimiRun }],
        ["pi-rpc", { runtime: "pi-rpc", run: piRun }],
      ]),
    });

    await expect(
      service.review({
        llm: "gemini-3.5-flash",
        task: "review_doc",
        prompt: "Review",
        cwd,
      }),
    ).rejects.toThrow(
      /Unknown logical llm.*ark-agent-deepseek-v4-flash, ark-agent-plan, ark-coding-plan, kimi-k3/u,
    );
    expect(kimiRun).not.toHaveBeenCalled();
    expect(piRun).not.toHaveBeenCalled();
  });

  it("routes active Ark Pi and Kimi profiles only to their bound runtime adapters", async () => {
    const kimiRun = vi.fn(async () => completed());
    const piRun = vi.fn(async () =>
      completed({ actualModel: "deepseek-v4-flash" }),
    );
    const piProfile: LlmProfile = {
      ...enabledProfile("ark-agent-deepseek-v4-flash"),
    };
    const service = new ExternalAgentService({
      registry: createLlmRegistry([enabledProfile(), piProfile]),
      adapters: new Map([
        ["kimi-acp", { runtime: "kimi-acp", run: kimiRun }],
        ["pi-rpc", { runtime: "pi-rpc", run: piRun }],
      ]),
      parentEnvironment: { PATH: process.env.PATH },
    });

    await service.delegate({
      llm: "ark-agent-deepseek-v4-flash",
      prompt: "Use Pi",
      cwd,
    });
    expect(piRun).toHaveBeenCalledOnce();
    expect(kimiRun).not.toHaveBeenCalled();
  });

  it("reports Pi command lifecycle observations once without exposing them publicly", async () => {
    const reports: Array<readonly PiCommandLifecycleObservation[]> = [];
    const commandReports: Array<readonly CommandObservation[]> = [];
    const service = createPiService(async () =>
      completed({
        actualModel: "ark-code-latest",
        events: [
          {
            runtime: "pi-rpc",
            type: "tool_call",
            toolCallId: "write-1",
            kind: "execute",
            title: "Write result",
            rawInput: { command: "node -e write" },
          },
          {
            runtime: "pi-rpc",
            type: "tool_result",
            toolCallId: "write-1",
            title: "Write result",
            isError: true,
          },
        ],
      }),
    );

    const result = await service.delegate(
      { llm: "ark-agent-plan", prompt: "Run", cwd },
      {
        onCommandObservations: (value) => commandReports.push(value),
        onPiCommandLifecycleObservations: (value) => reports.push(value),
      },
    );

    expect(reports).toEqual([
      [
        {
          source: "raw_input",
          command: "node -e write",
          origin: "raw_input",
          outcome: "error",
        },
      ],
    ]);
    expect(commandReports).toEqual([
      [
        {
          source: "raw_input",
          command: "node -e write",
          origin: "raw_input",
        },
      ],
    ]);
    expect(result.commandsRun).toEqual(["node -e write"]);
    expect(result).not.toHaveProperty("piCommandLifecycleObservations");
    expect(JSON.stringify(result)).not.toContain(
      "piCommandLifecycleObservations",
    );
  });

  it("reports one empty Pi command lifecycle batch when the adapter throws", async () => {
    const reports: Array<readonly PiCommandLifecycleObservation[]> = [];
    const service = createPiService(async () => {
      throw new Error("adapter failed");
    });

    const result = await service.delegate(
      { llm: "ark-agent-plan", prompt: "Run", cwd },
      {
        onPiCommandLifecycleObservations: (value) => reports.push(value),
      },
    );

    expect(reports).toEqual([[]]);
    expect(result.diagnostics).toEqual(["adapter failed"]);
  });

  it("reports one empty Pi command lifecycle batch for zero events", async () => {
    const reports: Array<readonly PiCommandLifecycleObservation[]> = [];
    const service = createPiService(async () => completed({ events: [] }));

    await service.delegate(
      { llm: "ark-agent-plan", prompt: "Run", cwd },
      {
        onPiCommandLifecycleObservations: (value) => reports.push(value),
      },
    );

    expect(reports).toEqual([[]]);
  });

  it("never reports Pi command lifecycle observations for a Kimi delegate", async () => {
    const observer = vi.fn();
    const service = createService(async () =>
      completed({
        events: [
          {
            runtime: "pi-rpc",
            type: "tool_call",
            toolCallId: "lookalike",
            kind: "execute",
            title: "Run",
            rawInput: { command: "npm test" },
          },
        ],
      }),
    );

    await service.delegate(
      { llm: "kimi-k3", prompt: "Run", cwd },
      { onPiCommandLifecycleObservations: observer },
    );

    expect(observer).not.toHaveBeenCalled();
  });

  it("freezes the Pi command lifecycle observation array and items", async () => {
    let observed: readonly PiCommandLifecycleObservation[] = [];
    const service = createPiService(async () =>
      completed({
        events: [
          {
            runtime: "pi-rpc",
            type: "tool_call",
            toolCallId: "freeze-1",
            kind: "execute",
            title: "Run",
            rawInput: { command: "npm test" },
          },
        ],
      }),
    );

    await service.delegate(
      { llm: "ark-agent-plan", prompt: "Run", cwd },
      {
        onPiCommandLifecycleObservations: (value) => {
          observed = value;
        },
      },
    );

    expect(Object.isFrozen(observed)).toBe(true);
    expect(Object.isFrozen(observed[0])).toBe(true);
  });

  it("isolates a throwing Pi command lifecycle callback with one fixed diagnostic", async () => {
    const commandObserver = vi.fn();
    const service = createPiService(async () =>
      completed({
        events: [
          {
            runtime: "pi-rpc",
            type: "tool_call",
            toolCallId: "callback-1",
            kind: "execute",
            title: "Run",
            rawInput: { command: "npm test" },
          },
        ],
      }),
    );

    const result = await service.delegate(
      { llm: "ark-agent-plan", prompt: "Run", cwd },
      {
        onCommandObservations: commandObserver,
        onPiCommandLifecycleObservations: () => {
          throw new Error("SENSITIVE lifecycle detail: npm test");
        },
      },
    );

    expect(commandObserver).toHaveBeenCalledOnce();
    expect(result.commandsRun).toEqual(["npm test"]);
    expect(result.diagnostics).toEqual([
      "Internal Pi command lifecycle callback failed",
    ]);
    expect(result.diagnostics.join("\n")).not.toContain("SENSITIVE");
    expect(result.diagnostics.join("\n")).not.toContain("npm test");
  });

  it("keeps the existing command policy beside Pi command lifecycle reporting", async () => {
    const commandReports: Array<readonly CommandObservation[]> = [];
    const lifecycleReports: Array<
      readonly PiCommandLifecycleObservation[]
    > = [];
    const service = createPiService(async () =>
      completed({
        events: [
          {
            runtime: "pi-rpc",
            type: "tool_call",
            toolCallId: "title-only",
            kind: "execute",
            title: "git status --short",
          },
        ],
      }),
    );

    const result = await service.delegate(
      { llm: "ark-agent-plan", prompt: "Run", cwd },
      {
        commandObservationPolicy: "raw_only",
        onCommandObservations: (value) => commandReports.push(value),
        onPiCommandLifecycleObservations: (value) =>
          lifecycleReports.push(value),
      },
    );

    expect(commandReports).toEqual([
      [
        {
          source: "title_fallback",
          command: "git status --short",
          origin: "title",
        },
      ],
    ]);
    expect(lifecycleReports).toEqual([
      [
        {
          source: "title_fallback",
          command: "git status --short",
          origin: "title",
          outcome: "missing",
        },
      ],
    ]);
    expect(result.commandsRun).toEqual([]);
  });

  it("fails review when Pi reports a disallowed writable tool event", async () => {
    const piProfile: LlmProfile = {
      ...enabledProfile("ark-agent-deepseek-v4-flash"),
    };
    const adapter: ExternalAgentAdapter = {
      runtime: "pi-rpc",
      run: async () =>
        completed({
          actualModel: "deepseek-v4-flash",
          events: [
            {
              type: "tool_call",
              runtime: "pi-rpc",
              kind: "execute",
              title: "bash",
              rawInput: { command: "git status" },
            },
          ],
        }),
    };
    const service = new ExternalAgentService({
      registry: createLlmRegistry([piProfile]),
      adapters: new Map([["pi-rpc", adapter]]),
    });
    const result = await service.review({
      llm: "ark-agent-deepseek-v4-flash",
      task: "review_diff",
      prompt: "Review",
      cwd,
    });
    expect(result.status).toBe("failed");
    expect(result.diagnostics.join("\n")).toContain("review_policy_violation");
  });

  it("fails review when the adapter mutates the workspace", async () => {
    const service = createService(async () => {
      await writeFile(path.join(cwd, "tracked.txt"), "changed", "utf8");
      return completed();
    });
    const result = await service.review({
      llm: "kimi-k3",
      task: "review_diff",
      prompt: "Review",
      cwd,
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe("workspace_changed");
    expect(result.filesChanged).toEqual(["tracked.txt"]);
  });

  it("uses actual workspace changes when delegate model evidence is empty", async () => {
    const service = createService(async () => {
      await writeFile(path.join(cwd, "new.txt"), "created", "utf8");
      return completed({ text: "I changed nothing", events: [] });
    });
    const result = await service.delegate({
      llm: "kimi-k3",
      prompt: "Create new.txt",
      cwd,
    });

    expect(result.ok).toBe(true);
    expect(result.filesChanged).toEqual(["new.txt"]);
    expect(result.summary).toBe("I changed nothing");
  });

  it("derives commands from protocol tool events instead of model prose", async () => {
    const service = createService(async () =>
      completed({
        text: "Model prose mentions pnpm lint.",
        events: [
          {
            type: "tool_call",
            toolCallId: "call-1",
            kind: "execute",
            title: "Run tests",
            rawInput: { command: "npm test" },
          },
        ],
      }),
    );
    const result = await service.delegate({
      llm: "kimi-k3",
      prompt: "Test",
      cwd,
    });
    expect(result.commandsRun).toEqual(["npm test"]);
    expect(result.commandsRun).not.toContain("pnpm lint");
  });

  it("reports a late-update command observation once without exposing it publicly", async () => {
    const observed: Array<readonly CommandObservation[]> = [];
    const service = createService(async () =>
      completed({
        events: [
          {
            type: "tool_call",
            toolCallId: "call-1",
            kind: "execute",
            title: "Run",
          },
          {
            type: "tool_call_update",
            toolCallId: "call-1",
            rawInput: { command: "git status --short" },
          },
        ],
      }),
    );

    const result = await service.delegate(
      {
        llm: "kimi-k3",
        prompt: "Run",
        cwd,
      },
      { onCommandObservations: (value) => observed.push(value) },
    );

    expect(observed).toEqual([
      [
        {
          source: "late_update",
          command: "git status --short",
          origin: "raw_input",
        },
      ],
    ]);
    expect(result.commandsRun).toEqual(["git status --short"]);
    expect(result).not.toHaveProperty("commandObservations");
    expect(JSON.stringify(result)).not.toContain("commandObservations");
  });

  it("keeps title fallback commands for ordinary delegate callers", async () => {
    const service = createService(async () =>
      completed({
        events: [
          {
            type: "tool_call",
            toolCallId: "ordinary-title",
            kind: "execute",
            title: "git status --short",
          },
        ],
      }),
    );

    const result = await service.delegate({
      llm: "kimi-k3",
      prompt: "Run",
      cwd,
    });

    expect(result.commandsRun).toEqual(["git status --short"]);
  });

  it.each([
    {
      name: "an initial exact title",
      events: [
        {
          type: "tool_call",
          toolCallId: "initial-title",
          kind: "execute",
          title: "git status --short",
        },
      ],
    },
    {
      name: "a late exact title",
      events: [
        {
          type: "tool_call",
          toolCallId: "late-title",
          kind: "execute",
          title: "Run",
        },
        {
          type: "tool_call_update",
          toolCallId: "late-title",
          title: "git status --short",
        },
      ],
    },
    {
      name: "a late execute kind with an initial exact title",
      events: [
        {
          type: "tool_call",
          toolCallId: "late-kind",
          kind: null,
          title: "git status --short",
        },
        {
          type: "tool_call_update",
          toolCallId: "late-kind",
          kind: "execute",
        },
      ],
    },
  ])("excludes $name for a raw-only internal caller", async ({ events }) => {
    const service = createService(async () => completed({ events }));

    const result = await service.delegate(
      {
        llm: "kimi-k3",
        prompt: "Run",
        cwd,
      },
      { commandObservationPolicy: "raw_only" },
    );

    expect(result.commandsRun).toEqual([]);
  });

  it.each([
    {
      name: "an initial raw command",
      events: [
        {
          type: "tool_call",
          toolCallId: "initial-raw",
          kind: "execute",
          title: "Run",
          rawInput: { command: "git status --short" },
        },
      ],
    },
    {
      name: "a late raw command",
      events: [
        {
          type: "tool_call",
          toolCallId: "late-raw",
          kind: "execute",
          title: "Run",
        },
        {
          type: "tool_call_update",
          toolCallId: "late-raw",
          rawInput: { command: "git status --short" },
        },
      ],
    },
  ])("keeps $name for a raw-only internal caller", async ({ events }) => {
    const service = createService(async () => completed({ events }));

    const result = await service.delegate(
      {
        llm: "kimi-k3",
        prompt: "Run",
        cwd,
      },
      { commandObservationPolicy: "raw_only" },
    );

    expect(result.commandsRun).toEqual(["git status --short"]);
  });

  it("reports one empty command observation batch when delegate emits no execute events", async () => {
    const observed: Array<readonly CommandObservation[]> = [];
    const service = createService(async () =>
      completed({
        events: [{ type: "message", text: "No tools needed" }],
      }),
    );

    const result = await service.delegate(
      {
        llm: "kimi-k3",
        prompt: "Run",
        cwd,
      },
      { onCommandObservations: (value) => observed.push(value) },
    );

    expect(observed).toEqual([[]]);
    expect(result.commandsRun).toEqual([]);
  });

  it("reports one empty command observation batch when the delegate adapter throws", async () => {
    const observed: Array<readonly CommandObservation[]> = [];
    const service = createService(async () => {
      throw new Error("adapter failed");
    });

    const result = await service.delegate(
      {
        llm: "kimi-k3",
        prompt: "Run",
        cwd,
      },
      { onCommandObservations: (value) => observed.push(value) },
    );

    expect(observed).toEqual([[]]);
    expect(result.ok).toBe(false);
    expect(result.status).toBe("failed");
    expect(result.diagnostics).toEqual(["adapter failed"]);
    expect(result.commandsRun).toEqual([]);
  });

  it("prevents command observation callback mutation from spoofing commandsRun", async () => {
    let observed: readonly CommandObservation[] = [];
    const service = createService(async () =>
      completed({
        events: [
          {
            type: "tool_call",
            toolCallId: "call-1",
            kind: "execute",
            rawInput: { command: "npm test" },
          },
        ],
      }),
    );

    const result = await service.delegate(
      {
        llm: "kimi-k3",
        prompt: "Run",
        cwd,
      },
      {
        onCommandObservations: (value) => {
          observed = value;
          const first = value[0];
          if (first === undefined) throw new Error("missing observation");
          (first as { command: string | null }).command =
            "git status --short";
        },
      },
    );

    expect(Object.isFrozen(observed)).toBe(true);
    expect(Object.isFrozen(observed[0])).toBe(true);
    expect(result.commandsRun).toEqual(["npm test"]);
    expect(result.commandsRun).not.toContain("git status --short");
    expect(result.diagnostics).toContain(
      "Internal command observation callback failed",
    );
  });

  it("isolates throwing command observation callback from delegate completion", async () => {
    const telemetryObserver = vi.fn();
    const service = createService(async () => {
      await writeFile(path.join(cwd, "callback-output.txt"), "created", "utf8");
      return completed({
        events: [
          {
            type: "tool_call",
            toolCallId: "call-1",
            kind: "execute",
            rawInput: { command: "npm test" },
          },
        ],
      });
    });

    const result = await service.delegate(
      {
        llm: "kimi-k3",
        prompt: "Run",
        cwd,
      },
      {
        onCommandObservations: () => {
          throw new Error(
            "SENSITIVE callback detail: git status --short",
          );
        },
        onExecutionTelemetry: telemetryObserver,
      },
    );

    expect(telemetryObserver).toHaveBeenCalledOnce();
    expect(result.ok).toBe(true);
    expect(result.status).toBe("completed");
    expect(result.filesChanged).toEqual(["callback-output.txt"]);
    expect(result.commandsRun).toEqual(["npm test"]);
    expect(result.diagnostics).toEqual([
      "Internal command observation callback failed",
    ]);
    expect(result.diagnostics.join("\n")).not.toContain("SENSITIVE");
    expect(result.diagnostics.join("\n")).not.toContain("npm test");
    expect(result.diagnostics.join("\n")).not.toContain("git status");
  });

  it("isolates throwing execution telemetry callback from delegate completion", async () => {
    const commandObserver = vi.fn();
    const service = createService(async () => {
      await writeFile(path.join(cwd, "telemetry-output.txt"), "created", "utf8");
      return completed({
        events: [
          {
            type: "tool_call",
            toolCallId: "call-1",
            kind: "execute",
            rawInput: { command: "npm test" },
          },
        ],
      });
    });

    const result = await service.delegate(
      {
        llm: "kimi-k3",
        prompt: "Run",
        cwd,
      },
      {
        onCommandObservations: commandObserver,
        onExecutionTelemetry: () => {
          throw new Error("SENSITIVE telemetry detail: npm test");
        },
      },
    );

    expect(commandObserver).toHaveBeenCalledOnce();
    expect(result.ok).toBe(true);
    expect(result.status).toBe("completed");
    expect(result.filesChanged).toEqual(["telemetry-output.txt"]);
    expect(result.commandsRun).toEqual(["npm test"]);
    expect(result.diagnostics).toEqual([
      "Internal execution telemetry callback failed",
    ]);
    expect(result.diagnostics.join("\n")).not.toContain("SENSITIVE");
    expect(result.diagnostics.join("\n")).not.toContain("npm test");
  });

  it("isolates throwing execution telemetry callback from review completion", async () => {
    const commandObserver = vi.fn();
    const service = createService(async () => {
      await writeFile(path.join(cwd, "review-output.txt"), "created", "utf8");
      return completed();
    });

    const result = await service.review(
      {
        llm: "kimi-k3",
        task: "review_diff",
        prompt: "Review",
        cwd,
      },
      {
        onCommandObservations: commandObserver,
        onExecutionTelemetry: () => {
          throw new Error("SENSITIVE telemetry detail");
        },
      },
    );

    expect(commandObserver).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.status).toBe("workspace_changed");
    expect(result.filesChanged).toEqual(["review-output.txt"]);
    expect(result.diagnostics).toEqual([
      "Internal execution telemetry callback failed",
    ]);
    expect(result.diagnostics.join("\n")).not.toContain("SENSITIVE");
  });

  it.each([
    ["cancelled", "cancelled"],
    ["timed_out", "timed_out"],
  ] as const)("preserves adapter status %s", async (adapterStatus, expected) => {
    const service = createService(async () => completed({ status: adapterStatus }));
    const result = await service.delegate({
      llm: "kimi-k3",
      prompt: "Run",
      cwd,
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(expected);
  });

  it("does not retry a delegate after the adapter starts and throws", async () => {
    const run = vi.fn(async () => {
      await writeFile(path.join(cwd, "partial.txt"), "partial", "utf8");
      throw new Error("adapter failed after write");
    });
    const service = createService(run);
    const result = await service.delegate({
      llm: "kimi-k3",
      prompt: "Run once",
      cwd,
    });
    expect(run).toHaveBeenCalledOnce();
    expect(result.status).toBe("failed");
    expect(result.filesChanged).toEqual(["partial.txt"]);
  });

  it("builds a review packet with caller context, criteria, and Git evidence", async () => {
    await writeFile(path.join(cwd, "tracked.txt"), "working change", "utf8");
    let receivedPrompt = "";
    const service = createService(async (request) => {
      receivedPrompt = request.prompt;
      return completed();
    });
    const result = await service.review({
      llm: "kimi-k3",
      task: "adversarial_review",
      prompt: "Challenge the design",
      cwd,
      context: "Windows lifecycle",
      acceptanceCriteria: ["No orphan process"],
      includeGitDiff: true,
    });
    expect(result.status).toBe("completed");
    expect(receivedPrompt).toContain("Challenge the design");
    expect(receivedPrompt).toContain("Windows lifecycle");
    expect(receivedPrompt).toContain("No orphan process");
    expect(receivedPrompt).toContain("working change");
  });
});
