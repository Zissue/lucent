import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { mkdirSync, renameSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
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

describe("CombatProfiles", () => {
  it.effect.each(["save", "reload"] as const)(
    "keeps change events ordered when a %s yields",
    (operation) =>
      Effect.gen(function* () {
        const writeStarted = yield* Deferred.make<void>();
        let watchWrites = false;
        const { combatProfiles, path } = yield* makeHarness((fs) => ({
          ...fs,
          makeDirectory: (path) =>
            Effect.sync(() => {
              mkdirSync(path, { recursive: true });
            }),
          writeFile: (path, contents) =>
            Effect.sync(() => writeFileSync(path, contents)),
          rename: (from, to) =>
            Effect.sync(() => renameSync(from, to)).pipe(
              Effect.tap(() =>
                watchWrites
                  ? Deferred.succeed(writeStarted, undefined)
                  : Effect.void,
              ),
            ),
        }));
        yield* combatProfiles.load;
        yield* combatProfiles.saveProfile({ ...testProfile, label: "First" });
        const labels: string[] = [];
        yield* combatProfiles.onChanged((library) => {
          labels.push(library.profiles.at(-1)!.label);
        });

        watchWrites = true;
        const first = yield* (
          operation === "save"
            ? combatProfiles.saveProfile({ ...testProfile, label: "First" })
            : combatProfiles.load
        ).pipe(
          Effect.provideService(References.MaxOpsBeforeYield, 16),
          Effect.forkScoped,
        );
        yield* Deferred.await(writeStarted);
        const second = yield* combatProfiles
          .saveProfile({ ...testProfile, label: "Second" })
          .pipe(Effect.forkScoped);
        yield* Fiber.join(first);
        yield* Fiber.join(second);

        expect(labels).toEqual(["First", "Second"]);
        expect((yield* combatProfiles.get).profiles.at(-1)?.label).toBe(
          "Second",
        );
        expect(
          JSON.parse(
            yield* Effect.promise(() => readFile(path, "utf8")),
          ).profiles.at(-1)?.label,
        ).toBe("Second");
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

  it.effect("loads profile files into canonical data and re-saves them", () =>
    Effect.gen(function* () {
      const { combatProfiles, path } = yield* makeHarness();
      yield* Effect.promise(() =>
        writeFile(
          path,
          JSON.stringify(
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
          ),
          "utf8",
        ),
      );

      const loaded = yield* combatProfiles.load;
      const saved = yield* Effect.promise(() => readFile(path, "utf8"));

      expect(normalizeCombatProfileLibrary(JSON.parse(saved))).toEqual(loaded);
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

it.live.each(["save", "reload"] as const)(
  "allows a %s listener to read committed combat profiles",
  (operation) =>
    Effect.gen(function* () {
      const { combatProfiles } = yield* makeHarness();
      yield* combatProfiles.saveProfile(testProfile);
      const labels: string[] = [];
      yield* combatProfiles.onChanged(() =>
        combatProfiles.get.pipe(
          Effect.tap((library) =>
            Effect.sync(() => {
              labels.push(library.profiles.at(-1)?.label ?? "missing");
            }),
          ),
        ),
      );
      const result = yield* (
        operation === "save"
          ? combatProfiles.saveProfile({ ...testProfile, label: "Committed" })
          : combatProfiles.load
      ).pipe(Effect.timeout("200 millis"));
      expect(labels).toEqual([
        operation === "save" ? "Committed" : "Farm Rotation",
      ]);
      expect(result.profiles.at(-1)?.label).toBe(
        operation === "save" ? "Committed" : "Farm Rotation",
      );
    }),
);
