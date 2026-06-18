import resolve from "@rollup/plugin-node-resolve";
import typescript from "@rollup/plugin-typescript";
import { rmSync } from "fs";
import { builtinModules } from "module";
import dts from "rollup-plugin-dts";

// Wipes dist once before the first build so stale artifacts don't linger.
const cleanDist = () => ({
  name: "clean-dist",
  buildStart() {
    rmSync("dist", { recursive: true, force: true });
  },
});

// This package ships zero runtime dependencies. The Redis client is injected,
// node-cron is a type-only peer, so the only externals are Node built-ins plus
// the peer/optional packages (never bundled).
const external = [
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
  "node-cron",
  "ioredis",
  "redis",
];

const basePlugins = () => [
  resolve(),
  typescript({
    tsconfig: "./tsconfig.json",
    sourceMap: true,
    declaration: false,
    exclude: ["**/*.test.ts"],
    noEmitOnError: process.env.NODE_ENV !== "development",
  }),
];

export default [
  // ESM build
  {
    input: "src/index.ts",
    output: {
      dir: "dist",
      format: "esm",
      entryFileNames: "[name].js",
      sourcemap: true,
    },
    external,
    plugins: [cleanDist(), ...basePlugins()],
  },
  // CJS build
  {
    input: "src/index.ts",
    output: {
      dir: "dist",
      format: "cjs",
      entryFileNames: "[name].cjs",
      sourcemap: true,
      exports: "named",
    },
    external,
    plugins: basePlugins(),
  },
  // Type declarations: one bundled .d.ts for the public entry.
  {
    input: "src/index.ts",
    output: {
      file: "dist/index.d.ts",
      format: "es",
    },
    external,
    plugins: [dts()],
  },
];
