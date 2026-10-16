import { mkdtemp, readFile, rm } from "fs/promises";
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
