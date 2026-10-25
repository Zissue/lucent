import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import { Command, Flag } from "effect/cli";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { formatCommand, runCommand } from "./process.mjs";

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

const run = Effect.fn("buildDesktopArtifact.run")(function* (
  command: string,
  args: readonly string[],
) {
  yield* Effect.log(`$ ${formatCommand(command, args)}`);
  yield* runCommand(command, args, {
    cwd: REPO_ROOT,
    shell: process.platform === "win32",
  });
});

const detectHostPlatform = (): Effect.Effect<
  BuildPlatform,
  BuildDesktopArtifactError
> => {
  switch (process.platform) {
    case "darwin":
      return Effect.succeed("mac");
    case "linux":
      return Effect.succeed("linux");
    case "win32":
      return Effect.succeed("win");
    default:
      return Effect.fail(
        new BuildDesktopArtifactError(
          `Unsupported host platform: ${process.platform}`,
        ),
      );
  }
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

const buildDesktopArtifact = Effect.fn("buildDesktopArtifact")(function* (
  input: { readonly platform: Option.Option<BuildPlatform> },
) {
  const fs = yield* FileSystem.FileSystem;
  const platform = Option.isSome(input.platform)
    ? input.platform.value
    : yield* detectHostPlatform();

  yield* Effect.log("Cleaning app/build");
  yield* fs.remove(BUILD_OUTPUT_DIR, { recursive: true, force: true });
  yield* run("pnpm", [
    "--filter",
    "@lucent/electron^...",
    "--if-present",
    "build",
  ]);
  yield* run("pnpm", ["run", "typecheck"]);
  yield* run("pnpm", ["--dir", "app", "build"]);
  yield* run("pnpm", [
    "--dir",
    "app",
    "electron-builder",
    ...electronBuilderArgs(platform),
  ]);
});

const command = Command.make("build-desktop-artifact", {
  platform: Flag.Literals("platform", BUILD_PLATFORMS).pipe(
    Flag.withDescription("Platform to package (defaults to the host)"),
    Flag.optional,
  ),
}).pipe(
  Command.withDescription("Typecheck, build, and package the desktop app"),
  Command.withHandler(buildDesktopArtifact),
);

Command.runWith(command, { version: "1.0.0" })(
  process.argv.slice(2).filter((arg) => arg !== "--"),
).pipe(
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
