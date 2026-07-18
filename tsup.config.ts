import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/version.ts",
    cli: "src/cli/main.ts",
    "kimi-smoke": "src/smoke/kimi.ts",
    mcp: "src/mcp/main.ts",
    "pi-smoke": "src/smoke/pi.ts",
    "ark-smoke": "src/smoke/ark.ts",
    "local-acceptance": "src/acceptance/local.ts",
    "release-assurance": "src/release/assurance.ts",
  },
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
  target: "node20",
});
