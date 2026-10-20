import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import { FileSystem } from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as PlatformError from "effect/PlatformError";
import * as References from "effect/References";
import * as Scope from "effect/Scope";
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

const makeSettings = Effect.fn("makeSettings")(function* (appDataDir: string) {
  const workspaceDir = yield* Effect.promise(() =>
    makeTempDir("lucent-settings-workspace-"),
  );
  return yield* DesktopSettings.pipe(
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
                workspaceDir,
              }),
            ),
            desktopFileSystemLayer,
          ),
        ),
      ),
    ),
  );
});

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

      yield* settings.get;
      let emitted = 0;
      let lastThemeMode: string | null = null;
      const scope = yield* Scope.make();
      yield* settings
        .onChanged((nextSettings) => {
          emitted += 1;
          lastThemeMode = nextSettings.appearance.themeMode;
        })
        .pipe(Scope.provide(scope));

      const updated = yield* settings.updateAppearance({ themeMode: "light" });
      yield* Scope.close(scope, Exit.void);
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

  it.effect("saves color patches sparsely and removes null overrides", () =>
    Effect.gen(function* () {
      const appDataDir = yield* Effect.promise(() =>
        makeTempDir("lucent-settings-colors-"),
      );
      const settings = yield* makeSettings(appDataDir);
      const settingsPath = join(appDataDir, "settings.json");
      yield* settings.get;

      const updated = yield* settings.updateAppearance({
        themes: {
          light: {
            colors: { accent: [1, 2, 3], foreground: [10, 20, 30] },
            sansFontSize: 18,
          },
          dark: { colors: { background: [30, 20, 10] } },
        },
      });

      expect(updated.appearance.themes.light.colors).toEqual({
        accent: [1, 2, 3],
        foreground: [10, 20, 30],
      });
      expect(updated.appearance.themes.dark.colors).toEqual({
        background: [30, 20, 10],
      });
      expect(
        JSON.parse(yield* Effect.promise(() => readFile(settingsPath, "utf8"))),
      ).toMatchObject({
        version: 2,
        appearance: {
          themes: {
            light: {
              colors: { accent: "#010203", foreground: "#0a141e" },
              sansFontSize: 18,
            },
            dark: { colors: { background: "#1e140a" } },
          },
        },
      });

      const cleared = yield* settings.updateAppearance({
        themes: {
          light: { colors: { accent: null } },
          dark: { colors: { background: null } },
        },
      });
      const persisted = yield* Effect.promise(() =>
        readFile(settingsPath, "utf8"),
      );

      expect(cleared.appearance.themes.light.colors).toEqual({
        foreground: [10, 20, 30],
      });
      expect(cleared.appearance.themes.light.sansFontSize).toBe(18);
      expect(cleared.appearance.themes.dark.colors).toEqual({});
      expect(updated.appearance.themes.light.colors).toEqual({
        accent: [1, 2, 3],
        foreground: [10, 20, 30],
      });
      expect(JSON.parse(persisted).appearance.themes.light.colors).toEqual({
        foreground: "#0a141e",
      });
      expect(JSON.parse(persisted).appearance.themes.dark.colors).toEqual({});
      expect(persisted).not.toContain('"tokens"');
      expect(persisted).not.toContain('"accent"');
      const reloaded = yield* (yield* makeSettings(appDataDir)).get;
      expect(reloaded.appearance.themes.light.colors).toEqual({
        foreground: [10, 20, 30],
      });
      expect(reloaded.appearance.themes.dark.colors).toEqual({});

      const reset = yield* settings.resetAppearance;
      expect(reset.appearance.themes.light.colors).toEqual({});
      expect(reset.appearance.themes.dark.colors).toEqual({});
    }),
  );

  it.effect(
    "saves trimmed font overrides and removes null and blank patches",
    () =>
      Effect.gen(function* () {
        const appDataDir = yield* Effect.promise(() =>
          makeTempDir("lucent-settings-fonts-"),
        );
        const settings = yield* makeSettings(appDataDir);
        const settingsPath = join(appDataDir, "settings.json");
        yield* settings.get;

        for (const reset of [null, "", "   "]) {
          const updated = yield* settings.updateAppearance({
            themes: {
              light: { sansFont: " Custom Sans ", monoFont: " Custom Mono " },
              dark: { sansFont: "Dark Sans", monoFont: "Dark Mono" },
            },
          });
          expect(updated.appearance.themes.light).toStrictEqual({
            colors: {},
            sansFont: "Custom Sans",
            monoFont: "Custom Mono",
            sansFontSize: 14,
            monoFontSize: 12,
            rounding: 1,
          });
          expect(
            JSON.parse(
              yield* Effect.promise(() => readFile(settingsPath, "utf8")),
            ),
          ).toMatchObject({
            appearance: {
              themes: {
                light: { sansFont: "Custom Sans", monoFont: "Custom Mono" },
                dark: { sansFont: "Dark Sans", monoFont: "Dark Mono" },
              },
            },
          });

          const clearedSans = yield* settings.updateAppearance({
            themes: { light: { sansFont: reset }, dark: { sansFont: reset } },
          });
          expect(clearedSans.appearance.themes.light).toStrictEqual({
            colors: {},
            monoFont: "Custom Mono",
            sansFontSize: 14,
            monoFontSize: 12,
            rounding: 1,
          });
          expect(clearedSans.appearance.themes.dark).toStrictEqual({
            colors: {},
            monoFont: "Dark Mono",
            sansFontSize: 14,
            monoFontSize: 12,
            rounding: 1,
          });

          const clearedMono = yield* settings.updateAppearance({
            themes: { light: { monoFont: reset }, dark: { monoFont: reset } },
          });
          expect(clearedMono.appearance.themes.light).not.toHaveProperty(
            "monoFont",
          );
          expect(clearedMono.appearance.themes.dark).not.toHaveProperty(
            "monoFont",
          );
          const cleared = yield* settings.updateAppearance({
            themes: {
              light: { sansFont: "   ", monoFont: "   " },
              dark: { sansFont: "   ", monoFont: "   " },
            },
          });
          expect(cleared.appearance.themes).toStrictEqual({
            light: {
              colors: {},
              sansFontSize: 14,
              monoFontSize: 12,
              rounding: 1,
            },
            dark: {
              colors: {},
              sansFontSize: 14,
              monoFontSize: 12,
              rounding: 1,
            },
          });
          expect(
            JSON.parse(
              yield* Effect.promise(() => readFile(settingsPath, "utf8")),
            ).appearance.themes,
          ).toStrictEqual({
            light: {
              colors: {},
              sansFontSize: 14,
              monoFontSize: 12,
              rounding: 1,
            },
            dark: {
              colors: {},
              sansFontSize: 14,
              monoFontSize: 12,
              rounding: 1,
            },
          });
          const reloaded = yield* (yield* makeSettings(appDataDir)).get;
          expect(reloaded.appearance.themes.light).not.toHaveProperty(
            "sansFont",
          );
          expect(reloaded.appearance.themes.light).not.toHaveProperty(
            "monoFont",
          );
          expect(updated.appearance.themes.light.sansFont).toBe("Custom Sans");
          expect(updated.appearance.themes.light.monoFont).toBe("Custom Mono");
        }
      }),
  );

  it.effect("migrates a v1 file in memory and writes v2 on the next save", () =>
    Effect.gen(function* () {
      const appDataDir = yield* Effect.promise(() =>
        makeTempDir("lucent-settings-migration-"),
      );
      const settingsPath = join(appDataDir, "settings.json");
      yield* Effect.promise(() =>
        writeFile(
          settingsPath,
          JSON.stringify({
            version: 1,
            preferences: { useGameTabs: true },
            appearance: {
              themes: {
                light: {
                  tokens: {
                    background: "#ffffff",
                    foreground: "#262626",
                    primary: "#123456",
                    accent: "#abcdef",
                    card: "#010203",
                  },
                  sansFont: "Custom Sans",
                  sansFontSize: 17,
                },
                dark: {
                  sansFont:
                    '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
                  monoFont:
                    'ui-monospace, "SFMono-Regular", "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
                  tokens: {
                    background: "#010203",
                    foreground: "#f5f5f5",
                    primary: "#f5f5f5",
                  },
                },
              },
            },
          }),
        ),
      );
      const source = yield* Effect.promise(() =>
        readFile(settingsPath, "utf8"),
      );
      const settings = yield* makeSettings(appDataDir);
      const migrated = yield* settings.get;
      expect(yield* Effect.promise(() => readFile(settingsPath, "utf8"))).toBe(
        source,
      );
      yield* settings.updatePreferences({ useGameTabs: true });
      const persisted = yield* Effect.promise(() =>
        readFile(settingsPath, "utf8"),
      );

      expect(migrated.version).toBe(2);
      expect(migrated.appearance.themes.light.colors).toEqual({
        accent: [18, 52, 86],
      });
      expect(migrated.appearance.themes.dark.colors).toEqual({
        background: [1, 2, 3],
      });
      expect(migrated.appearance.themes.light.sansFont).toBe("Custom Sans");
      expect(migrated.appearance.themes.light.sansFontSize).toBe(17);
      expect(migrated.appearance.themes.dark).not.toHaveProperty("sansFont");
      expect(migrated.appearance.themes.dark).not.toHaveProperty("monoFont");
      expect(JSON.parse(persisted)).not.toHaveProperty(
        "appearance.themes.dark.sansFont",
      );
      expect(JSON.parse(persisted)).not.toHaveProperty(
        "appearance.themes.dark.monoFont",
      );
      expect(migrated.preferences.useGameTabs).toBe(true);
      expect(JSON.parse(persisted)).toMatchObject({
        version: 2,
        appearance: {
          themes: {
            light: { colors: { accent: "#123456" } },
            dark: { colors: { background: "#010203" } },
          },
        },
      });
      expect(persisted).not.toContain('"tokens"');
      expect(yield* (yield* makeSettings(appDataDir)).get).toEqual(migrated);
      expect(yield* Effect.promise(() => readFile(settingsPath, "utf8"))).toBe(
        persisted,
      );
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

      yield* settings.get;
      yield* settings.updatePreferences({ useGameTabs: true });
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
        const loaded = yield* settings.get.pipe(
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
      const loaded = yield* settings.get.pipe(
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
        expect(loaded.appearance.themes.dark.colors.background).toEqual([
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
        const loaded = yield* settings.get.pipe(
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
          const loaded = yield* settings.get.pipe(Effect.result);
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
      const loaded = yield* settings.get;
      expect(loaded.preferences.useGameTabs).toBe(true);
      expect(loaded.preferences.launchMode).toBe("account-manager");
      expect(loaded.appearance.themeMode).toBe("light");
    }),
  );

  it.effect(
    "loads missing and valid partial settings silently without writing",
    () =>
      Effect.gen(function* () {
        const { settings: missingSettings } = yield* makeRecoverySettings();
        const { records, logger } = captureLogs();
        expect(
          (yield* missingSettings.get.pipe(
            Effect.provideService(Logger.CurrentLoggers, new Set([logger])),
          )).appearance.themeMode,
        ).toBe("dark");
        const { settings, path } = yield* makeRecoverySettings();
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
        const loaded = yield* settings.get.pipe(
          Effect.provideService(Logger.CurrentLoggers, new Set([logger])),
        );
        expect(loaded.appearance.themes.dark.sansFont).toBe("Arial");
        expect(loaded.appearance.themes.dark.colors.background).toEqual([
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
        ).toBe(0);
      }),
  );

  it.effect(
    "migrates an older file in memory and reports invalid entries without rewriting",
    () =>
      Effect.gen(function* () {
        const { settings, path } = yield* makeRecoverySettings();
        yield* Effect.promise(() =>
          writeFile(
            path,
            JSON.stringify({
              version: 0,
              appearance: { themes: { dark: { sansFontSize: 99 } } },
              preferences: { useGameTabs: true },
            }),
          ),
        );
        const { records, logger } = captureLogs();
        const loaded = yield* settings.get.pipe(
          Effect.provideService(Logger.CurrentLoggers, new Set([logger])),
        );
        expect(loaded.preferences.useGameTabs).toBe(true);
        const persisted = JSON.parse(
          yield* Effect.promise(() => readFile(path, "utf8")),
        );
        expect(records).toEqual([
          {
            level: "Warn",
            message: [
              "Saved settings had invalid entries; ignoring them until the next save",
            ],
            annotations: {
              component: "settings",
              data: { path, reset: ["appearance.themes.dark.sansFontSize"] },
            },
          },
        ]);
        expect(persisted.version).toBe(0);
        expect(persisted.appearance?.themes?.dark?.sansFontSize).toBe(99);
      }),
  );
});

describe("settings change publication", () => {
  it.effect(
    "publishes concurrent updates in commit order without a stale overwrite",
    () =>
      Effect.gen(function* () {
        const { settings, path } = yield* makeRecoverySettings();
        yield* settings.get;
        const started = yield* Deferred.make<void>();
        const finish = yield* Deferred.make<void>();
        const publications: string[] = [];
        yield* settings.onChanged((next) =>
          Effect.gen(function* () {
            publications.push(next.appearance.themeMode);
            if (next.appearance.themeMode === "light") {
              yield* Deferred.succeed(started, undefined);
              yield* Deferred.await(finish);
            }
          }),
        );
        const received: string[] = [];
        yield* settings.onChanged((next) => {
          received.push(next.appearance.themeMode);
        });
        const first = yield* settings
          .updateAppearance({ themeMode: "light" })
          .pipe(Effect.forkChild);
        yield* Deferred.await(started);
        const second = yield* settings
          .updateAppearance({
            themeMode: "system",
          })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.succeed(finish, undefined);
        const firstResult = yield* Fiber.join(first);
        expect(firstResult.appearance.themeMode).toBe("light");
        expect((yield* Fiber.join(second)).appearance.themeMode).toBe("system");
        expect(publications).toEqual(["light", "system"]);
        expect(received).toEqual(["light", "system"]);
        expect((yield* settings.get).appearance.themeMode).toBe("system");
        expect(
          JSON.parse(yield* Effect.promise(() => readFile(path, "utf8")))
            .appearance.themeMode,
        ).toBe("system");
      }),
  );
});

it.effect("commits settings interrupted after the file rename", () =>
  Effect.gen(function* () {
    let armed = false;
    const { settings, path } = yield* makeRecoverySettings((fileSystem) =>
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
    yield* settings.get;
    const received: string[] = [];
    yield* settings.onChanged((next) => {
      received.push(next.appearance.themeMode);
    });
    const { records, logger } = captureLogs();
    armed = true;
    const running = yield* settings
      .updateAppearance({ themeMode: "light" })
      .pipe(
        Effect.provideService(Logger.CurrentLoggers, new Set([logger])),
        Effect.forkChild,
      );
    const exit = yield* Fiber.await(running);
    expect(exit).toMatchObject({
      _tag: "Failure",
      cause: { reasons: [{ _tag: "Interrupt" }] },
    });
    expect(
      JSON.parse(yield* Effect.promise(() => readFile(path, "utf8"))).appearance
        .themeMode,
    ).toBe("light");
    expect((yield* settings.get).appearance.themeMode).toBe("light");
    expect(received).toEqual(["light"]);
    yield* settings.updatePreferences({ checkForUpdates: true });
    const current = yield* settings.get;
    const persisted = JSON.parse(
      yield* Effect.promise(() => readFile(path, "utf8")),
    );
    expect(current.appearance.themeMode).toBe("light");
    expect(current.preferences.checkForUpdates).toBe(true);
    expect(persisted.appearance.themeMode).toBe("light");
    expect(persisted.preferences.checkForUpdates).toBe(true);
    expect(received).toEqual(["light", "light"]);
    expect(records).toEqual([]);
  }),
);

it.effect(
  "reads newer settings silently and writes the current version on update",
  () =>
    Effect.gen(function* () {
      const { settings, path } = yield* makeRecoverySettings();
      const source = JSON.stringify({
        version: DEFAULT_APP_SETTINGS.version + 1,
        preferences: { useGameTabs: true },
        futureOnly: "retain",
      });
      yield* Effect.promise(() => writeFile(path, source));
      const { records, logger } = captureLogs();
      const loaded = yield* settings.get.pipe(
        Effect.provideService(Logger.CurrentLoggers, new Set([logger])),
      );
      expect(loaded.preferences.useGameTabs).toBe(true);
      expect(records).toEqual([]);
      expect(yield* Effect.promise(() => readFile(path, "utf8"))).toBe(source);
      expect(
        (yield* settings.updatePreferences({ useGameTabs: false })).preferences
          .useGameTabs,
      ).toBe(false);
      const saved = JSON.parse(
        yield* Effect.promise(() => readFile(path, "utf8")),
      );
      expect({
        version: saved.version,
        useGameTabs: saved.preferences.useGameTabs,
        futureOnly: saved.futureOnly,
      }).toEqual({
        version: DEFAULT_APP_SETTINGS.version,
        useGameTabs: false,
        futureOnly: undefined,
      });
    }),
);
