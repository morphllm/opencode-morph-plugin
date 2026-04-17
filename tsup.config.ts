import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["index.ts"],
  format: ["esm"],
  platform: "node",
  target: "node18",
  dts: true,
  sourcemap: true,
  clean: true,
  outDir: "dist",
  external: ["@opencode-ai/plugin", "@opencode-ai/sdk"],
  noExternal: [/^@morphllm\/morphsdk(?:\/.*)?$/],
});
