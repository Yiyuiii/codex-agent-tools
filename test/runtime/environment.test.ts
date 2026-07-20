import { describe, expect, it } from "vitest";

import { buildChildEnvironment } from "../../src/runtime/environment.js";

describe("child environment", () => {
  it("removes inherited proxies and unrelated credentials for direct profiles", () => {
    const env = buildChildEnvironment(
      { network: "direct", credentialEnv: [] },
      {
        PATH: "C:\\Windows",
        HTTPS_PROXY: "http://secret-proxy",
        http_proxy: "http://secret-proxy",
        ALL_PROXY: "socks5://secret-proxy",
        all_proxy: "socks5://secret-proxy",
        ANTHROPIC_API_KEY: "secret",
        OPENAI_API_KEY: "secret",
      },
    );

    expect(env.PATH).toBe("C:\\Windows");
    expect(env.HTTPS_PROXY).toBeUndefined();
    expect(env.http_proxy).toBeUndefined();
    expect(env.ALL_PROXY).toBeUndefined();
    expect(env.all_proxy).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });

  it.each([
    ["proxy-10808", "http://127.0.0.1:10808"],
    ["proxy-11808", "http://127.0.0.1:11808"],
  ] as const)("injects only the fixed %s route", (network, expectedProxy) => {
    const env = buildChildEnvironment(
      { network, credentialEnv: [] },
      { Path: "C:\\bin", HTTPS_PROXY: "http://parent:9999" },
    );

    expect(env.PATH).toBe("C:\\bin");
    expect(env.HTTP_PROXY).toBe(expectedProxy);
    expect(env.HTTPS_PROXY).toBe(expectedProxy);
    expect(env.http_proxy).toBe(expectedProxy);
    expect(env.https_proxy).toBe(expectedProxy);
    expect(env.ALL_PROXY).toBeUndefined();
    expect(env.all_proxy).toBeUndefined();
  });

  it("copies only explicitly allowed non-empty credential variables", () => {
    const env = buildChildEnvironment(
      { network: "direct", credentialEnv: ["GEMINI_API_KEY", "EMPTY_KEY"] },
      {
        PATH: "x",
        GEMINI_API_KEY: "gemini-secret",
        EMPTY_KEY: "  ",
        ARK_API_KEY: "ark-secret",
      },
    );

    expect(env.GEMINI_API_KEY).toBe("gemini-secret");
    expect(env.EMPTY_KEY).toBeUndefined();
    expect(env.ARK_API_KEY).toBeUndefined();
  });

  it("treats credential variables as a priority list and copies only the first", () => {
    const env = buildChildEnvironment(
      {
        network: "direct",
        credentialEnv: [
          "GEMINI_API_KEY",
          "GOOGLE_API_KEY",
          "GOOGLE_GENERATIVE_AI_API_KEY",
        ],
      },
      {
        GEMINI_API_KEY: "primary",
        GOOGLE_API_KEY: "secondary",
        GOOGLE_GENERATIVE_AI_API_KEY: "tertiary",
      },
    );
    expect(env.GEMINI_API_KEY).toBe("primary");
    expect(env.GOOGLE_API_KEY).toBeUndefined();
    expect(env.GOOGLE_GENERATIVE_AI_API_KEY).toBeUndefined();
  });

  it("normalizes Ark credentials to one private child variable", () => {
    const env = buildChildEnvironment(
      {
        network: "direct",
        credentialEnv: [
          "ARK_API_KEY",
          "VOLCENGINE_API_KEY",
          "API_KEY_DOUBAO_CODING",
        ],
        credentialTargetEnv: "CODEX_AGENT_ARK_CODING_KEY",
      },
      {
        PATH: "C:\\bin",
        API_KEY_DOUBAO_CODING: "ark-local",
        ANTHROPIC_API_KEY: "forbidden",
        OPENAI_API_KEY: "forbidden",
        DEEPSEEK_API_KEY: "forbidden",
        GEMINI_API_KEY: "forbidden",
        KIMI_API_KEY: "forbidden",
        HTTPS_PROXY: "http://parent:9999",
      },
    );

    expect(env).toEqual({
      PATH: "C:\\bin",
      CODEX_AGENT_ARK_CODING_KEY: "ark-local",
    });
  });
});
