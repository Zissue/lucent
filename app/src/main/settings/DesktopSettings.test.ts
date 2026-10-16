import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { DEFAULT_APP_SETTINGS } from "@lucent/core/settings";
import { DesktopEnvironment } from "../app/DesktopEnvironment";
import { layer as desktopFileSystemLayer } from "@effect/platform-node/NodeFileSystem";
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

  it.effect("saves color patches sparsely and removes null overrides", () =>
    Effect.gen(function* () {
      const appDataDir = yield* Effect.promise(() =>
        makeTempDir("lucent-settings-colors-"),
      );
      const settings = yield* makeSettings(appDataDir);
      const settingsPath = join(appDataDir, "settings.json");
      yield* settings.load;

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
      const reloaded = yield* settings.load;
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
        yield* settings.load;

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
          const reloaded = yield* settings.load;
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

  it.effect(
    "rewrites a v1 file as v2 and preserves the migrated overrides on reload",
    () =>
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
        const settings = yield* makeSettings(appDataDir);
        const migrated = yield* settings.load;
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
        expect(yield* settings.load).toEqual(migrated);
        expect(
          yield* Effect.promise(() => readFile(settingsPath, "utf8")),
        ).toBe(persisted);
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
