import {
  mkdtemp,
  rm,
  stat,
  truncate,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import { vi } from "vitest";

import { afterEach, describe, expect, it } from "@effect/vitest";

import { layer, makeScriptFiles, ScriptFiles } from "./ScriptFiles";
import { desktopLogRecord } from "../../shared/logRecord";
import * as ScriptSourceParser from "./ScriptSourceParser";

const tempDirectories = new Set<string>();

const makeTempDirectory = async (): Promise<string> => {
  const path = await mkdtemp(join(tmpdir(), "lucent-script-files-"));
  tempDirectories.add(path);
  return path;
};

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    [...tempDirectories].map((path) =>
      rm(path, { force: true, recursive: true }),
    ),
  );
  tempDirectories.clear();
});

describe("ScriptFiles service", () => {
  it.effect(
    "returns the current source and extracted inputs after a same-size edit",
    () =>
      Effect.gen(function* () {
        const directory = yield* Effect.promise(makeTempDirectory);
        const path = join(directory, "farm.js");
        const files = makeScriptFiles();
        const firstSource = [
          'const helper = require("./helper");',
          "module.exports = function* run() { return 1; };",
          "module.exports.inputs = { fields: [] };",
        ].join("\n");
        const secondSource = firstSource.replace("return 1", "return 2");
        expect(secondSource).toHaveLength(firstSource.length);

        yield* Effect.promise(() => writeFile(path, firstSource));
        const firstStat = yield* Effect.promise(() => stat(path));
        const first = yield* files.analyze(path);

        yield* Effect.promise(() => writeFile(path, secondSource));
        yield* Effect.promise(() =>
          utimes(path, firstStat.atime, firstStat.mtime),
        );
        const second = yield* files.analyze(path);

        expect(first.file.source).toBe(firstSource);
        expect(second.file.source).toBe(secondSource);
        expect(second.file.revision).not.toBe(first.file.revision);
        expect(second.file.inputs).toEqual({ id: path, fields: [] });
        expect(second.requirements).toEqual(["./helper"]);
      }),
  );

  it.effect("reads normalized paths and hashes the file contents", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(makeTempDirectory);
      const path = join(directory, "empty.js");
      yield* Effect.promise(() => writeFile(path, ""));
      const files = yield* ScriptFiles;
      expect(yield* files.read(relative(process.cwd(), path))).toEqual({
        inputs: null,
        name: "empty.js",
        path,
        revision:
          "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        source: "",
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("does not cache missing files", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(makeTempDirectory);
      const path = join(directory, "created-later.js");
      const files = makeScriptFiles();

      expect(yield* files.resolve(path)).toEqual({
        status: "missing",
        path,
      });

      yield* Effect.promise(() =>
        writeFile(path, "module.exports = function* run() {};"),
      );
      expect(yield* files.resolve(path)).toMatchObject({
        status: "found",
        file: {
          path,
          source: "module.exports = function* run() {};",
          inputs: null,
        },
      });
    }),
  );

  it.effect("treats a path beneath a regular file as missing", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(makeTempDirectory);
      const parent = join(directory, "parent.js");
      yield* Effect.promise(() => writeFile(parent, ""));
      const path = join(parent, "child.js");
      expect(yield* makeScriptFiles().resolve(path)).toEqual({
        status: "missing",
        path,
      });
      expect(
        yield* makeScriptFiles().analyze(path).pipe(Effect.flip),
      ).toMatchObject({
        _tag: "ScriptFilesError",
        path,
        message: `Script file was not found at ${path}.`,
      });
    }),
  );

  it.effect(
    "returns processing failures for malformed and oversized scripts",
    () =>
      Effect.gen(function* () {
        const directory = yield* Effect.promise(makeTempDirectory);
        const malformedPath = join(directory, "malformed.js");
        const oversizedPath = join(directory, "oversized.js");
        yield* Effect.promise(() =>
          writeFile(malformedPath, "module.exports = function* ("),
        );
        yield* Effect.promise(() => writeFile(oversizedPath, ""));
        yield* Effect.promise(() =>
          truncate(oversizedPath, 16 * 1024 * 1024 + 1),
        );
        const files = makeScriptFiles();

        expect(yield* files.resolve(malformedPath)).toMatchObject({
          status: "failed",
          path: malformedPath,
          message: "Script source could not be parsed.",
          detailsText: expect.stringContaining("ScriptInputsExtractorError"),
        });
        expect(yield* files.resolve(oversizedPath)).toMatchObject({
          status: "failed",
          path: oversizedPath,
          message: `Script file exceeds the 16 MiB limit: ${oversizedPath}.`,
        });
      }),
  );

  it.effect(
    "accepts exactly 16 MiB and limits UTF-8 bytes rather than characters",
    () =>
      Effect.gen(function* () {
        const directory = yield* Effect.promise(makeTempDirectory);
        const path = join(directory, "boundary.js");
        const source = `//${"é".repeat(8 * 1024 * 1024 - 1)}`;
        yield* Effect.promise(() => writeFile(path, source));
        const files = makeScriptFiles();
        expect(yield* files.read(path)).toMatchObject({
          path,
          source,
          inputs: null,
        });
        yield* Effect.promise(() => writeFile(path, `${source}é`));
        expect(yield* files.resolve(path)).toMatchObject({
          status: "failed",
          path,
          message: `Script file exceeds the 16 MiB limit: ${path}.`,
        });
      }),
  );
});

