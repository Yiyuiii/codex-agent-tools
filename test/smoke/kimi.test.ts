import { createHash } from "node:crypto";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type {
  AdapterExecutionTelemetry,
  ExternalAgentAdapter,
} from "../../src/adapters/adapter.js";
import { createLlmRegistry, resolveLlm } from "../../src/llms/registry.js";
import {
  parseKimiSmokeArguments,
  runKimiSmoke,
  type KimiSmokeService,
} from "../../src/smoke/kimi.js";
import { SmokeInfrastructureError } from "../../src/smoke/evidence.js";
import { ExternalAgentService } from "../../src/tasks/service.js";

const roots: string[] = [];

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function tempRoot(): Promise<string> {
  const root = path.join(
    os.tmpdir(),
    `codex-agent-tools-smoke-test-${process.pid}-${Date.now()}-${roots.length}`,
  );
  await mkdir(root, { recursive: true });
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const validKimiTelemetry: AdapterExecutionTelemetry = {
  adapterClientInvocationCount: 1,
  adapterRetryCount: 0,
  runtimeReportedAutoRetryCount: 0,
  adapterReportedFallbackUsed: false,
  source: "kimi-acp-observable",
};

const qualificationContext = {
  qualificationPlanId: "four-llm-v1" as const,
  batchId: "2026-07-26T12-00-00Z-a1b2c3d4",
  ordinal: 4,
  llm: "kimi-k3",
  task: "delegate" as const,
  frozenCommit: "a".repeat(40),
  frozenBuildIdentity: "b".repeat(64),
  authorizationReferenceSha256: "c".repeat(64),
  orchestratorFallbackUsed: false as const,
};

describe("Kimi real-smoke harness", () => {
  it("requires an explicit supported llm and one task", () => {
    expect(
      parseKimiSmokeArguments(["--llm", "kimi-k3", "--task", "review"]),
    ).toEqual({ llm: "kimi-k3", task: "review" });
    expect(() => parseKimiSmokeArguments(["--task", "review"])).toThrow(
      /--llm/u,
    );
    expect(() =>
      parseKimiSmokeArguments(["--llm", "kimi-k3", "--task", "other"]),
    ).toThrow(/--task/u);
    expect(() =>
      parseKimiSmokeArguments([
        "--llm",
        "ark-coding-plan",
        "--task",
        "review",
      ]),
    ).toThrow(/Kimi ACP profile/u);
  });

  it.each([
    ["review", "an omitted", undefined],
    ["delegate", "an omitted", undefined],
    ["review", "an explicit", 1_800_000],
    ["delegate", "an explicit", 1_800_000],
  ] as const)(
    "forwards %s service input with %s per-run timeout",
    async (task, _timeoutKind, timeoutMs) => {
      const root = await tempRoot();
      let capturedInput: unknown;
      const service: KimiSmokeService = {
        review: async (input) => {
          capturedInput = input;
          throw new Error("captured review input");
        },
        delegate: async (input) => {
          capturedInput = input;
          throw new Error("captured delegate input");
        },
      };
      const options = {
        llm: "kimi-k3",
        task,
        tempRoot: root,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      };

      await expect(
        runKimiSmoke(options, {
          service,
          readKimiVersion: async () => "0.27.0",
          listKimiProcessIds: async () => [100],
        }),
      ).rejects.toBeInstanceOf(SmokeInfrastructureError);

      if (timeoutMs === undefined) {
        expect(capturedInput).not.toHaveProperty("timeoutMs");
      } else {
        expect(capturedInput).toHaveProperty("timeoutMs", timeoutMs);
      }
    },
  );

  it("rejects a qualification identity for a different active case", async () => {
    await expect(
      runKimiSmoke({
        llm: "kimi-k3",
        task: "delegate",
        qualificationContext: {
          ...qualificationContext,
          ordinal: 3,
          task: "review",
        },
      }),
    ).rejects.toThrow("Smoke qualification identity mismatch");
  });

  it("validates a read-only review against the known empty-array defect", async () => {
    const root = await tempRoot();
    const secretCommand = "echo secret-review-command";
    const service: KimiSmokeService = {
      review: async (_input, context) => {
        context?.onExecutionTelemetry?.(validKimiTelemetry);
        context?.onCommandObservations?.([
          {
            source: "raw_input",
            command: secretCommand,
            origin: "raw_input",
          },
        ]);
        return {
          ok: true,
          status: "completed",
          llm: "kimi-k3",
          actualModel: "kimi-code/k3",
          elapsedMs: 12,
          diagnostics: [],
          filesChanged: [],
          review: "The empty array has length zero, so division returns NaN.",
        };
      },
      delegate: async () => {
        throw new Error("not used");
      },
    };

    const evidence = await runKimiSmoke(
      { llm: "kimi-k3", task: "review", tempRoot: root },
      {
        service,
        readKimiVersion: async () => "0.27.0",
        listKimiProcessIds: async () => [100],
        now: () => new Date("2026-07-18T00:00:00.000Z"),
      },
    );

    expect(evidence).toMatchObject({
      schemaVersion: 2,
      qualification: null,
      llm: "kimi-k3",
      task: "review",
      actualModel: "kimi-code/k3",
      route: "direct",
      kimiVersion: "0.27.0",
      status: "completed",
      passed: true,
      failureReason: null,
      adapterClientInvocationCount: 1,
      adapterRetryCount: 0,
      runtimeReportedAutoRetryCount: 0,
      adapterReportedFallbackUsed: false,
      executionTelemetrySource: "kimi-acp-observable",
      checks: {
        workspaceUnchanged: true,
        knownDefectFound: true,
        noNewKimiProcesses: true,
      },
    });
    expect(evidence.outputSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(evidence).not.toHaveProperty("commandObservations");
    expect(evidence).not.toHaveProperty("writeCommandObservations");
    expect(JSON.stringify(evidence)).not.toContain(secretCommand);
    expect(await readdir(root)).toEqual([]);
  });

  it("validates delegate output, filesystem evidence, and a command event", async () => {
    const root = await tempRoot();
    const observedCommand = "git status --short";
    const service: KimiSmokeService = {
      review: async () => {
        throw new Error("not used");
      },
      delegate: async (input, context) => {
        context?.onExecutionTelemetry?.(validKimiTelemetry);
        context?.onCommandObservations?.([
          {
            source: "late_update",
            command: observedCommand,
            origin: "raw_input",
          },
        ]);
        await writeFile(path.join(input.cwd, "result.txt"), "KIMI_SMOKE_OK\n", "utf8");
        return {
          ok: true,
          status: "completed",
          llm: "kimi-k3",
          actualModel: "kimi-code/k3",
          elapsedMs: 15,
          diagnostics: [],
          filesChanged: ["result.txt"],
          summary: "Created and verified result.txt.",
          commandsRun: ["git status --short"],
          verification: [],
          risks: [],
        };
      },
    };

    const evidence = await runKimiSmoke(
      {
        llm: "kimi-k3",
        task: "delegate",
        tempRoot: root,
        qualificationContext,
      },
      {
        service,
        readKimiVersion: async () => "0.27.0",
        listKimiProcessIds: async () => [100],
      },
    );

    expect(evidence).toMatchObject({
      schemaVersion: 3,
      qualification: qualificationContext,
      passed: true,
      adapterClientInvocationCount: 1,
      adapterRetryCount: 0,
      runtimeReportedAutoRetryCount: 0,
      adapterReportedFallbackUsed: false,
      orchestratorFallbackUsed: false,
      executionTelemetrySource: "kimi-acp-observable",
      resultFileReadStatus: "read",
      resultFileByteLength: Buffer.byteLength("KIMI_SMOKE_OK\n"),
      resultFileRawSha256: sha256("KIMI_SMOKE_OK\n"),
      resultFileNormalizedSha256: sha256("KIMI_SMOKE_OK"),
      expectedResultNormalizedSha256: sha256("KIMI_SMOKE_OK"),
      resultFileNormalizedLineCount: 1,
      resultFileContainsExpectedLine: true,
      checks: {
        resultFileValid: true,
        resultFileObserved: true,
        requiredCommandObserved: true,
        noNewKimiProcesses: true,
      },
      filesChanged: ["result.txt"],
      commandCount: 1,
      commandObservations: [{ source: "late_update", match: "exact" }],
    });
    expect(evidence).not.toHaveProperty("writeCommandObservations");
    expect(JSON.stringify(evidence)).not.toContain(observedCommand);
    expect(await readdir(root)).toEqual([]);
  });

  it("fails closed when delegate command observations are not reported", async () => {
    const root = await tempRoot();
    const secret = "KIMI_MISSING_OBSERVATION_SECRET";
    const service: KimiSmokeService = {
      review: async () => {
        throw new Error("not used");
      },
      delegate: async (input, context) => {
        context?.onExecutionTelemetry?.(validKimiTelemetry);
        await writeFile(
          path.join(input.cwd, "result.txt"),
          "KIMI_SMOKE_OK\n",
          "utf8",
        );
        return {
          ok: true,
          status: "completed",
          llm: "kimi-k3",
          actualModel: "kimi-code/k3",
          elapsedMs: 15,
          diagnostics: [],
          filesChanged: ["result.txt"],
          summary: secret,
          commandsRun: ["git status --short"],
          verification: [],
          risks: [],
        };
      },
    };

    const failure = await runKimiSmoke(
      { llm: "kimi-k3", task: "delegate", tempRoot: root },
      {
        service,
        readKimiVersion: async () => "0.27.0",
        listKimiProcessIds: async () => [100],
      },
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(SmokeInfrastructureError);
    expect(failure).toMatchObject({
      message: "Smoke infrastructure failure",
      stage: "task_execution",
    });
    expect(String(failure)).not.toContain(secret);
    expect(await readdir(root)).toEqual([]);
  });

  it("accepts exactly one empty command observation report", async () => {
    const root = await tempRoot();
    const service: KimiSmokeService = {
      review: async () => {
        throw new Error("not used");
      },
      delegate: async (input, context) => {
        context?.onExecutionTelemetry?.(validKimiTelemetry);
        context?.onCommandObservations?.([]);
        await writeFile(
          path.join(input.cwd, "result.txt"),
          "KIMI_SMOKE_OK\n",
          "utf8",
        );
        return {
          ok: true,
          status: "completed",
          llm: "kimi-k3",
          actualModel: "kimi-code/k3",
          elapsedMs: 15,
          diagnostics: [],
          filesChanged: ["result.txt"],
          summary: "Created result.txt without a command event.",
          commandsRun: [],
          verification: [],
          risks: [],
        };
      },
    };

    const evidence = await runKimiSmoke(
      { llm: "kimi-k3", task: "delegate", tempRoot: root },
      {
        service,
        readKimiVersion: async () => "0.27.0",
        listKimiProcessIds: async () => [100],
      },
    );

    expect(evidence).toMatchObject({
      passed: false,
      failureReason: "acceptance_failed",
      commandObservations: [],
      checks: {
        requiredCommandObserved: false,
      },
    });
    expect(await readdir(root)).toEqual([]);
  });

  it("fails closed when delegate command observations are reported twice", async () => {
    const root = await tempRoot();
    const secretCommand = "echo repeated-observation-secret";
    const service: KimiSmokeService = {
      review: async () => {
        throw new Error("not used");
      },
      delegate: async (input, context) => {
        context?.onExecutionTelemetry?.(validKimiTelemetry);
        context?.onCommandObservations?.([
          {
            source: "late_update",
            command: "git status --short",
            origin: "raw_input",
          },
        ]);
        context?.onCommandObservations?.([
          {
            source: "raw_input",
            command: secretCommand,
            origin: "raw_input",
          },
        ]);
        await writeFile(
          path.join(input.cwd, "result.txt"),
          "KIMI_SMOKE_OK\n",
          "utf8",
        );
        return {
          ok: true,
          status: "completed",
          llm: "kimi-k3",
          actualModel: "kimi-code/k3",
          elapsedMs: 15,
          diagnostics: [],
          filesChanged: ["result.txt"],
          summary: "Created and verified result.txt.",
          commandsRun: ["git status --short"],
          verification: [],
          risks: [],
        };
      },
    };

    const failure = await runKimiSmoke(
      { llm: "kimi-k3", task: "delegate", tempRoot: root },
      {
        service,
        readKimiVersion: async () => "0.27.0",
        listKimiProcessIds: async () => [100],
      },
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(SmokeInfrastructureError);
    expect(failure).toMatchObject({
      message: "Smoke infrastructure failure",
      stage: "task_execution",
    });
    expect(String(failure)).not.toContain(secretCommand);
    expect(await readdir(root)).toEqual([]);
  });

  it("uses separate file and exact-command tool calls in the delegate prompt", async () => {
    const root = await tempRoot();
    let capturedPrompt = "";
    let capturedCommandObservationPolicy: unknown;
    const service: KimiSmokeService = {
      review: async () => {
        throw new Error("not used");
      },
      delegate: async (input, context) => {
        capturedPrompt = input.prompt;
        capturedCommandObservationPolicy =
          context?.commandObservationPolicy;
        context?.onExecutionTelemetry?.(validKimiTelemetry);
        context?.onCommandObservations?.([
          {
            source: "late_update",
            command: "git status --short",
            origin: "raw_input",
          },
        ]);
        await writeFile(
          path.join(input.cwd, "result.txt"),
          "KIMI_SMOKE_OK\n",
          "utf8",
        );
        return {
          ok: true,
          status: "completed",
          llm: "kimi-k3",
          actualModel: "kimi-code/k3",
          elapsedMs: 15,
          diagnostics: [],
          filesChanged: ["result.txt"],
          summary: "Created and verified result.txt.",
          commandsRun: ["git status --short"],
          verification: [],
          risks: [],
        };
      },
    };

    await runKimiSmoke(
      { llm: "kimi-k3", task: "delegate", tempRoot: root },
      {
        service,
        readKimiVersion: async () => "0.27.0",
        listKimiProcessIds: async () => [100],
      },
    );

    expect(capturedPrompt).toContain("two separate tool calls");
    expect(capturedPrompt).toContain("file-writing tool call");
    expect(capturedPrompt).toContain("command-execution tool call");
    expect(capturedPrompt).toContain(
      "Do not place any command before or after it.",
    );
    expect(capturedPrompt).toContain("shell chaining or connectors");
    expect(capturedPrompt).toContain("pipes");
    expect(capturedPrompt).toContain("redirects");
    expect(capturedPrompt).toContain("wrapper commands");
    expect(capturedPrompt).toMatch(
      /command line exactly as shown:\r?\n\r?\ngit status --short\r?\n\r?\n/u,
    );
    expect(capturedPrompt).toContain("Do not modify any other file.");
    expect(capturedPrompt).toContain("Report");
    expect(capturedCommandObservationPolicy).toBe("raw_only");
  });

  it("requires the exact git status command and does not persist command text", async () => {
    const root = await tempRoot();
    const command = "echo x && git status --short";
    const service: KimiSmokeService = {
      review: async () => {
        throw new Error("not used");
      },
      delegate: async (input, context) => {
        context?.onExecutionTelemetry?.(validKimiTelemetry);
        context?.onCommandObservations?.([
          { source: "late_update", command, origin: "raw_input" },
        ]);
        await writeFile(
          path.join(input.cwd, "result.txt"),
          "KIMI_SMOKE_OK\n",
          "utf8",
        );
        return {
          ok: true,
          status: "completed",
          llm: "kimi-k3",
          actualModel: "kimi-code/k3",
          elapsedMs: 15,
          diagnostics: [],
          filesChanged: ["result.txt"],
          summary: "Created the expected result.",
          commandsRun: [command],
          verification: [],
          risks: [],
        };
      },
    };

    const evidence = await runKimiSmoke(
      { llm: "kimi-k3", task: "delegate", tempRoot: root },
      {
        service,
        readKimiVersion: async () => "0.27.0",
        listKimiProcessIds: async () => [100],
      },
    );

    expect(evidence.passed).toBe(false);
    expect(evidence.checks.requiredCommandObserved).toBe(false);
    expect(evidence).toMatchObject({
      commandObservations: [{ source: "late_update", match: "embedded" }],
    });
    expect(evidence).not.toHaveProperty("commandsRun");
    expect(JSON.stringify(evidence)).not.toContain(command);
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
      expectedPassed: false,
      expectedObservation: {
        source: "title_fallback",
        match: "other",
      },
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
      expectedPassed: false,
      expectedObservation: {
        source: "title_fallback",
        match: "other",
      },
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
      expectedPassed: false,
      expectedObservation: {
        source: "title_fallback",
        match: "other",
      },
    },
    {
      name: "an initial exact raw command",
      events: [
        {
          type: "tool_call",
          toolCallId: "initial-raw",
          kind: "execute",
          title: "Run",
          rawInput: { command: "git status --short" },
        },
      ],
      expectedPassed: true,
      expectedObservation: {
        source: "raw_input",
        match: "exact",
      },
    },
    {
      name: "a late exact raw command",
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
      expectedPassed: true,
      expectedObservation: {
        source: "late_update",
        match: "exact",
      },
    },
  ])(
    "uses only raw command input for qualification when ACP reports $name",
    async ({ events, expectedPassed, expectedObservation }) => {
      const root = await tempRoot();
      const base = resolveLlm("kimi-k3");
      const profile = {
        ...base,
        capabilities: { ...base.capabilities, delegate: true },
        qualityGates: {
          ...base.qualityGates,
          delegate: { status: "passed" as const, evidence: "test" },
        },
      };
      const adapter: ExternalAgentAdapter = {
        runtime: "kimi-acp",
        run: async (request) => {
          await writeFile(
            path.join(request.cwd, "result.txt"),
            "KIMI_SMOKE_OK\n",
            "utf8",
          );
          return {
            status: "completed",
            text: "Created and checked result.txt.",
            actualModel: "kimi-code/k3",
            elapsedMs: 10,
            events,
            diagnostics: [],
            executionTelemetry: validKimiTelemetry,
          };
        },
      };
      const service = new ExternalAgentService({
        registry: createLlmRegistry([profile]),
        adapters: new Map([["kimi-acp", adapter]]),
      });

      const evidence = await runKimiSmoke(
        { llm: "kimi-k3", task: "delegate", tempRoot: root },
        {
          service,
          readKimiVersion: async () => "0.27.0",
          listKimiProcessIds: async () => [100],
        },
      );

      expect(evidence.passed).toBe(expectedPassed);
      expect(evidence.checks.requiredCommandObserved).toBe(expectedPassed);
      expect(evidence.commandObservations).toEqual([expectedObservation]);
      expect(
        Object.keys(evidence.commandObservations?.[0] ?? {}).sort(),
      ).toEqual(["match", "source"]);
      expect(JSON.stringify(evidence)).not.toContain("git status --short");
      expect(JSON.stringify(evidence)).not.toContain("origin");
    },
  );

  it("fails the gate when a new Kimi process remains after the task", async () => {
    const root = await tempRoot();
    let call = 0;
    const service: KimiSmokeService = {
      review: async () => ({
        ok: true,
        status: "completed",
        llm: "kimi-k3",
        actualModel: "kimi-code/k3",
        elapsedMs: 12,
        diagnostics: [],
        filesChanged: [],
        review: "Empty input has length zero and produces NaN.",
      }),
      delegate: async () => {
        throw new Error("not used");
      },
    };
    const evidence = await runKimiSmoke(
      { llm: "kimi-k3", task: "review", tempRoot: root },
      {
        service,
        readKimiVersion: async () => "0.27.0",
        listKimiProcessIds: async () => (call++ === 0 ? [100] : [100, 200]),
      },
    );
    expect(evidence.passed).toBe(false);
    expect(evidence.checks.noNewKimiProcesses).toBe(false);
    expect(evidence.failureReason).toBe("process_residual");
  });

  it("fails when the Kimi ACP observer reports null telemetry", async () => {
    const root = await tempRoot();
    const service: KimiSmokeService = {
      review: async (_input, context) => {
        context?.onExecutionTelemetry?.(null);
        return {
          ok: true,
          status: "completed",
          llm: "kimi-k3",
          actualModel: "kimi-code/k3",
          elapsedMs: 12,
          diagnostics: [],
          filesChanged: [],
          review: "Empty input has length zero and produces NaN.",
        };
      },
      delegate: async () => {
        throw new Error("not used");
      },
    };

    const evidence = await runKimiSmoke(
      { llm: "kimi-k3", task: "review", tempRoot: root },
      {
        service,
        readKimiVersion: async () => "0.27.0",
        listKimiProcessIds: async () => [100],
      },
    );

    expect(evidence.passed).toBe(false);
    expect(evidence.checks.executionTelemetryValid).toBe(false);
  });

  it("classifies adapter, authentication, or model failures without diagnostics", async () => {
    const root = await tempRoot();
    const secret = "KIMI_AUTH_SECRET_SENTINEL";
    const service: KimiSmokeService = {
      review: async () => ({
        ok: false,
        status: "failed",
        llm: "kimi-k3",
        actualModel: "kimi-code/k3",
        elapsedMs: 12,
        diagnostics: [`authentication failed for ${secret}`],
        filesChanged: [],
        review: "",
      }),
      delegate: async () => {
        throw new Error("not used");
      },
    };

    const evidence = await runKimiSmoke(
      { llm: "kimi-k3", task: "review", tempRoot: root },
      {
        service,
        readKimiVersion: async () => "0.27.0",
        listKimiProcessIds: async () => [100],
      },
    );

    expect(evidence.failureReason).toBe(
      "adapter_auth_or_model_unavailable",
    );
    expect(evidence.diagnosticCount).toBe(1);
    expect(JSON.stringify(evidence)).not.toContain(secret);
  });

  it("classifies a completed result that misses the acceptance checks", async () => {
    const root = await tempRoot();
    const service: KimiSmokeService = {
      review: async () => ({
        ok: true,
        status: "completed",
        llm: "kimi-k3",
        actualModel: "kimi-code/k3",
        elapsedMs: 12,
        diagnostics: [],
        filesChanged: [],
        review: "No issue found.",
      }),
      delegate: async () => {
        throw new Error("not used");
      },
    };

    const evidence = await runKimiSmoke(
      { llm: "kimi-k3", task: "review", tempRoot: root },
      {
        service,
        readKimiVersion: async () => "0.27.0",
        listKimiProcessIds: async () => [100],
      },
    );

    expect(evidence.passed).toBe(false);
    expect(evidence.failureReason).toBe("acceptance_failed");
  });

  it("labels a version-probe exception without exposing its original message", async () => {
    const root = await tempRoot();
    const secret = "KIMI_VERSION_SECRET_SENTINEL";

    const failure = await runKimiSmoke(
      { llm: "kimi-k3", task: "review", tempRoot: root },
      {
        readKimiVersion: async () => {
          throw new Error(secret);
        },
      },
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(SmokeInfrastructureError);
    expect(failure).toMatchObject({
      message: "Smoke infrastructure failure",
      stage: "version_probe",
    });
    expect(String(failure)).not.toContain(secret);
    expect(await readdir(root)).toEqual([]);
  });

  it("labels a missing post-task process snapshot and records the baseline count", async () => {
    const root = await tempRoot();
    const secret = "KIMI_POST_SNAPSHOT_SECRET_SENTINEL";
    let calls = 0;
    const service: KimiSmokeService = {
      review: async () => ({
        ok: true,
        status: "completed",
        llm: "kimi-k3",
        actualModel: "kimi-code/k3",
        elapsedMs: 12,
        diagnostics: [],
        filesChanged: [],
        review: "Empty input has length zero and produces NaN.",
      }),
      delegate: async () => {
        throw new Error("not used");
      },
    };

    const failure = await runKimiSmoke(
      { llm: "kimi-k3", task: "review", tempRoot: root },
      {
        service,
        readKimiVersion: async () => "0.27.0",
        listKimiProcessIds: async () => {
          if (calls++ === 0) return [100, 101];
          throw new Error(secret);
        },
      },
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(SmokeInfrastructureError);
    expect(failure).toMatchObject({
      message: "Smoke infrastructure failure",
      stage: "post_process_snapshot",
      counts: { processIdsBefore: 2 },
    });
    expect(String(failure)).not.toContain(secret);
    expect(await readdir(root)).toEqual([]);
  });

  it("rejects non-Kimi logical IDs before creating a workspace", async () => {
    const root = await tempRoot();
    await expect(
      runKimiSmoke({ llm: "deepseek", task: "review", tempRoot: root }),
    ).rejects.toThrow(/Supported llms/u);
    expect(await readdir(root)).toEqual([]);
  });
});
