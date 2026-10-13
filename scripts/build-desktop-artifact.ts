import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { formatCommand, runCommand } from "./process.mjs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SCRIPT_DIR, "..");
const BUILD_OUTPUT_DIR = join(REPO_ROOT, "app", "build");
const BUILD_PLATFORMS = ["mac", "win", "linux", "all"] as const;

type BuildPlatform = (typeof BUILD_PLATFORMS)[number];

class BuildDesktopArtifactError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BuildDesktopArtifactError";
  }
}

const isBuildPlatform = (value: string): value is BuildPlatform =>
  BUILD_PLATFORMS.includes(value as BuildPlatform);

const run = Effect.fn("buildDesktopArtifact.run")(function* (
  command: string,
  args: readonly string[],
) {
  console.log(`$ ${formatCommand(command, args)}`);
  yield* runCommand(command, args, {
    cwd: REPO_ROOT,
    shell: process.platform === "win32",
  });
});

const detectHostPlatform = (): BuildPlatform => {
  switch (process.platform) {
    case "darwin":
      return "mac";
    case "linux":
      return "linux";
    case "win32":
      return "win";
    default:
      throw new BuildDesktopArtifactError(
        `Unsupported host platform: ${process.platform}`,
      );
  }
};

const parsePlatform = (args: ReadonlyArray<string>): BuildPlatform => {
  let platform: BuildPlatform | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--") {
      break;
    }

    if (arg === "--platform") {
      const value = args[index + 1];
      if (!value || !isBuildPlatform(value)) {
        throw new BuildDesktopArtifactError(
          `Expected --platform to be one of: ${BUILD_PLATFORMS.join(", ")}`,
        );
      }

      platform = value;
      index += 1;
      continue;
    }

    if (arg?.startsWith("--platform=")) {
      const value = arg.slice("--platform=".length);
      if (!isBuildPlatform(value)) {
        throw new BuildDesktopArtifactError(
          `Expected --platform to be one of: ${BUILD_PLATFORMS.join(", ")}`,
        );
      }

      platform = value;
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      console.log(
        `Usage: tsx scripts/build-desktop-artifact.ts [--platform ${BUILD_PLATFORMS.join("|")}]\n`,
      );
      process.exit(0);
    }

    throw new BuildDesktopArtifactError(`Unknown argument: ${arg}`);
  }

  return platform ?? detectHostPlatform();
};

const electronBuilderArgs = (
  platform: BuildPlatform,
): ReadonlyArray<string> => {
  const publishArgs = ["--publish", "never"] as const;

  switch (platform) {
    case "all":
      return ["-mwl", ...publishArgs];
    case "mac":
      return ["--mac", ...publishArgs];
    case "win":
      return ["--win", ...publishArgs];
    case "linux":
      return ["--linux", ...publishArgs];
  }
};

const main = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const platform = yield* Effect.try({
    try: () => parsePlatform(process.argv.slice(2)),
    catch: (cause) =>
      cause instanceof Error
        ? cause
        : new BuildDesktopArtifactError(String(cause)),
  });

  console.log("Cleaning app/build");
  yield* fs.remove(BUILD_OUTPUT_DIR, { recursive: true, force: true });
  yield* run("pnpm", ["run", "typecheck"]);
  yield* run("pnpm", [
    "--filter",
    "@lucent/electron^...",
    "--if-present",
    "build",
  ]);
  yield* run("pnpm", ["--dir", "app", "build"]);
  yield* run("pnpm", [
    "--dir",
    "app",
    "electron-builder",
    ...electronBuilderArgs(platform),
  ]);
});

main.pipe(
  Effect.catch((cause) =>
    Effect.sync(() => {
      console.error("Desktop artifact build failed:", cause);
      process.exitCode = 1;
    }),
  ),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
