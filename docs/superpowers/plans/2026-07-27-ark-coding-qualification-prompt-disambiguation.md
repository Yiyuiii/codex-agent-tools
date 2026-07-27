# Ark Coding Plan Qualification Prompt Disambiguation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the deterministic Ark Coding Plan delegate qualification-prompt delimiter ambiguity, preserve every existing safety and qualification gate, freeze a fully verified candidate, and stop with an exact one-batch authorization review package before any real model call.

**Architecture:** Add one pure prompt-contract builder inside the existing Pi smoke module and route all three Ark delegate profiles through it. The builder emits a Bash-safe Node/Base64 write command and structurally separated payload; the result-file validator, Ark registry/routing, qualification protocol, evidence schemas, telemetry, retry policy, and immutable historical evidence remain untouched. After TDD implementation, run the complete deterministic and evidence-integrity chain, independently review the candidate, persist a Chinese HTML authorization brief, and freeze a clean HEAD.

**Tech Stack:** TypeScript 5.9, Node.js 20+, Vitest 4, Pi RPC 0.80.10, Git Bash on Windows, tsup, PowerShell, Git.

**Execution status (2026-07-27):** Tasks 1–5 are complete through implementation commit `76504d7d165366ad291e6ff08026b7236f862fc8`, independent specification/code-quality PASS, full offline verification, immutable-evidence audit, and authorization-review material. The fresh full suite is 44 files / 569 passed / 1 skipped / 0 failed. No new real model call occurred. Task 6 remains pending: commit the documentation surface, create the empty frozen-candidate commit, and rerun the exact post-freeze verification chain before handoff.

---

## Source of truth

- Design: `docs/superpowers/specs/2026-07-27-ark-coding-qualification-prompt-disambiguation-design.md`
- Previous blocked batch: `docs/smoke/evidence/batches/2026-07-26T17-20-48.464Z-b49aed1d-48fa-40cd-9c73-1388bc91369d/`
- Historical Gemini baseline commit: `e24b942`
- Current plan-writing commit parent: `ec8c21e917c49068cedf008e5bc575a5aa849648`

## Execution constraints

- The approved design, this plan, and the new AGENTS memory entry must be committed as the planning baseline before Task 1. Confirm `git status --short` is empty immediately after that plan-phase commit.
- Work only in `D:\Codes\codex-agent-tools\.worktrees\gemini-retirement`.
- Use RED → GREEN → REFACTOR for the prompt behavior change.
- Do not modify `D:\Codes\codex-cc-tools`, Claude Code, or the active Codex/Pi configuration.
- Do not read, write, compare, back up, or restore active `~/.codex/config.toml`.
- Do not invoke `smoke:ark`, `smoke:kimi`, `acceptance:local`, `qualify:gates -- --authorization-ref`, qualification recovery, active plugin add/remove, npm publish, or any external LLM.
- `acceptance:plugin:isolated -- --check-report` is allowed because it uses a temporary `CODEX_HOME` and performs byte comparison only.
- Do not modify any file below `docs/smoke/evidence/`.
- Do not modify `src/smoke/result-file-evidence.ts`, `src/smoke/ark.ts`, `src/qualification/`, registry/provider/network/credential code, or retry/fallback behavior.
- Keep `four-llm-v1`, manifest/checkpoint schema v2, and qualification evidence schema v3 unchanged.
- If a required verification fails, diagnose and fix it locally; do not cross a real-model or active-install boundary.

## File responsibility map

- `src/smoke/pi.ts`: owns the new pure delegate prompt contract and uses it in the existing delegate branch.
- `test/smoke/pi.test.ts`: white-box contract test plus existing Pi delegate evidence integration.
- `test/smoke/ark.test.ts`: parameterized integration coverage for all three Ark delegate profiles.
- `test/smoke/result-file-evidence.test.ts`: characterization that the unchanged validator rejects a trailing natural-language delimiter.
- `README.md`, `docs/operations.md`, `docs/smoke/ark.md`, `docs/release/checklist.md`, `docs/release/real-plugin-install-review.md`: current user/maintainer status after the offline repair.
- `docs/release/four-llm-qualification-authorization-review.html`: single-file Chinese human authorization brief; it never grants authorization by itself.
- `AGENTS.md`, the approved design, and this plan: durable cross-session state and completion boundaries.

## Task 1: Build the deterministic Pi delegate prompt contract with TDD

**Files:**

- Modify: `test/smoke/result-file-evidence.test.ts:84-112`
- Modify: `test/smoke/pi.test.ts:16-20,224-294`
- Modify: `src/smoke/pi.ts:288-294,606-624`

- [x] **Step 1: Add a strict-validator characterization for the exact historical defect**

Extend the existing invalid-content table in `test/smoke/result-file-evidence.test.ts`:

```ts
  it.each([
    ["empty", "", 0, false],
    ["wrong line", "WRONG\n", 1, false],
    ["natural-language delimiter", "EXPECTED;\n", 1, false],
    ["extra lines", "before\nEXPECTED\nafter\n", 3, true],
  ])(
```

Run:

```powershell
npx vitest run test/smoke/result-file-evidence.test.ts
```

Expected: PASS without changing `src/smoke/result-file-evidence.ts`. This is a characterization gate, not the behavior RED.

- [x] **Step 2: Write the RED pure-contract test**

Add `buildPiDelegateSmokeContract` to the existing import from `../../src/smoke/pi.js`:

```ts
import {
  buildPiDelegateSmokeContract,
  runPiSmoke,
  type PiSmokeService,
} from "../../src/smoke/pi.js";
```

