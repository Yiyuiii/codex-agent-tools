import { describe, expect, expectTypeOf, it } from "vitest";

import type { NetworkPolicy } from "../../src/domain/types.js";
import {
  buildChildEnvironment,
  buildPiChildEnvironment,
} from "../../src/runtime/environment.js";

describe("child environment", () => {
  const invalidEnvironmentError = "Invalid child environment";

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
      "win32",
    );

    expect(env).toEqual({
      ProgramFiles: "C:\\Program Files",
      "ProgramFiles(x86)": "C:\\Program Files (x86)",
    });
  });

  it("preserves current Windows identity keys under canonical names", () => {
    const env = buildChildEnvironment(
      { network: "direct", credentialEnv: [] },
      {
        homedrive: "C:",
        HomePath: "\\Users\\runner",
        LOGONSERVER: "\\\\DOMAIN-CONTROLLER",
        systemdrive: "C:",
        UserDomain: "EXAMPLE",
        username: "runner",
      },
      "win32",
    );

    expect(env).toEqual({
      HOMEDRIVE: "C:",
      HOMEPATH: "\\Users\\runner",
      LOGONSERVER: "\\\\DOMAIN-CONTROLLER",
      SYSTEMDRIVE: "C:",
      USERDOMAIN: "EXAMPLE",
      USERNAME: "runner",
    });
  });

  it("rejects ambiguous case variants of a consumed system key without naming it", () => {
    expect(() =>
      buildChildEnvironment(
        { network: "direct", credentialEnv: [] },
        { PATH: "C:\\one", Path: "C:\\two" },
        "win32",
      ),
    ).toThrowError(new Error(invalidEnvironmentError));
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
        anthropic_api_key: "other-secret",
        OPENAI_API_KEY: "secret",
      },
      "win32",
    );

    expect(env.PATH).toBe("C:\\Windows");
    expect(env.HTTP_PROXY).toBeUndefined();
    expect(env.HTTPS_PROXY).toBeUndefined();
    expect(env.http_proxy).toBeUndefined();
    expect(env.https_proxy).toBeUndefined();
    expect(env.ALL_PROXY).toBeUndefined();
    expect(env.all_proxy).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.anthropic_api_key).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });

  it("copies only explicitly allowed non-empty credential variables", () => {
    const env = buildChildEnvironment(
      { network: "direct", credentialEnv: ["PROJECT_API_KEY", "EMPTY_KEY"] },
      {
        PATH: "x",
        project_api_key: "project-secret",
        EMPTY_KEY: "  ",
        ARK_API_KEY: "ark-secret",
        GEMINI_API_KEY: "retired-google-secret",
        GOOGLE_API_KEY: "retired-google-secret",
      },
      "win32",
    );

    expect(env.PROJECT_API_KEY).toBe("project-secret");
    expect(env.EMPTY_KEY).toBeUndefined();
    expect(env.ARK_API_KEY).toBeUndefined();
    expect(env.GEMINI_API_KEY).toBeUndefined();
    expect(env.GOOGLE_API_KEY).toBeUndefined();
  });

  it("rejects ambiguous case variants of the selected credential without naming it", () => {
    expect(() =>
      buildChildEnvironment(
        { network: "direct", credentialEnv: ["PROJECT_API_KEY"] },
        {
          PROJECT_API_KEY: "first-secret",
          project_api_key: "second-secret",
        },
        "win32",
      ),
    ).toThrowError(new Error(invalidEnvironmentError));
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

  it("does not inspect ambiguous lower-priority credentials after selecting the first", () => {
    const env = buildChildEnvironment(
      {
        network: "direct",
        credentialEnv: ["PRIMARY_KEY", "SECONDARY_KEY"],
      },
      {
        PRIMARY_KEY: "primary",
        SECONDARY_KEY: "secondary-one",
        secondary_key: "secondary-two",
      },
      "win32",
    );

    expect(env).toEqual({ PRIMARY_KEY: "primary" });
  });

  it.each([
    {
      policy: {
        network: "direct" as const,
        credentialEnv: ["path"],
      },
      parent: { PATH: "C:\\Windows" },
    },
    {
      policy: {
        network: "direct" as const,
        credentialEnv: ["PROJECT_API_KEY"],
        credentialTargetEnv: "Path",
      },
      parent: { PROJECT_API_KEY: "secret" },
    },
  ])(
    "rejects system and credential namespace collisions without exposing names or values",
    ({ policy, parent }) => {
      expect(() => buildChildEnvironment(policy, parent, "win32")).toThrowError(
        new Error(invalidEnvironmentError),
      );
    },
  );

  it("keeps POSIX base and credential lookup case-sensitive", () => {
    const env = buildChildEnvironment(
      { network: "direct", credentialEnv: ["Path"] },
      {
        PATH: "/usr/local/bin",
        Path: "posix-credential",
        HOMEDRIVE: "must-not-cross-platform",
        USERNAME: "must-not-cross-platform",
      },
      "linux",
    );

    expect(env).toEqual({
      PATH: "/usr/local/bin",
      Path: "posix-credential",
    });
  });

  it("uses the legacy case-insensitive POSIX fallback when no exact credential exists", () => {
    const env = buildChildEnvironment(
      {
        network: "direct",
        credentialEnv: ["PROJECT_API_KEY"],
        credentialTargetEnv: "PRIVATE_KEY",
      },
      { project_api_key: "fallback-secret" },
      "linux",
    );

    expect(env).toEqual({ PRIVATE_KEY: "fallback-secret" });
  });

  it("prefers an exact POSIX credential over a case-insensitive fallback", () => {
    const env = buildChildEnvironment(
      {
        network: "direct",
        credentialEnv: ["PROJECT_API_KEY"],
      },
      {
        PROJECT_API_KEY: "exact-secret",
        project_api_key: "fallback-secret",
      },
      "linux",
    );

    expect(env).toEqual({ PROJECT_API_KEY: "exact-secret" });
  });

  it.each([
    {
      policy: {
        network: "direct" as const,
        credentialEnv: ["PATH"],
      },
      parent: { PATH: "/usr/bin" },
      expected: { PATH: "/usr/bin" },
    },
    {
      policy: {
        network: "direct" as const,
        credentialEnv: ["PROJECT_API_KEY"],
        credentialTargetEnv: "PATH",
      },
      parent: {
        PATH: "/usr/bin",
        PROJECT_API_KEY: "credential-overwrite",
      },
      expected: { PATH: "credential-overwrite" },
    },
  ])(
    "preserves legacy POSIX writes when credential names overlap base names",
    ({ policy, parent, expected }) => {
      expect(buildChildEnvironment(policy, parent, "linux")).toEqual(expected);
    },
  );

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

  it("preserves the existing missing-credential error contract", () => {
    expect(() =>
      buildChildEnvironment(
        {
          network: "direct",
          credentialEnv: ["PRIMARY_KEY", "SECONDARY_KEY"],
          credentialTargetEnv: "PRIVATE_KEY",
        },
        {},
      ),
    ).toThrow("Missing credential: PRIMARY_KEY or SECONDARY_KEY");
  });

  describe("Pi runtime environment", () => {
    it("adds only the isolated Pi directory after building the Windows child environment", () => {
      const env = buildPiChildEnvironment(
        {
          network: "direct",
          credentialEnv: ["PROJECT_API_KEY"],
          credentialTargetEnv: "PRIVATE_KEY",
        },
        "C:\\isolated\\pi-agent",
        {
          PATH: "C:\\Windows",
          PROJECT_API_KEY: "selected-secret",
          PI_CODING_AGENT_DIR: "C:\\poison\\canonical",
          pi_coding_agent_dir: "C:\\poison\\variant",
          HTTPS_PROXY: "http://parent:1",
          UNRELATED_SECRET: "forbidden",
        },
        "win32",
      );

      expect(env).toEqual({
        PATH: "C:\\Windows",
        PRIVATE_KEY: "selected-secret",
        PI_CODING_AGENT_DIR: "C:\\isolated\\pi-agent",
      });
    });

    it.each([
      {
        policy: {
          network: "direct" as const,
          credentialEnv: ["pi_coding_agent_dir"],
        },
      },
      {
        policy: {
          network: "direct" as const,
          credentialEnv: ["PROJECT_API_KEY"],
          credentialTargetEnv: "Pi_Coding_Agent_Dir",
        },
      },
    ])(
      "rejects Windows credential and Pi runtime namespace collisions without disclosing values",
      ({ policy }) => {
        expect(() =>
          buildPiChildEnvironment(
            policy,
            "C:\\isolated\\pi-agent",
            { PROJECT_API_KEY: "selected-secret" },
            "win32",
          ),
        ).toThrowError(new Error(invalidEnvironmentError));
      },
    );

    it.each([
      {
        policy: {
          network: "direct" as const,
          credentialEnv: ["PI_CODING_AGENT_DIR"],
        },
      },
      {
        policy: {
          network: "direct" as const,
          credentialEnv: ["PROJECT_API_KEY"],
          credentialTargetEnv: "PI_CODING_AGENT_DIR",
        },
      },
    ])(
      "rejects exact POSIX credential and Pi runtime namespace collisions",
      ({ policy }) => {
        expect(() =>
          buildPiChildEnvironment(
            policy,
            "/isolated/pi-agent",
            { PROJECT_API_KEY: "selected-secret" },
            "linux",
          ),
        ).toThrowError(new Error(invalidEnvironmentError));
      },
    );

    it("preserves a distinct POSIX credential name while replacing the exact parent Pi runtime", () => {
      const env = buildPiChildEnvironment(
        {
          network: "direct",
          credentialEnv: ["PROJECT_API_KEY", "pi_coding_agent_dir"],
          credentialTargetEnv: "PRIVATE_KEY",
        },
        "/isolated/pi-agent",
        {
          PATH: "/usr/bin",
          PI_CODING_AGENT_DIR: "/poison/canonical",
          pi_coding_agent_dir: "lowercase-credential",
        },
        "linux",
      );

      expect(env).toEqual({
        PATH: "/usr/bin",
        PRIVATE_KEY: "lowercase-credential",
        PI_CODING_AGENT_DIR: "/isolated/pi-agent",
      });
    });

    it.each(["", "   ", "C:\\isolated\0pi-agent"])(
      "rejects an invalid Pi runtime value with a fixed error",
      (piCodingAgentDir) => {
        expect(() =>
          buildPiChildEnvironment(
            { network: "direct", credentialEnv: [] },
            piCodingAgentDir,
            {},
            "win32",
          ),
        ).toThrowError(new Error(invalidEnvironmentError));
      },
    );
  });
});
