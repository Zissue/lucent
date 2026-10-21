import { join } from "node:path";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeCommittedState } from "../app/CommittedState";
import * as Schema from "effect/Schema";

import {
  DEFAULT_APP_SETTINGS,
  THEME_COLOR_NAMES,
  normalizeAppSettings,
  serializeAppSettings,
  type AppearancePatch,
  type AppSettings,
  type PreferencesPatch,
  type ThemeProfile,
  type ThemeProfilePatch,
  type ThemeColors,
} from "@lucent/core/settings";
import {
  DEFAULT_HOTKEYS,
  SETTINGS_COMMANDS,
  findDuplicateHotkeyBinding,
  getSettingsCommandDefinition,
  isSettingsCommandId,
  normalizeHotkeyBindingValue,
  type HotkeyBinding,
  type HotkeysPatch,
  type SettingsCommandId,
} from "@lucent/core/hotkeys";
import { DesktopEnvironment } from "../app/DesktopEnvironment";
import { type Listener } from "../app/ListenerRegistry";
import { FileSystem } from "effect/FileSystem";
import type * as Scope from "effect/Scope";
import { type JsonFileError, makeJsonFile } from "../filesystem/JsonFile";
import { makeSavedDocument } from "../filesystem/SavedDocument";
import * as SettingsDiagnostics from "./DesktopSettingsDiagnostics";

const settingsOperationSchema = Schema.Literals([
  "mkdir",
  "parse",
  "read",
  "rename",
  "unlink",
  "write",
  "validate-hotkey",
]);

