import { describe, expect, expectTypeOf, it } from "vitest";

import type { NetworkPolicy } from "../../src/domain/types.js";
import { buildChildEnvironment } from "../../src/runtime/environment.js";

describe("child environment", () => {
  it("exposes only the direct active network policy", () => {
    expectTypeOf<NetworkPolicy>().toEqualTypeOf<"direct">();
  });

  it("preserves Windows program roots needed by Pi shell discovery", () => {
    const env = buildChildEnvironment(
      { network: "direct", credentialEnv: [] },
      {
        PROGRAMFILES: "C:\\Program Files",
        "programfiles(x86)": "C:\\Program Files (x86)",
        ProgramW6432: "C:\\Program Files",
        HTTP_PROXY: "http://parent:1",
      },
    );

    expect(env).toEqual({
      ProgramFiles: "C:\\Program Files",
      "ProgramFiles(x86)": "C:\\Program Files (x86)",
    });
  });

  it("removes inherited proxies and unrelated credentials for direct profiles", () => {
    const env = buildChildEnvironment(
      { network: "direct", credentialEnv: [] },
      {
        PATH: "C:\\Windows",
        HTTP_PROXY: "http://parent:1",
        HTTPS_PROXY: "http://parent:2",
        ALL_PROXY: "socks5://parent:3",
        http_proxy: "http://parent:4",
        https_proxy: "http://parent:5",
        all_proxy: "socks5://parent:6",
        ANTHROPIC_API_KEY: "secret",
        OPENAI_API_KEY: "secret",
      },
    );

    expect(env.PATH).toBe("C:\\Windows");
    expect(env.HTTP_PROXY).toBeUndefined();
    expect(env.HTTPS_PROXY).toBeUndefined();
    expect(env.http_proxy).toBeUndefined();
    expect(env.https_proxy).toBeUndefined();
    expect(env.ALL_PROXY).toBeUndefined();
    expect(env.all_proxy).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });

  it("copies only explicitly allowed non-empty credential variables", () => {
    const env = buildChildEnvironment(
      { network: "direct", credentialEnv: ["PROJECT_API_KEY", "EMPTY_KEY"] },
      {
        PATH: "x",
        PROJECT_API_KEY: "project-secret",
        EMPTY_KEY: "  ",
        ARK_API_KEY: "ark-secret",
        GEMINI_API_KEY: "retired-google-secret",
        GOOGLE_API_KEY: "retired-google-secret",
      },
    );

    expect(env.PROJECT_API_KEY).toBe("project-secret");
    expect(env.EMPTY_KEY).toBeUndefined();
    expect(env.ARK_API_KEY).toBeUndefined();
    expect(env.GEMINI_API_KEY).toBeUndefined();
    expect(env.GOOGLE_API_KEY).toBeUndefined();
  });

  it("treats credential variables as a priority list and copies only the first", () => {
    const env = buildChildEnvironment(
      {
        network: "direct",
        credentialEnv: [
          "ARK_API_KEY",
          "VOLCENGINE_API_KEY",
          "API_KEY_DOUBAO_CODING",
        ],
      },
      {
        ARK_API_KEY: "primary",
        VOLCENGINE_API_KEY: "secondary",
        API_KEY_DOUBAO_CODING: "tertiary",
      },
    );
    expect(env.ARK_API_KEY).toBe("primary");
    expect(env.VOLCENGINE_API_KEY).toBeUndefined();
    expect(env.API_KEY_DOUBAO_CODING).toBeUndefined();
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
