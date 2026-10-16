import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  DEFAULT_HOTKEYS,
  HotkeysSettingsSchema,
  normalizeHotkeySettings,
  type HotkeysSettings,
} from "./hotkeys";

export const APP_SETTINGS_VERSION = 2;

export const AppLaunchModeSchema = Schema.Literals(["game", "account-manager"]);
export const ThemeModeSchema = Schema.Literals(["system", "light", "dark"]);
export const MotionModeSchema = Schema.Literals(["system", "on", "off"]);
export const ThemeVariantSchema = Schema.Literals(["light", "dark"]);

export type AppSettingsVersion = typeof APP_SETTINGS_VERSION;

export type AppLaunchMode = typeof AppLaunchModeSchema.Type;
export type ThemeMode = typeof ThemeModeSchema.Type;
export type MotionMode = typeof MotionModeSchema.Type;
export type ThemeVariant = typeof ThemeVariantSchema.Type;
export type ThemeRgb = readonly [number, number, number];

export const THEME_COLOR_NAMES = [
  "accent",
  "background",
  "foreground",
] as const;

export const ThemeRgbSchema = Schema.Tuple([
  Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 255 })),
  Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 255 })),
  Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 255 })),
]);
export const UnknownRecordSchema = Schema.Record(Schema.String, Schema.Unknown);
export const THEME_FONT_MIN_LENGTH = 1;
export const THEME_FONT_MAX_LENGTH = 256;
export const THEME_FONT_SIZE_MIN = 10;
export const THEME_FONT_SIZE_MAX = 24;
export const THEME_ROUNDING_MIN = 0;
export const THEME_ROUNDING_MAX = 2;
export const ThemeFontSchema = Schema.String.check(
  Schema.isBetweenLength(THEME_FONT_MIN_LENGTH, THEME_FONT_MAX_LENGTH),
);
const ThemeFontPatchSchema = Schema.NullOr(
  Schema.Union([ThemeFontSchema, Schema.Literal("")]),
);
export const ThemeFontSizeSchema = Schema.Int.check(
  Schema.isBetween({
    minimum: THEME_FONT_SIZE_MIN,
    maximum: THEME_FONT_SIZE_MAX,
  }),
);
export const ThemeRoundingSchema = Schema.Finite.check(
  Schema.isBetween({
    minimum: THEME_ROUNDING_MIN,
    maximum: THEME_ROUNDING_MAX,
  }),
);

export const ThemeColorsSchema = Schema.Struct({
  accent: Schema.optionalKey(ThemeRgbSchema),
  background: Schema.optionalKey(ThemeRgbSchema),
  foreground: Schema.optionalKey(ThemeRgbSchema),
});
const OptionalThemeRgbSchema = Schema.optionalKey(
  Schema.NullOr(ThemeRgbSchema),
);
const ThemeColorsPatchSchema = Schema.Struct({
  accent: OptionalThemeRgbSchema,
  background: OptionalThemeRgbSchema,
  foreground: OptionalThemeRgbSchema,
});

export const ThemeProfileSchema = Schema.Struct({
  colors: ThemeColorsSchema,
  sansFont: Schema.optionalKey(ThemeFontSchema),
  monoFont: Schema.optionalKey(ThemeFontSchema),
  sansFontSize: ThemeFontSizeSchema,
  monoFontSize: ThemeFontSizeSchema,
  rounding: ThemeRoundingSchema,
});

export const ThemeProfilePatchSchema = Schema.Struct({
  colors: Schema.optionalKey(ThemeColorsPatchSchema),
  sansFont: Schema.optionalKey(ThemeFontPatchSchema),
  monoFont: Schema.optionalKey(ThemeFontPatchSchema),
  sansFontSize: Schema.optionalKey(ThemeFontSizeSchema),
  monoFontSize: Schema.optionalKey(ThemeFontSizeSchema),
  rounding: Schema.optionalKey(ThemeRoundingSchema),
});

export const PreferencesPatchSchema = Schema.Struct({
  checkForUpdates: Schema.optionalKey(Schema.Boolean),
  launchMode: Schema.optionalKey(AppLaunchModeSchema),
  showGameUsernameInWindowTitle: Schema.optionalKey(Schema.Boolean),
  useGameTabs: Schema.optionalKey(Schema.Boolean),
});

export const AppearancePatchSchema = Schema.Struct({
  themeMode: Schema.optionalKey(ThemeModeSchema),
  reduceMotion: Schema.optionalKey(MotionModeSchema),
  useCursorPointers: Schema.optionalKey(Schema.Boolean),
  themes: Schema.optionalKey(
    Schema.Struct({
      light: Schema.optionalKey(ThemeProfilePatchSchema),
      dark: Schema.optionalKey(ThemeProfilePatchSchema),
    }),
  ),
});

