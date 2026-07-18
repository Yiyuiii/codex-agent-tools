import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/version.ts",
    cli: "src/cli/main.ts",
    "kimi-smoke": "src/smoke/kimi.ts",
    mcp: "src/mcp/main.ts",
    "pi-smoke": "src/smoke/pi.ts",
    "release-assurance": "src/release/assurance.ts",
  },
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
  target: "node20",
});
