import { access, readFile, rm } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Command, Flag } from "effect/cli";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SCRIPT_DIR, "..");
const CLEAN_RELATIVE_PATHS = [
  "node_modules",
  "dist",
  "build",
  "app/node_modules",
  "app/dist",
  "app/build",
  "app/.electron-runtime",
  "docs/node_modules",
  "docs/dist",
  "docs/build",
  "docs/.blume/node_modules",
  "docs/.blume/dist",
  "docs/.blume/build",
  "docs/.blume-verify/node_modules",
  "docs/.blume-verify/dist",
  "docs/.blume-verify/build",
  "packages/core/node_modules",
  "packages/core/dist",
  "packages/core/build",
  "packages/game/node_modules",
  "packages/game/dist",
  "packages/game/build",
  "packages/oxlint-plugin-lucent/node_modules",
  "packages/oxlint-plugin-lucent/dist",
  "packages/oxlint-plugin-lucent/build",
  "packages/ui/node_modules",
  "packages/ui/dist",
  "packages/ui/build",
  "storybook-static",
] as const;
const CLEAN_PATHS = CLEAN_RELATIVE_PATHS.map((path) => join(REPO_ROOT, path));

type CliInput = {
  dryRun: boolean;
};

class CleanError extends Data.TaggedError("CleanError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const toErrorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const toRelativePath = (path: string): string => {
  const value = relative(REPO_ROOT, path);
  return value === "" ? "." : value.split(sep).join("/");
};

const validateRepoRoot = (): Effect.Effect<void, CleanError> =>
  Effect.gen(function* () {
    const packageJsonPath = join(REPO_ROOT, "package.json");
    const source = yield* Effect.tryPromise({
      try: () => readFile(packageJsonPath, "utf8"),
      catch: (cause) =>
        new CleanError({
          message: `Failed to read ${toRelativePath(packageJsonPath)}`,
          cause,
        }),
    });

    const parsed = yield* Effect.try({
      try: () => JSON.parse(source) as { name?: unknown },
      catch: (cause) =>
        new CleanError({
          message: `Failed to parse ${toRelativePath(packageJsonPath)}`,
          cause,
        }),
    });

    if (parsed.name !== "lucent") {
      return yield* new CleanError({
        message: `Refusing to clean unexpected repo root: ${REPO_ROOT}`,
      });
    }
  });

const findCleanTargets = (): Effect.Effect<ReadonlyArray<string>, CleanError> =>
  Effect.gen(function* () {
    const targets: string[] = [];

    for (const path of CLEAN_PATHS) {
      const exists = yield* Effect.promise(() =>
        access(path).then(
          () => true,
          () => false,
        ),
      );
      if (exists) {
        targets.push(path);
      }
    }

    return targets.sort((left, right) =>
      toRelativePath(left).localeCompare(toRelativePath(right)),
    );
  });

const deleteTarget = (path: string): Effect.Effect<void, CleanError> =>
  Effect.tryPromise({
    try: () => rm(path, { recursive: true, force: true }),
    catch: (cause) =>
      new CleanError({
        message: `Failed to delete ${toRelativePath(path)}`,
        cause,
      }),
  });

const clean = (input: CliInput): Effect.Effect<void, CleanError> =>
  Effect.gen(function* () {
    yield* validateRepoRoot();
    const targets = yield* findCleanTargets();

    if (targets.length === 0) {
      yield* Console.log("Clean complete. No generated directories found.");
      return;
    }

    if (input.dryRun) {
      for (const target of targets) {
        yield* Console.log(`Would delete: ${toRelativePath(target)}`);
      }
      yield* Console.log(
        `Clean dry run complete. ${targets.length} path(s) matched.`,
      );
      return;
    }

    for (const target of targets) {
      yield* Console.log(`Deleting: ${toRelativePath(target)}`);
      yield* deleteTarget(target);
    }

    yield* Console.log(`Clean complete. ${targets.length} path(s) deleted.`);
  });

const command = Command.make("clean", {
  dryRun: Flag.Boolean("dry-run").pipe(
    Flag.withDescription(
      "Print paths that would be deleted without removing them",
    ),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription("Remove generated directories from the repository"),
  Command.withHandler(clean),
);

const getCliArgs = (): ReadonlyArray<string> =>
  process.argv.slice(2).filter((arg) => arg !== "--");

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  Command.runWith(command, {
    version: "1.0.0",
  })(getCliArgs()).pipe(
    Effect.tapError((error) =>
      error instanceof CleanError
        ? Console.error(`Clean failed: ${error.message}`)
        : Console.error(`Clean failed: ${toErrorMessage(error)}`),
    ),
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
