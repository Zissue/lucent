import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as References from "effect/References";

import {
  normalizeScriptInputValues,
  type ScriptInputsDefinition,
} from "@lucent/core/scriptInputs";
import { DesktopEnvironment } from "../app/DesktopEnvironment";
import { layer as desktopFileSystemLayer } from "@effect/platform-node/NodeFileSystem";
import {
  ScriptInputRepository,
  layer as scriptInputRepositoryLayer,
} from "./ScriptInputRepository";

import { JsonFileError } from "../filesystem/JsonFile";
const tempDirs = new Set<string>();

const makeTempDir = async (prefix: string): Promise<string> => {
  const path = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.add(path);
  return path;
};

afterEach(async () => {
  await Promise.all(
    [...tempDirs].map((path) => rm(path, { force: true, recursive: true })),
  );
  tempDirs.clear();
});

const definition: ScriptInputsDefinition = {
  id: "repository-test",
  fields: [
    {
      key: "target",
      type: "string",
      label: "Target",
      required: true,
    },
    {
      key: "count",
      type: "number",
      label: "Count",
      default: 3,
    },
    {
      key: "enabled",
      type: "boolean",
      label: "Enabled",
      default: false,
    },
    {
      key: "server",
      type: "select",
      label: "Server",
      options: ["Artix", "Yorumi"],
      default: "Artix",
    },
    {
      key: "rewards",
      type: "multi-select",
      label: "Rewards",
      options: ["Weapon", "Armor", "Pet"],
      default: ["Armor"],
    },
  ],
};

const makeRepository = () =>
  Effect.gen(function* () {
    const appDataDir = yield* Effect.promise(() =>
      makeTempDir("lucent-script-inputs-data-"),
    );
    const workspaceDir = yield* Effect.promise(() =>
      makeTempDir("lucent-script-inputs-workspace-"),
    );
    const env = DesktopEnvironment.of({
      appDataDir,
      assetsDir: join(appDataDir, "assets"),
      isDev: true,
      platform: "darwin",
      workspaceDir,
    });
    const repository = yield* ScriptInputRepository.pipe(
      Effect.provide(
        scriptInputRepositoryLayer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(DesktopEnvironment, env),
              desktopFileSystemLayer,
            ),
          ),
        ),
      ),
    );
    return { env, repository };
  });

const captureLogs = () => {
  const records: unknown[] = [];
  const logger = Logger.make((options) =>
    records.push({
      level: options.logLevel,
      message:
        options.cause.reasons.length === 0
          ? options.message
          : [
              ...(Array.isArray(options.message)
                ? options.message
                : [options.message]),
              options.cause,
            ],
      annotations: options.fiber.getRef(References.CurrentLogAnnotations),
    }),
  );
  return { records, logger };
};