export type ThemeColorName = (typeof THEME_COLOR_NAMES)[number];
export type ThemeColors = Partial<Record<ThemeColorName, ThemeRgb>>;
export interface PreferencesPatch {
  readonly checkForUpdates?: boolean;
  readonly launchMode?: AppLaunchMode;
  readonly showGameUsernameInWindowTitle?: boolean;
  readonly useGameTabs?: boolean;
}
export interface ThemeProfilePatch {
  readonly monoFont?: string | null;
  readonly monoFontSize?: number;
  readonly rounding?: number;
  readonly sansFont?: string | null;
  readonly sansFontSize?: number;
  readonly colors?: Partial<Record<ThemeColorName, ThemeRgb | null>>;
}
export interface AppearancePatch {
  readonly reduceMotion?: MotionMode;
  readonly themeMode?: ThemeMode;
  readonly themes?: Partial<Record<ThemeVariant, ThemeProfilePatch>>;
  readonly useCursorPointers?: boolean;
}

export interface ThemeProfile {
  readonly colors: ThemeColors;
  readonly sansFont?: string;
  readonly monoFont?: string;
  readonly sansFontSize: number;
  readonly monoFontSize: number;
  readonly rounding: number;
}

export interface AppSettings {
  readonly version: AppSettingsVersion;
  readonly preferences: {
    readonly checkForUpdates: boolean;
    readonly launchMode: AppLaunchMode;
    readonly showGameUsernameInWindowTitle: boolean;
    readonly useGameTabs: boolean;
  };
  readonly appearance: {
    readonly themeMode: ThemeMode;
    readonly reduceMotion: MotionMode;
    readonly useCursorPointers: boolean;
    readonly themes: Record<ThemeVariant, ThemeProfile>;
  };
  readonly hotkeys: HotkeysSettings;
}

export const AppSettingsSchema = Schema.Struct({
  version: Schema.Literal(APP_SETTINGS_VERSION),
  preferences: Schema.Struct({
    checkForUpdates: Schema.Boolean,
    launchMode: AppLaunchModeSchema,
    showGameUsernameInWindowTitle: Schema.Boolean,
    useGameTabs: Schema.Boolean,
  }),
  appearance: Schema.Struct({
    themeMode: ThemeModeSchema,
    reduceMotion: MotionModeSchema,
    useCursorPointers: Schema.Boolean,
    themes: Schema.Struct({
      light: ThemeProfileSchema,
      dark: ThemeProfileSchema,
    }),
  }),
  hotkeys: HotkeysSettingsSchema,
});

export const DEFAULT_SANS_FONT =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
export const DEFAULT_MONO_FONT =
  'ui-monospace, "SFMono-Regular", "SF Mono", Menlo, Consolas, "Liberation Mono", monospace';
const DEFAULT_SANS_FONT_SIZE = 14;
const DEFAULT_MONO_FONT_SIZE = 12;

export const DEFAULT_THEME_COLORS: Record<
  ThemeVariant,
  Record<ThemeColorName, ThemeRgb>
> = {
  light: {
    background: [248, 248, 250],
    foreground: [25, 25, 28],
    accent: [25, 25, 28],
  },
  dark: {
    background: [14, 14, 16],
    foreground: [243, 243, 245],
    accent: [243, 243, 245],
  },
};

const LEGACY_THEME_DEFAULTS: Record<
  ThemeVariant,
  Record<"background" | "foreground" | "primary", ThemeRgb>
> = {
  light: {
    background: [255, 255, 255],
    foreground: [38, 38, 38],
    primary: [38, 38, 38],
  },
  dark: {
    background: [14, 14, 15],
    foreground: [245, 245, 245],
    primary: [245, 245, 245],
  },
};

const DEFAULT_LIGHT_THEME_PROFILE: ThemeProfile = {
  colors: {},
  sansFontSize: DEFAULT_SANS_FONT_SIZE,
  monoFontSize: DEFAULT_MONO_FONT_SIZE,
  rounding: 1,
};

const DEFAULT_DARK_THEME_PROFILE: ThemeProfile = {
  colors: {},
  sansFontSize: DEFAULT_SANS_FONT_SIZE,
  monoFontSize: DEFAULT_MONO_FONT_SIZE,
  rounding: 1,
};

export const DEFAULT_APP_SETTINGS: AppSettings = {
  version: APP_SETTINGS_VERSION,
  preferences: {
    checkForUpdates: false,
    launchMode: "game",
    showGameUsernameInWindowTitle: false,
    useGameTabs: false,
  },
  appearance: {
    themeMode: "dark",
    reduceMotion: "system",
    useCursorPointers: false,
    themes: {
      light: DEFAULT_LIGHT_THEME_PROFILE,
      dark: DEFAULT_DARK_THEME_PROFILE,
    },
  },
  hotkeys: DEFAULT_HOTKEYS,
};