Insert this test before the existing `"validates delegate file and command evidence"` test:

```ts
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
```

- [x] **Step 2a: Add unsafe shell-token rejection to the RED contract test**

Add:

```ts
  it.each(["ark'unsafe", "ark\nunsafe", "ark unsafe"])(
    "rejects unsafe delegate smoke token %j",
    (llm) => {
      expect(() => buildPiDelegateSmokeContract(llm)).toThrow(
        "Unsafe Pi smoke llm id",
      );
    },
  );
```

- [x] **Step 2b: Replace the old prose-shape assertions in the delegate integration test**

At the end of `"validates delegate file and command evidence"`, replace:

```ts
    expect(receivedPrompt).toContain("Both actions are mandatory");
    expect(receivedPrompt).toContain("bash tool with the exact command `git status --short`");
```

with:

```ts
    expect(receivedPrompt).toBe(
      buildPiDelegateSmokeContract("ark-agent-plan").prompt,
    );
    expect(receivedPrompt).not.toContain("ARK_SMOKE_OK:ark-agent-plan;");
```

- [x] **Step 3: Run the focused test and observe RED**

Run:

```powershell
npx vitest run test/smoke/pi.test.ts -t "builds an unambiguous delegate write contract"
```

Expected: FAIL because `buildPiDelegateSmokeContract` is not exported/implemented. If it passes, stop and inspect whether the intended production change already exists.

- [x] **Step 4: Implement the minimal pure contract**

Insert after `sha256()` in `src/smoke/pi.ts`:

```ts
export interface PiDelegateSmokeContract {
  readonly resultFileName: string;
  readonly expectedLine: string;
  readonly writeCommand: string;
  readonly prompt: string;
}

export function buildPiDelegateSmokeContract(
  llm: string,
): PiDelegateSmokeContract {
  if (!/^[A-Za-z0-9._-]+$/u.test(llm)) {
    throw new Error("Unsafe Pi smoke llm id");
  }
  const resultFileName = `${llm}-smoke.txt`;
  const expectedLine = `ARK_SMOKE_OK:${llm}`;
  const payloadBase64 = Buffer.from(`${expectedLine}\n`, "utf8").toString(
    "base64",
  );
  const writeCommand =
    `node -e 'require("node:fs").writeFileSync(process.argv[1],Buffer.from(process.argv[2],"base64"))' ` +
    `'${resultFileName}' '${payloadBase64}'`;
  return Object.freeze({
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
}
```

This helper is exported only from the internal smoke module for direct testing. Do not re-export it from the package root or MCP surface.

- [x] **Step 5: Wire the existing delegate branch to the contract**

Replace the inline `resultFileName`, `expectedLine`, and one-sentence prompt in `runPiSmoke` with:

```ts
    const { resultFileName, expectedLine, prompt } =
      buildPiDelegateSmokeContract(options.llm);
    const result = await inSmokeInfrastructureStage(
      "task_execution",
      () =>
        service.delegate(
          {
            llm: options.llm,
            prompt,
            cwd,
            timeoutMs,
          },
          context,
        ),
    );
```

Leave `inspectResultFile`, `requiredCommandObserved`, telemetry, environment, file-range, and cleanup code byte-for-byte unchanged except for formatter-only wrapping.

- [x] **Step 6: Run the focused GREEN tests**

Run:

```powershell
npx vitest run test/smoke/pi.test.ts test/smoke/result-file-evidence.test.ts
```

Expected: both files PASS; the new contract has three passing cases and the semicolon variant remains invalid.

- [x] **Step 7: Run type checking and inspect the production diff**

Run:

```powershell
npm run typecheck
git diff --check
git diff -- src/smoke/pi.ts test/smoke/pi.test.ts test/smoke/result-file-evidence.test.ts
```

Expected: typecheck exits 0; the production diff changes prompt construction only.

- [x] **Step 8: Keep Task 1 changes uncommitted until the shared Ark integration is GREEN**

Do not commit yet. The old `test/smoke/ark.test.ts` parses the superseded prose shape and would fail against the new production prompt. Continue directly to Task 2 so the first behavior commit is fully GREEN.

## Task 2: Prove all three Ark delegate profiles share the exact contract

**Files:**

- Modify: `test/smoke/ark.test.ts:8-12,151-226`

- [x] **Step 1: Import the pure contract**

Replace the Pi smoke type-only import with:

```ts
import {
  buildPiDelegateSmokeContract,
  type PiSmokeService,
} from "../../src/smoke/pi.js";
```

- [x] **Step 2: Replace the single DeepSeek delegate test with parameterized integration coverage**

Replace `"uses a profile-specific delegate file and requires command evidence"` with:

