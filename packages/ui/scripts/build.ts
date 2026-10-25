import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import { runCommand } from "../../../scripts/process.mjs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";
import { solidPlugin } from "esbuild-plugin-solid";
import runtimeTargets from "../../../app/runtime-targets.json";

const root = resolve(import.meta.dirname, "..");
const dist = resolve(root, "dist");

async function buildCss(): Promise<void> {
  const tokens = await readFile(resolve(root, "src/styles/tokens.css"), "utf8");
  const components = await readFile(
    resolve(root, "src/styles/components.css"),
    "utf8",
  );

  await writeFile(resolve(dist, "tokens.css"), tokens);
  await writeFile(resolve(dist, "styles.css"), `${tokens}\n${components}`);
}

const main = Effect.gen(function* () {
  yield* Effect.tryPromise(() => rm(dist, { force: true, recursive: true }));
  yield* Effect.tryPromise(() => mkdir(dist, { recursive: true }));

  yield* Effect.tryPromise(() =>
    build({
      bundle: true,
      conditions: ["solid", "browser"],
      entryPoints: [resolve(root, "src/index.ts")],
      external: [
        "@ark-ui/solid",
        "@ark-ui/solid/*",
        "@tanstack/solid-virtual",
        "clsx",
        "solid-js",
        "solid-js/web",
      ],
      format: "esm",
      jsx: "automatic",
      jsxImportSource: "solid-js",
      outfile: resolve(dist, "index.js"),
      platform: "browser",
      plugins: [solidPlugin()],
      sourcemap: true,
      target: `chrome${runtimeTargets.chrome}`,
    }),
  );

  yield* runCommand("tsc", ["-p", "tsconfig.build.json"], {
    cwd: root,
    shell: process.platform === "win32",
  });
  yield* Effect.tryPromise(buildCss);
});

main.pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain);