const decodeAppLaunchMode = Schema.decodeUnknownOption(AppLaunchModeSchema);
const decodeThemeMode = Schema.decodeUnknownOption(ThemeModeSchema);
const decodeMotionMode = Schema.decodeUnknownOption(MotionModeSchema);
const decodeThemeRgb = Schema.decodeUnknownOption(ThemeRgbSchema);
const decodeRecord = Schema.decodeUnknownOption(UnknownRecordSchema);
const decodeBoolean = Schema.decodeUnknownOption(Schema.Boolean);
const decodeFinite = Schema.decodeUnknownOption(Schema.Finite);
const decodeString = Schema.decodeUnknownOption(Schema.String);
const isThemeFont = Schema.is(ThemeFontSchema);

const decodeOrElse = <A>(
  decode: (value: unknown) => Option.Option<A>,
  value: unknown,
  fallback: A,
): A => {
  const decoded = decode(value);
  return Option.isSome(decoded) ? decoded.value : fallback;
};

const decodeRecordOrEmpty = (value: unknown): Record<string, unknown> => {
  const decoded = decodeRecord(value);
  return Option.isSome(decoded) ? decoded.value : {};
};

export const isAppLaunchMode = (value: unknown): value is AppLaunchMode =>
  Option.isSome(decodeAppLaunchMode(value));

const normalizeRgb = (value: unknown): ThemeRgb | undefined => {
  const stringValue = decodeString(value);
  if (Option.isSome(stringValue)) {
    const match = /^#?([0-9a-f]{6})$/i.exec(stringValue.value.trim());
    if (!match) {
      return undefined;
    }

    const hex = match[1];
    if (hex === undefined) {
      return undefined;
    }

    return [
      Number.parseInt(hex.slice(0, 2), 16),
      Number.parseInt(hex.slice(2, 4), 16),
      Number.parseInt(hex.slice(4, 6), 16),
    ];
  }

  const tupleValue = decodeThemeRgb(value);
  return Option.isSome(tupleValue) ? tupleValue.value : undefined;
};

