import { appendFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";

const scenario = process.env.FAKE_PI_SCENARIO ?? "normal";
const logPath = process.env.FAKE_PI_LOG;
const childPidPath = process.env.FAKE_PI_CHILD_PID_FILE;
const argv = process.argv.slice(2);
let buffer = Buffer.alloc(0);
let grandchild;
let selectedModel = "gemini-3.5-flash";
let selectedProvider = "google";
const providerApis = {
  google: "google-generative-ai",
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
    emit({
      id: command.id,
      type: "response",
      command: "set_model",
      success: true,
      data: {
        id: command.modelId,
        provider: command.provider,
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
            model: "glm-5.2",
            provider: "ark-agent-plan",
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
    if (scenario === "retry-success") {
      setTimeout(() => {
        emit({
          type: "message_end",
          message: {
            role: "assistant",
            model: "gemini-3.5-flash",
            provider: "google",
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
            model: "gemini-3.5-flash",
            provider: "google",
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
      emit({
        type: "tool_execution_end",
        toolCallId: "tool-1",
        toolName,
        result: { content: [{ type: "text", text: "ok" }] },
        isError: false,
      });
      emit({ type: "agent_end", messages: [], willRetry: false });
      emit({ type: "agent_settled" });
      const stderrBytes = Number.parseInt(
        process.env.FAKE_PI_STDERR_BYTES ?? "0",
        10,
      );
      if (stderrBytes > 0) process.stderr.write("x".repeat(stderrBytes));
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