describe("saved script input recovery", () => {
  it.effect(
    "keeps valid fields and reports discarded scripts and fields once without changing the file",
    () =>
      Effect.gen(function* () {
        const { env, repository } = yield* makeRepository();
        const path = join(env.appDataDir, "script-inputs.json");
        const source =
          JSON.stringify(
            {
              "repository-test": {
                target: "kept",
                count: "secret-invalid-value",
                enabled: true,
                server: "Removed",
                rewards: ["Weapon", "Removed"],
              },
              broken: null,
            },
            null,
            3,
          ) + "\n";
        yield* Effect.promise(() => writeFile(path, source));
        const { records, logger } = captureLogs();
        const loaded = yield* repository
          .getValues(definition)
          .pipe(
            Effect.provideService(Logger.CurrentLoggers, new Set([logger])),
          );
        expect(loaded).toEqual({
          target: "kept",
          count: 3,
          enabled: true,
          server: "Artix",
          rewards: ["Weapon"],
        });
        expect(records).toEqual([
          {
            level: "Warn",
            message: [
              "Saved script inputs had invalid entries; ignoring them until the next save",
            ],
            annotations: {
              component: "script-inputs",
              data: { path, ignored: { scripts: 1, fields: 3 } },
            },
          },
        ]);
        expect(yield* Effect.promise(() => readFile(path, "utf8"))).toBe(
          source,
        );
        yield* repository
          .saveValues(definition, { ...loaded, count: 7 })
          .pipe(
            Effect.provideService(Logger.CurrentLoggers, new Set([logger])),
          );
        expect(records).toHaveLength(1);
        expect(
          JSON.parse(yield* Effect.promise(() => readFile(path, "utf8"))),
        ).toEqual({
          "repository-test": {
            target: "kept",
            count: 7,
            enabled: true,
            server: "Artix",
            rewards: ["Weapon"],
          },
        });
      }),
  );

  it.effect("reports duplicate selections that normalization discarded", () =>
    Effect.gen(function* () {
      const { env, repository } = yield* makeRepository();
      const path = join(env.appDataDir, "script-inputs.json");
      const source = JSON.stringify({
        "repository-test": { rewards: ["Pet", "Pet"] },
      });
      yield* Effect.promise(() => writeFile(path, source));
      const { records, logger } = captureLogs();
      expect(
        yield* repository
          .getValues(definition)
          .pipe(
            Effect.provideService(Logger.CurrentLoggers, new Set([logger])),
          ),
      ).toEqual({
        count: 3,
        enabled: false,
        server: "Artix",
        rewards: ["Pet"],
      });
      expect(records).toEqual([
        {
          level: "Warn",
          message: [
            "Saved script inputs had invalid entries; ignoring them until the next save",
          ],
          annotations: {
            component: "script-inputs",
            data: { path, ignored: { scripts: 0, fields: 1 } },
          },
        },
      ]);
      expect(yield* Effect.promise(() => readFile(path, "utf8"))).toBe(source);
    }),
  );

  it.effect("fails reads and saves when the input path is a directory", () =>
    Effect.gen(function* () {
      const { env, repository } = yield* makeRepository();
      const path = join(env.appDataDir, "script-inputs.json");
      yield* Effect.promise(() => mkdir(path));
      const sentinel = join(path, "saved-inputs.json");
      const source = '{"existing-test":{"target":"kept"}}';
      yield* Effect.promise(() => writeFile(sentinel, source));
      const { records, logger } = captureLogs();
      for (const operation of [
        repository.getValues(definition),
        repository.saveValues(definition, { target: "new" }),
      ]) {
        const error = yield* operation.pipe(
          Effect.flip,
          Effect.provideService(Logger.CurrentLoggers, new Set([logger])),
        );
        expect(error).toMatchObject({
          _tag: "ScriptInputRepositoryError",
          operation: "read",
          cause: { _tag: "JsonFileError", operation: "read" },
        });
      }
      expect(records).toEqual([]);
      expect(yield* Effect.promise(() => readFile(sentinel, "utf8"))).toBe(
        source,
      );
      expect((yield* Effect.promise(() => stat(path))).isDirectory()).toBe(
        true,
      );
    }),
  );

  for (const source of ["{private-file-text", "[]", "null"]) {
    it.effect(
      `recovers unreadable script inputs from ${source.slice(0, 1)}`,
      () =>
        Effect.gen(function* () {
          const { env, repository } = yield* makeRepository();
          const path = join(env.appDataDir, "script-inputs.json");
          yield* Effect.promise(() => writeFile(path, source));
          const { records, logger } = captureLogs();
          const loaded = yield* repository
            .getValues(definition)
            .pipe(
              Effect.provideService(Logger.CurrentLoggers, new Set([logger])),
            );
          expect(loaded).toEqual({
            count: 3,
            enabled: false,
            server: "Artix",
            rewards: ["Armor"],
          });
          expect(yield* Effect.promise(() => readFile(path, "utf8"))).toBe(
            source,
          );
          expect(records).toEqual([
            {
              level: "Warn",
              message: [
                "Saved script inputs could not be read; using defaults until the next save",
                ...(source === "{private-file-text"
                  ? [
                      Cause.fail(
                        new JsonFileError({
                          operation: "parse",
                          path,
                          cause: new SyntaxError(
                            "Invalid JSON at line 1 column 2",
                          ),
                        }),
                      ),
                    ]
                  : []),
              ],
              annotations: {
                component: "script-inputs",
                data: { path, ignored: { file: 1 } },
              },
            },
          ]);
          const saved = yield* repository
            .saveValues(definition, { target: "new" })
            .pipe(
              Effect.provideService(Logger.CurrentLoggers, new Set([logger])),
            );
          expect(records).toHaveLength(1);
          expect(saved).toEqual({
            target: "new",
            count: 3,
            enabled: false,
            server: "Artix",
            rewards: ["Armor"],
          });
          expect(
            JSON.parse(yield* Effect.promise(() => readFile(path, "utf8")))[
              "repository-test"
            ],
          ).toEqual(saved);
        }),
    );
  }

  it.effect("loads missing and valid optional inputs silently", () =>
    Effect.gen(function* () {
      const { env, repository } = yield* makeRepository();
      const { records, logger } = captureLogs();
      expect(
        yield* repository
          .getValues(definition)
          .pipe(
            Effect.provideService(Logger.CurrentLoggers, new Set([logger])),
          ),
      ).toEqual({
        count: 3,
        enabled: false,
        server: "Artix",
        rewards: ["Armor"],
      });
      const path = join(env.appDataDir, "script-inputs.json");
      const source = JSON.stringify({
        "repository-test": { target: "kept", rewards: ["Pet", "Weapon"] },
      });
      yield* Effect.promise(() => writeFile(path, source));
      expect(
        yield* repository
          .getValues(definition)
          .pipe(
            Effect.provideService(Logger.CurrentLoggers, new Set([logger])),
          ),
      ).toEqual({
        target: "kept",
        count: 3,
        enabled: false,
        server: "Artix",
        rewards: ["Weapon", "Pet"],
      });
      expect(records).toEqual([]);
      expect(yield* Effect.promise(() => readFile(path, "utf8"))).toBe(source);
    }),
  );
});