export class DesktopSettingsError extends Schema.TaggedError<DesktopSettingsError>()(
  "DesktopSettingsError",
  {
    detail: Schema.String,
    operation: settingsOperationSchema,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export interface DesktopSettingsShape {
  readonly get: Effect.Effect<AppSettings, DesktopSettingsError>;
  readonly onChanged: (
    listener: Listener<AppSettings>,
  ) => Effect.Effect<void, never, Scope.Scope>;
  readonly resetAppearance: Effect.Effect<AppSettings, DesktopSettingsError>;
  readonly resetHotkeys: Effect.Effect<AppSettings, DesktopSettingsError>;
  readonly updateAppearance: (
    patch: AppearancePatch,
  ) => Effect.Effect<AppSettings, DesktopSettingsError>;
  readonly updateHotkeys: (
    patch: HotkeysPatch,
  ) => Effect.Effect<AppSettings, DesktopSettingsError>;
  readonly updatePreferences: (
    patch: PreferencesPatch,
  ) => Effect.Effect<AppSettings, DesktopSettingsError>;
}

export class DesktopSettings extends Context.Service<
  DesktopSettings,
  DesktopSettingsShape
>()("lucent/desktop/settings/DesktopSettings") {}

const wrapDataError = (error: JsonFileError): DesktopSettingsError =>
  new DesktopSettingsError({
    operation: error.operation,
    detail: error.message,
    cause: error,
  });

const mergeThemeProfile = (
  current: ThemeProfile,
  patch: ThemeProfilePatch,
): ThemeProfile => {
  const colors: ThemeColors = { ...current.colors };
  for (const name of THEME_COLOR_NAMES) {
    const value = patch.colors?.[name];
    if (value === null) {
      delete colors[name];
    } else if (value !== undefined) {
      colors[name] = value;
    }
  }

  const sansFont =
    patch.sansFont === undefined ? current.sansFont : patch.sansFont;
  const monoFont =
    patch.monoFont === undefined ? current.monoFont : patch.monoFont;

  return {
    colors,
    ...(sansFont ? { sansFont } : {}),
    ...(monoFont ? { monoFont } : {}),
    sansFontSize: patch.sansFontSize ?? current.sansFontSize,
    monoFontSize: patch.monoFontSize ?? current.monoFontSize,
    rounding: patch.rounding ?? current.rounding,
  };
};

const applyAppearancePatch = (
  current: AppSettings,
  patch: AppearancePatch,
): AppSettings => {
  const themes = { ...current.appearance.themes };
  if (patch.themes !== undefined) {
    for (const [variant, profilePatch] of Object.entries(patch.themes)) {
      if (variant !== "light" && variant !== "dark") {
        continue;
      }
      themes[variant] = mergeThemeProfile(
        current.appearance.themes[variant],
        profilePatch,
      );
    }
  }

  return normalizeAppSettings({
    ...current,
    appearance: {
      ...current.appearance,
      themeMode: patch.themeMode ?? current.appearance.themeMode,
      reduceMotion: patch.reduceMotion ?? current.appearance.reduceMotion,
      useCursorPointers:
        patch.useCursorPointers ?? current.appearance.useCursorPointers,
      themes,
    },
  });
};

const applyPreferencesPatch = (
  current: AppSettings,
  patch: PreferencesPatch,
): AppSettings =>
  normalizeAppSettings({
    ...current,
    preferences: {
      ...current.preferences,
      checkForUpdates:
        patch.checkForUpdates ?? current.preferences.checkForUpdates,
      showGameUsernameInWindowTitle:
        patch.showGameUsernameInWindowTitle ??
        current.preferences.showGameUsernameInWindowTitle,
      useGameTabs: patch.useGameTabs ?? current.preferences.useGameTabs,
      launchMode: patch.launchMode ?? current.preferences.launchMode,
    },
  });

const hotkeyValidationError = (detail: string): DesktopSettingsError =>
  new DesktopSettingsError({
    operation: "validate-hotkey",
    detail,
  });

const createHotkeyBindingMap = (
  settings: AppSettings,
): Map<SettingsCommandId, string> =>
  new Map(
    settings.hotkeys.bindings.map((binding) => [binding.id, binding.value]),
  );

const createOrderedHotkeyBindings = (
  values: ReadonlyMap<SettingsCommandId, string>,
): readonly HotkeyBinding[] =>
  SETTINGS_COMMANDS.map((command) => ({
    id: command.id,
    value: values.get(command.id) ?? command.defaultHotkey,
  }));

const applyHotkeysPatch = (
  current: AppSettings,
  patch: HotkeysPatch,
): Effect.Effect<AppSettings, DesktopSettingsError> =>
  Effect.gen(function* () {
    const values = createHotkeyBindingMap(current);
    for (const binding of patch.bindings ?? []) {
      if (!isSettingsCommandId(binding.id)) {
        return yield* hotkeyValidationError(
          `Unknown hotkey command: ${String(binding.id)}`,
        );
      }

      const nextValue =
        binding.value === null
          ? getSettingsCommandDefinition(binding.id).defaultHotkey
          : normalizeHotkeyBindingValue(binding.value);
      if (nextValue === null) {
        return yield* hotkeyValidationError(
          `Invalid hotkey binding for ${
            getSettingsCommandDefinition(binding.id).label
          }.`,
        );
      }
      values.set(binding.id, nextValue);
    }

    const bindings = createOrderedHotkeyBindings(values);
    const duplicate = findDuplicateHotkeyBinding(bindings);
    if (duplicate !== null) {
      return yield* hotkeyValidationError(
        `Hotkey is already assigned to ${
          getSettingsCommandDefinition(duplicate.id).label
        }.`,
      );
    }

    return normalizeAppSettings({
      ...current,
      hotkeys: { bindings },
    });
  });

const makeDesktopSettings = Effect.gen(function* () {
  const env = yield* DesktopEnvironment;
  const jsonFile = makeJsonFile(yield* FileSystem);
  const settingsPath = join(env.appDataDir, "settings.json");
  const document = yield* makeSavedDocument(jsonFile, {
    kind: "settings",
    path: settingsPath,
    versions: SettingsDiagnostics.settingsVersions,
    defaults: () => DEFAULT_APP_SETTINGS,
    decode: SettingsDiagnostics.decodeSettings,
    encode: serializeAppSettings,
    mapError: wrapDataError,
  });

  const {
    get,
    update,
    subscribe: onChanged,
  } = yield* makeCommittedState({
    load: document.load,
    write: document.save,
  });

  const resetAppearance: DesktopSettingsShape["resetAppearance"] = update(
    (current) =>
      Effect.succeed(
        normalizeAppSettings({
          ...current,
          appearance: DEFAULT_APP_SETTINGS.appearance,
        }),
      ),
  );

  const resetHotkeys: DesktopSettingsShape["resetHotkeys"] = update((current) =>
    Effect.succeed(
      normalizeAppSettings({
        ...current,
        hotkeys: DEFAULT_HOTKEYS,
      }),
    ),
  );

  const updateAppearance: DesktopSettingsShape["updateAppearance"] = (patch) =>
    update((current) => Effect.succeed(applyAppearancePatch(current, patch)));

  const updateHotkeys: DesktopSettingsShape["updateHotkeys"] = (patch) =>
    update((current) => applyHotkeysPatch(current, patch));

  const updatePreferences: DesktopSettingsShape["updatePreferences"] = (
    patch,
  ) =>
    update((current) => Effect.succeed(applyPreferencesPatch(current, patch)));

  return DesktopSettings.of({
    get,
    onChanged,
    resetAppearance,
    resetHotkeys,
    updateAppearance,
    updateHotkeys,
    updatePreferences,
  });
});

export const layer = Layer.effect(DesktopSettings, makeDesktopSettings);
