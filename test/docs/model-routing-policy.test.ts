import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);

function read(relativePath: string): string {
  return readFileSync(resolve(repositoryRoot, relativePath), "utf8");
}

describe("external model routing policy", () => {
  it("documents plan-backed routes as the default and Direct DeepSeek as API-billed", () => {
    for (const relativePath of ["README.md", "docs/operations.md"]) {
      const content = read(relativePath);
      expect(content).toContain("`kimi-k3`");
      expect(content).toContain("`ark-coding-plan`");
      expect(content).toContain("API 计费");
      expect(content).toContain("Direct `deepseek-v4-flash`");
      expect(content).toContain("优先");
    }
  });

  it("requires invocation-scoped process attribution for host acceptance", () => {
    const content = read("docs/release/real-host-acceptance.md");
    expect(content).toContain("在任何业务调用前记录 PID 与创建时间基线");
    expect(content).toContain("不得把调用后全机非零总数归因于当前调用");
    expect(content).toContain("invocation-scoped cleanup");
  });

  it("identifies the actually exercised isolated plugin candidate", () => {
    const content = read("docs/release/plugin-isolated-state.md");
    expect(content).toContain("候选版本：`0.1.2-beta.2`");
    expect(content).toContain("实际执行日期：2026-08-23");
  });
});
