import { describe, expect, it } from "vitest";

import {
  decidePermission,
  selectPermissionResponse,
} from "../../../src/adapters/kimi/permissions.js";

describe("Kimi ACP permissions", () => {
  it("allows review reads and searches only when every path is inside cwd", () => {
    const cwd = "C:\\work";
    expect(
      decidePermission("review", cwd, {
        kind: "read",
        locations: [{ path: "C:\\work\\src\\a.ts" }],
      }),
    ).toBe("allow");
    expect(
      decidePermission("review", cwd, {
        kind: "search",
        locations: [{ path: "C:\\work" }],
      }),
    ).toBe("allow");
    expect(
      decidePermission("review", cwd, {
        kind: "read",
        locations: [{ path: "C:\\work-around\\secret.txt" }],
      }),
    ).toBe("deny");
    expect(decidePermission("review", cwd, { kind: "read" })).toBe("deny");
  });

  it.each(["edit", "delete", "move", "execute", "fetch", "other"])(
    "denies review tool kind %s",
    (kind) => {
      expect(
        decidePermission("review", "C:\\work", {
          kind,
          locations: [{ path: "C:\\work\\a.ts" }],
        }),
      ).toBe("deny");
    },
  );

  it("allows delegate permissions because the public tool is destructive", () => {
    expect(
      decidePermission("delegate", "C:\\work", {
        kind: "execute",
        locations: [{ path: "C:\\outside" }],
      }),
    ).toBe("allow");
  });

  it("selects one-shot allow/reject options and cancels if rejection is unavailable", () => {
    const options = [
      { optionId: "always", kind: "allow_always" },
      { optionId: "once", kind: "allow_once" },
      { optionId: "reject", kind: "reject_once" },
    ];
    expect(selectPermissionResponse("allow", options)).toEqual({
      outcome: { outcome: "selected", optionId: "once" },
    });
    expect(selectPermissionResponse("deny", options)).toEqual({
      outcome: { outcome: "selected", optionId: "reject" },
    });
    expect(
      selectPermissionResponse("deny", [
        { optionId: "once", kind: "allow_once" },
      ]),
    ).toEqual({ outcome: { outcome: "cancelled" } });
  });
});
