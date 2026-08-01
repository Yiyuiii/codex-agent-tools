import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    "codex-external-agents-mcp": "src/mcp/main.ts",
  },
  outDir: "plugins/codex-external-agents/runtime",
  format: ["esm"],
  outExtension: () => ({ js: ".mjs" }),
  platform: "node",
  target: "node24",
  bundle: true,
  noExternal: [/.*/u],
  banner: {
    js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
  },
  splitting: false,
  dts: false,
  sourcemap: false,
  clean: true,
});