```ts
  it.each([
    {
      llm: "ark-coding-plan",
      actualModel: "ark-code-latest",
      provider: "ark-coding-plan",
      credentialEnv: "CODEX_AGENT_ARK_CODING_KEY",
    },
    {
      llm: "ark-agent-plan",
      actualModel: "ark-code-latest",
      provider: "ark-agent-plan",
      credentialEnv: "CODEX_AGENT_ARK_AGENT_KEY",
    },
    {
      llm: "ark-agent-deepseek-v4-flash",
      actualModel: "deepseek-v4-flash",
      provider: "ark-agent-plan",
      credentialEnv: "CODEX_AGENT_ARK_AGENT_KEY",
    },
  ] as const)(
    "uses the exact delegate contract for $llm",
    async ({ llm, actualModel, provider, credentialEnv }) => {
      const root = await tempRoot();
      const contract = buildPiDelegateSmokeContract(llm);
      let receivedPrompt = "";
      const service: PiSmokeService = {
        review: async () => {
          throw new Error("not used");
        },
        delegate: async (input, context) => {
          context?.onExecutionTelemetry?.(validPiTelemetry);
          receivedPrompt = input.prompt;
          await writeFile(
            path.join(input.cwd, contract.resultFileName),
            `${contract.expectedLine}\n`,
            "utf8",
          );
          return {
            ok: true,
            status: "completed",
            llm,
            actualModel,
            elapsedMs: 10,
            diagnostics: [],
            filesChanged: [contract.resultFileName],
            summary: "created and verified",
            commandsRun: ["git status --short"],
            verification: [],
            risks: [],
          };
        },
      };

      const evidence = await runArkSmoke(
        { llm, task: "delegate", tempRoot: root },
        {
          service,
          runtimeEvidence: {
            configSha256: "c".repeat(64),
            childEnvironment: {
              [credentialEnv]: "secret",
              PI_CODING_AGENT_DIR: "C:\\cache\\pi",
            },
          },
          readPiVersion: async () => "0.80.10",
          listPiRpcProcessIds: async () => [],
        },
      );

      expect(receivedPrompt).toBe(contract.prompt);
      expect(evidence.passed).toBe(true);
      expect(evidence).toMatchObject({
        llm,
        actualModel,
        expectedModel: actualModel,
        provider,
        credentialEnv,
        filesChanged: [contract.resultFileName],
        resultFileReadStatus: "read",
        resultFileByteLength: Buffer.byteLength(
          `${contract.expectedLine}\n`,
        ),
        resultFileRawSha256: sha256(`${contract.expectedLine}\n`),
        resultFileNormalizedSha256: sha256(contract.expectedLine),
        expectedResultNormalizedSha256: sha256(contract.expectedLine),
        resultFileNormalizedLineCount: 1,
        resultFileContainsExpectedLine: true,
        checks: {
          resultFileValid: true,
          resultFileObserved: true,
          onlyExpectedFileChanged: true,
          requiredCommandObserved: true,
          environmentIsolated: true,
          noNewPiRpcProcesses: true,
        },
      });
      expect(await readdir(root)).toEqual([]);
    },
  );
```

This removes the brittle `/create ([^ ]+\.txt)/` prompt parser from the old test.

- [x] **Step 3: Run the Ark/Pi/validator integration set**

Run:

```powershell
npx vitest run test/smoke/pi.test.ts test/smoke/ark.test.ts test/smoke/result-file-evidence.test.ts
```

Expected: PASS for all three Ark profiles; no production file beyond `src/smoke/pi.ts` is needed.

- [x] **Step 4: Probe the exact Bash → Node argv contract without Pi or a real model**

Run:

```powershell
$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$probeRoot = Join-Path $tempRoot ("codex-agent-tools-prompt-probe-" + [guid]::NewGuid().ToString("N"))
$probeFull = [IO.Path]::GetFullPath($probeRoot)
$tempPrefix = $tempRoot.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
if (-not $probeFull.StartsWith($tempPrefix, [StringComparison]::OrdinalIgnoreCase)) {
  throw "Probe path escaped the system temp directory"
}
New-Item -ItemType Directory -Path $probeFull | Out-Null
try {
  $isWindows = [Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT
  if ($isWindows) {
    $gitExecutable = (Get-Command git -ErrorAction Stop).Source
    $gitRoot = Split-Path (Split-Path $gitExecutable -Parent) -Parent
    $bashExecutable = Join-Path $gitRoot "bin\bash.exe"
  } else {
    $bashExecutable = (Get-Command bash -ErrorAction Stop).Source
  }
  if (-not (Test-Path -LiteralPath $bashExecutable -PathType Leaf)) {
    throw "Bash executable is unavailable"
  }
  $probeScript = @'
import { spawnSync } from "node:child_process";
import { buildPiDelegateSmokeContract } from "./src/smoke/pi.ts";

const [bashExecutable, cwd] = process.argv.slice(2);
const { writeCommand } = buildPiDelegateSmokeContract("ark-coding-plan");
const child = spawnSync(bashExecutable, ["-c", writeCommand], {
  cwd,
  encoding: "utf8",
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
});
if (child.error) {
  throw child.error;
}
if (child.status !== 0) {
  process.stderr.write(child.stderr ?? "");
  process.exit(child.status ?? 1);
}
'@
  $probeScript | node --import tsx --input-type=module - $bashExecutable $probeFull
  if ($LASTEXITCODE -ne 0) {
    throw "Bash probe failed"
  }
  $resultPath = Join-Path $probeFull "ark-coding-plan-smoke.txt"
  $actualBytes = [IO.File]::ReadAllBytes($resultPath)
  $actualBase64 = [Convert]::ToBase64String($actualBytes)
  if ($actualBase64 -ne "QVJLX1NNT0tFX09LOmFyay1jb2RpbmctcGxhbgo=") {
    throw "Bash probe produced unexpected bytes"
  }
  $actualSha = (Get-FileHash -Algorithm SHA256 -LiteralPath $resultPath).Hash.ToLowerInvariant()
  if ($actualBytes.Length -ne 29 -or $actualBytes[-1] -ne 10 -or
      $actualSha -ne "7b82d87530083f53c07b5b34d5ab4cc8c6bc031c96c70b0be28920262c20fb59") {
    throw "Bash probe byte contract mismatch"
  }
  Write-Output "bashNodeArgvProbe=passed bytes=29 lineEnding=LF sha256=$actualSha"
} finally {
  if (Test-Path -LiteralPath $probeFull) {
    Remove-Item -LiteralPath $probeFull -Recurse -Force
  }
}
```

