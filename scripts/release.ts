import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Cause from "effect/Cause";
import * as Console from "effect/Console";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { ChildProcess } from "effect/unstable/process";

import {
  findLatestRelease,
  formatReleaseTag,
  gitCliffChangelogArgs,
  gitCliffChangelogCommand,
  makeInitialChangelog,
  parseVersion,
  RELEASE_NOTES_PLACEHOLDER_CONTENT,
  releaseNotesAreReady,
  resolveTargetVersion,
  type Release,
} from "./release-logic";

const execFileAsync = promisify(execFile);

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SCRIPT_DIR, "..");
const APP_PACKAGE_JSON_PATH = join(REPO_ROOT, "app", "package.json");
const CHANGELOG_PATH = join(REPO_ROOT, "CHANGELOG.md");
const RELEASE_NOTES_PATH = join(REPO_ROOT, "RELEASE_NOTES.md");
const RELEASE_BRANCH = "main";
const RELEASE_FILES = ["app/package.json", "CHANGELOG.md"] as const;

type CliInput = {
  readonly bumpOrVersion: string;
  readonly dryRun: boolean;
  readonly allowDirty: boolean;
};

type AppPackageJson = {
  readonly name?: unknown;
  readonly version?: unknown;
  readonly [key: string]: unknown;
};

class ReleaseError extends Data.TaggedError("ReleaseError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const toRelativePath = (path: string): string => {
  const value = relative(REPO_ROOT, path);
  return value === "" ? "." : value.split(sep).join("/");
};

const runGit = (
  args: ReadonlyArray<string>,
): Effect.Effect<string, ReleaseError> =>
  Effect.tryPromise({
    try: async () => {
      const { stdout } = await execFileAsync("git", [...args], {
        cwd: REPO_ROOT,
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024,
      });
      // Porcelain status uses a leading space as one of its two state bytes.
      return stdout.trimEnd();
    },
    catch: (cause) =>
      new ReleaseError({
        message: `git ${args.join(" ")} failed`,
        cause,
      }),
  });

const validateRepoRoot = (): Effect.Effect<void, ReleaseError> =>
  Effect.gen(function* () {
    const packageJsonPath = join(REPO_ROOT, "package.json");
    const source = yield* Effect.tryPromise({
      try: () => readFile(packageJsonPath, "utf8"),
      catch: (cause) =>
        new ReleaseError({
          message: `Failed to read ${toRelativePath(packageJsonPath)}`,
          cause,
        }),
    });

    const parsed = yield* Effect.try({
      try: () => JSON.parse(source) as { name?: unknown },
      catch: (cause) =>
        new ReleaseError({
          message: `Failed to parse ${toRelativePath(packageJsonPath)}`,
          cause,
        }),
    });

    if (parsed.name !== "lucent") {
      return yield* new ReleaseError({
        message: `Refusing to release from unexpected repo root: ${REPO_ROOT}`,
      });
    }
  });

const getCurrentBranch = (): Effect.Effect<string, ReleaseError> =>
  runGit(["branch", "--show-current"]).pipe(
    Effect.flatMap((branch) =>
      branch === ""
        ? Effect.fail(
            new ReleaseError({
              message: "Unable to determine current git branch",
            }),
          )
        : Effect.succeed(branch),
    ),
  );

const requireReleaseBranch = (branch: string) =>
  branch === RELEASE_BRANCH
    ? Effect.void
    : Effect.fail(
        new ReleaseError({
          message: `release must run from ${RELEASE_BRANCH}. Current branch is ${branch}.`,
        }),
      );

const getLatestRelease = (): Effect.Effect<
  Release | null,
  ReleaseError
> =>
  runGit(["tag", "--merged", RELEASE_BRANCH]).pipe(
    Effect.map((output) =>
      findLatestRelease(output.split(/\r?\n/).map((value) => value.trim())),
    ),
  );

