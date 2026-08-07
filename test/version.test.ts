import { describe, expect, it } from "vitest";

import { PACKAGE_NAME, SERVER_NAME, VERSION } from "../src/version.js";

describe("package identity", () => {
  it("uses the approved external-agent names", () => {
    expect(PACKAGE_NAME).toBe("codex-agent-tools");
    expect(SERVER_NAME).toBe("codex_external_agents");
  });

  it("uses the current stable version", () => {
    expect(VERSION).toBe("0.1.1");
  });
});