Expected: `bashNodeArgvProbe=passed bytes=29 lineEnding=LF sha256=7b82d87530083f53c07b5b34d5ab4cc8c6bc031c96c70b0be28920262c20fb59`; no Pi, Kimi, Ark network, or real-smoke process is launched. Piping the JavaScript module over stdin keeps its quotes out of PowerShell's native-command argument binder, while `spawnSync(bashExecutable, ["-c", writeCommand])` reproduces the production Bash argv boundary.

- [x] **Step 5: Run the Pi and qualification regression set**

Run:

```powershell
npx vitest run test/adapters/pi/adapter.test.ts test/adapters/pi/client.test.ts test/smoke/pi.test.ts test/smoke/ark.test.ts test/smoke/result-file-evidence.test.ts test/qualification/protocol.test.ts test/qualification/verifier.test.ts
npm run typecheck
```

Expected: all selected tests and typecheck PASS. `four-llm-v1` and evidence schemas remain unchanged.

- [x] **Step 6: Commit the single fully GREEN behavior change**

```powershell
git add -- src/smoke/pi.ts test/smoke/pi.test.ts test/smoke/ark.test.ts test/smoke/result-file-evidence.test.ts
git diff --cached --check
git diff --cached --name-status
git commit -m "fix: disambiguate Ark delegate smoke prompt"
```

## Task 3: Run the complete offline verification and immutable-evidence audit

**Files:**

- No tracked changes expected unless a reproducible defect is found.

- [x] **Step 1: Run the complete deterministic suite**

Run each command separately and stop at the first non-zero exit:

```powershell
npm run typecheck
npm test
npm run build
npm run smoke:release
npm run acceptance:plugin:isolated -- --check-report
npm run qualify:gates -- --help
npm run verify:qualification -- --help
git diff --check
git status --short
```

Expected: every command exits 0 and the worktree is clean. None of these commands may carry `--authorization-ref`.

- [x] **Step 2: Verify the current blocked batch through the immutable verifier**

```powershell
npm run --silent verify:qualification -- --mode immutable-evidence --manifest docs/smoke/evidence/batches/2026-07-26T17-20-48.464Z-b49aed1d-48fa-40cd-9c73-1388bc91369d/manifest.json
```

Expected JSON:

```json
{"verified":true,"mode":"immutable-evidence","batchId":"2026-07-26T17-20-48.464Z-b49aed1d-48fa-40cd-9c73-1388bc91369d","qualificationPlanId":"four-llm-v1","status":"blocked","promotionEligible":false}
```

- [x] **Step 3: Recheck the five-file current batch SHA-256 values and baseline blobs**

```powershell
$expectedCurrent = [ordered]@{
  "docs/smoke/evidence/batches/2026-07-26T17-20-48.464Z-b49aed1d-48fa-40cd-9c73-1388bc91369d/cases/2026-07-26T17-23-31.295Z-ark-coding-plan-delegate-ark.json" = "166947716c19d435155e4ce0d041e4c88b7ef9b79f302787e0c27572eb39e6c9"
  "docs/smoke/evidence/batches/2026-07-26T17-20-48.464Z-b49aed1d-48fa-40cd-9c73-1388bc91369d/checkpoints/000000.json" = "a9e38d79835954db06bc6fe329cb8b22735e200a1d3b56225ffb4f097cefd71d"
  "docs/smoke/evidence/batches/2026-07-26T17-20-48.464Z-b49aed1d-48fa-40cd-9c73-1388bc91369d/checkpoints/000001.json" = "a4a935a9aae1e5ddd5aabafec4d753f52ad96ba7228d74f32907ecb855d6cb26"
  "docs/smoke/evidence/batches/2026-07-26T17-20-48.464Z-b49aed1d-48fa-40cd-9c73-1388bc91369d/checkpoints/000002.json" = "da72ebd93a302ed206cef32168a3fbf4be8840adf1287ed2d7cc3c171a38c3e3"
  "docs/smoke/evidence/batches/2026-07-26T17-20-48.464Z-b49aed1d-48fa-40cd-9c73-1388bc91369d/manifest.json" = "f374987c475c291baaef553771ee56562654275bfbd8c15e4b11b26141baa58c"
}
foreach ($entry in $expectedCurrent.GetEnumerator()) {
  $actualSha = (Get-FileHash -Algorithm SHA256 -LiteralPath $entry.Key).Hash.ToLowerInvariant()
  if ($actualSha -ne $entry.Value) {
    throw "Current batch SHA mismatch: $($entry.Key)"
  }
  $workingBlob = (git hash-object --no-filters -- $entry.Key).Trim()
  $baselineBlob = (git rev-parse "fb599c8:$($entry.Key)").Trim()
  if ($LASTEXITCODE -ne 0 -or $workingBlob -ne $baselineBlob) {
    throw "Current batch blob mismatch: $($entry.Key)"
  }
}
Write-Output "currentBlockedEvidence=5/5"
git diff --exit-code -- docs/smoke/evidence
```

Expected: `currentBlockedEvidence=5/5` and Git reports no evidence diff.

- [x] **Step 4: Recheck all 14 historical evidence SHA-256 values and baseline blobs**

Run this exact PowerShell block:

```powershell
$expected = [ordered]@{
  "docs/smoke/evidence/2026-07-18T08-33-35.891Z-gemini-3.5-flash-review-pi.json" = "3e30fd8879f26cbd51359c0383ca71ed288364d899a96dde3f8b32f3d5fa49a1"
  "docs/smoke/evidence/2026-07-18T08-33-56.352Z-gemini-3.5-flash-delegate-pi.json" = "85b0302d6e5d1e81a33e62697c12d62fe1d56654d915c3c77cdcbe2a81660ca1"
  "docs/smoke/evidence/2026-07-18T08-35-31.179Z-gemini-3.5-flash-delegate-pi.json" = "ba5aea6c9cb0a158b079e3ca6a2dbaa7f682924d193fb53bb62ff9529290f7ea"
  "docs/smoke/evidence/2026-07-18T10-24-35.508Z-gemini-3.5-flash-review-pi.json" = "7105920a222337ee456f59a4ca37888c04ec90e673fb56a832147c0545aab160"
  "docs/smoke/evidence/2026-07-18T11-14-05.781Z-gemini-3.5-flash-review-pi.json" = "bd87b76a1d29d1ece12781cdd2068f8efdbf881e09c801f7213416da88091559"
  "docs/smoke/evidence/2026-07-20T07-30-18.646Z-gemini-3.5-flash-review-pi.json" = "4c4656c0d5210555e641af05616e973508826b5aa549eaca9e3d9b24b8bc7e8d"
  "docs/smoke/evidence/2026-07-20T07-33-34.354Z-gemini-3.5-flash-delegate-pi.json" = "9863ec964cfe4c070bf8d76369ae240431f4b3f373c34999a27d8fae6889c5dc"
  "docs/smoke/evidence/2026-07-25T15-47-08.146Z-gemini-3.5-flash-review-pi.json" = "09f78efdaea50a3f05ef8e8365fda4aab0127152c9ac65600ec76a83d28d663b"
  "docs/smoke/evidence/2026-07-25T15-48-28.600Z-gemini-3.5-flash-delegate-pi.json" = "890e546ff993e17f4f9303b88bb10dcb82fbd45a8bf0252f629c458db5a7d5c0"
  "docs/smoke/evidence/batches/2026-07-26T08-55-33.323Z-9322d00a-709b-475b-8e76-fa94af80ca6f/cases/2026-07-26T09-01-07.689Z-gemini-3.5-flash-delegate-pi.json" = "ed2e5c79c4cfbf851c7901aeeee5be885055ef244aefcf4ee11dca6ccbccf484"
  "docs/smoke/evidence/batches/2026-07-26T08-55-33.323Z-9322d00a-709b-475b-8e76-fa94af80ca6f/checkpoints/000000.json" = "acf04a1a7e811f0a60e2b84005e9f18b9bd6eb77c3a8d6554caf5d63a6233e3c"
  "docs/smoke/evidence/batches/2026-07-26T08-55-33.323Z-9322d00a-709b-475b-8e76-fa94af80ca6f/checkpoints/000001.json" = "27c3b3b5b673cf17e680a0dc83bf382b146491d11cb8d1547cb4c597062f369f"
  "docs/smoke/evidence/batches/2026-07-26T08-55-33.323Z-9322d00a-709b-475b-8e76-fa94af80ca6f/checkpoints/000002.json" = "e12145f05e9520c409bf748eab5321b93160cee31c02af9c5ad275f64041b15f"
  "docs/smoke/evidence/batches/2026-07-26T08-55-33.323Z-9322d00a-709b-475b-8e76-fa94af80ca6f/manifest.json" = "78dd7af3a3ba17a83ba96fed021cd559a49e2641ca9facb89fe932d0d06a06c5"
}
foreach ($entry in $expected.GetEnumerator()) {
  $path = $entry.Key
  $actualSha = (Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash.ToLowerInvariant()
  if ($actualSha -ne $entry.Value) {
    throw "Historical SHA-256 mismatch: $path"
  }
  $currentBlob = (git hash-object --no-filters -- $path).Trim()
  $baselineBlob = (git rev-parse "e24b942:$path").Trim()
  if ($LASTEXITCODE -ne 0 -or $currentBlob -ne $baselineBlob) {
    throw "Historical blob mismatch: $path"
  }
}
Write-Output "historicalEvidence=14/14"
```

Expected: `historicalEvidence=14/14`.

- [x] **Step 5: Recheck the historical blocked batch through the immutable verifier**

```powershell
npm run --silent verify:qualification -- --mode immutable-evidence --manifest docs/smoke/evidence/batches/2026-07-26T08-55-33.323Z-9322d00a-709b-475b-8e76-fa94af80ca6f/manifest.json
```

Expected: verified `five-llm-v1` historical blocked evidence with `promotionEligible=false`. Do not use `frozen-candidate` mode because current source/build intentionally differs from that historical freeze.

- [x] **Step 6: Verify production target-process counts**

```powershell
npx tsx -e "import('./src/runtime/agent-processes.ts').then(async ({ classifyAgentProcesses }) => { const counts = await classifyAgentProcesses(); console.log(JSON.stringify(counts)); if (counts.kimi.count !== 0 || counts.piRpc.count !== 0 || counts.realSmoke.count !== 0) process.exitCode = 1; })"
```

Expected:

```json
{"kimi":{"count":0},"piRpc":{"count":0},"realSmoke":{"count":0}}
```

- [x] **Step 7: Record the fresh command results for the final review brief**

Keep only non-secret facts in execution state:

