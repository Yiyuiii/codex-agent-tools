import { describe, expect, it, vi } from "vitest";

import { createProgram } from "../../src/cli/main.js";

describe("codex-agent-tools CLI", () => {
  it("only exposes doctor without Codex config mutation commands or options", () => {
    const program = createProgram();
    const doctor = program.commands.at(0);
    const help = `${program.helpInformation()}\n${doctor?.helpInformation() ?? ""}`;

    expect(program.commands.map((command) => command.name())).toEqual(["doctor"]);
    expect(help).not.toContain("install");
    expect(help).toContain("doctor");
    expect(help).not.toContain("uninstall");
    expect(help).not.toContain("restore");
    expect(help).not.toContain("--config");
    expect(doctor?.description()).toBe(
      "Check external runtimes, routes, credentials, artifacts, and logical LLM gates.",
    );
  });

  it("parses doctor JSON and strict flags", async () => {
    const doctor = vi.fn(async () => undefined);
    const program = createProgram({ doctor });
    await program.parseAsync(
      [
        "node",
        "codex-agent-tools",
        "doctor",
        "--json",
        "--strict",
      ],
      { from: "node" },
    );
    expect(doctor).toHaveBeenCalledWith({
      json: true,
      strict: true,
    });
  });

  it("advertises the beta package version", () => {
    expect(createProgram().version()).toBe("0.1.0-beta.0");
  });
});
