import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/cli.ts"],
  clean: true,
  dts: true,
  format: ["esm"],
  sourcemap: true,
  target: "node22",
  outDir: "dist",
  shims: false,
  banner: {
    js: "#!/usr/bin/env node",
  },
});