const readAppPackageJson = (): Effect.Effect<AppPackageJson, ReleaseError> =>
  Effect.gen(function* () {
    const source = yield* Effect.tryPromise({
      try: () => readFile(APP_PACKAGE_JSON_PATH, "utf8"),
      catch: (cause) =>
        new ReleaseError({
          message: `Failed to read ${toRelativePath(APP_PACKAGE_JSON_PATH)}`,
          cause,
        }),
    });

    return yield* Effect.try({
      try: () => JSON.parse(source) as AppPackageJson,
      catch: (cause) =>
        new ReleaseError({
          message: `Failed to parse ${toRelativePath(APP_PACKAGE_JSON_PATH)}`,
          cause,
        }),
    });
  });

const getAppVersion = (packageJson: AppPackageJson) =>
  typeof packageJson.version === "string" &&
  parseVersion(packageJson.version) !== null
    ? Effect.succeed(packageJson.version)
    : Effect.fail(
        new ReleaseError({
          message: `${toRelativePath(APP_PACKAGE_JSON_PATH)} must contain a semantic version`,
        }),
      );

const resolveReleaseTargetVersion = (
  bumpOrVersion: string,
  latestRelease: Release | null,
): Effect.Effect<string, ReleaseError> => {
  const result = resolveTargetVersion(bumpOrVersion, latestRelease);
  return result.ok
    ? Effect.succeed(result.version)
    : Effect.fail(new ReleaseError({ message: result.message }));
};

const tagExists = (tag: string): Effect.Effect<boolean, never> =>
  runGit(["rev-parse", "--verify", "--quiet", `refs/tags/${tag}`]).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  );

const requireNewTag = (tag: string) =>
  tagExists(tag).pipe(
    Effect.flatMap((exists) =>
      exists
        ? Effect.fail(
            new ReleaseError({ message: `Tag ${tag} already exists` }),
          )
        : Effect.void,
    ),
  );

const getDirtyStatus = (): Effect.Effect<ReadonlyArray<string>, ReleaseError> =>
  runGit(["status", "--porcelain"]).pipe(
    Effect.map((output) =>
      output === ""
        ? []
        : output.split(/\r?\n/).filter((line) => line.trim() !== ""),
    ),
  );

const checkDirtyTree = (
  dirtyStatus: ReadonlyArray<string>,
  input: CliInput,
): Effect.Effect<void, ReleaseError> =>
  Effect.gen(function* () {
    if (dirtyStatus.length === 0) {
      return;
    }

    if (!input.dryRun || !input.allowDirty) {
      return yield* new ReleaseError({
        message:
          "Working tree is dirty. Commit or stash changes before creating a release PR. Use --dry-run --allow-dirty to preview.",
      });
    }

    yield* Console.log("Working tree has existing changes:");
    for (const line of dirtyStatus) {
      yield* Console.log(`  ${line}`);
    }
  });

// RELEASE_NOTES.md is ignored local input for the first release. Only the
// generated CHANGELOG.md belongs in the release pull request.
const readInitialReleaseNotes = (): Effect.Effect<string, ReleaseError> =>
  Effect.tryPromise({
    try: async () => {
      try {
        return await readFile(RELEASE_NOTES_PATH, "utf8");
      } catch (cause) {
        if (
          cause instanceof Error &&
          "code" in cause &&
          cause.code === "ENOENT"
        ) {
          await writeFile(
            RELEASE_NOTES_PATH,
            RELEASE_NOTES_PLACEHOLDER_CONTENT,
          );
          return RELEASE_NOTES_PLACEHOLDER_CONTENT;
        }
        throw cause;
      }
    },
    catch: (cause) =>
      new ReleaseError({
        message: `Failed to read ${toRelativePath(RELEASE_NOTES_PATH)}`,
        cause,
      }),
  }).pipe(
    Effect.flatMap((source) =>
      releaseNotesAreReady(source)
        ? Effect.succeed(source)
        : Effect.fail(
            new ReleaseError({
              message:
                "Fill in the local RELEASE_NOTES.md file, then rerun the release command.",
            }),
          ),
    ),
  );

