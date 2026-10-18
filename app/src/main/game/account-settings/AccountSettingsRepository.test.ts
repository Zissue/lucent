import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { FileSystem } from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as PlatformError from "effect/PlatformError";
import * as References from "effect/References";
import * as Stream from "effect/Stream";

import { DEFAULT_ACCOUNT_SETTINGS } from "@lucent/core/accountSettings";
import { DesktopEnvironment } from "../../app/DesktopEnvironment";
import { layer as desktopFileSystemLayer } from "@effect/platform-node/NodeFileSystem";
import { JsonFileError } from "../../filesystem/JsonFile";
import {
  AccountSettingsRepository,
  layer as accountSettingsRepositoryLayer,
} from "./AccountSettingsRepository";

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

const makeRepository = (
  wrapFileSystem: (fs: FileSystem) => FileSystem = (fs) => fs,
) =>
  Effect.gen(function* () {
    const appDataDir = yield* Effect.promise(() =>
      makeTempDir("lucent-account-settings-data-"),
    );
    const workspaceDir = yield* Effect.promise(() =>
      makeTempDir("lucent-account-settings-workspace-"),
    );
    const env = DesktopEnvironment.of({
      appDataDir,
      assetsDir: join(appDataDir, "assets"),
      isDev: true,
      platform: "darwin",
      workspaceDir,
    });
    const repository = yield* AccountSettingsRepository.pipe(
      Effect.provide(
        accountSettingsRepositoryLayer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(DesktopEnvironment, env),
              Layer.effect(
                FileSystem,
                Effect.map(FileSystem, wrapFileSystem),
              ).pipe(Layer.provide(desktopFileSystemLayer)),
            ),
          ),
        ),
      ),
    );
    return { env, repository };
  });

describe("AccountSettingsRepository", () => {
  it.effect(
    "uses a lowercase username filename without creating defaults",
    () =>
      Effect.gen(function* () {
        const { repository } = yield* makeRepository();
        const path = yield* repository.pathFor("  Hero Name  ");

        expect(path).toMatch(/account-settings\/hero name\.json$/u);
        expect(yield* repository.get("Hero Name")).toEqual(
          DEFAULT_ACCOUNT_SETTINGS,
        );
        expect(
          yield* Effect.promise(() =>
            stat(path).then(
              () => true,
              () => false,
            ),
          ),
        ).toBe(false);
      }),
  );

  it.effect(
    "normalizes fields independently and preserves siblings on update",
    () =>
      Effect.gen(function* () {
        const { repository } = yield* makeRepository();
        const path = yield* repository.pathFor("Hero");
        yield* Effect.promise(() => mkdir(dirname(path), { recursive: true }));
        yield* Effect.promise(() =>
          writeFile(
            path,
            JSON.stringify({
              scripts: {
                restartAfterReconnect: "invalid",
                roomPolicy: { kind: "specific", roomNumber: 42 },
                safeStartStop: false,
              },
            }),
            "utf8",
          ),
        );

        expect(yield* repository.get("hero")).toMatchObject({
          scripts: {
            restartAfterReconnect: false,
            roomPolicy: { kind: "specific", roomNumber: 42 },
            safeStartStop: false,
          },
        });

        const updated = yield* repository.update("HERO", {
          scripts: { restartAfterReconnect: true },
        });
        expect(updated.scripts).toEqual({
          restartAfterReconnect: true,
          roomPolicy: { kind: "specific", roomNumber: 42 },
          safeStartStop: false,
        });
      }),
  );

  it.effect("leaves malformed JSON untouched until an edit heals it", () =>
    Effect.gen(function* () {
      const { repository } = yield* makeRepository();
      const path = yield* repository.pathFor("Hero");
      yield* Effect.promise(() => mkdir(dirname(path), { recursive: true }));
      yield* Effect.promise(() => writeFile(path, "{not-json", "utf8"));

      expect(yield* repository.get("Hero")).toEqual(DEFAULT_ACCOUNT_SETTINGS);
      expect(yield* Effect.promise(() => readFile(path, "utf8"))).toBe(
        "{not-json",
      );

      const healed = yield* repository.update("Hero", {
        scripts: { safeStartStop: false },
      });
      expect(healed.scripts.safeStartStop).toBe(false);
      expect(
        JSON.parse(yield* Effect.promise(() => readFile(path, "utf8"))),
      ).toEqual(healed);
    }),
  );
});

const captureLogs = <A, E, R>(effect: Effect.Effect<A, E, R>) => {
  const records: {
    level: string;
    message: unknown;
    annotations: Readonly<Record<string, unknown>>;
  }[] = [];
  const logger = Logger.make((options) => {
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
    });
  });
  return effect.pipe(
    Effect.provideService(Logger.CurrentLoggers, new Set([logger])),
    Effect.map((value) => ({ value, records })),
  );
};

