import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/version.ts", mcp: "src/mcp/main.ts" },
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
  target: "node20",
});