const writeAppVersion = (
  packageJson: AppPackageJson,
  targetVersion: string,
): Effect.Effect<void, ReleaseError> =>
  Effect.tryPromise({
    try: () =>
      writeFile(
        APP_PACKAGE_JSON_PATH,
        `${JSON.stringify({ ...packageJson, version: targetVersion }, null, 2)}\n`,
      ),
    catch: (cause) =>
      new ReleaseError({
        message: `Failed to write ${toRelativePath(APP_PACKAGE_JSON_PATH)}`,
        cause,
      }),
  });

const writeInitialChangelog = (
  targetVersion: string,
  targetTag: string,
  releaseNotes: string,
): Effect.Effect<void, ReleaseError> =>
  Effect.tryPromise({
    try: () =>
      writeFile(
        CHANGELOG_PATH,
        makeInitialChangelog({
          date: new Date().toISOString().slice(0, 10),
          notes: releaseNotes,
          tag: targetTag,
          version: targetVersion,
        }),
      ),
    catch: (cause) =>
      new ReleaseError({
        message: `Failed to write ${toRelativePath(CHANGELOG_PATH)}`,
        cause,
      }),
  });

const resetInitialReleaseNotes = (): Effect.Effect<void, ReleaseError> =>
  Effect.tryPromise({
    try: () => writeFile(RELEASE_NOTES_PATH, RELEASE_NOTES_PLACEHOLDER_CONTENT),
    catch: (cause) =>
      new ReleaseError({
        message: `Failed to reset ${toRelativePath(RELEASE_NOTES_PATH)}`,
        cause,
      }),
  });

const runCommand = (command: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const child = yield* ChildProcess.make(command, args, {
      cwd: REPO_ROOT,
      env: process.env,
      extendEnv: true,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
      shell: process.platform === "win32",
      detached: false,
      forceKillAfter: "30 seconds",
    });
    const exitCode = Number(yield* child.exitCode);

    if (exitCode !== 0) {
      return yield* new ReleaseError({
        message: `${command} ${args.join(" ")} exited with code ${exitCode}`,
      });
    }
  }).pipe(
    Effect.mapError((cause) =>
      cause instanceof ReleaseError
        ? cause
        : new ReleaseError({
            message: `${command} failed`,
            cause,
          }),
    ),
    Effect.scoped,
  );

const printPlan = (
  branch: string,
  latestRelease: Release | null,
  appVersion: string,
  targetVersion: string,
  targetTag: string,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    yield* Console.log(`Current branch: ${branch}`);
    yield* Console.log(
      `Latest release tag: ${latestRelease?.tag ?? "none (first release)"}`,
    );
    yield* Console.log(`Current app/package.json version: ${appVersion}`);
    yield* Console.log(`Target version: ${targetVersion}`);
    yield* Console.log(`Target tag: ${targetTag}`);
    yield* Console.log("Files that would change:");
    for (const file of RELEASE_FILES) {
      yield* Console.log(`  ${file}`);
    }

    yield* Console.log(
      `Would create release/${targetTag}, commit the release files, run typecheck/lint/format, push, and open a PR with an empty body.`,
    );

    if (latestRelease === null) {
      yield* Console.log(
        "Changelog source: curated notes from RELEASE_NOTES.md",
      );
      return;
    }

    yield* Console.log(`git-cliff command: ${gitCliffChangelogCommand(targetTag)}`);
  });

