import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as PlatformError from "effect/PlatformError";
import * as References from "effect/References";
import * as Stream from "effect/Stream";

import {
  COMBAT_PROFILE_LIBRARY_VERSION,
  DEFAULT_COMBAT_PROFILE_ID,
  normalizeCombatProfileLibrary,
  type CombatProfile,
  type CombatProfileLibrary,
} from "@lucent/core/combatProfiles";
import { DesktopEnvironment } from "../../app/DesktopEnvironment";
import { FileSystem } from "effect/FileSystem";
import { layer as desktopFileSystemLayer } from "@effect/platform-node/NodeFileSystem";
import { JsonFileError } from "../../filesystem/JsonFile";
import {
  CombatProfiles,
  layer as desktopCombatProfilesLayer,
} from "./CombatProfiles";

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

const makeHarness = (
  wrapFileSystem: (fs: FileSystem) => FileSystem = (fs) => fs,
) =>
  Effect.gen(function* () {
    const appDataDir = yield* Effect.promise(() =>
      makeTempDir("lucent-combat-profiles-data-"),
    );
    const workspaceDir = yield* Effect.promise(() =>
      makeTempDir("lucent-combat-profiles-workspace-"),
    );
    const env = DesktopEnvironment.of({
      appDataDir,
      assetsDir: join(appDataDir, "assets"),
      isDev: true,
      platform: "darwin",
      workspaceDir,
    });
    const combatProfilesLayer = desktopCombatProfilesLayer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(DesktopEnvironment, env),
          Layer.effect(FileSystem, Effect.map(FileSystem, wrapFileSystem)).pipe(
            Layer.provide(desktopFileSystemLayer),
          ),
        ),
      ),
    );
    const combatProfiles = yield* CombatProfiles.pipe(
      Effect.provide(combatProfilesLayer),
    );

    return {
      combatProfiles,
      path: join(env.appDataDir, "combat-profiles.json"),
    };
  });

const testProfile: CombatProfile = {
  id: "archpaladin-farm",
  label: "Farm Rotation",
  classNames: ["ArchPaladin"],
  delayMs: 150,
  cooldownMode: "use-if-ready",
  steps: [{ skill: 1, conditions: [], priority: true }],
  messageTriggers: [],
};