const rgbToHex = (rgb: ThemeRgb): string =>
  `#${rgb.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;

const normalizeFont = (
  value: unknown,
  defaultFont: string,
): string | undefined => {
  const decoded = decodeString(value);
  if (Option.isNone(decoded)) {
    return undefined;
  }

  const font = decoded.value.trim();
  return font !== defaultFont && isThemeFont(font) ? font : undefined;
};

const normalizeFontSize = (value: unknown, fallback: number): number => {
  const decoded = decodeFinite(value);
  if (Option.isNone(decoded)) {
    return fallback;
  }

  return Math.min(
    THEME_FONT_SIZE_MAX,
    Math.max(THEME_FONT_SIZE_MIN, Math.round(decoded.value)),
  );
};

const normalizeRounding = (value: unknown, fallback: number): number => {
  const decoded = decodeFinite(value);
  if (Option.isNone(decoded)) {
    return fallback;
  }

  return Math.min(
    THEME_ROUNDING_MAX,
    Math.max(THEME_ROUNDING_MIN, decoded.value),
  );
};

const normalizeThemeColors = (value: unknown): ThemeColors => {
  const record = decodeRecordOrEmpty(value);
  const colors: ThemeColors = {};
  for (const name of THEME_COLOR_NAMES) {
    const color = normalizeRgb(record[name]);
    if (color !== undefined) {
      colors[name] = color;
    }
  }
  return colors;
};

// V1 -> V2
const migrateThemeColors = (
  value: unknown,
  variant: ThemeVariant,
): ThemeColors => {
  const tokens = decodeRecordOrEmpty(value);
  const colors: ThemeColors = {};
  for (const name of THEME_COLOR_NAMES) {
    const legacyName = name === "accent" ? "primary" : name;
    const color = normalizeRgb(tokens[legacyName]);
    const fallback = LEGACY_THEME_DEFAULTS[variant][legacyName];
    if (
      color !== undefined &&
      color.some((channel, index) => channel !== fallback[index])
    ) {
      colors[name] = color;
    }
  }
  return colors;
};

const normalizeThemeProfile = (
  value: unknown,
  variant: ThemeVariant,
  isCurrentVersion: boolean,
): ThemeProfile => {
  const fallback = DEFAULT_APP_SETTINGS.appearance.themes[variant];
  const profile = decodeRecord(value);
  if (Option.isNone(profile)) {
    return fallback;
  }

  const sansFont = normalizeFont(profile.value["sansFont"], DEFAULT_SANS_FONT);
  const monoFont = normalizeFont(profile.value["monoFont"], DEFAULT_MONO_FONT);

  return {
    colors: isCurrentVersion
      ? normalizeThemeColors(profile.value["colors"])
      : migrateThemeColors(profile.value["tokens"], variant),
    ...(sansFont === undefined ? {} : { sansFont }),
    ...(monoFont === undefined ? {} : { monoFont }),
    sansFontSize: normalizeFontSize(
      profile.value["sansFontSize"],
      fallback.sansFontSize,
    ),
    monoFontSize: normalizeFontSize(
      profile.value["monoFontSize"],
      fallback.monoFontSize,
    ),
    rounding: normalizeRounding(profile.value["rounding"], fallback.rounding),
  };
};

export const normalizeAppSettings = (value: unknown): AppSettings => {
  const settings = decodeRecordOrEmpty(value);
  const preferences = decodeRecordOrEmpty(settings["preferences"]);
  const appearance = decodeRecordOrEmpty(settings["appearance"]);
  const themes = decodeRecordOrEmpty(appearance["themes"]);

  return {
    version: APP_SETTINGS_VERSION,
    preferences: {
      checkForUpdates: decodeOrElse(
        decodeBoolean,
        preferences["checkForUpdates"],
        DEFAULT_APP_SETTINGS.preferences.checkForUpdates,
      ),
      launchMode: decodeOrElse(
        decodeAppLaunchMode,
        preferences["launchMode"],
        DEFAULT_APP_SETTINGS.preferences.launchMode,
      ),
      showGameUsernameInWindowTitle: decodeOrElse(
        decodeBoolean,
        preferences["showGameUsernameInWindowTitle"],
        DEFAULT_APP_SETTINGS.preferences.showGameUsernameInWindowTitle,
      ),
      useGameTabs: decodeOrElse(
        decodeBoolean,
        preferences["useGameTabs"],
        DEFAULT_APP_SETTINGS.preferences.useGameTabs,
      ),
    },
    appearance: {
      themeMode: decodeOrElse(
        decodeThemeMode,
        appearance["themeMode"],
        DEFAULT_APP_SETTINGS.appearance.themeMode,
      ),
      reduceMotion: decodeOrElse(
        decodeMotionMode,
        appearance["reduceMotion"],
        DEFAULT_APP_SETTINGS.appearance.reduceMotion,
      ),
      useCursorPointers: decodeOrElse(
        decodeBoolean,
        appearance["useCursorPointers"],
        DEFAULT_APP_SETTINGS.appearance.useCursorPointers,
      ),
      themes: {
        light: normalizeThemeProfile(
          themes["light"],
          "light",
          settings["version"] === APP_SETTINGS_VERSION,
        ),
        dark: normalizeThemeProfile(
          themes["dark"],
          "dark",
          settings["version"] === APP_SETTINGS_VERSION,
        ),
      },
    },
    hotkeys: normalizeHotkeySettings(settings["hotkeys"]),
  };
};

const serializeColors = (
  colors: ThemeColors,
): Partial<Record<ThemeColorName, string>> => {
  const serialized: Partial<Record<ThemeColorName, string>> = {};
  for (const name of THEME_COLOR_NAMES) {
    const color = colors[name];
    if (color !== undefined) {
      serialized[name] = rgbToHex(color);
    }
  }
  return serialized;
};

const serializeThemeProfile = (
  profile: ThemeProfile,
): Omit<ThemeProfile, "colors"> & {
  readonly colors: Partial<Record<ThemeColorName, string>>;
} => ({
  colors: serializeColors(profile.colors),
  ...(profile.sansFont === undefined ? {} : { sansFont: profile.sansFont }),
  ...(profile.monoFont === undefined ? {} : { monoFont: profile.monoFont }),
  sansFontSize: profile.sansFontSize,
  monoFontSize: profile.monoFontSize,
  rounding: profile.rounding,
});

export const serializeAppSettings = (settings: AppSettings): unknown => {
  const normalized = normalizeAppSettings(settings);
  return {
    version: normalized.version,
    preferences: normalized.preferences,
    appearance: {
      themeMode: normalized.appearance.themeMode,
      reduceMotion: normalized.appearance.reduceMotion,
      useCursorPointers: normalized.appearance.useCursorPointers,
      themes: {
        light: serializeThemeProfile(normalized.appearance.themes.light),
        dark: serializeThemeProfile(normalized.appearance.themes.dark),
      },
    },
    hotkeys: normalized.hotkeys,
  };
};