describe("ScriptInputRepository service", () => {
  it.effect("normalizes saved values before persisting", () =>
    Effect.gen(function* () {
      const { env, repository } = yield* makeRepository();

      expect(yield* repository.getValues(definition)).toEqual(
        normalizeScriptInputValues(definition, {}),
      );

      const values = yield* repository.saveValues(definition, {
        count: Number.NaN,
        enabled: true,
        rewards: ["Pet", "Weapon", "Removed"],
        server: "Missing",
        target: "chaos",
      });
      const persisted = JSON.parse(
        yield* Effect.promise(() =>
          readFile(join(env.appDataDir, "script-inputs.json"), "utf8"),
        ),
      ) as Record<string, unknown>;

      expect(values).toEqual({
        count: 3,
        enabled: true,
        rewards: ["Weapon", "Pet"],
        server: "Artix",
        target: "chaos",
      });
      expect(persisted).toEqual({
        "repository-test": values,
      });
    }),
  );

  it.effect("preserves concurrent saves for different scripts", () =>
    Effect.gen(function* () {
      const { env, repository } = yield* makeRepository();
      const alternateDefinition: ScriptInputsDefinition = {
        ...definition,
        id: "alternate-test",
      };

      const [primaryValues, alternateValues] = yield* Effect.all(
        [
          repository.saveValues(definition, { target: "primary" }),
          repository.saveValues(alternateDefinition, { target: "alternate" }),
        ],
        { concurrency: "unbounded" },
      );
      const persisted = JSON.parse(
        yield* Effect.promise(() =>
          readFile(join(env.appDataDir, "script-inputs.json"), "utf8"),
        ),
      ) as Record<string, unknown>;

      expect(persisted).toEqual({
        "alternate-test": alternateValues,
        "repository-test": primaryValues,
      });
    }),
  );

  it.effect(
    "preserves valid entries when another stored entry is malformed",
    () =>
      Effect.gen(function* () {
        const { env, repository } = yield* makeRepository();
        const path = join(env.appDataDir, "script-inputs.json");
        yield* Effect.promise(() =>
          writeFile(
            path,
            JSON.stringify({
              "existing-test": { target: "existing" },
              malformed: "not-an-object",
            }),
            "utf8",
          ),
        );

        yield* repository.saveValues(definition, { target: "new" });
        const persisted = JSON.parse(
          yield* Effect.promise(() => readFile(path, "utf8")),
        ) as Record<string, unknown>;

        expect(persisted).toEqual({
          "existing-test": { target: "existing" },
          "repository-test": {
            count: 3,
            enabled: false,
            rewards: ["Armor"],
            server: "Artix",
            target: "new",
          },
        });
      }),
  );
});
