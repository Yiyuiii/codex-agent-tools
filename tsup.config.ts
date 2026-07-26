import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/version.ts",
    cli: "src/cli/main.ts",
    "kimi-smoke": "src/smoke/kimi.ts",
    "smoke-evidence": "src/smoke/evidence.ts",
    mcp: "src/mcp/main.ts",
    "pi-smoke": "src/smoke/pi.ts",
    "ark-smoke": "src/smoke/ark.ts",
    "local-acceptance": "src/acceptance/local.ts",
    "plugin-mcp-cleanup": "src/plugin/mcp-cleanup.ts",
    "plugin-state-snapshot": "src/plugin/state-snapshot.ts",
    "release-assurance": "src/release/assurance.ts",
    qualification: "src/qualification/manifest.ts",
  },
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
  target: "node20",
});
