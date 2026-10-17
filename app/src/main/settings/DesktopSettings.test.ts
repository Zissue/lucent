import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { FileSystem } from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as PlatformError from "effect/PlatformError";
import * as References from "effect/References";
import * as Stream from "effect/Stream";

import { DEFAULT_APP_SETTINGS } from "@lucent/core/settings";
import { DesktopEnvironment } from "../app/DesktopEnvironment";
import { layer as desktopFileSystemLayer } from "@effect/platform-node/NodeFileSystem";
import { JsonFileError } from "../filesystem/JsonFile";
import {
  DesktopSettings,
  DesktopSettingsError,
  layer as desktopSettingsLayer,
} from "./DesktopSettings";

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

describe("DesktopSettings", () => {
  it.effect("persists appearance updates and emits one change after save", () =>
    Effect.gen(function* () {
      const appDataDir = yield* Effect.promise(() =>
        makeTempDir("lucent-settings-data-"),
      );
      const workspaceDir = yield* Effect.promise(() =>
        makeTempDir("lucent-settings-workspace-"),
      );
      const env = DesktopEnvironment.of({
        appDataDir,
        assetsDir: join(appDataDir, "assets"),
        isDev: true,
        platform: "darwin",
        workspaceDir,
      });
      const settingsLayer = desktopSettingsLayer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(DesktopEnvironment, env),
            desktopFileSystemLayer,
          ),
        ),
      );
      const settings = yield* DesktopSettings.pipe(
        Effect.provide(settingsLayer),
      );

      yield* settings.load;
      let emitted = 0;
      let lastThemeMode: string | null = null;
      const unsubscribe = yield* settings.onChanged((nextSettings) => {
        emitted += 1;
        lastThemeMode = nextSettings.appearance.themeMode;
      });

      const updated = yield* settings.updateAppearance({ themeMode: "light" });
      unsubscribe();
      const persisted = JSON.parse(
        yield* Effect.promise(() =>
          readFile(join(env.appDataDir, "settings.json"), "utf8"),
        ),
      ) as {
        readonly appearance?: { readonly themeMode?: string };
        readonly hotkeys?: { readonly bindings?: readonly unknown[] };
      };

      expect(updated.appearance.themeMode).toBe("light");
      expect(persisted.appearance?.themeMode).toBe("light");
      expect(persisted.hotkeys?.bindings?.length).toBe(
        DEFAULT_APP_SETTINGS.hotkeys.bindings.length,
      );
      expect(emitted).toBe(1);
      expect(lastThemeMode).toBe("light");
    }),
  );

  it.effect("rejects duplicate hotkey bindings before saving", () =>
    Effect.gen(function* () {
      const appDataDir = yield* Effect.promise(() =>
        makeTempDir("lucent-settings-data-"),
      );
      const workspaceDir = yield* Effect.promise(() =>
        makeTempDir("lucent-settings-workspace-"),
      );
      const env = DesktopEnvironment.of({
        appDataDir,
        assetsDir: join(appDataDir, "assets"),
        isDev: true,
        platform: "darwin",
        workspaceDir,
      });
      const settingsLayer = desktopSettingsLayer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(DesktopEnvironment, env),
            desktopFileSystemLayer,
          ),
        ),
      );
      const settings = yield* DesktopSettings.pipe(
        Effect.provide(settingsLayer),
      );

      yield* settings.load;
      const before = yield* Effect.promise(() =>
        readFile(join(env.appDataDir, "settings.json"), "utf8"),
      );
      const result = yield* settings
        .updateHotkeys({
          bindings: [{ id: "toggleBank", value: "Mod+Shift+X" }],
        })
        .pipe(
          Effect.match({
            onFailure: (error) => error,
            onSuccess: () => null,
          }),
        );

      expect(result).toBeInstanceOf(DesktopSettingsError);
      expect(result?.message).toContain("Hotkey is already assigned");
      expect(
        yield* Effect.promise(() =>
          readFile(join(env.appDataDir, "settings.json"), "utf8"),
        ),
      ).toBe(before);
    }),
  );

  it.effect(
    "serializes concurrent reads and full-file updates before initial load",
    () =>
      Effect.gen(function* () {
        const appDataDir = yield* Effect.promise(() =>
          makeTempDir("lucent-settings-data-"),
        );
        const workspaceDir = yield* Effect.promise(() =>
          makeTempDir("lucent-settings-workspace-"),
        );
        const env = DesktopEnvironment.of({
          appDataDir,
          assetsDir: join(appDataDir, "assets"),
          isDev: true,
          platform: "darwin",
          workspaceDir,
        });
        const settingsLayer = desktopSettingsLayer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(DesktopEnvironment, env),
              desktopFileSystemLayer,
            ),
          ),
        );
        const settings = yield* DesktopSettings.pipe(
          Effect.provide(settingsLayer),
        );

        yield* Effect.all(
          [
            settings.get,
            settings.get,
            settings.updateAppearance({ themeMode: "light" }),
            settings.updatePreferences({
              launchMode: "account-manager",
              showGameUsernameInWindowTitle: true,
              useGameTabs: true,
            }),
          ],
          { concurrency: "unbounded" },
        );

        const current = yield* settings.get;
        const persisted = JSON.parse(
          yield* Effect.promise(() =>
            readFile(join(env.appDataDir, "settings.json"), "utf8"),
          ),
        ) as {
          readonly appearance?: { readonly themeMode?: string };
          readonly preferences?: {
            readonly launchMode?: string;
            readonly showGameUsernameInWindowTitle?: boolean;
            readonly useGameTabs?: boolean;
          };
        };

        expect(current.appearance.themeMode).toBe("light");
        expect(current.preferences.useGameTabs).toBe(true);
        expect(current.preferences.launchMode).toBe("account-manager");
        expect(current.preferences.showGameUsernameInWindowTitle).toBe(true);
        expect(persisted.appearance?.themeMode).toBe("light");
        expect(persisted.preferences?.useGameTabs).toBe(true);
        expect(persisted.preferences?.launchMode).toBe("account-manager");
        expect(persisted.preferences?.showGameUsernameInWindowTitle).toBe(true);
      }),
  );
});