describe("AccountSettingsRepository saved data", () => {
  it.effect(
    "warns once about reset fields without account names and keeps valid siblings",
    () =>
      Effect.gen(function* () {
        const { env, repository } = yield* makeRepository();
        const path = yield* repository.pathFor("Private Hero");
        const source =
          '{"scripts":{"restartAfterReconnect":"invalid","roomPolicy":{"kind":"specific","roomNumber":42},"safeStartStop":false}}';
        yield* Effect.promise(() => mkdir(dirname(path), { recursive: true }));
        yield* Effect.promise(() => writeFile(path, source));
        const { value, records } = yield* captureLogs(
          repository.get("Private Hero"),
        );
        expect(value).toEqual({
          version: 1,
          scripts: {
            restartAfterReconnect: false,
            roomPolicy: { kind: "specific", roomNumber: 42 },
            safeStartStop: false,
          },
        });
        expect(records).toEqual([
          {
            level: "Warn",
            message: [
              "Saved account settings had invalid entries; ignoring them until the next save",
            ],
            annotations: {
              component: "account-settings",
              data: {
                path: join(
                  env.appDataDir,
                  "account-settings",
                  "[account].json",
                ),
                reset: ["scripts.restartAfterReconnect"],
              },
            },
          },
        ]);
        expect(yield* Effect.promise(() => readFile(path, "utf8"))).toBe(
          source,
        );
        const { value: saved, records: saveRecords } = yield* captureLogs(
          repository.update("Private Hero", {
            scripts: { restartAfterReconnect: true },
          }),
        );
        expect(saved).toEqual({
          version: 1,
          scripts: {
            restartAfterReconnect: true,
            roomPolicy: { kind: "specific", roomNumber: 42 },
            safeStartStop: false,
          },
        });
        expect(saveRecords).toEqual([]);
        expect(
          JSON.parse(yield* Effect.promise(() => readFile(path, "utf8"))),
        ).toEqual({
          version: 1,
          scripts: {
            restartAfterReconnect: true,
            roomPolicy: { kind: "specific", roomNumber: 42 },
            safeStartStop: false,
          },
        });
      }),
  );

  for (const source of ["{not-json", "[]", "null", "42"]) {
    it.effect(
      `uses defaults and a private path without overwriting unreadable source ${source}`,
      () =>
        Effect.gen(function* () {
          const { env, repository } = yield* makeRepository();
          const path = yield* repository.pathFor("Private Hero");
          yield* Effect.promise(() =>
            mkdir(dirname(path), { recursive: true }),
          );
          yield* Effect.promise(() => writeFile(path, source));
          const { value, records } = yield* captureLogs(
            repository.get("Private Hero"),
          );
          expect(value).toEqual({
            version: 1,
            scripts: {
              restartAfterReconnect: false,
              roomPolicy: { kind: "random-private" },
              safeStartStop: true,
            },
          });
          expect(records).toEqual([
            {
              level: "Warn",
              message: [
                "Saved account settings could not be read; using defaults until the next save",
                ...(source === "{not-json"
                  ? [
                      Cause.fail(
                        new JsonFileError({
                          operation: "parse",
                          path: join(
                            env.appDataDir,
                            "account-settings",
                            "[account].json",
                          ),
                          cause: new SyntaxError(
                            "Invalid JSON at line 1 column 2",
                          ),
                        }),
                      ),
                    ]
                  : []),
              ],
              annotations: {
                component: "account-settings",
                data: {
                  path: join(
                    env.appDataDir,
                    "account-settings",
                    "[account].json",
                  ),
                  ignored: { file: 1 },
                },
              },
            },
          ]);
          expect(yield* Effect.promise(() => readFile(path, "utf8"))).toBe(
            source,
          );
          const { value: updated, records: saveRecords } = yield* captureLogs(
            repository.update("Private Hero", {
              scripts: { safeStartStop: false },
            }),
          );
          expect(updated).toEqual({
            version: 1,
            scripts: {
              restartAfterReconnect: false,
              roomPolicy: { kind: "random-private" },
              safeStartStop: false,
            },
          });
          expect(saveRecords).toEqual([]);
          expect(
            JSON.parse(yield* Effect.promise(() => readFile(path, "utf8"))),
          ).toEqual({
            version: 1,
            scripts: {
              restartAfterReconnect: false,
              roomPolicy: { kind: "random-private" },
              safeStartStop: false,
            },
          });
        }),
    );
  }

  it.effect("fails unreadable storage without overwriting it on update", () =>
    Effect.gen(function* () {
      let unreadablePath: string | undefined;
      const { repository } = yield* makeRepository((fileSystem) =>
        FileSystem.of({
          ...fileSystem,
          stream: (path, options) =>
            path === unreadablePath
              ? Stream.fail(
                  PlatformError.systemError({
                    _tag: "PermissionDenied",
                    module: "FileSystem",
                    method: "stream",
                    pathOrDescriptor: path,
                  }),
                )
              : fileSystem.stream(path, options),
        }),
      );
      const path = yield* repository.pathFor("Hero");
      const source =
        '{"version":1,"scripts":{"restartAfterReconnect":true,"roomPolicy":{"kind":"specific","roomNumber":42},"safeStartStop":false}}\n';
      yield* Effect.promise(() => mkdir(dirname(path), { recursive: true }));
      yield* Effect.promise(() => writeFile(path, source));
      unreadablePath = path;
      const { value, records } = yield* captureLogs(
        Effect.gen(function* () {
          try {
            const loaded = yield* repository.get("Hero").pipe(Effect.result);
            const updated = yield* repository
              .update("Hero", { scripts: { safeStartStop: true } })
              .pipe(Effect.result);
            return { loaded, updated };
          } finally {
            unreadablePath = undefined;
          }
        }),
      );
      for (const result of [value.loaded, value.updated]) {
        expect(result).toMatchObject({
          _tag: "Failure",
          failure: {
            _tag: "AccountSettingsError",
            operation: "read",
            detail: `JSON file read failed at ${path}.`,
            cause: { _tag: "JsonFileError", operation: "read", path },
          },
        });
      }
      expect(yield* Effect.promise(() => readFile(path, "utf8"))).toBe(source);
      expect(records).toEqual([]);
      expect(yield* repository.get("Hero")).toEqual({
        version: 1,
        scripts: {
          restartAfterReconnect: true,
          roomPolicy: { kind: "specific", roomNumber: 42 },
          safeStartStop: false,
        },
      });
    }),
  );

  it.effect("loads missing files and valid optional fields silently", () =>
    Effect.gen(function* () {
      const { repository } = yield* makeRepository();
      const path = yield* repository.pathFor("Hero");
      const missing = yield* captureLogs(repository.get("Hero"));
      expect(missing).toEqual({
        value: {
          version: 1,
          scripts: {
            restartAfterReconnect: false,
            roomPolicy: { kind: "random-private" },
            safeStartStop: true,
          },
        },
        records: [],
      });
      yield* Effect.promise(() => mkdir(dirname(path), { recursive: true }));
      yield* Effect.promise(() =>
        writeFile(path, '{"scripts":{"safeStartStop":false}}'),
      );
      const valid = yield* captureLogs(repository.get("Hero"));
      expect(valid).toEqual({
        value: {
          version: 1,
          scripts: {
            restartAfterReconnect: false,
            roomPolicy: { kind: "random-private" },
            safeStartStop: false,
          },
        },
        records: [],
      });
    }),
  );
});