const createReleasePr = Effect.fn("createReleasePr")(function* (
  targetVersion: string,
  targetTag: string,
) {
  const releaseBranch = `release/${targetTag}`;
  const title = `chore(release): ${targetVersion}`;
  yield* runGit(["add", "--", ...RELEASE_FILES]);
  yield* runGit(["commit", "-m", title, "--", ...RELEASE_FILES]);
  for (const check of ["typecheck", "lint", "format"]) {
    yield* runCommand("pnpm", [check]);
  }
  yield* runGit(["push", "--set-upstream", "origin", releaseBranch]);
  yield* runCommand("gh", [
    "pr",
    "create",
    "--base",
    RELEASE_BRANCH,
    "--head",
    releaseBranch,
    "--title",
    title,
    "--body",
    "",
  ]);
  yield* Console.log(
    `After this pull request merges, GitHub Actions tags the merged commit as ${targetTag} and builds a draft release.`,
  );
  yield* Console.log(
    "Review and publish the draft on GitHub when it is ready.",
  );
});

const release = (input: CliInput) =>
  Effect.gen(function* () {
    yield* validateRepoRoot();

    const branch = yield* getCurrentBranch();
    yield* requireReleaseBranch(branch);

    const dirtyStatus = yield* getDirtyStatus();
    yield* checkDirtyTree(dirtyStatus, input);

    if (!input.dryRun) {
      yield* runCommand("gh", ["auth", "status"]);
      yield* runGit(["fetch", "origin", "main", "--tags"]);
      const head = yield* runGit(["rev-parse", "HEAD"]);
      const remoteMain = yield* runGit(["rev-parse", "origin/main"]);
      if (head !== remoteMain) {
        return yield* new ReleaseError({
          message:
            "Local main must match origin/main. Update main before releasing.",
        });
      }
    }

    const latestRelease = yield* getLatestRelease();
    const appPackageJson = yield* readAppPackageJson();
    const appVersion = yield* getAppVersion(appPackageJson);
    const targetVersion = yield* resolveReleaseTargetVersion(
      input.bumpOrVersion,
      latestRelease,
    );
    const targetTag = formatReleaseTag(targetVersion);
    yield* requireNewTag(targetTag);

    if (latestRelease !== null && appVersion !== latestRelease.version) {
      yield* Console.log(
        `Warning: app/package.json is ${appVersion} but latest release is ${latestRelease.tag}. Bumping from ${latestRelease.tag}.`,
      );
    }

    const initialReleaseNotes =
      latestRelease === null ? yield* readInitialReleaseNotes() : null;
    if (input.dryRun) {
      yield* printPlan(
        branch,
        latestRelease,
        appVersion,
        targetVersion,
        targetTag,
      );
      return;
    }

    yield* runGit(["switch", "-c", `release/${targetTag}`]);
    yield* Console.log(
      `Preparing release/${targetTag}. If a later step fails, the branch and files are kept for recovery.`,
    );
    yield* writeAppVersion(appPackageJson, targetVersion);
    if (initialReleaseNotes !== null) {
      yield* writeInitialChangelog(
        targetVersion,
        targetTag,
        initialReleaseNotes,
      );
    } else {
      yield* runCommand("git-cliff", gitCliffChangelogArgs(targetTag));
    }
    yield* runCommand("pnpm", ["release:validate", targetTag]);
    yield* createReleasePr(targetVersion, targetTag);
    if (initialReleaseNotes !== null) {
      yield* resetInitialReleaseNotes();
    }
  });

const command = Command.make("release", {
  bumpOrVersion: Argument.string("bump-or-version").pipe(
    Argument.withDescription(
      "patch, minor, major, prerelease, or a semver version",
    ),
  ),
  dryRun: Flag.boolean("dry-run").pipe(
    Flag.withDescription("Print the release plan without writing files"),
    Flag.withDefault(false),
  ),
  allowDirty: Flag.boolean("allow-dirty").pipe(
    Flag.withDescription(
      "Allow existing working tree changes when using --dry-run",
    ),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription(
    "Prepare a Lucent release and open its pull request from main",
  ),
  Command.withHandler(release),
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
    Effect.catch((error) =>
      Effect.gen(function* () {
        yield* Console.error("Release failed:", Cause.pretty(Cause.fail(error)));
        process.exitCode = 1;
      }),
    ),
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
