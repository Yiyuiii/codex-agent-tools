import { createHash } from "node:crypto";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, expectTypeOf, it } from "vitest";

import type { AdapterExecutionTelemetry } from "../../src/adapters/adapter.js";
import {
  PiAdapter,
  type PiAdapterDependencies,
} from "../../src/adapters/pi/adapter.js";
import type {
  BuildIsolatedPiConfigOptions,
  IsolatedPiConfig,
} from "../../src/adapters/pi/config.js";
import {
  buildPiDelegateSmokeContract,
  runPiSmoke,
  type PiSmokeService,
} from "../../src/smoke/pi.js";
import {
  SmokeInfrastructureError,
  type SmokeKind,
} from "../../src/smoke/evidence.js";

const roots: string[] = [];

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function tempRoot(): Promise<string> {
  const root = path.join(
    os.tmpdir(),
    `codex-agent-tools-pi-smoke-test-${process.pid}-${Date.now()}-${roots.length}`,
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

function runtimeEvidence(environment: NodeJS.ProcessEnv = {
  CODEX_AGENT_ARK_AGENT_KEY: "secret",
  PI_CODING_AGENT_DIR: "C:\\cache\\pi",
}) {
  return {
    configSha256: "a".repeat(64),
    childEnvironment: environment,
  };
}

const validPiTelemetry: AdapterExecutionTelemetry = {
  adapterClientInvocationCount: 1,
  adapterRetryCount: 0,
  runtimeReportedAutoRetryCount: 0,
  adapterReportedFallbackUsed: false,
  source: "pi-rpc-observable",
};

const qualificationContext = {
  qualificationPlanId: "four-llm-v1" as const,
  batchId: "2026-07-26T12-00-00Z-a1b2c3d4",
  ordinal: 5,
  llm: "ark-agent-plan",
  task: "review" as const,
  frozenCommit: "a".repeat(40),
  frozenBuildIdentity: "b".repeat(64),
  authorizationReferenceSha256: "c".repeat(64),
  orchestratorFallbackUsed: false as const,
};

const delegateQualificationContext = {
  ...qualificationContext,
  ordinal: 8,
  llm: "ark-agent-deepseek-v4-flash",
  task: "delegate" as const,
};

describe("Ark Pi real-smoke harness", () => {
  it("limits public smoke kinds to active launchers", () => {
    expectTypeOf<SmokeKind>().toEqualTypeOf<"ark" | "kimi">();
  });

  it.each([
    {
      label: "standalone Ark",
      llm: "ark-agent-plan",
      qualificationContext: null,
      expectedQualification: undefined,
      expectedRetryMode: "default",
    },
    {
      label: "qualified Ark",
      llm: "ark-agent-plan",
      qualificationContext,
      expectedQualification: true,
      expectedRetryMode: "qualification-single-attempt",
    },
  ] as const)(
    "constructs $label runtime with the intended config and retry mode",
    async ({
      llm,
      qualificationContext: context,
      expectedQualification,
      expectedRetryMode,
    }) => {
      const module = await import("../../src/smoke/pi.js");
      const createRuntime = (
        module as unknown as {
          createPiSmokeRuntime?: (
            llm: string,
            task: "review" | "delegate",
            qualificationContext: typeof context,
            dependencies: {
              buildConfig: (
                options: BuildIsolatedPiConfigOptions,
              ) => Promise<IsolatedPiConfig>;
              createAdapter: (
                dependencies: PiAdapterDependencies,
              ) => PiAdapter;
            },
          ) => Promise<unknown>;
        }
      ).createPiSmokeRuntime;
      expect(createRuntime).toBeTypeOf("function");
      if (createRuntime === undefined) return;

      const configCalls: BuildIsolatedPiConfigOptions[] = [];
      const retryModes: string[] = [];
      await createRuntime(llm, "review", context, {
        buildConfig: async (options) => {
          configCalls.push({ ...options });
          return {
            agentDir: "C:\\isolated\\pi",
            settingsPath: "C:\\isolated\\pi\\settings.json",
            modelsPath: "C:\\isolated\\pi\\models.json",
            environment: { PI_CODING_AGENT_DIR: "C:\\isolated\\pi" },
            contentSha256: "d".repeat(64),
          };
        },
        createAdapter: (dependencies) => {
          retryModes.push(dependencies.retryMode ?? "default");
          return new PiAdapter(dependencies);
        },
      });

      expect(configCalls).toHaveLength(1);
      expect(configCalls[0]).toMatchObject({
        providers: ["ark"],
        ...(expectedQualification === undefined
          ? {}
          : { qualification: expectedQualification }),
      });
      if (expectedQualification === true) {
        expect(configCalls[0]?.qualification).toBe(true);
      } else {
        expect(configCalls[0]).not.toHaveProperty("qualification");
      }
      expect(retryModes).toEqual([expectedRetryMode]);
    },
  );

  it("validates Ark review, direct environment isolation, and process cleanup", async () => {
    const root = await tempRoot();
    const service: PiSmokeService = {
      review: async (_input, context) => {
        expect(context).not.toHaveProperty("onPiCommandLifecycleObservations");
        context?.onExecutionTelemetry?.(validPiTelemetry);
        return {
          ok: true,
          status: "completed",
          llm: "ark-agent-plan",
          actualModel: "ark-code-latest",
          elapsedMs: 12,
          diagnostics: [],
          filesChanged: [],
          review: "Empty input has length zero, so division returns NaN.",
        };
      },
      delegate: async () => {
        throw new Error("not used");
      },
    };
    const evidence = await runPiSmoke(
      {
        llm: "ark-agent-plan",
        task: "review",
        tempRoot: root,
      },
      {
        service,
        runtimeEvidence: runtimeEvidence(),
        readPiVersion: async () => "0.80.10",
        listPiRpcProcessIds: async () => [100],
        now: () => new Date("2026-07-18T00:00:00.000Z"),
      },
    );
    expect(evidence).toMatchObject({
      schemaVersion: 2,
      qualification: null,
      llm: "ark-agent-plan",
      task: "review",
      actualModel: "ark-code-latest",
      piVersion: "0.80.10",
      route: "direct",
      credentialEnv: "CODEX_AGENT_ARK_AGENT_KEY",
      passed: true,
      adapterClientInvocationCount: 1,
      adapterRetryCount: 0,
      runtimeReportedAutoRetryCount: 0,
      adapterReportedFallbackUsed: false,
      orchestratorFallbackUsed: null,
      executionTelemetrySource: "pi-rpc-observable",
      checks: {
        actualModelMatches: true,
        environmentIsolated: true,
        noNewPiRpcProcesses: true,
        workspaceUnchanged: true,
        knownDefectFound: true,
      },
    });
    expect(evidence).not.toHaveProperty("writeCommandObservations");
    expect(evidence.configSha256).toBe("a".repeat(64));
    expect(await readdir(root)).toEqual([]);
  });

  it("keeps the lifecycle observer and evidence field out of qualification reviews", async () => {
    const root = await tempRoot();
    const service: PiSmokeService = {
      review: async (_input, context) => {
        expect(context).not.toHaveProperty("onPiCommandLifecycleObservations");
        context?.onExecutionTelemetry?.(validPiTelemetry);
        return {
          ok: true,
          status: "completed",
          llm: "ark-agent-plan",
          actualModel: "ark-code-latest",
          elapsedMs: 12,
          diagnostics: [],
          filesChanged: [],
          review: "Empty input has length zero, so division returns NaN.",
        };
      },
      delegate: async () => {
        throw new Error("not used");
      },
    };

    const evidence = await runPiSmoke(
      {
        llm: "ark-agent-plan",
        task: "review",
        tempRoot: root,
        qualificationContext,
      },
      {
        service,
        runtimeEvidence: runtimeEvidence(),
        readPiVersion: async () => "0.80.10",
        listPiRpcProcessIds: async () => [100],
      },
    );

    expect(evidence.schemaVersion).toBe(3);
    expect(evidence).not.toHaveProperty("writeCommandObservations");
    expect(await readdir(root)).toEqual([]);
  });

  it.each([
    {
      llm: "ark-coding-plan",
      resultFileName: "ark-coding-plan-smoke.txt",
      expectedLine: "ARK_SMOKE_OK:ark-coding-plan",
      payloadBase64: "QVJLX1NNT0tFX09LOmFyay1jb2RpbmctcGxhbgo=",
    },
    {
      llm: "ark-agent-plan",
      resultFileName: "ark-agent-plan-smoke.txt",
      expectedLine: "ARK_SMOKE_OK:ark-agent-plan",
      payloadBase64: "QVJLX1NNT0tFX09LOmFyay1hZ2VudC1wbGFuCg==",
    },
    {
      llm: "ark-agent-deepseek-v4-flash",
      resultFileName: "ark-agent-deepseek-v4-flash-smoke.txt",
      expectedLine: "ARK_SMOKE_OK:ark-agent-deepseek-v4-flash",
      payloadBase64:
        "QVJLX1NNT0tFX09LOmFyay1hZ2VudC1kZWVwc2Vlay12NC1mbGFzaAo=",
    },
  ] as const)(
    "builds an unambiguous delegate write contract for $llm",
    ({ llm, resultFileName, expectedLine, payloadBase64 }) => {
      const writeCommand =
        `node -e 'require("node:fs").writeFileSync(process.argv[1],Buffer.from(process.argv[2],"base64"))' ` +
        `'${resultFileName}' '${payloadBase64}'`;
      const contract = buildPiDelegateSmokeContract(llm);

      expect(contract).toEqual({
        resultFileName,
        expectedLine,
        writeCommand,
        prompt: [
          "Both actions below are mandatory before you finish.",
          "1. Invoke the bash tool with this exact command:",
          "```bash",
          writeCommand,
          "```",
          "The command must create the result file with this exact normalized payload:",
          "```text",
          expectedLine,
          "```",
          "The code fences are not part of the file.",
          "2. Invoke the bash tool with this exact command:",
          "```bash",
          "git status --short",
          "```",
          "Report both actions. Do not modify any other file. Do not substitute a prose claim for either bash invocation.",
        ].join("\n"),
      });
      expect(contract.prompt).not.toContain(`${expectedLine};`);

      const lines = contract.prompt.split("\n");
      const payloadIndex = lines.indexOf(expectedLine);
      expect(lines[payloadIndex - 1]).toBe("```text");
      expect(lines[payloadIndex + 1]).toBe("```");

      const bashCommands = [
        ...contract.prompt.matchAll(/```bash\n([^\r\n]+)\n```/gu),
      ].map((match) => match[1]);
      expect(bashCommands).toEqual([writeCommand, "git status --short"]);

      const commandParts = writeCommand.split("'");
      expect(commandParts).toHaveLength(7);
      expect(commandParts[1]).toBe(
        'require("node:fs").writeFileSync(process.argv[1],Buffer.from(process.argv[2],"base64"))',
      );
      expect(commandParts[3]).toBe(resultFileName);
      expect(commandParts[5]).toBe(payloadBase64);
      expect(Buffer.from(commandParts[5] ?? "", "base64")).toEqual(
        Buffer.from(`${expectedLine}\n`, "utf8"),
      );
    },
  );

  it.each(["ark'unsafe", "ark\nunsafe", "ark unsafe"])(
    "rejects unsafe delegate smoke token %j",
    (llm) => {
      expect(() => buildPiDelegateSmokeContract(llm)).toThrow(
        "Unsafe Pi smoke llm id",
      );
    },
  );

  it("validates delegate file and command evidence", async () => {
    const root = await tempRoot();
    let receivedPrompt = "";
    const service: PiSmokeService = {
      review: async () => {
        throw new Error("not used");
      },
      delegate: async (input, context) => {
        expect(context).not.toHaveProperty("onPiCommandLifecycleObservations");
        context?.onExecutionTelemetry?.(validPiTelemetry);
        receivedPrompt = input.prompt;
        await writeFile(
          path.join(input.cwd, "ark-agent-plan-smoke.txt"),
          "ARK_SMOKE_OK:ark-agent-plan\n",
          "utf8",
        );
        return {
          ok: true,
          status: "completed",
          llm: "ark-agent-plan",
          actualModel: "ark-code-latest",
          elapsedMs: 15,
          diagnostics: [],
          filesChanged: ["ark-agent-plan-smoke.txt"],
          summary: "Created the Ark result file and ran git status.",
          commandsRun: ["git status --short"],
          verification: [],
          risks: [],
        };
      },
    };
    const evidence = await runPiSmoke(
      { llm: "ark-agent-plan", task: "delegate", tempRoot: root },
      {
        service,
        runtimeEvidence: runtimeEvidence(),
        readPiVersion: async () => "0.80.10",
        listPiRpcProcessIds: async () => [100],
      },
    );
    expect(evidence).toMatchObject({
      passed: true,
      adapterClientInvocationCount: 1,
      adapterRetryCount: 0,
      runtimeReportedAutoRetryCount: 0,
      adapterReportedFallbackUsed: false,
      executionTelemetrySource: "pi-rpc-observable",
      filesChanged: ["ark-agent-plan-smoke.txt"],
      commandCount: 1,
      resultFileReadStatus: "read",
      resultFileByteLength: Buffer.byteLength(
        "ARK_SMOKE_OK:ark-agent-plan\n",
      ),
      resultFileRawSha256: sha256("ARK_SMOKE_OK:ark-agent-plan\n"),
      resultFileNormalizedSha256: sha256("ARK_SMOKE_OK:ark-agent-plan"),
      expectedResultNormalizedSha256: sha256(
        "ARK_SMOKE_OK:ark-agent-plan",
      ),
      resultFileNormalizedLineCount: 1,
      resultFileContainsExpectedLine: true,
      checks: {
        resultFileValid: true,
        resultFileObserved: true,
        onlyExpectedFileChanged: true,
        requiredCommandObserved: true,
        noNewPiRpcProcesses: true,
      },
    });
    expect(receivedPrompt).toBe(
      buildPiDelegateSmokeContract("ark-agent-plan").prompt,
    );
    expect(receivedPrompt).not.toContain("ARK_SMOKE_OK:ark-agent-plan;");
    expect(evidence).not.toHaveProperty("writeCommandObservations");
    expect(await readdir(root)).toEqual([]);
  });

  it("records only sanitized lifecycle evidence for a qualification delegate", async () => {
    const root = await tempRoot();
    const contract = buildPiDelegateSmokeContract(
      "ark-agent-deepseek-v4-flash",
    );
    const privateLifecycleSentinels = {
      toolCallId: "PI_PRODUCER_PRIVATE_TOOL_CALL_ID_SENTINEL",
      path: "PI_PRODUCER_PRIVATE_PATH_SENTINEL",
      rawOutput: "PI_PRODUCER_PRIVATE_RAW_OUTPUT_SENTINEL",
    } as const;
    const service: PiSmokeService = {
      review: async () => {
        throw new Error("not used");
      },
      delegate: async (_input, context) => {
        context?.onExecutionTelemetry?.(validPiTelemetry);
        context?.onPiCommandLifecycleObservations?.([
          Object.assign(
            {
              source: "raw_input",
              command: contract.writeCommand,
              origin: "raw_input",
              outcome: "error",
            } as const,
            privateLifecycleSentinels,
          ),
          {
            source: "raw_input",
            command: "git status --short",
            origin: "raw_input",
            outcome: "success",
          },
        ]);
        return {
          ok: true,
          status: "completed",
          llm: "ark-agent-deepseek-v4-flash",
          actualModel: "deepseek-v4-flash",
          elapsedMs: 15,
          diagnostics: [],
          filesChanged: [],
          summary: "qualification delegate completed",
          commandsRun: [contract.writeCommand, "git status --short"],
          verification: [],
          risks: [],
        };
      },
    };

    const evidence = await runPiSmoke(
      {
        llm: "ark-agent-deepseek-v4-flash",
        task: "delegate",
        tempRoot: root,
        qualificationContext: delegateQualificationContext,
      },
      {
        service,
        runtimeEvidence: runtimeEvidence(),
        readPiVersion: async () => "0.80.10",
        listPiRpcProcessIds: async () => [100],
      },
    );

    expect(evidence).toMatchObject({
      schemaVersion: 3,
      passed: false,
      failureReason: "acceptance_failed",
      commandCount: 2,
      resultFileReadStatus: "missing",
      writeCommandObservations: [
        { source: "raw_input", match: "exact", outcome: "error" },
        { source: "raw_input", match: "other", outcome: "success" },
      ],
    });
    expect(evidence.checks).toMatchObject({
      resultFileValid: false,
      resultFileObserved: false,
      onlyExpectedFileChanged: false,
      requiredCommandObserved: true,
      executionTelemetryValid: true,
    });
    const serialized = JSON.stringify(evidence);
    expect(serialized).not.toContain(contract.writeCommand);
    expect(serialized).not.toContain(contract.resultFileName);
    expect(serialized).not.toContain(
      Buffer.from(`${contract.expectedLine}\n`, "utf8").toString("base64"),
    );
    expect(serialized).not.toContain('"origin"');
    for (const sentinel of Object.values(privateLifecycleSentinels)) {
      expect(serialized).not.toContain(sentinel);
    }
    expect(await readdir(root)).toEqual([]);
  });

  it.each([
    ["missing", 0],
    ["duplicate", 2],
    ["oversized", 257],
  ] as const)(
    "fails qualification task execution for a %s lifecycle observer report",
    async (_label, reportCount) => {
      const root = await tempRoot();
      const contract = buildPiDelegateSmokeContract(
        "ark-agent-deepseek-v4-flash",
      );
      const service: PiSmokeService = {
        review: async () => {
          throw new Error("not used");
        },
        delegate: async (_input, context) => {
          context?.onExecutionTelemetry?.(validPiTelemetry);
          if (reportCount === 257) {
            context?.onPiCommandLifecycleObservations?.(
              Array.from({ length: reportCount }, () => ({
                source: "unextractable" as const,
                command: null,
                origin: null,
                outcome: "unknown" as const,
              })),
            );
          } else {
            for (let index = 0; index < reportCount; index += 1) {
              context?.onPiCommandLifecycleObservations?.([]);
            }
          }
          return {
            ok: true,
            status: "completed",
            llm: "ark-agent-deepseek-v4-flash",
            actualModel: "deepseek-v4-flash",
            elapsedMs: 15,
            diagnostics: [],
            filesChanged: [],
            summary: "qualification delegate completed",
            commandsRun: [contract.writeCommand, "git status --short"],
            verification: [],
            risks: [],
          };
        },
      };

      const failure = await runPiSmoke(
        {
          llm: "ark-agent-deepseek-v4-flash",
          task: "delegate",
          tempRoot: root,
          qualificationContext: delegateQualificationContext,
        },
        {
          service,
          runtimeEvidence: runtimeEvidence(),
          readPiVersion: async () => "0.80.10",
          listPiRpcProcessIds: async () => [100],
        },
      ).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(SmokeInfrastructureError);
      expect(failure).toMatchObject({
        message: "Smoke infrastructure failure",
        stage: "task_execution",
      });
      expect(String(failure)).not.toContain(contract.writeCommand);
      expect(await readdir(root)).toEqual([]);
    },
  );

  it.each([
    [["pwd"], "unrelated command"],
    [["echo x && git status --short"], "compound command"],
    [["bash"], "tool title only"],
  ])(
    "rejects %s as %s rather than exact command evidence",
    async (commandsRun) => {
      const root = await tempRoot();
      const service: PiSmokeService = {
        review: async () => {
          throw new Error("not used");
        },
        delegate: async (input) => {
          await writeFile(
            path.join(input.cwd, "ark-agent-plan-smoke.txt"),
            "ARK_SMOKE_OK:ark-agent-plan\n",
            "utf8",
          );
          return {
            ok: true,
            status: "completed",
            llm: "ark-agent-plan",
            actualModel: "ark-code-latest",
            elapsedMs: 15,
            diagnostics: [],
            filesChanged: ["ark-agent-plan-smoke.txt"],
            summary: "Tool event claimed git status --short.",
            commandsRun,
            verification: [],
            risks: [],
          };
        },
      };

      const evidence = await runPiSmoke(
        { llm: "ark-agent-plan", task: "delegate", tempRoot: root },
        {
          service,
          runtimeEvidence: runtimeEvidence(),
          readPiVersion: async () => "0.80.10",
          listPiRpcProcessIds: async () => [100],
        },
      );

      expect(evidence.passed).toBe(false);
      expect(evidence.checks.requiredCommandObserved).toBe(false);
      expect(evidence).not.toHaveProperty("commandsRun");
      expect(JSON.stringify(evidence)).not.toContain(commandsRun[0]);
    },
  );

  it("fails when a forbidden credential or proxy reaches the Pi child", async () => {
    const root = await tempRoot();
    const service: PiSmokeService = {
      review: async () => ({
        ok: true,
        status: "completed",
        llm: "ark-agent-plan",
        actualModel: "ark-code-latest",
        elapsedMs: 12,
        diagnostics: [],
        filesChanged: [],
        review: "Empty array length zero produces NaN.",
      }),
      delegate: async () => {
        throw new Error("not used");
      },
    };
    const evidence = await runPiSmoke(
      { llm: "ark-agent-plan", task: "review", tempRoot: root },
      {
        service,
        runtimeEvidence: runtimeEvidence({
          CODEX_AGENT_ARK_AGENT_KEY: "secret",
          ANTHROPIC_API_KEY: "forbidden",
          HTTPS_PROXY: "http://127.0.0.1:11808",
          PI_CODING_AGENT_DIR: "C:\\cache\\pi",
        }),
        readPiVersion: async () => "0.80.10",
        listPiRpcProcessIds: async () => [100],
      },
    );
    expect(evidence.passed).toBe(false);
    expect(evidence.checks.environmentIsolated).toBe(false);
  });

  it.each([
    ["missing observer", undefined],
    ["null telemetry", null],
    [
      "multiple client invocations",
      { ...validPiTelemetry, adapterClientInvocationCount: 2 },
    ],
    ["adapter retry", { ...validPiTelemetry, adapterRetryCount: 1 }],
    [
      "runtime retry",
      { ...validPiTelemetry, runtimeReportedAutoRetryCount: 1 },
    ],
    [
      "reported fallback",
      { ...validPiTelemetry, adapterReportedFallbackUsed: true },
    ],
  ] as const)("fails qualification telemetry gate for %s", async (_name, telemetry) => {
    const root = await tempRoot();
    const service: PiSmokeService = {
      review: async (_input, context) => {
        if (telemetry !== undefined) {
          context?.onExecutionTelemetry?.(telemetry);
        }
        return {
          ok: true,
          status: "completed",
          llm: "ark-agent-plan",
          actualModel: "ark-code-latest",
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

    const evidence = await runPiSmoke(
      { llm: "ark-agent-plan", task: "review", tempRoot: root },
      {
        service,
        runtimeEvidence: runtimeEvidence(),
        readPiVersion: async () => "0.80.10",
        listPiRpcProcessIds: async () => [100],
      },
    );

    expect(evidence.passed).toBe(false);
    expect(evidence.checks.executionTelemetryValid).toBe(false);
  });

  it("labels a Pi version-probe exception without exposing its original message", async () => {
    const root = await tempRoot();
    const secret = "PI_VERSION_SECRET_SENTINEL";
    const service: PiSmokeService = {
      review: async () => {
        throw new Error("not reached");
      },
      delegate: async () => {
        throw new Error("not reached");
      },
    };

    const failure = await runPiSmoke(
      { llm: "ark-agent-plan", task: "review", tempRoot: root },
      {
        service,
        runtimeEvidence: runtimeEvidence(),
        readPiVersion: async () => {
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

  it("labels a missing post-task Pi snapshot and records the baseline count", async () => {
    const root = await tempRoot();
    const secret = "PI_POST_SNAPSHOT_SECRET_SENTINEL";
    let calls = 0;
    const service: PiSmokeService = {
      review: async () => ({
        ok: true,
        status: "completed",
        llm: "ark-agent-plan",
        actualModel: "ark-code-latest",
        elapsedMs: 12,
        diagnostics: [],
        filesChanged: [],
        review: "Empty input has length zero and produces NaN.",
      }),
      delegate: async () => {
        throw new Error("not reached");
      },
    };

    const failure = await runPiSmoke(
      { llm: "ark-agent-plan", task: "review", tempRoot: root },
      {
        service,
        runtimeEvidence: runtimeEvidence(),
        readPiVersion: async () => "0.80.10",
        listPiRpcProcessIds: async () => {
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
});