it.effect(
  "reports only fixed field paths when nested account settings are invalid",
  () =>
    Effect.gen(function* () {
      const { env, repository } = yield* makeRepository();
      const path = yield* repository.pathFor("Private Hero");
      const source =
        '{"version":"wrong","scripts":{"roomPolicy":{"kind":"specific","roomNumber":0},"safeStartStop":null}}';
      yield* Effect.promise(() => mkdir(dirname(path), { recursive: true }));
      yield* Effect.promise(() => writeFile(path, source));
      const { value, records } = yield* captureLogs(
        repository.get("Private Hero"),
      );
      expect(value).toEqual({
        version: 1,
        scripts: {
          restartAfterReconnect: false,
          roomPolicy: { kind: "random-private" },
          safeStartStop: true,
        },
      });
      expect(records).toEqual([
        {
          level: "Warn",
          message: [
            "Saved account settings had invalid entries; ignoring them until the next save",
          ],
          annotations: {
            component: "account-settings",
            data: {
              path: join(env.appDataDir, "account-settings", "[account].json"),
              reset: ["version", "scripts.roomPolicy", "scripts.safeStartStop"],
            },
          },
        },
      ]);
      expect(yield* Effect.promise(() => readFile(path, "utf8"))).toBe(source);
    }),
);

it.effect(
  "reads newer account settings silently and writes the current version on update",
  () =>
    Effect.gen(function* () {
      const { repository } = yield* makeRepository();
      const path = yield* repository.pathFor("Hero");
      yield* Effect.promise(() => mkdir(dirname(path), { recursive: true }));
      const source =
        '{"version":2,"scripts":{"safeStartStop":false},"futureOnly":"retain"}';
      yield* Effect.promise(() => writeFile(path, source));
      expect(yield* captureLogs(repository.get("Hero"))).toEqual({
        value: {
          version: 1,
          scripts: {
            restartAfterReconnect: false,
            roomPolicy: { kind: "random-private" },
            safeStartStop: false,
          },
        },
        records: [],
      });
      expect(yield* Effect.promise(() => readFile(path, "utf8"))).toBe(source);
      expect(
        yield* captureLogs(
          repository.update("Hero", { scripts: { safeStartStop: true } }),
        ),
      ).toEqual({
        value: {
          version: 1,
          scripts: {
            restartAfterReconnect: false,
            roomPolicy: { kind: "random-private" },
            safeStartStop: true,
          },
        },
        records: [],
      });
      expect(
        JSON.parse(yield* Effect.promise(() => readFile(path, "utf8"))),
      ).toEqual({
        version: 1,
        scripts: {
          restartAfterReconnect: false,
          roomPolicy: { kind: "random-private" },
          safeStartStop: true,
        },
      });
    }),
);
