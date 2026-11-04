import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/cli/index.ts" },
  format: ["esm"],
  target: "node22",
  platform: "node",
  sourcemap: true,
  clean: true,
  outDir: "dist",
  banner: { js: "#!/usr/bin/env node" },
});
