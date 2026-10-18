import { join } from "path";

import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SynchronizedRef from "effect/SynchronizedRef";

import {
  DEFAULT_APP_SETTINGS,
  normalizeAppSettings,
  serializeAppSettings,
  type AppearancePatch,
  type AppSettings,
  type PreferencesPatch,
  type ThemeProfile,
  type ThemeProfilePatch,
  type ThemeRgb,
  type ThemeTokenName,
  type ThemeVariant,
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
import { makeListenerRegistry, type Listener } from "../app/ListenerRegistry";
import { FileSystem } from "effect/FileSystem";
import { type JsonFileError, makeJsonFile } from "../filesystem/JsonFile";
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
  readonly load: Effect.Effect<AppSettings, DesktopSettingsError>;
  readonly onChanged: (
    listener: Listener<AppSettings>,
  ) => Effect.Effect<() => void>;
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
  variant: ThemeVariant,
  current: ThemeProfile,
  patch: ThemeProfilePatch,
): ThemeProfile => {
  const defaults = DEFAULT_APP_SETTINGS.appearance.themes[variant];
  const tokens: Record<ThemeTokenName, ThemeRgb> = {
    ...current.tokens,
  };

  if (patch.tokens !== undefined) {
    for (const [name, value] of Object.entries(patch.tokens)) {
      const tokenName = name as ThemeTokenName;
      tokens[tokenName] = value ?? defaults.tokens[tokenName];
    }
  }

  return {
    tokens,
    sansFont: patch.sansFont ?? current.sansFont,
    monoFont: patch.monoFont ?? current.monoFont,
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
        variant,
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
  const settingsRef = yield* SynchronizedRef.make<AppSettings | null>(null);
  const settingsChanges = makeListenerRegistry<AppSettings>();

  const readSettingsFromFile = Effect.fnUntraced(function* (
    diagnostics: boolean,
  ) {
    const result = yield* jsonFile.read(settingsPath).pipe(
      Effect.catch((error) =>
        error.operation === "parse"
          ? Effect.succeed({ status: "malformed" as const, error })
          : Effect.fail(error),
      ),
      Effect.mapError(wrapDataError),
    );
    if (
      result.status === "malformed" ||
      (result.status === "ok" &&
        !SettingsDiagnostics.isSettingsRecord(result.value))
    ) {
      if (diagnostics) {
        yield* Effect.logWarning(
          "Saved settings could not be read; using defaults until the next save",
          ...(result.status === "malformed" ? [Cause.fail(result.error)] : []),
        ).pipe(
          Effect.annotateLogs({
            component: "settings",
            data: { path: settingsPath, ignored: { file: 1 } },
          }),
        );
      }
      return DEFAULT_APP_SETTINGS;
    }
    const settings =
      result.status === "missing"
        ? DEFAULT_APP_SETTINGS
        : normalizeAppSettings(result.value);
    if (result.status === "ok") {
      const reset = SettingsDiagnostics.settingsResetFields(
        result.value,
        settings,
      );
      if (reset.length > 0) {
        if (diagnostics) {
          yield* Effect.logWarning(
            "Saved settings had invalid entries; ignoring them until the next save",
          ).pipe(
            Effect.annotateLogs({
              component: "settings",
              data: { path: settingsPath, reset },
            }),
          );
        }
        return settings;
      }
    }
    yield* jsonFile
      .write(settingsPath, serializeAppSettings(settings))
      .pipe(Effect.mapError(wrapDataError));
    return settings;
  });

  const writeSettingsFile = (
    settings: AppSettings,
  ): Effect.Effect<AppSettings, DesktopSettingsError> => {
    const normalized = normalizeAppSettings(settings);
    return jsonFile
      .write(settingsPath, serializeAppSettings(normalized))
      .pipe(Effect.mapError(wrapDataError), Effect.as(normalized));
  };

  const get = SynchronizedRef.modifyEffect(settingsRef, (current) =>
    (current === null
      ? readSettingsFromFile(true)
      : Effect.succeed(current)
    ).pipe(Effect.map((settings) => [settings, settings] as const)),
  );
  const load = SynchronizedRef.modifyEffect(settingsRef, () =>
    readSettingsFromFile(true).pipe(
      Effect.map((settings) => [settings, settings] as const),
    ),
  );
  const update = (
    modify: (
      current: AppSettings,
    ) => Effect.Effect<AppSettings, DesktopSettingsError>,
  ) =>
    SynchronizedRef.modifyEffect(settingsRef, (current) =>
      (current === null
        ? readSettingsFromFile(false)
        : Effect.succeed(current)
      ).pipe(
        Effect.flatMap(modify),
        Effect.flatMap(writeSettingsFile),
        Effect.map((saved) => [saved, saved] as const),
      ),
    ).pipe(Effect.tap(settingsChanges.publish));

  const onChanged: DesktopSettingsShape["onChanged"] =
    settingsChanges.subscribe;

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
    load,
    onChanged,
    resetAppearance,
    resetHotkeys,
    updateAppearance,
    updateHotkeys,
    updatePreferences,
  });
});

export const layer = Layer.effect(DesktopSettings, makeDesktopSettings);
