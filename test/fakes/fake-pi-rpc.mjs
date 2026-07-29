import { appendFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";

const scenario = process.env.FAKE_PI_SCENARIO ?? "normal";
const logPath = process.env.FAKE_PI_LOG;
const childPidPath = process.env.FAKE_PI_CHILD_PID_FILE;
const argv = process.argv.slice(2);
let buffer = Buffer.alloc(0);
let grandchild;
let selectedModel = "ark-code-latest";
let selectedProvider = "ark-agent-plan";
const providerApis = {
  "ark-coding-plan": "anthropic-messages",
  "ark-agent-plan": "anthropic-messages",
};

function log(value) {
  if (logPath) appendFileSync(logPath, `${JSON.stringify(value)}\n`, "utf8");
}

function emit(value) {
  const line = `${JSON.stringify(value)}\r\n`;
  const split = Math.max(1, Math.floor(line.length / 2));
  process.stdout.write(line.slice(0, split));
  process.stdout.write(line.slice(split));
}

function spawnGrandchild() {
  grandchild = spawn(
    process.execPath,
    ["-e", "setInterval(() => {}, 1000)"],
    { stdio: "ignore", windowsHide: true },
  );
  if (childPidPath) writeFileSync(childPidPath, String(grandchild.pid), "utf8");
}

function handle(command) {
  log({ kind: "command", value: command });
  if (command.type === "set_model") {
    selectedModel = command.modelId;
    selectedProvider = command.provider;
    const responseProvider =
      scenario === "provider-mismatch" ? "unexpected-provider" : command.provider;
    emit({
      id: command.id,
      type: "response",
      command: "set_model",
      success: true,
      data: {
        id: command.modelId,
        provider: responseProvider,
        api: providerApis[command.provider],
      },
    });
    return;
  }
  if (command.type === "set_thinking_level") {
    emit({
      id: command.id,
      type: "response",
      command: "set_thinking_level",
      success: true,
    });
    return;
  }
  if (
    command.type === "set_auto_retry" ||
    command.type === "set_auto_compaction"
  ) {
    emit({
      id: command.id,
      type: "response",
      command: command.type,
      success: true,
    });
    return;
  }
  if (command.type === "prompt") {
    emit({
      id: command.id,
      type: "response",
      command: "prompt",
      success: true,
    });
    if (scenario === "exit") {
      setTimeout(() => process.exit(7), 5);
      return;
    }
    if (scenario === "hold") {
      spawnGrandchild();
      return;
    }
    if (scenario === "api-error") {
      setTimeout(() => {
        emit({
          type: "message_end",
          message: {
            role: "assistant",
            model: selectedModel,
            provider: selectedProvider,
            content: [],
            stopReason: "error",
            errorMessage: "upstream rejected fake-secret",
          },
        });
        emit({ type: "agent_end", messages: [], willRetry: false });
        emit({ type: "agent_settled" });
      }, 5);
      return;
    }
    if (
      scenario === "runtime-identity-mismatch" ||
      scenario === "runtime-identity-mismatch-failed" ||
      scenario === "runtime-identity-mismatch-cancelled"
    ) {
      const failed = scenario === "runtime-identity-mismatch-failed";
      emit({
        type: "message_end",
        message: {
          role: "assistant",
          model: "runtime-model-fake-secret",
          provider: "runtime-provider-fake-secret",
          content: failed
            ? []
            : [{ type: "text", text: "Runtime identity mismatch." }],
          stopReason: failed ? "error" : "stop",
          ...(failed
            ? { errorMessage: "runtime failed with fake-secret" }
            : {}),
        },
      });
      if (scenario === "runtime-identity-mismatch-cancelled") {
        spawnGrandchild();
        return;
      }
      emit({ type: "agent_end", messages: [], willRetry: false });
      emit({ type: "agent_settled" });
      return;
    }
    if (scenario === "runtime-identity-missing") {
      emit({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Runtime identity missing." }],
          stopReason: "stop",
        },
      });
      emit({ type: "agent_end", messages: [], willRetry: false });
      emit({ type: "agent_settled" });
      return;
    }
    if (scenario === "runtime-identity-agent-end-only") {
      emit({
        type: "agent_end",
        messages: [
          {
            role: "assistant",
            model: "agent-end-model-fake-secret",
            provider: "agent-end-provider-fake-secret",
            content: [{ type: "text", text: "Agent-end-only result." }],
            stopReason: "stop",
          },
        ],
        willRetry: false,
      });
      emit({ type: "agent_settled" });
      return;
    }
    if (scenario === "retry-success") {
      setTimeout(() => {
        emit({
          type: "message_end",
          message: {
            role: "assistant",
            model: selectedModel,
            provider: selectedProvider,
            content: [],
            stopReason: "error",
            errorMessage: "temporary quota fake-secret",
          },
        });
        emit({ type: "agent_end", messages: [], willRetry: true });
        emit({
          type: "auto_retry_start",
          attempt: 1,
          maxAttempts: 4,
          delayMs: 1,
          errorMessage: "temporary quota fake-secret",
        });
        emit({
          type: "message_end",
          message: {
            role: "assistant",
            model: selectedModel,
            provider: selectedProvider,
            content: [{ type: "text", text: "Recovered after retry." }],
            stopReason: "stop",
          },
        });
        emit({ type: "auto_retry_end", success: true, attempt: 1 });
        emit({ type: "agent_end", messages: [], willRetry: false });
        emit({ type: "agent_settled" });
      }, 5);
      return;
    }
    if (scenario === "retry-final-identity-mismatch") {
      setTimeout(() => {
        emit({
          type: "message_end",
          message: {
            role: "assistant",
            model: selectedModel,
            provider: selectedProvider,
            content: [],
            stopReason: "error",
            errorMessage: "temporary quota fake-secret",
          },
        });
        emit({ type: "agent_end", messages: [], willRetry: true });
        emit({ type: "auto_retry_start", attempt: 1 });
        emit({
          type: "message_end",
          message: {
            role: "assistant",
            model: "retry-model-fake-secret",
            provider: "retry-provider-fake-secret",
            content: [{ type: "text", text: "Retry fallback result." }],
            stopReason: "stop",
          },
        });
        emit({ type: "auto_retry_end", success: true, attempt: 1 });
        emit({ type: "agent_end", messages: [], willRetry: false });
        emit({ type: "agent_settled" });
      }, 5);
      return;
    }
    if (scenario === "retry-two") {
      setTimeout(() => {
        for (const attempt of [1, 2]) {
          emit({ type: "agent_end", messages: [], willRetry: true });
          emit({
            type: "auto_retry_start",
            attempt,
            maxAttempts: 4,
            delayMs: 1,
            errorMessage: `temporary quota fake-secret attempt ${attempt}`,
          });
          emit({ type: "auto_retry_end", success: true, attempt });
        }
        emit({
          type: "message_end",
          message: {
            role: "assistant",
            model: selectedModel,
            provider: selectedProvider,
            content: [{ type: "text", text: "Recovered after two retries." }],
            stopReason: "stop",
          },
        });
        emit({ type: "agent_end", messages: [], willRetry: false });
        emit({ type: "agent_settled" });
      }, 5);
      return;
    }
    if (scenario === "retry-two-will-only") {
      setTimeout(() => {
        emit({ type: "agent_end", messages: [], willRetry: true });
        emit({ type: "compaction_end", willRetry: true });
        emit({
          type: "message_end",
          message: {
            role: "assistant",
            model: selectedModel,
            provider: selectedProvider,
            content: [{ type: "text", text: "Two willRetry signals." }],
            stopReason: "stop",
          },
        });
        emit({ type: "agent_settled" });
      }, 5);
      return;
    }
    if (scenario === "retry-signal-after") {
      setTimeout(() => {
        emit({ type: "auto_retry_start", attempt: 1 });
        emit({ type: "auto_retry_end", success: true, attempt: 1 });
        emit({ type: "agent_end", messages: [], willRetry: true });
        emit({
          type: "message_end",
          message: {
            role: "assistant",
            model: selectedModel,
            provider: selectedProvider,
            content: [{ type: "text", text: "Signal followed explicit retry." }],
            stopReason: "stop",
          },
        });
        emit({ type: "agent_settled" });
      }, 5);
      return;
    }
    if (scenario === "retry-duplicates") {
      setTimeout(() => {
        emit({ type: "auto_retry_start", attempt: 1 });
        emit({ type: "auto_retry_start", attempt: 1 });
        emit({ type: "auto_retry_end", success: true, attempt: 1 });
        emit({ type: "auto_retry_end", success: true, attempt: 1 });
        emit({
          type: "message_end",
          message: {
            role: "assistant",
            model: selectedModel,
            provider: selectedProvider,
            content: [{ type: "text", text: "Duplicate retry events." }],
            stopReason: "stop",
          },
        });
        emit({ type: "agent_settled" });
      }, 5);
      return;
    }
    if (scenario === "retry-overlapping") {
      setTimeout(() => {
        emit({ type: "auto_retry_start", attempt: 1 });
        emit({ type: "auto_retry_start", attempt: 2 });
        emit({ type: "auto_retry_end", success: true, attempt: 2 });
        emit({
          type: "message_end",
          message: {
            role: "assistant",
            model: selectedModel,
            provider: selectedProvider,
            content: [{ type: "text", text: "Overlapping retry attempts." }],
            stopReason: "stop",
          },
        });
        emit({ type: "agent_settled" });
      }, 5);
      return;
    }
    if (scenario === "retry-unbalanced") {
      setTimeout(() => {
        emit({
          type: "auto_retry_start",
          attempt: 1,
          errorMessage: "unbalanced retry fake-secret",
        });
        emit({
          type: "message_end",
          message: {
            role: "assistant",
            model: selectedModel,
            provider: selectedProvider,
            content: [{ type: "text", text: "Unbalanced retry result." }],
            stopReason: "stop",
          },
        });
        emit({ type: "agent_settled" });
      }, 5);
      return;
    }
    if (scenario === "compaction-retry") {
      setTimeout(() => {
        emit({
          type: "compaction_end",
          willRetry: true,
          errorMessage: "compaction retry fake-secret",
        });
        emit({
          type: "message_end",
          message: {
            role: "assistant",
            model: selectedModel,
            provider: selectedProvider,
            content: [{ type: "text", text: "Compaction retry result." }],
            stopReason: "stop",
          },
        });
        emit({ type: "agent_settled" });
      }, 5);
      return;
    }
    if (
      scenario === "compaction-and-explicit" ||
      scenario === "agent-explicit-compaction"
    ) {
      setTimeout(() => {
        if (scenario === "agent-explicit-compaction") {
          emit({ type: "agent_end", messages: [], willRetry: true });
        }
        if (scenario === "compaction-and-explicit") {
          emit({
            type: "compaction_end",
            willRetry: true,
            errorMessage: "independent compaction retry fake-secret",
          });
        }
        emit({
          type: "auto_retry_start",
          attempt: 1,
          errorMessage: "explicit retry fake-secret",
        });
        emit({ type: "auto_retry_end", success: true, attempt: 1 });
        if (scenario === "agent-explicit-compaction") {
          emit({
            type: "compaction_end",
            willRetry: true,
            errorMessage: "independent compaction retry fake-secret",
          });
        }
        emit({
          type: "message_end",
          message: {
            role: "assistant",
            model: selectedModel,
            provider: selectedProvider,
            content: [{ type: "text", text: "Independent retry sources." }],
            stopReason: "stop",
          },
        });
        emit({ type: "agent_settled" });
      }, 5);
      return;
    }
    setTimeout(() => {
      const tools = argv[argv.indexOf("--tools") + 1] ?? "";
      const toolName = tools.includes("bash") ? "bash" : "read";
      const args =
        toolName === "bash"
          ? { command: "git status --short" }
          : { path: "README.md" };
      emit({ type: "future_event", secret: "fake-secret" });
      emit({
        type: "message_end",
        message: {
          role: "assistant",
          model: selectedModel,
          provider: selectedProvider,
          content: [{ type: "text", text: "Pi says hello." }],
        },
      });
      emit({
        type: "tool_execution_start",
        toolCallId: "tool-1",
        toolName,
        args,
      });
      const oversizedEnd =
        scenario === "oversized-tool-end-error" ||
        scenario === "oversized-tool-end-nonboolean";
      const endEvent = {
        type: "tool_execution_end",
        toolCallId: "tool-1",
        toolName,
        result: {
          content: [
            {
              type: "text",
              text: oversizedEnd ? "x".repeat(70_000) : "ok",
            },
          ],
        },
        isError:
          scenario === "oversized-tool-end-error"
            ? true
            : scenario === "oversized-tool-end-nonboolean"
              ? "false"
              : false,
      };
      emit(endEvent);
      emit({ type: "agent_end", messages: [], willRetry: false });
      const stderrBytes = Number.parseInt(
        process.env.FAKE_PI_STDERR_BYTES ?? "0",
        10,
      );
      if (stderrBytes > 0) process.stderr.write("x".repeat(stderrBytes));
      emit({ type: "agent_settled" });
      process.stderr.write("Authorization: Bearer fake-secret\n");
    }, 5);
    return;
  }
  if (command.type === "abort") {
    emit({
      id: command.id,
      type: "response",
      command: "abort",
      success: true,
    });
  }
}

log({ kind: "argv", value: argv });
process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const end = buffer.indexOf(0x0a);
    if (end < 0) break;
    let record = buffer.subarray(0, end);
    buffer = buffer.subarray(end + 1);
    if (record.at(-1) === 0x0d) record = record.subarray(0, -1);
    handle(JSON.parse(record.toString("utf8")));
  }
});

setInterval(() => {}, 1000);