const captureLogs = <A, E, R>(effect: Effect.Effect<A, E, R>) => {
  const records: {
    readonly level: string;
    readonly message: unknown;
    readonly annotations: Readonly<Record<string, unknown>>;
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

const genericProfile = {
  id: "generic-base",
  label: "Generic",
  delayMs: 150,
  cooldownMode: "use-if-ready",
  steps: [
    { skill: 1, conditions: [] },
    { skill: 2, conditions: [] },
    { skill: 3, conditions: [] },
    { skill: 4, conditions: [] },
  ],
};

describe("CombatProfiles", () => {
  it.effect("preserves invalid entries on disk until a real save", () =>
    Effect.gen(function* () {
      const { combatProfiles, path } = yield* makeHarness();
      const original = `${JSON.stringify(
        {
          version: 1,
          profiles: [
            null,
            { label: "Missing ID" },
            {
              id: "survivor",
              label: "Survivor",
              delayMs: 150,
              cooldownMode: "use-if-ready",
              classNames: ["Mage", 42],
              steps: [
                null,
                {
                  skill: 2,
                  conditions: [
                    { type: "self-hp", op: "<=", value: 30, unit: "percent" },
                    { type: "invalid" },
                  ],
                },
              ],
              messageTriggers: [
                { messageIncludes: "Enrage", skill: 3, source: "aura" },
                { messageIncludes: "", skill: 2 },
              ],
            },
          ],
        },
        null,
        4,
      )}\n`;
      yield* Effect.promise(() => writeFile(path, original));

      const { value, records } = yield* captureLogs(combatProfiles.load);

      expect(value).toEqual({
        version: 1,
        profiles: [
          genericProfile,
          {
            id: "survivor",
            label: "Survivor",
            delayMs: 150,
            cooldownMode: "use-if-ready",
            classNames: ["Mage"],
            steps: [
              {
                skill: 2,
                conditions: [
                  { type: "self-hp", op: "<=", value: 30, unit: "percent" },
                ],
              },
            ],
            messageTriggers: [
              { messageIncludes: "Enrage", skill: 3, source: "aura" },
            ],
          },
        ],
      });
      expect(records).toEqual([
        {
          level: "Warn",
          message: [
            "Saved combat profiles had invalid entries; ignoring them until the next save",
          ],
          annotations: {
            component: "combat-profiles",
            data: {
              path,
              ignored: {
                profiles: 2,
                classNames: 1,
                steps: 1,
                conditions: 1,
                messageTriggers: 1,
              },
            },
          },
        },
      ]);
      expect(yield* Effect.promise(() => readFile(path, "utf8"))).toBe(
        original,
      );
      const saved = yield* combatProfiles.saveProfile({
        ...testProfile,
        label: "Saved",
      });
      expect(
        JSON.parse(yield* Effect.promise(() => readFile(path, "utf8"))),
      ).toEqual(saved);
      expect(saved.profiles.at(-1)?.label).toBe("Saved");
    }),
  );

  it.effect.each(['{"secret":', "null", "[]", '{"profiles":42}'])(
    "recovers unreadable combat profile data %s without overwriting it",
    (original) =>
      Effect.gen(function* () {
        const { combatProfiles, path } = yield* makeHarness();
        yield* Effect.promise(() => writeFile(path, original));
        const { value, records } = yield* captureLogs(combatProfiles.load);
        expect(value).toEqual({ version: 1, profiles: [genericProfile] });
        expect(records).toEqual([
          {
            level: "Warn",
            message: [
              "Saved combat profiles could not be read; using defaults until the next save",
              ...(original === '{"secret":'
                ? [
                    Cause.fail(
                      new JsonFileError({
                        operation: "parse",
                        path,
                        cause: new SyntaxError("Invalid JSON"),
                      }),
                    ),
                  ]
                : []),
            ],
            annotations: {
              component: "combat-profiles",
              data: { path, ignored: { file: 1 } },
            },
          },
        ]);
        expect(yield* Effect.promise(() => readFile(path, "utf8"))).toBe(
          original,
        );
        const saved = yield* combatProfiles.saveProfile(testProfile);
        expect(saved.profiles.at(-1)?.label).toBe("Farm Rotation");
        expect(
          JSON.parse(yield* Effect.promise(() => readFile(path, "utf8"))),
        ).toEqual(saved);
      }),
  );

  it.effect("fails unreadable storage without overwriting it on save", () =>
    Effect.gen(function* () {
      let unreadablePath: string | undefined;
      const { combatProfiles, path } = yield* makeHarness((fileSystem) =>
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
      const source =
        '{"version":1,"profiles":[{"id":"saved","label":"Saved","delayMs":150,"cooldownMode":"use-if-ready","steps":[{"skill":1,"conditions":[]}]}]}\n';
      yield* Effect.promise(() => writeFile(path, source));
      unreadablePath = path;
      const { value, records } = yield* captureLogs(
        Effect.gen(function* () {
          try {
            const loaded = yield* combatProfiles.load.pipe(Effect.result);
            const saved = yield* combatProfiles
              .saveProfile(testProfile)
              .pipe(Effect.result);
            return { loaded, saved };
          } finally {
            unreadablePath = undefined;
          }
        }),
      );
      for (const result of [value.loaded, value.saved]) {
        expect(result).toMatchObject({
          _tag: "Failure",
          failure: {
            _tag: "CombatProfilesError",
            operation: "read",
            detail: `JSON file read failed at ${path}.`,
            cause: { _tag: "JsonFileError", operation: "read", path },
          },
        });
      }
      expect(yield* Effect.promise(() => readFile(path, "utf8"))).toBe(source);
      expect(records).toEqual([]);
      expect(
        (yield* combatProfiles.load).profiles.find(
          (profile) => profile.id === "saved",
        ),
      ).toEqual({
        id: "saved",
        label: "Saved",
        delayMs: 150,
        cooldownMode: "use-if-ready",
        steps: [{ skill: 1, conditions: [] }],
      });
    }),
  );

  it.effect("keeps valid migrations and missing optional fields silent", () =>
    Effect.gen(function* () {
      const { combatProfiles, path } = yield* makeHarness();
      const missing = yield* captureLogs(combatProfiles.load);
      expect(missing.value).toEqual({ version: 1, profiles: [genericProfile] });
      expect(missing.records).toEqual([]);
      yield* Effect.promise(() =>
        writeFile(
          path,
          JSON.stringify({
            profiles: [{ id: "legacy", steps: [{ skill: 2 }] }],
          }),
        ),
      );
      const migrated = yield* captureLogs(combatProfiles.load);
      expect(migrated.value).toEqual({
        version: 1,
        profiles: [
          genericProfile,
          {
            id: "legacy",
            label: "Profile",
            delayMs: 150,
            cooldownMode: "use-if-ready",
            steps: [{ skill: 2, conditions: [] }],
          },
        ],
      });
      expect(migrated.records).toEqual([]);
      expect(
        JSON.parse(yield* Effect.promise(() => readFile(path, "utf8"))),
      ).toEqual(migrated.value);
    }),
  );
  it.effect("deletes saved profiles from the library", () =>
    Effect.gen(function* () {
      const { combatProfiles } = yield* makeHarness();

      yield* combatProfiles.load;
      const saved = yield* combatProfiles.saveProfile(testProfile);
      expect(saved.profiles.at(-1)?.steps[0]?.priority).toBe(true);

      const next = yield* combatProfiles.deleteProfile(testProfile.id);

      expect(
        next.profiles.some((profile) => profile.id === testProfile.id),
      ).toBe(false);
      expect(next.profiles[0]?.id).toBe(DEFAULT_COMBAT_PROFILE_ID);
    }),
  );

  it.effect(
    "loads reset fields into canonical data without re-saving them",
    () =>
      Effect.gen(function* () {
        const { combatProfiles, path } = yield* makeHarness();
        const original = JSON.stringify(
          {
            version: COMBAT_PROFILE_LIBRARY_VERSION,
            profiles: [
              {
                id: "broken-profile",
                label: "Broken",
                delayMs: -1,
                cooldownMode: "invalid",
                steps: [{ skill: "bad" }],
                messageTriggers: [
                  {
                    messageIncludes: " Enrage ",
                    skill: 99,
                    source: "invalid",
                    cooldownMs: 999_999,
                  },
                ],
              },
            ],
          },
          null,
          2,
        );
        yield* Effect.promise(() => writeFile(path, original, "utf8"));

        const { value: loaded, records } = yield* captureLogs(
          combatProfiles.load,
        );
        const saved = yield* Effect.promise(() => readFile(path, "utf8"));

        expect(saved).toBe(original);
        expect(loaded.profiles.map((profile) => profile.id)).toEqual([
          DEFAULT_COMBAT_PROFILE_ID,
          "broken-profile",
        ]);
        expect(loaded.profiles[1]).toMatchObject({
          id: "broken-profile",
          label: "Broken",
          delayMs: 0,
          cooldownMode: "use-if-ready",
          messageTriggers: [
            {
              messageIncludes: "Enrage",
              skill: 5,
              source: "any",
              cooldownMs: 60_000,
            },
          ],
        });
        expect(records).toEqual([
          {
            level: "Warn",
            message: [
              "Saved combat profiles had invalid entries; ignoring them until the next save",
            ],
            annotations: {
              component: "combat-profiles",
              data: { path, ignored: { fields: 5, steps: 1 } },
            },
          },
        ]);
      }),
  );

  it.effect("does not overwrite files with unsupported future versions", () =>
    Effect.gen(function* () {
      const { combatProfiles, path } = yield* makeHarness();
      const original = `${JSON.stringify(
        {
          version: COMBAT_PROFILE_LIBRARY_VERSION + 1,
          profiles: [testProfile],
        },
        null,
        2,
      )}\n`;
      yield* Effect.promise(() => writeFile(path, original, "utf8"));

      const error = yield* Effect.flip(combatProfiles.load);
      const saved = yield* Effect.promise(() => readFile(path, "utf8"));

      expect(error.operation).toBe("parse");
      expect(saved).toBe(original);
    }),
  );

  it.effect(
    "rejects future versions before recovering invalid profile shapes",
    () =>
      Effect.gen(function* () {
        const { combatProfiles, path } = yield* makeHarness();
        const original = '{"version":2,"profiles":42}\n';
        yield* Effect.promise(() => writeFile(path, original, "utf8"));

        const { value: error, records } = yield* captureLogs(
          Effect.flip(combatProfiles.load),
        );
        const saveError = yield* Effect.flip(
          combatProfiles.saveProfile(testProfile),
        );

        expect(error.operation).toBe("parse");
        expect(error.detail).toBe(
          "Unsupported combat profile library version 2",
        );
        expect(saveError.operation).toBe("parse");
        expect(saveError.detail).toBe(
          "Unsupported combat profile library version 2",
        );
        expect(records).toEqual([]);
        expect(yield* Effect.promise(() => readFile(path, "utf8"))).toBe(
          original,
        );
      }),
  );

  it.effect(
    "publishes a successful retry after an invalid file is repaired",
    () =>
      Effect.gen(function* () {
        const { combatProfiles, path } = yield* makeHarness();
        const changes: CombatProfileLibrary[] = [];
        yield* combatProfiles.onChanged((library) => {
          changes.push(library);
        });
        yield* Effect.promise(() =>
          writeFile(
            path,
            JSON.stringify({
              version: COMBAT_PROFILE_LIBRARY_VERSION + 1,
              profiles: [testProfile],
            }),
            "utf8",
          ),
        );

        yield* Effect.flip(combatProfiles.load);
        yield* Effect.promise(() =>
          writeFile(
            path,
            JSON.stringify({
              version: COMBAT_PROFILE_LIBRARY_VERSION,
              profiles: [testProfile],
            }),
            "utf8",
          ),
        );

        const loaded = yield* combatProfiles.load;

        expect(changes).toEqual([loaded]);
      }),
  );

  it.effect(
    "orders a save behind an in-flight load and publishes committed state",
    () =>
      Effect.gen(function* () {
        const readStarted = yield* Deferred.make<void>();
        const releaseRead = yield* Deferred.make<void>();
        let blockRead = false;
        const { combatProfiles, path } = yield* makeHarness((fs) => ({
          ...fs,
          stream: (path, options) =>
            fs.stream(path, options).pipe(
              Stream.mapEffect((bytes) =>
                Effect.gen(function* () {
                  if (blockRead) {
                    yield* Deferred.succeed(readStarted, undefined);
                    yield* Deferred.await(releaseRead);
                  }
                  return bytes;
                }),
              ),
            ),
        }));
        const initial = yield* combatProfiles.load;
        const changes: CombatProfileLibrary[] = [];
        yield* combatProfiles.onChanged((library) => {
          changes.push(library);
        });
        blockRead = true;
        const loading = yield* combatProfiles.load.pipe(Effect.forkScoped);
        yield* Deferred.await(readStarted);
        const saving = yield* combatProfiles
          .saveProfile(testProfile)
          .pipe(Effect.forkScoped);
        yield* Effect.yieldNow;
        expect(saving.pollUnsafe()).toBeUndefined();
        expect(changes).toEqual([]);
        yield* Deferred.succeed(releaseRead, undefined);
        expect(yield* Fiber.join(loading)).toEqual(initial);
        const saved = yield* Fiber.join(saving);
        expect(saved.profiles).toContainEqual(
          expect.objectContaining({
            id: testProfile.id,
            steps: testProfile.steps,
          }),
        );
        expect(changes).toEqual([initial, saved]);
        expect(yield* combatProfiles.get).toEqual(saved);
        expect(
          normalizeCombatProfileLibrary(
            JSON.parse(yield* Effect.promise(() => readFile(path, "utf8"))),
          ),
        ).toEqual(saved);
      }),
  );
});

for (const source of ["{", '{"version":1,"profiles":[null]}']) {
  it.effect(
    `saves combat profiles without recovery warnings before loading ${source}`,
    () =>
      Effect.gen(function* () {
        const { combatProfiles, path } = yield* makeHarness();
        yield* Effect.promise(() => writeFile(path, source));
        const { value, records } = yield* captureLogs(
          combatProfiles.saveProfile(testProfile),
        );
        const expected = {
          version: 1,
          profiles: [
            genericProfile,
            {
              id: "archpaladin-farm",
              label: "Farm Rotation",
              classNames: ["ArchPaladin"],
              delayMs: 150,
              cooldownMode: "use-if-ready",
              steps: [{ skill: 1, conditions: [], priority: true }],
            },
          ],
        };
        expect(value).toEqual(expected);
        expect(
          JSON.parse(yield* Effect.promise(() => readFile(path, "utf8"))),
        ).toEqual(expected);
        expect(records).toEqual([]);
      }),
  );
}

it.effect("commits combat profiles interrupted after the file rename", () =>
  Effect.gen(function* () {
    let armed = false;
    const { combatProfiles, path } = yield* makeHarness((fileSystem) =>
      FileSystem.of({
        ...fileSystem,
        rename: (from, to) =>
          fileSystem.rename(from, to).pipe(
            Effect.tap(() =>
              Effect.withFiber((fiber) => {
                if (armed) {
                  armed = false;
                  fiber.interruptUnsafe();
                }
                return Effect.void;
              }),
            ),
          ),
      }),
    );
    yield* combatProfiles.load;
    const received: string[] = [];
    yield* combatProfiles.onChanged((next) => {
      received.push(next.profiles.at(-1)?.label ?? "missing");
    });
    armed = true;
    const running = yield* combatProfiles
      .saveProfile({ ...testProfile, label: "Committed" })
      .pipe(Effect.forkChild);
    const exit = yield* Fiber.await(running);
    expect(exit).toMatchObject({
      _tag: "Failure",
      cause: { reasons: [{ _tag: "Interrupt" }] },
    });
    expect(
      JSON.parse(
        yield* Effect.promise(() => readFile(path, "utf8")),
      ).profiles.at(-1)?.label,
    ).toBe("Committed");
    expect((yield* combatProfiles.get).profiles.at(-1)?.label).toBe(
      "Committed",
    );
    expect(received).toEqual(["Committed"]);
    expect((yield* combatProfiles.load).profiles.at(-1)?.label).toBe(
      "Committed",
    );
    expect(received).toEqual(["Committed", "Committed"]);
  }),
);

it.effect("publishes every load even when combat profiles are unchanged", () =>
  Effect.gen(function* () {
    const { combatProfiles } = yield* makeHarness();
    const names: string[][] = [];
    yield* combatProfiles.onChanged((value) => {
      names.push(value.profiles.map((profile) => profile.label));
    });
    yield* combatProfiles.load;
    yield* combatProfiles.load;
    expect(names).toEqual([["Generic"], ["Generic"]]);
  }),
);