for (const source of ["{", '{"appearance":{"themeMode":"invalid"}}']) {
  it.effect(
    `saves settings without recovery warnings before loading ${source}`,
    () =>
      Effect.gen(function* () {
        const { settings, path } = yield* makeRecoverySettings();
        yield* Effect.promise(() => writeFile(path, source));
        const { records, logger } = captureLogs();
        const value = yield* settings
          .updateAppearance({ themeMode: "light" })
          .pipe(
            Effect.provideService(Logger.CurrentLoggers, new Set([logger])),
          );
        expect(value.appearance.themeMode).toBe("light");
        expect(
          JSON.parse(yield* Effect.promise(() => readFile(path, "utf8")))
            .appearance.themeMode,
        ).toBe("light");
        expect(records).toEqual([]);
      }),
  );
}

const makeRecoverySettings = (
  wrapFileSystem: (fs: FileSystem) => FileSystem = (fs) => fs,
) =>
  Effect.gen(function* () {
    const appDataDir = yield* Effect.promise(() =>
      makeTempDir("lucent-settings-recovery-"),
    );
    const settings = yield* DesktopSettings.pipe(
      Effect.provide(
        desktopSettingsLayer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(
                DesktopEnvironment,
                DesktopEnvironment.of({
                  appDataDir,
                  assetsDir: join(appDataDir, "assets"),
                  isDev: true,
                  platform: "darwin",
                  workspaceDir: appDataDir,
                }),
              ),
              Layer.effect(
                FileSystem,
                Effect.map(FileSystem, wrapFileSystem),
              ).pipe(Layer.provide(desktopFileSystemLayer)),
            ),
          ),
        ),
      ),
    );
    return { settings, path: join(appDataDir, "settings.json") };
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

