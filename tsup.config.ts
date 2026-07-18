import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/version.ts" },
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
  target: "node20",
});
