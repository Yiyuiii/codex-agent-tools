import path from "node:path";
import { Readable, Writable } from "node:stream";

import * as acp from "@agentclientprotocol/sdk";

const sessions = new Map();

function configOptions(currentModel) {
  return [
    {
      type: "select",
      id: "model",
      name: "Model",
      category: "model",
      currentValue: currentModel,
      options: [
        { value: "kimi-code/kimi-for-coding", name: "K2.7 Coding" },
        {
          value: "kimi-code/kimi-for-coding-highspeed",
          name: "K2.7 Coding Highspeed",
        },
        { value: "kimi-code/k3", name: "K3" },
      ],
    },
  ];
}

const agent = {
  async initialize() {
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: false,
        sessionCapabilities:
          process.env.FAKE_KIMI_SCENARIO === "no-resume"
            ? {}
            : { resume: {} },
      },
      agentInfo: { name: "fake-kimi-acp", version: "1.0.0" },
    };
  },

  async newSession(params) {
    const sessionId = `fake-session-${sessions.size + 1}`;
    const model = "kimi-code/kimi-for-coding";
    sessions.set(sessionId, { cwd: params.cwd, model, cancel: undefined });
    return {
      sessionId,
      configOptions:
        process.env.FAKE_KIMI_SCENARIO === "no-model" ? [] : configOptions(model),
    };
  },

  async setConfigOption(params) {
    const session = sessions.get(params.sessionId);
    if (!session) throw new Error("unknown session");
    if (params.configId === "model") session.model = params.value;
    return { configOptions: configOptions(session.model) };
  },

  async resumeSession(params) {
    const model = "kimi-code/kimi-for-coding";
    sessions.set(params.sessionId, {
      cwd: params.cwd,
      model,
      cancel: undefined,
    });
    return { configOptions: configOptions(model) };
  },

  async prompt(params, client) {
    const session = sessions.get(params.sessionId);
    if (!session) throw new Error("unknown session");

    if (process.env.FAKE_KIMI_SCENARIO === "hang") {
      await new Promise((resolve) => {
        session.cancel = resolve;
      });
      return { stopReason: "cancelled" };
    }

    const delayMs = Number.parseInt(process.env.FAKE_KIMI_DELAY_MS ?? "0", 10);
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }

    await client.notify(acp.methods.client.session.update, {
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "Inspecting fixture" },
      },
    });
    await client.notify(acp.methods.client.session.update, {
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "read-1",
        title: "Read fixture",
        kind: "read",
        status: "in_progress",
        locations: [{ path: path.join(session.cwd, "fixture.txt") }],
        rawInput: { path: path.join(session.cwd, "fixture.txt") },
      },
    });

    let readContent = "not-read";
    try {
      const read = await client.request(acp.methods.client.fs.readTextFile, {
        sessionId: params.sessionId,
        path:
          process.env.FAKE_KIMI_SCENARIO === "outside-read"
            ? path.resolve(session.cwd, "..", "outside.txt")
            : path.join(session.cwd, "fixture.txt"),
      });
      readContent = read.content;
    } catch {
      readContent = "read-denied";
    }

    let writeDenied = false;
    if (process.env.FAKE_KIMI_SCENARIO === "write-rpc") {
      try {
        await client.request(acp.methods.client.fs.writeTextFile, {
          sessionId: params.sessionId,
          path: path.join(session.cwd, "written.txt"),
          content: "forbidden",
        });
      } catch {
        writeDenied = true;
      }
    }

    const permission = await client.request(
      acp.methods.client.session.requestPermission,
      {
        sessionId: params.sessionId,
        toolCall: {
          toolCallId: "edit-1",
          title: "Edit fixture",
          kind: "edit",
          status: "pending",
          locations: [{ path: path.join(session.cwd, "fixture.txt") }],
        },
        options: [
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "reject", name: "Reject", kind: "reject_once" },
        ],
      },
    );
    const permissionValue =
      permission.outcome.outcome === "selected"
        ? permission.outcome.optionId
        : "cancelled";

    await client.notify(acp.methods.client.session.update, {
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "read-1",
        status: "completed",
      },
    });
    await client.notify(acp.methods.client.session.update, {
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: `model=${session.model};read=${readContent};permission=${permissionValue};writeDenied=${writeDenied}`,
        },
      },
    });
    return { stopReason: "end_turn" };
  },

  async cancel(params) {
    const session = sessions.get(params.sessionId);
    session?.cancel?.();
  },
};

if (process.env.FAKE_KIMI_STDERR) {
  process.stderr.write(`${process.env.FAKE_KIMI_STDERR}\n`);
}

const stream = acp.ndJsonStream(
  Writable.toWeb(process.stdout),
  Readable.toWeb(process.stdin),
);

acp
  .agent({ name: "fake-kimi-acp" })
  .onRequest(acp.methods.agent.initialize, (ctx) => agent.initialize(ctx.params))
  .onRequest(acp.methods.agent.session.new, (ctx) => agent.newSession(ctx.params))
  .onRequest(acp.methods.agent.session.setConfigOption, (ctx) =>
    agent.setConfigOption(ctx.params),
  )
  .onRequest(acp.methods.agent.session.resume, (ctx) =>
    agent.resumeSession(ctx.params),
  )
  .onRequest(acp.methods.agent.session.prompt, (ctx) =>
    agent.prompt(ctx.params, ctx.client),
  )
  .onNotification(acp.methods.agent.session.cancel, (ctx) =>
    agent.cancel(ctx.params),
  )
  .connect(stream);