describe("saved settings recovery", () => {
  it.effect(
    "keeps valid settings and preserves invalid bytes until an edit",
    () =>
      Effect.gen(function* () {
        const { settings, path } = yield* makeRecoverySettings();
        const source =
          JSON.stringify(
            {
              preferences: { useGameTabs: true, launchMode: "invalid" },
              appearance: { themeMode: "light", reduceMotion: false },
            },
            null,
            3,
          ) + "\n";
        yield* Effect.promise(() => writeFile(path, source));
        const { records, logger } = captureLogs();
        const loaded = yield* settings.load.pipe(
          Effect.provideService(Logger.CurrentLoggers, new Set([logger])),
        );
        expect(loaded.preferences).toEqual({
          checkForUpdates: false,
          launchMode: "game",
          showGameUsernameInWindowTitle: false,
          useGameTabs: true,
        });
        expect(loaded.appearance.themeMode).toBe("light");
        expect(loaded.appearance.reduceMotion).toBe("system");
        expect(yield* Effect.promise(() => readFile(path, "utf8"))).toBe(
          source,
        );
        expect(records).toEqual([
          {
            level: "Warn",
            message: [
              "Saved settings had invalid entries; ignoring them until the next save",
            ],
            annotations: {
              component: "settings",
              data: {
                path,
                reset: ["preferences.launchMode", "appearance.reduceMotion"],
              },
            },
          },
        ]);
        yield* settings.updatePreferences({ checkForUpdates: true });
        const saved = JSON.parse(
          yield* Effect.promise(() => readFile(path, "utf8")),
        );
        expect(saved.preferences).toEqual({
          checkForUpdates: true,
          launchMode: "game",
          showGameUsernameInWindowTitle: false,
          useGameTabs: true,
        });
      }),
  );

  it.effect("preserves invalid enum strings that reset to the default", () =>
    Effect.gen(function* () {
      const { settings, path } = yield* makeRecoverySettings();
      const source = JSON.stringify({
        preferences: { launchMode: " game " },
        appearance: { themeMode: " dark ", reduceMotion: " system " },
      });
      yield* Effect.promise(() => writeFile(path, source));
      const { records, logger } = captureLogs();
      const loaded = yield* settings.load.pipe(
        Effect.provideService(Logger.CurrentLoggers, new Set([logger])),
      );
      expect(loaded.preferences.launchMode).toBe("game");
      expect(loaded.appearance.themeMode).toBe("dark");
      expect(loaded.appearance.reduceMotion).toBe("system");
      expect(records).toEqual([
        {
          level: "Warn",
          message: [
            "Saved settings had invalid entries; ignoring them until the next save",
          ],
          annotations: {
            component: "settings",
            data: {
              path,
              reset: [
                "preferences.launchMode",
                "appearance.themeMode",
                "appearance.reduceMotion",
              ],
            },
          },
        },
      ]);
      expect(yield* Effect.promise(() => readFile(path, "utf8"))).toBe(source);
    }),
  );

  it.effect("reports hotkey overrides discarded by normalization", () =>
    Effect.gen(function* () {
      const { settings, path } = yield* makeRecoverySettings();
      const source = JSON.stringify({
        hotkeys: {
          bindings: [
            { id: "toggleBank", value: "Alt+Z" },
            { id: "loadScript", value: 42 },
          ],
        },
      });
      yield* Effect.promise(() => writeFile(path, source));
      const { records, logger } = captureLogs();
      const loaded = yield* settings.get.pipe(
        Effect.provideService(Logger.CurrentLoggers, new Set([logger])),
      );
      expect(
        loaded.hotkeys.bindings.find((binding) => binding.id === "toggleBank"),
      ).toEqual({ id: "toggleBank", value: "Mod+B" });
      expect(records).toEqual([
        {
          level: "Warn",
          message: [
            "Saved settings had invalid entries; ignoring them until the next save",
          ],
          annotations: {
            component: "settings",
            data: { path, reset: ["hotkeys.bindings"] },
          },
        },
      ]);
      expect(yield* Effect.promise(() => readFile(path, "utf8"))).toBe(source);
    }),
  );

  it.effect(
    "reports invalid theme fields without exposing arbitrary token names",
    () =>
      Effect.gen(function* () {
        const { settings, path } = yield* makeRecoverySettings();
        const source = JSON.stringify({
          appearance: {
            themes: {
              dark: {
                sansFont: "  ",
                sansFontSize: 99,
                rounding: "bad",
                tokens: {
                  background: "#123456",
                  foreground: "invalid",
                  "private-token-name": "private-token-value",
                },
              },
            },
          },
        });
        yield* Effect.promise(() => writeFile(path, source));
        const { records, logger } = captureLogs();
        const loaded = yield* settings.get.pipe(
          Effect.provideService(Logger.CurrentLoggers, new Set([logger])),
        );
        expect(loaded.appearance.themes.dark.tokens.background).toEqual([
          18, 52, 86,
        ]);
        expect(loaded.appearance.themes.dark.sansFontSize).toBe(24);
        expect(loaded.appearance.themes.dark.rounding).toBe(1);
        expect(records).toEqual([
          {
            level: "Warn",
            message: [
              "Saved settings had invalid entries; ignoring them until the next save",
            ],
            annotations: {
              component: "settings",
              data: {
                path,
                reset: [
                  "appearance.themes.dark.tokens",
                  "appearance.themes.dark.sansFont",
                  "appearance.themes.dark.sansFontSize",
                  "appearance.themes.dark.rounding",
                ],
              },
            },
          },
        ]);
        expect(yield* Effect.promise(() => readFile(path, "utf8"))).toBe(
          source,
        );
      }),
  );

  for (const source of ["{invalid secret", "[]", "null"]) {
    it.effect(`recovers unreadable settings from ${source.slice(0, 1)}`, () =>
      Effect.gen(function* () {
        const { settings, path } = yield* makeRecoverySettings();
        yield* Effect.promise(() => writeFile(path, source));
        const { records, logger } = captureLogs();
        const loaded = yield* settings.load.pipe(
          Effect.provideService(Logger.CurrentLoggers, new Set([logger])),
        );
        expect(loaded.preferences.launchMode).toBe("game");
        expect(loaded.appearance.themeMode).toBe("dark");
        expect(yield* Effect.promise(() => readFile(path, "utf8"))).toBe(
          source,
        );
        expect(records).toEqual([
          {
            level: "Warn",
            message: [
              "Saved settings could not be read; using defaults until the next save",
              ...(source === "{invalid secret"
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
              component: "settings",
              data: { path, ignored: { file: 1 } },
            },
          },
        ]);
      }),
    );
  }

  it.effect("fails unreadable storage without overwriting it on update", () =>
    Effect.gen(function* () {
      let unreadablePath: string | undefined;
      const { settings, path } = yield* makeRecoverySettings((fileSystem) =>
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
        '{"version":1,"preferences":{"useGameTabs":true,"launchMode":"account-manager"},"appearance":{"themeMode":"light"}}\n';
      yield* Effect.promise(() => writeFile(path, source));
      unreadablePath = path;
      const { records, logger } = captureLogs();
      const results = yield* Effect.gen(function* () {
        try {
          const loaded = yield* settings.load.pipe(Effect.result);
          const updated = yield* settings
            .updatePreferences({ checkForUpdates: true })
            .pipe(Effect.result);
          return [loaded, updated];
        } finally {
          unreadablePath = undefined;
        }
      }).pipe(Effect.provideService(Logger.CurrentLoggers, new Set([logger])));
      for (const result of results) {
        expect(result).toMatchObject({
          _tag: "Failure",
          failure: {
            _tag: "DesktopSettingsError",
            operation: "read",
            detail: `JSON file read failed at ${path}.`,
            cause: { _tag: "JsonFileError", operation: "read", path },
          },
        });
      }
      expect(yield* Effect.promise(() => readFile(path, "utf8"))).toBe(source);
      expect(records).toEqual([]);
      const loaded = yield* settings.load;
      expect(loaded.preferences.useGameTabs).toBe(true);
      expect(loaded.preferences.launchMode).toBe("account-manager");
      expect(loaded.appearance.themeMode).toBe("light");
    }),
  );

  it.effect(
    "loads missing and valid partial settings silently and keeps migration writes",
    () =>
      Effect.gen(function* () {
        const { settings, path } = yield* makeRecoverySettings();
        const { records, logger } = captureLogs();
        expect(
          (yield* settings.load.pipe(
            Effect.provideService(Logger.CurrentLoggers, new Set([logger])),
          )).appearance.themeMode,
        ).toBe("dark");
        yield* Effect.promise(() =>
          writeFile(
            path,
            JSON.stringify({
              version: 0,
              appearance: {
                themeMode: "light",
                themes: {
                  dark: {
                    sansFont: "  Arial  ",
                    tokens: { background: "  123456  " },
                  },
                },
              },
              hotkeys: { bindings: [{ id: "toggleBank", value: "alt+z" }] },
            }),
          ),
        );
        const loaded = yield* settings.load.pipe(
          Effect.provideService(Logger.CurrentLoggers, new Set([logger])),
        );
        expect(loaded.appearance.themes.dark.sansFont).toBe("Arial");
        expect(loaded.appearance.themes.dark.tokens.background).toEqual([
          18, 52, 86,
        ]);
        expect(
          loaded.hotkeys.bindings.find(
            (binding) => binding.id === "toggleBank",
          ),
        ).toEqual({ id: "toggleBank", value: "Alt+Z" });
        expect(records).toEqual([]);
        expect(
          JSON.parse(yield* Effect.promise(() => readFile(path, "utf8")))
            .version,
        ).toBe(1);
      }),
  );
});
