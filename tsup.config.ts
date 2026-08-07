import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    cli: "src/cli/main.ts",
    "kimi-smoke": "src/smoke/kimi.ts",
    "smoke-evidence": "src/smoke/evidence.ts",
    mcp: "src/mcp/main.ts",
    "ark-smoke": "src/smoke/ark.ts",
    "npm-package-acceptance": "src/acceptance/npm-package.ts",
    "plugin-mcp-cleanup": "src/plugin/mcp-cleanup.ts",
    "plugin-isolated-report": "src/plugin/isolated-report.ts",
    "plugin-state-snapshot": "src/plugin/state-snapshot.ts",
    "release-assurance": "src/release/assurance.ts",
    "release-validation": "src/release/release-validation.ts",
    "capability-qualification": "src/qualification/capability-index.ts",
  },
  format: ["esm"],
  splitting: false,
  dts: false,
  clean: true,
  sourcemap: false,
  target: "node24",
});
