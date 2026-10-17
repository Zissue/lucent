import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { layer as fileSystemLayer } from "@effect/platform-node/NodeFileSystem";
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as References from "effect/References";

import { DesktopEnvironment } from "../../app/DesktopEnvironment";
import { JsonFileError } from "../../filesystem/JsonFile";
import { AccountRepository, layer } from "./AccountRepository";

const tempDirs = new Set<string>();

afterEach(async () => {
  await Promise.all(
    [...tempDirs].map((path) => rm(path, { force: true, recursive: true })),
  );
  tempDirs.clear();
});

const makeLayer = Effect.gen(function* () {
  const appDataDir = yield* Effect.promise(() =>
    mkdtemp(join(tmpdir(), "lucent-account-repository-")),
  );
  tempDirs.add(appDataDir);
  return layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        fileSystemLayer,
        Layer.succeed(DesktopEnvironment, {
          appDataDir,
          assetsDir: join(appDataDir, "assets"),
          isDev: true,
          platform: "darwin",
          workspaceDir: join(appDataDir, "workspace"),
        }),
      ),
    ),
  );
});

describe("AccountRepository", () => {
  it.effect(
    "advances revisions only for changed storage across loads and updates",
    () =>
      Effect.gen(function* () {
        const dependencies = yield* makeLayer;
        yield* Effect.gen(function* () {
          const repository = yield* AccountRepository;
          expect(yield* repository.getWithRevision).toBeNull();
          yield* repository.get;
          yield* repository.load;
          expect(yield* repository.getWithRevision).toEqual({
            storage: { accounts: [], groups: {} },
            revision: 0,
          });
          yield* repository.update((storage) =>
            Effect.succeed({ ...storage, groups: { Raiders: [] } }),
          );
          yield* repository.update((storage) => Effect.succeed({ ...storage }));
          yield* repository.load;
          expect(yield* repository.getWithRevision).toEqual({
            storage: { accounts: [], groups: { Raiders: [] } },
            revision: 1,
          });
          yield* Effect.promise(() =>
            writeFile(repository.path, '{"accounts":[],"groups":{"Alts":[]}}'),
          );
          yield* repository.load;
          expect(yield* repository.getWithRevision).toEqual({
            storage: { accounts: [], groups: { Alts: [] } },
            revision: 2,
          });
        }).pipe(Effect.provide(dependencies));
      }),
  );

  it.effect(
    "keeps revisions and storage when a save fails or changes nothing",
    () =>
      Effect.gen(function* () {
        const dependencies = yield* makeLayer;
        yield* Effect.gen(function* () {
          const repository = yield* AccountRepository;
          yield* repository.update((storage) => Effect.succeed({ ...storage }));
          expect(yield* repository.getWithRevision).toEqual({
            storage: { accounts: [], groups: {} },
            revision: 0,
          });
          yield* repository.update((storage) =>
            Effect.succeed({ ...storage, groups: { Raiders: [] } }),
          );
          yield* Effect.promise(async () => {
            await rm(repository.path);
            await mkdir(repository.path);
          });
          const unchanged = yield* repository.update((storage) =>
            Effect.succeed({ ...storage }),
          );
          expect(unchanged).toEqual({ accounts: [], groups: { Raiders: [] } });
          const error = yield* repository
            .update((storage) =>
              Effect.succeed({ ...storage, groups: { Alts: [] } }),
            )
            .pipe(Effect.flip);
          expect(error.operation).toBe("rename");
          expect(yield* repository.getWithRevision).toEqual({
            storage: { accounts: [], groups: { Raiders: [] } },
            revision: 1,
          });
        }).pipe(Effect.provide(dependencies));
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

describe("AccountRepository saved data", () => {
  it.effect(
    "keeps valid entries and preserves invalid source until a changed save",
    () =>
      Effect.gen(function* () {
        const dependencies = yield* makeLayer;
        yield* Effect.gen(function* () {
          const repository = yield* AccountRepository;
          const source = JSON.stringify({
            accounts: [
              { label: "Hero", username: "Hero", password: "secret" },
              { label: "Duplicate", username: "hero", password: "private" },
              { label: "Broken", username: "Broken", password: 42 },
            ],
            groups: {
              Raiders: ["Hero", "Hero", "Missing", 42],
              " raiders ": ["Hero"],
              " ": ["Hero"],
            },
          });
          yield* Effect.promise(() => writeFile(repository.path, source));
          const { value, records } = yield* captureLogs(repository.get);
          expect(value).toEqual({
            accounts: [{ label: "Hero", username: "Hero", password: "secret" }],
            groups: { Raiders: ["Hero"] },
          });
          expect(records).toEqual([
            {
              level: "Warn",
              message: [
                "Saved accounts had invalid entries; ignoring them until the next save",
              ],
              annotations: {
                component: "accounts",
                data: {
                  path: repository.path,
                  ignored: { accounts: 2, groups: 2, groupMembers: 5 },
                },
              },
            },
          ]);
          expect(
            yield* Effect.promise(() => readFile(repository.path, "utf8")),
          ).toBe(source);
          yield* repository.update((storage) => Effect.succeed({ ...storage }));
          expect(
            yield* Effect.promise(() => readFile(repository.path, "utf8")),
          ).toBe(source);
          expect(yield* repository.getWithRevision).toEqual({
            storage: {
              accounts: [
                { label: "Hero", username: "Hero", password: "secret" },
              ],
              groups: { Raiders: ["Hero"] },
            },
            revision: 0,
          });
          yield* repository.update((storage) =>
            Effect.succeed({
              ...storage,
              groups: { Raiders: ["Hero"], Alts: [] },
            }),
          );
          expect(
            JSON.parse(
              yield* Effect.promise(() => readFile(repository.path, "utf8")),
            ),
          ).toEqual({
            accounts: [{ label: "Hero", username: "Hero", password: "secret" }],
            groups: { Raiders: ["Hero"], Alts: [] },
          });
          expect(yield* repository.getWithRevision).toEqual({
            storage: {
              accounts: [
                { label: "Hero", username: "Hero", password: "secret" },
              ],
              groups: { Raiders: ["Hero"], Alts: [] },
            },
            revision: 1,
          });
        }).pipe(Effect.provide(dependencies));
      }),
  );

  for (const source of ["{not-json", "[]", "null", "42"]) {
    it.effect(
      `uses defaults without overwriting unreadable source ${source}`,
      () =>
        Effect.gen(function* () {
          const dependencies = yield* makeLayer;
          yield* Effect.gen(function* () {
            const repository = yield* AccountRepository;
            yield* Effect.promise(() => writeFile(repository.path, source));
            const { value, records } = yield* captureLogs(repository.load);
            expect(value).toEqual({ accounts: [], groups: {} });
            expect(records).toEqual([
              {
                level: "Warn",
                message: [
                  "Saved accounts could not be read; using defaults until the next save",
                  ...(source === "{not-json"
                    ? [
                        Cause.fail(
                          new JsonFileError({
                            operation: "parse",
                            path: repository.path,
                            cause: new SyntaxError(
                              "Invalid JSON at line 1 column 2",
                            ),
                          }),
                        ),
                      ]
                    : []),
                ],
                annotations: {
                  component: "accounts",
                  data: {
                    path: repository.path,
                    reset: ["accounts", "groups"],
                  },
                },
              },
            ]);
            expect(
              yield* Effect.promise(() => readFile(repository.path, "utf8")),
            ).toBe(source);
            yield* repository.update((storage) =>
              Effect.succeed({ ...storage, groups: { Raiders: [] } }),
            );
            expect(
              JSON.parse(
                yield* Effect.promise(() => readFile(repository.path, "utf8")),
              ),
            ).toEqual({ accounts: [], groups: { Raiders: [] } });
          }).pipe(Effect.provide(dependencies));
        }),
    );
  }

  it.effect("loads missing and valid optional fields silently", () =>
    Effect.gen(function* () {
      const dependencies = yield* makeLayer;
      yield* Effect.gen(function* () {
        const repository = yield* AccountRepository;
        const missing = yield* captureLogs(repository.get);
        expect(missing).toEqual({
          value: { accounts: [], groups: {} },
          records: [],
        });
        yield* Effect.promise(() =>
          writeFile(
            repository.path,
            '{"accounts":[{"label":"Hero","username":"Hero","password":"secret"}]}',
          ),
        );
        const valid = yield* captureLogs(repository.load);
        expect(valid).toEqual({
          value: {
            accounts: [{ label: "Hero", username: "Hero", password: "secret" }],
            groups: {},
          },
          records: [],
        });
        expect(
          JSON.parse(
            yield* Effect.promise(() => readFile(repository.path, "utf8")),
          ),
        ).toEqual({
          accounts: [{ label: "Hero", username: "Hero", password: "secret" }],
          groups: {},
        });
      }).pipe(Effect.provide(dependencies));
    }),
  );
});

it.effect(
  "keeps valid account data when a collection has the wrong shape",
  () =>
    Effect.gen(function* () {
      const dependencies = yield* makeLayer;
      yield* Effect.gen(function* () {
        const repository = yield* AccountRepository;
        const source =
          '{"accounts":[{"label":"Hero","username":"Hero","password":"secret"}],"groups":{"Raiders":42}}';
        yield* Effect.promise(() => writeFile(repository.path, source));
        const { value, records } = yield* captureLogs(repository.get);
        expect(value).toEqual({
          accounts: [{ label: "Hero", username: "Hero", password: "secret" }],
          groups: { Raiders: [] },
        });
        expect(records).toEqual([
          {
            level: "Warn",
            message: [
              "Saved accounts had invalid entries; ignoring them until the next save",
            ],
            annotations: {
              component: "accounts",
              data: { path: repository.path, reset: ["groups"] },
            },
          },
        ]);
        expect(
          yield* Effect.promise(() => readFile(repository.path, "utf8")),
        ).toBe(source);
      }).pipe(Effect.provide(dependencies));
    }),
);

it.effect(
  "reports both ignored accounts and reset group fields in one warning",
  () =>
    Effect.gen(function* () {
      const dependencies = yield* makeLayer;
      yield* Effect.gen(function* () {
        const repository = yield* AccountRepository;
        const source =
          '{"accounts":[{"label":"Hero","username":"Hero","password":"secret"},null],"groups":{"Raiders":42}}';
        yield* Effect.promise(() => writeFile(repository.path, source));
        const { value, records } = yield* captureLogs(repository.get);
        expect(value).toEqual({
          accounts: [{ label: "Hero", username: "Hero", password: "secret" }],
          groups: { Raiders: [] },
        });
        expect(records).toEqual([
          {
            level: "Warn",
            message: [
              "Saved accounts had invalid entries; ignoring them until the next save",
            ],
            annotations: {
              component: "accounts",
              data: {
                path: repository.path,
                ignored: { accounts: 1, groups: 0, groupMembers: 0 },
                reset: ["groups"],
              },
            },
          },
        ]);
        expect(
          yield* Effect.promise(() => readFile(repository.path, "utf8")),
        ).toBe(source);
      }).pipe(Effect.provide(dependencies));
    }),
);

it.effect(
  "fails reads and updates without replacing unreadable valid accounts",
  () =>
    Effect.gen(function* () {
      const dependencies = yield* makeLayer;
      yield* Effect.gen(function* () {
        const repository = yield* AccountRepository;
        const source =
          '{"accounts":[{"label":"Hero","username":"Hero","password":"secret"}],"groups":{}}';
        yield* Effect.promise(() => writeFile(repository.path, source));
        yield* Effect.promise(() => chmod(repository.path, 0));
        try {
          for (const operation of [
            repository.get,
            repository.update((storage) =>
              Effect.succeed({ ...storage, groups: { Raiders: [] } }),
            ),
          ]) {
            const { value: error, records } = yield* captureLogs(
              operation.pipe(Effect.flip),
            );
            expect(error).toMatchObject({
              _tag: "AccountsError",
              operation: "read",
              cause: { _tag: "JsonFileError", operation: "read" },
            });
            expect(records).toEqual([]);
            expect(yield* repository.getWithRevision).toBeNull();
          }
        } finally {
          yield* Effect.promise(() => chmod(repository.path, 0o600));
        }
        expect(
          yield* Effect.promise(() => readFile(repository.path, "utf8")),
        ).toBe(source);
        expect(yield* repository.get).toEqual({
          accounts: [{ label: "Hero", username: "Hero", password: "secret" }],
          groups: {},
        });
      }).pipe(Effect.provide(dependencies));
    }),
);

it.effect("rejects accounts above the read limit without replacing them", () =>
  Effect.gen(function* () {
    const dependencies = yield* makeLayer;
    yield* Effect.gen(function* () {
      const repository = yield* AccountRepository;
      const source = JSON.stringify({
        accounts: [],
        groups: {},
        padding: "x".repeat(8 * 1024 * 1024),
      });
      yield* Effect.promise(() => writeFile(repository.path, source));
      for (const operation of [
        repository.get,
        repository.update((storage) =>
          Effect.succeed({ ...storage, groups: { Raiders: [] } }),
        ),
      ]) {
        const { value: error, records } = yield* captureLogs(
          operation.pipe(Effect.flip),
        );
        expect(error).toMatchObject({
          _tag: "AccountsError",
          operation: "read",
          cause: {
            _tag: "JsonFileError",
            operation: "read",
            cause: {
              _tag: "FileSystemLimitError",
              kind: "bytes",
              limit: 8388608,
            },
          },
        });
        expect(records).toEqual([]);
        expect(yield* repository.getWithRevision).toBeNull();
      }
      expect(
        yield* Effect.promise(() => readFile(repository.path, "utf8")),
      ).toBe(source);
    }).pipe(Effect.provide(dependencies));
  }),
);

for (const source of ["{", '{"accounts":[null],"groups":{}}']) {
  it.effect(
    `saves accounts without recovery warnings before loading ${source}`,
    () =>
      Effect.gen(function* () {
        const dependencies = yield* makeLayer;
        yield* Effect.gen(function* () {
          const repository = yield* AccountRepository;
          yield* Effect.promise(() => writeFile(repository.path, source));
          const { value, records } = yield* captureLogs(
            repository.update((storage) =>
              Effect.succeed({ ...storage, groups: { Raiders: [] } }),
            ),
          );
          expect(value).toEqual({ accounts: [], groups: { Raiders: [] } });
          expect(
            JSON.parse(
              yield* Effect.promise(() => readFile(repository.path, "utf8")),
            ),
          ).toEqual({ accounts: [], groups: { Raiders: [] } });
          expect(records).toEqual([]);
        }).pipe(Effect.provide(dependencies));
      }),
  );
}