- exact full-test file/pass/skip/fail counts;
- typecheck/build/release/isolated exit status;
- immutable verifier JSON;
- `historicalEvidence=14/14`;
- `currentBlockedEvidence=5/5`;
- process counts 0/0/0;
- current clean HEAD.

Do not persist raw environment values, authorization UUIDs, process command lines, temp paths, or model output.

## Task 4: Run independent specification and code-quality reviews

**Files:**

- Modify only when a reviewer identifies a reproducible issue.

- [x] **Step 1: Dispatch an independent specification reviewer**

Provide:

- the approved design;
- this plan;
- base commit `ec8c21e917c49068cedf008e5bc575a5aa849648`;
- current HEAD and exact changed paths;
- the focused and complete verification results;
- explicit prohibitions on real model calls, evidence edits, active config/install, and Claude Code.

Ask it to check prompt/payload delimiting, all three Ark profiles, validator invariants, `four-llm-v1` compatibility, authorization boundaries, and documentation accuracy. It must not edit files.

- [x] **Step 2: Dispatch an independent code-quality reviewer**

Ask it to inspect shell quoting, Node argv positions, Base64/newline determinism, test strength, public-surface drift, unchanged validator/qualification paths, secret handling, and cleanup behavior. It must not edit files or invoke a real model.

- [x] **Step 3: Technically triage every finding**

For each finding:

1. reproduce it against the exact line and command;
2. reject it with evidence if it conflicts with the approved design or actual code;
3. for a real behavior defect, add a focused failing test and observe RED;
4. implement the smallest fix and observe targeted GREEN;
5. rerun Task 3 Steps 1–6;
6. commit only the exact fix paths with a finding-specific message.

Do not accept a suggestion that changes provider/model/route/credential/retry/fallback, result validator semantics, qualification schema, or historical evidence without stopping for a new design decision.

- [x] **Step 4: Require both reviews to reach PASS**

Expected: no reproducible Critical/Important/Minor issue remains. Advisory style preferences may be documented and rejected without code churn.

## Task 5: Persist current status and the human authorization brief

**Files:**

- Create: `docs/release/four-llm-qualification-authorization-review.html`
- Modify: `README.md`
- Modify: `AGENTS.md`
- Modify: `docs/operations.md`
- Modify: `docs/smoke/ark.md`
- Modify: `docs/release/checklist.md`
- Modify: `docs/release/real-plugin-install-review.md`
- Modify: `docs/superpowers/specs/2026-07-27-ark-coding-qualification-prompt-disambiguation-design.md`
- Modify: `docs/superpowers/plans/2026-07-27-ark-coding-qualification-prompt-disambiguation.md`

- [x] **Step 1: Update current Markdown facts without changing qualification status**

Record these facts consistently:

- the latest blocked evidence cryptographically reconstructs `ARK_SMOKE_OK:ark-coding-plan;\n`;
- the offline prompt fixture now uses an exact Node/Base64 Bash command with a separately fenced payload;
- validator, provider/model/direct route, credential, retry/fallback, telemetry, schemas, protocol, and evidence remain unchanged;
- deterministic and isolated checks have passed on the new candidate;
- registry remains 6 passed / 2 pending and install remains `blocked / not ready`;
- no new real model call has occurred;
- a fresh complete `four-llm-v1` batch still requires a new explicit authorization.

Do not claim Ark Coding Plan qualification or installation readiness.

- [x] **Step 2: Create the complete single-file Chinese HTML review brief**

Create `docs/release/four-llm-qualification-authorization-review.html` with this content:

The `44 个文件、569 passed / 1 skipped / 0 failed` line is the expected count after the tests specified by this plan. Before writing the file, compare it with the most recent full `npm test` output recorded in Task 3 Step 7. If independent review changed the test count, replace this count in both the HTML and the Step 3 required-string check with the exact observed values. Never present a predicted or stale count.

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>四模型八项资格批次授权审阅</title>
    <style>
      :root { color-scheme: light; font-family: system-ui, sans-serif; }
      body { max-width: 920px; margin: 0 auto; padding: 32px 20px 64px; line-height: 1.65; color: #1f2937; }
      h1, h2 { color: #111827; line-height: 1.25; }
      .status { border: 2px solid #b45309; background: #fffbeb; padding: 16px; border-radius: 10px; }
      .ok { border-left: 4px solid #047857; background: #ecfdf5; padding: 12px 16px; }
      .stop { border-left: 4px solid #b91c1c; background: #fef2f2; padding: 12px 16px; }
      code { background: #f3f4f6; padding: 0.1em 0.35em; border-radius: 4px; }
      li { margin: 0.35em 0; }
      a { color: #1d4ed8; }
    </style>
  </head>
  <body>
    <h1>四模型八项真实资格批次授权审阅</h1>
    <div class="status">
      <strong>状态：等待明确授权，尚未调用真实模型。</strong>
      本文件本身不是授权，也不是安装权限包。候选的完整 40 位提交由 Codex 在交接消息中提供；它必须等于本文件所在干净工作树的 HEAD。
    </div>

    <h2>为什么需要新批次</h2>
    <p>
      上一批在首项 Ark Coding Plan delegate 停止。双哈希复算证明模型写入的是
      <code>ARK_SMOKE_OK:ark-coding-plan;</code>，分号来自旧提示词中紧邻目标内容的自然语言分隔符。
      路由、模型、凭据隔离、文件范围、必需命令、单次执行和进程清理均已通过。
    </p>

    <h2>Codex 已自动完成</h2>
    <div class="ok">
      <ul>
        <li>将写文件动作改成可复制的 Node + Base64 精确 Bash 命令，并把 payload 独立分隔。</li>
        <li>继续严格拒绝尾部分号、额外行、非法 UTF-8、范围外文件和非精确 git 命令。</li>
        <li>唯一生产改动是 <code>src/smoke/pi.ts</code> 的提示词合同；回归覆盖 <code>pi.test.ts</code>、<code>ark.test.ts</code> 和 <code>result-file-evidence.test.ts</code>。</li>
        <li>类型检查、构建和 release smoke 通过；全量测试为 44 个文件、569 passed / 1 skipped / 0 failed；临时 CODEX_HOME 隔离生命周期 check-report 通过。</li>
        <li>旧批次 immutable verifier、当前批次 5/5 文件、历史 Gemini 14/14 SHA/blob 与目标进程 0/0/0 均通过复核。</li>
        <li>完成独立规格与代码质量复核；没有调用真实模型、安装插件或访问活动 config.toml。</li>
      </ul>
    </div>

    <h2>本次请求的唯一授权</h2>
    <p>
      允许 Codex 只在交接消息列出的 clean frozen commit 上启动一次全新的
      <code>four-llm-v1</code> 完整八项资格批次。固定顺序从 Ark Coding Plan delegate/review
      开始，再执行 Kimi K3、Ark Agent Plan 和 Ark Agent DeepSeek V4 Flash 的 review/delegate。
    </p>
    <ul>
      <li>任一 failed、blocked 或 interrupted 立即停止，后续项记为 not run。</li>
      <li>不 retry、fallback、resume、跳项、复用旧 evidence 或启动第二批。</li>
      <li>只有同批 8/8 passed 才允许后续成对晋级 Ark Coding Plan。</li>
      <li>最多产生八次真实调用并可能消耗对应计划额度；只允许创建一个新 batch evidence 目录。</li>
      <li>授权后才在内存生成一次性 UUID，文档、聊天和日志均不保存 UUID 正文。</li>
      <li>若 preflight 在 batch_started 前失败，本轮命令不会重跑；若 batch_started 已落盘，则任何终态都会消费本次授权。</li>
    </ul>

    <div class="stop">
      <strong>本次授权不包括：</strong>
      活动插件安装或回滚、读取或编辑活动 config.toml、移除 codex_cc_tools、修改 Claude Code、npm/公共 marketplace 发布。
      也不包括把隔离 worktree fast-forward 到长期正式仓库。
    </div>

    <h2>可追溯材料</h2>
    <ul>
      <li><a href="../superpowers/specs/2026-07-27-ark-coding-qualification-prompt-disambiguation-design.md">已确认设计</a></li>
      <li><a href="../superpowers/plans/2026-07-27-ark-coding-qualification-prompt-disambiguation.md">逐任务实施计划</a></li>
      <li><a href="checklist.md">四层发布门禁</a></li>
      <li><a href="real-plugin-install-review.md">当前 blocked / not ready 安装状态包</a></li>
      <li><a href="../smoke/evidence/batches/2026-07-26T17-20-48.464Z-b49aed1d-48fa-40cd-9c73-1388bc91369d/cases/2026-07-26T17-23-31.295Z-ark-coding-plan-delegate-ark.json">上一批首项 case evidence</a>，SHA-256 <code>166947716c19d435155e4ce0d041e4c88b7ef9b79f302787e0c27572eb39e6c9</code></li>
      <li><a href="../smoke/evidence/batches/2026-07-26T17-20-48.464Z-b49aed1d-48fa-40cd-9c73-1388bc91369d/manifest.json">上一批 blocked manifest</a></li>
      <li>blocked manifest SHA-256：<code>f374987c475c291baaef553771ee56562654275bfbd8c15e4b11b26141baa58c</code></li>
    </ul>

    <h2>建议回复</h2>
    <p>
      若同意，请明确回复：<strong>“授权在交接消息所列冻结提交上执行一次完整
      four-llm-v1 八项资格批次。”</strong>
    </p>
  </body>
</html>
```

- [x] **Step 3: Validate the review brief and local links**

```powershell
$review = "docs/release/four-llm-qualification-authorization-review.html"
$html = Get-Content -Raw -Encoding utf8 $review
foreach ($required in @(
  "等待明确授权",
  "尚未调用真实模型",
  "four-llm-v1",
  "不 retry、fallback、resume",
  "本次授权不包括",
  "活动 config.toml",
  "44 个文件、569 passed / 1 skipped / 0 failed",
  "166947716c19d435155e4ce0d041e4c88b7ef9b79f302787e0c27572eb39e6c9",
  "f374987c475c291baaef553771ee56562654275bfbd8c15e4b11b26141baa58c"
)) {
  if (-not $html.Contains($required)) {
    throw "Authorization review is missing: $required"
  }
}
foreach ($path in @(
  "docs/superpowers/specs/2026-07-27-ark-coding-qualification-prompt-disambiguation-design.md",
  "docs/superpowers/plans/2026-07-27-ark-coding-qualification-prompt-disambiguation.md",
  "docs/release/checklist.md",
  "docs/release/real-plugin-install-review.md",
  "docs/smoke/evidence/batches/2026-07-26T17-20-48.464Z-b49aed1d-48fa-40cd-9c73-1388bc91369d/cases/2026-07-26T17-23-31.295Z-ark-coding-plan-delegate-ark.json",
  "docs/smoke/evidence/batches/2026-07-26T17-20-48.464Z-b49aed1d-48fa-40cd-9c73-1388bc91369d/manifest.json"
)) {
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
    throw "Authorization review target is missing: $path"
  }
}
Write-Output "authorizationReview=valid"
```

Expected: `authorizationReview=valid`.

- [x] **Step 4: Run documentation consistency checks**

```powershell
rg -n "ARK_SMOKE_OK:ark-coding-plan;|6 passed / 2 pending|blocked / not ready|four-llm-v1|新.*明确授权" README.md AGENTS.md docs/operations.md docs/smoke/ark.md docs/release/checklist.md docs/release/real-plugin-install-review.md docs/release/four-llm-qualification-authorization-review.html
git diff --check
```

Expected: current docs distinguish “offline fixture repaired” from “real qualification still pending”; no document says 8/8, ready, installed, or replaced.

## Task 6: Freeze the candidate and stop at the human gate

**Files:**

- No tracked changes after the Task 5 documentation commit.

- [ ] **Step 1: Stage and commit the exact final status surface**

```powershell
git add -- README.md AGENTS.md docs/operations.md docs/smoke/ark.md docs/release/checklist.md docs/release/real-plugin-install-review.md docs/release/four-llm-qualification-authorization-review.html docs/superpowers/specs/2026-07-27-ark-coding-qualification-prompt-disambiguation-design.md docs/superpowers/plans/2026-07-27-ark-coding-qualification-prompt-disambiguation.md
git diff --cached --check
if ($LASTEXITCODE -ne 0) {
  throw "Cached diff check failed"
}
git diff --cached --name-status
if ($LASTEXITCODE -ne 0) {
  throw "Could not list cached paths"
}
git diff --quiet -- docs/smoke/evidence
if ($LASTEXITCODE -ne 0) {
  throw "Tracked evidence has unstaged changes"
}
$stagedEvidence = @(git diff --cached --name-only -- docs/smoke/evidence)
$untrackedEvidence = @(git ls-files --others --exclude-standard -- docs/smoke/evidence)
if ($stagedEvidence.Count -ne 0 -or $untrackedEvidence.Count -ne 0) {
  throw "Evidence paths must remain unstaged and contain no untracked files"
}
$expectedStaged = @(
  "AGENTS.md",
  "README.md",
  "docs/operations.md",
  "docs/release/checklist.md",
  "docs/release/four-llm-qualification-authorization-review.html",
  "docs/release/real-plugin-install-review.md",
  "docs/smoke/ark.md",
  "docs/superpowers/plans/2026-07-27-ark-coding-qualification-prompt-disambiguation.md",
  "docs/superpowers/specs/2026-07-27-ark-coding-qualification-prompt-disambiguation-design.md"
)
$actualStaged = @(git diff --cached --name-only)
$unexpected = @($actualStaged | Where-Object { $_ -notin $expectedStaged })
$missing = @($expectedStaged | Where-Object { $_ -notin $actualStaged })
if ($unexpected.Count -ne 0 -or $missing.Count -ne 0) {
  throw "Final staged path whitelist mismatch"
}
git commit -m "docs: prepare four-llm qualification authorization review"
```

Expected: only the listed current-status, design, plan, and review files are committed; evidence diff is empty.

- [ ] **Step 2: Rerun every deterministic and integrity gate on the clean documentation commit**

Repeat Task 3 Steps 1–6 and Task 5 Steps 3–4. Expected: all pass, `git status --short` is empty, and target processes remain 0/0/0.

- [ ] **Step 3: Create an explicit empty frozen-candidate commit**

```powershell
git commit --allow-empty -m "chore: freeze Ark Coding qualification prompt candidate"
```

The resulting 40-character HEAD is the candidate identity supplied alongside the HTML review. Do not edit any tracked file after this commit.

- [ ] **Step 4: Verify the exact committed candidate**

Run fresh against the committed HEAD:

```powershell
npm run typecheck
npm test
npm run build
npm run smoke:release
npm run acceptance:plugin:isolated -- --check-report
npm run qualify:gates -- --help
npm run verify:qualification -- --help
npm run --silent verify:qualification -- --mode immutable-evidence --manifest docs/smoke/evidence/batches/2026-07-26T17-20-48.464Z-b49aed1d-48fa-40cd-9c73-1388bc91369d/manifest.json
npx tsx -e "import('./src/runtime/agent-processes.ts').then(async ({ classifyAgentProcesses }) => { const counts = await classifyAgentProcesses(); console.log(JSON.stringify(counts)); if (counts.kimi.count !== 0 || counts.piRpc.count !== 0 || counts.realSmoke.count !== 0) process.exitCode = 1; })"
git diff --check HEAD^ HEAD
git status --short
git rev-parse HEAD
```

Expected: all commands exit 0; immutable result remains blocked/non-promotable for the existing batch; process counts are 0/0/0; status is empty; the final command prints the exact frozen SHA. Also rerun the exact 5/5 current-batch, 14/14 historical, and legacy immutable blocks from Task 3 before declaring the candidate frozen.

- [ ] **Step 5: Prepare the final Chinese human handoff**

The handoff must contain:

- the full 40-character frozen SHA;
- a clickable link to `docs/release/four-llm-qualification-authorization-review.html`;
- fresh test/build/release/isolated/evidence/process results;
- confirmation that no real model, active install/config, old-tool removal, Claude Code, or publish action occurred;
- the exact authorization sentence from the HTML;
- the statement that execution has stopped before the first real call.

Do not run the qualification batch in the same goal. Mark this offline goal complete only after the review material and clean frozen candidate are both ready.
