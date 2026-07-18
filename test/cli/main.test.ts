import { describe, expect, it, vi } from "vitest";

import { createProgram } from "../../src/cli/main.js";

describe("codex-agent-tools CLI", () => {
  it("parses install and uninstall without exposing model/backend overrides", async () => {
    const install = vi.fn(async () => undefined);
    const uninstall = vi.fn(async () => undefined);
    const program = createProgram({ install, uninstall });

    await program.parseAsync(
      ["node", "codex-agent-tools", "install", "--config", "D:\\config.toml"],
      { from: "node" },
    );
    await program.parseAsync(
      ["node", "codex-agent-tools", "uninstall", "--config", "D:\\config.toml"],
      { from: "node" },
    );

    expect(install).toHaveBeenCalledWith({ configPath: "D:\\config.toml" });
    expect(uninstall).toHaveBeenCalledWith({ configPath: "D:\\config.toml" });
    const help = program.helpInformation();
    expect(help).toContain("install");
    expect(help).toContain("uninstall");
    expect(help).toContain("doctor");
    expect(help).not.toContain("provider");
    expect(help).not.toContain("model");
  });

  it("parses doctor JSON and strict flags", async () => {
    const doctor = vi.fn(async () => undefined);
    const program = createProgram({ doctor });
    await program.parseAsync(
      [
        "node",
        "codex-agent-tools",
        "doctor",
        "--config",
        "D:\\config.toml",
        "--json",
        "--strict",
      ],
      { from: "node" },
    );
    expect(doctor).toHaveBeenCalledWith({
      configPath: "D:\\config.toml",
      json: true,
      strict: true,
    });
  });

  it("parses fail-closed legacy replacement and explicit backup restore", async () => {
    const install = vi.fn(async () => undefined);
    const restore = vi.fn(async () => undefined);
    const program = createProgram({ install, restore });

    await program.parseAsync(
      [
        "node",
        "codex-agent-tools",
        "install",
        "--config",
        "D:\\config.toml",
        "--replace-codex-cc-tools",
      ],
      { from: "node" },
    );
    await program.parseAsync(
      [
        "node",
        "codex-agent-tools",
        "restore",
        "--config",
        "D:\\config.toml",
        "--backup",
        "D:\\config.toml.backup",
      ],
      { from: "node" },
    );

    expect(install).toHaveBeenCalledWith({
      configPath: "D:\\config.toml",
      replaceCodexCcTools: true,
    });
    expect(restore).toHaveBeenCalledWith({
      configPath: "D:\\config.toml",
      backupPath: "D:\\config.toml.backup",
    });
  });

  it("advertises the prerelease package version", () => {
    expect(createProgram().version()).toBe("0.1.0-alpha.1");
  });
});