describe("script resolution failure logging", () => {
  it.effect(
    "logs unexpected file I/O once and keeps expected source outcomes silent",
    () =>
      Effect.gen(function* () {
        const directory = yield* Effect.promise(makeTempDirectory);
        const missingPath = join(directory, "missing.js");
        const malformedPath = join(directory, "malformed.js");
        const oversizedPath = join(directory, "oversized.js");
        yield* Effect.promise(() =>
          writeFile(malformedPath, "module.exports = function* ("),
        );
        yield* Effect.promise(() => writeFile(oversizedPath, ""));
        yield* Effect.promise(() =>
          truncate(oversizedPath, 16 * 1024 * 1024 + 1),
        );
        const files = makeScriptFiles();
        const logs: unknown[] = [];
        const causes: unknown[] = [];
        const logger = Logger.make((options) => {
          const { level, component, message, data, repeatKey } =
            desktopLogRecord(options);
          logs.push({ level, component, message, data, repeatKey });
          causes.push(Cause.squash(options.cause));
        });
        const results = yield* Effect.all([
          files.resolve(directory),
          files.resolve(missingPath),
          files.resolve(malformedPath),
          files.resolve(oversizedPath),
        ]).pipe(Effect.withLogger(logger));
        expect(results.map((result) => result.status)).toEqual([
          "failed",
          "missing",
          "failed",
          "failed",
        ]);
        expect(results[1]).toEqual({ status: "missing", path: missingPath });
        expect(results[2]).toMatchObject({
          message: "Script source could not be parsed.",
        });
        expect(logs).toEqual([
          {
            level: "warn",
            component: "script-files",
            message: "Failed to resolve script file",
            data: { path: directory },
            repeatKey: directory,
          },
        ]);
        expect(causes).toEqual([expect.objectContaining({ code: "EISDIR" })]);
      }),
  );

  it.effect("logs an analyzer defect once with its original cause", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(makeTempDirectory);
      const path = join(directory, "broken.js");
      yield* Effect.promise(() => writeFile(path, "exports.value = 1;"));
      const error = new Error("Analyzer defect");
      vi.spyOn(ScriptSourceParser, "analyzeScriptSource").mockReturnValue(
        Effect.die(error),
      );
      const files = makeScriptFiles();
      const logs: unknown[] = [];
      const causes: unknown[] = [];
      const logger = Logger.make((options) => {
        const { level, component, message, data, repeatKey } =
          desktopLogRecord(options);
        logs.push({ level, component, message, data, repeatKey });
        causes.push(Cause.squash(options.cause));
      });
      const result = yield* files.resolve(path).pipe(Effect.withLogger(logger));
      const missing = yield* files
        .resolve(join(directory, "missing.js"))
        .pipe(Effect.withLogger(logger));
      expect(result).toMatchObject({
        status: "failed",
        path,
        message: "Analyzer defect",
      });
      expect(missing).toEqual({
        status: "missing",
        path: join(directory, "missing.js"),
      });
      expect(logs).toEqual([
        {
          level: "error",
          component: "script-files",
          message: "Script file analysis failed unexpectedly",
          data: { path },
          repeatKey: path,
        },
      ]);
      expect(causes).toEqual([error]);
    }),
  );

  it.effect("keeps an interrupt-only resolution failure silent", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(makeTempDirectory);
      const path = join(directory, "cancelled.js");
      yield* Effect.promise(() => writeFile(path, ""));
      vi.spyOn(ScriptSourceParser, "analyzeScriptSource").mockReturnValue(
        Effect.interrupt,
      );
      const logs: unknown[] = [];
      const result = yield* makeScriptFiles()
        .resolve(path)
        .pipe(
          Effect.withLogger(
            Logger.make((options) => logs.push(desktopLogRecord(options))),
          ),
        );
      expect(result).toMatchObject({
        status: "failed",
        path,
        message: "All fibers interrupted without error",
      });
      expect(logs).toEqual([]);
    }),
  );
});
