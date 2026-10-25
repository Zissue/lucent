import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  DEFAULT_HOTKEYS,
  HotkeysSettingsSchema,
  normalizeHotkeySettings,
  type HotkeysSettings,
} from "./hotkeys";

const APP_SETTINGS_VERSION = 1;

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

export const THEME_TOKEN_NAMES = [
  "background",
  "foreground",
  "card",
  "cardForeground",
  "popover",
  "popoverForeground",
  "primary",
  "primaryForeground",
  "secondary",
  "secondaryForeground",
  "muted",
  "mutedForeground",
  "accent",
  "accentForeground",
  "destructive",
  "destructiveForeground",
  "success",
  "successForeground",
  "warning",
  "warningForeground",
  "info",
  "infoForeground",
  "border",
  "input",
  "ring",
] as const;

export const ThemeTokenNameSchema = Schema.Literals(THEME_TOKEN_NAMES);
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

export const ThemeTokenValuesSchema = Schema.Record(
  ThemeTokenNameSchema,
  ThemeRgbSchema,
);
const OptionalThemeRgbSchema = Schema.optionalKey(
  Schema.NullOr(ThemeRgbSchema),
);
const ThemeTokenPatchSchema = Schema.Struct({
  background: OptionalThemeRgbSchema,
  foreground: OptionalThemeRgbSchema,
  card: OptionalThemeRgbSchema,
  cardForeground: OptionalThemeRgbSchema,
  popover: OptionalThemeRgbSchema,
  popoverForeground: OptionalThemeRgbSchema,
  primary: OptionalThemeRgbSchema,
  primaryForeground: OptionalThemeRgbSchema,
  secondary: OptionalThemeRgbSchema,
  secondaryForeground: OptionalThemeRgbSchema,
  muted: OptionalThemeRgbSchema,
  mutedForeground: OptionalThemeRgbSchema,
  accent: OptionalThemeRgbSchema,
  accentForeground: OptionalThemeRgbSchema,
  destructive: OptionalThemeRgbSchema,
  destructiveForeground: OptionalThemeRgbSchema,
  success: OptionalThemeRgbSchema,
  successForeground: OptionalThemeRgbSchema,
  warning: OptionalThemeRgbSchema,
  warningForeground: OptionalThemeRgbSchema,
  info: OptionalThemeRgbSchema,
  infoForeground: OptionalThemeRgbSchema,
  border: OptionalThemeRgbSchema,
  input: OptionalThemeRgbSchema,
  ring: OptionalThemeRgbSchema,
});

export const ThemeProfileSchema = Schema.Struct({
  tokens: ThemeTokenValuesSchema,
  sansFont: ThemeFontSchema,
  monoFont: ThemeFontSchema,
  sansFontSize: ThemeFontSizeSchema,
  monoFontSize: ThemeFontSizeSchema,
  rounding: ThemeRoundingSchema,
});

export const ThemeProfilePatchSchema = Schema.Struct({
  tokens: Schema.optionalKey(ThemeTokenPatchSchema),
  sansFont: Schema.optionalKey(ThemeFontSchema),
  monoFont: Schema.optionalKey(ThemeFontSchema),
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

export type ThemeTokenName = (typeof THEME_TOKEN_NAMES)[number];
export type ThemeTokenValues = Record<ThemeTokenName, ThemeRgb>;
export interface PreferencesPatch {
  readonly checkForUpdates?: boolean;
  readonly launchMode?: AppLaunchMode;
  readonly showGameUsernameInWindowTitle?: boolean;
  readonly useGameTabs?: boolean;
}
export interface ThemeProfilePatch {
  readonly monoFont?: string;
  readonly monoFontSize?: number;
  readonly rounding?: number;
  readonly sansFont?: string;
  readonly sansFontSize?: number;
  readonly tokens?: Partial<Record<ThemeTokenName, ThemeRgb | null>>;
}
export interface AppearancePatch {
  readonly reduceMotion?: MotionMode;
  readonly themeMode?: ThemeMode;
  readonly themes?: Partial<Record<ThemeVariant, ThemeProfilePatch>>;
  readonly useCursorPointers?: boolean;
}

export interface ThemeProfile {
  readonly tokens: ThemeTokenValues;
  readonly sansFont: string;
  readonly monoFont: string;
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

const DEFAULT_SANS_FONT =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
const DEFAULT_MONO_FONT =
  'ui-monospace, "SFMono-Regular", "SF Mono", Menlo, Consolas, "Liberation Mono", monospace';
const DEFAULT_SANS_FONT_SIZE = 14;
const DEFAULT_MONO_FONT_SIZE = 12;

const DEFAULT_THEME_TOKENS: Record<ThemeVariant, ThemeTokenValues> = {
  light: {
    background: [255, 255, 255],
    foreground: [38, 38, 38],
    card: [255, 255, 255],
    cardForeground: [38, 38, 38],
    popover: [255, 255, 255],
    popoverForeground: [38, 38, 38],
    primary: [38, 38, 38],
    primaryForeground: [250, 250, 250],
    secondary: [245, 245, 245],
    secondaryForeground: [38, 38, 38],
    muted: [245, 245, 245],
    mutedForeground: [92, 92, 92],
    accent: [245, 245, 245],
    accentForeground: [38, 38, 38],
    destructive: [239, 68, 68],
    destructiveForeground: [185, 28, 28],
    success: [16, 185, 129],
    successForeground: [4, 120, 87],
    warning: [245, 158, 11],
    warningForeground: [180, 83, 9],
    info: [59, 130, 246],
    infoForeground: [29, 78, 216],
    border: [235, 235, 235],
    input: [229, 229, 229],
    ring: [163, 163, 163],
  },
  dark: {
    background: [14, 14, 15],
    foreground: [245, 245, 245],
    card: [18, 18, 20],
    cardForeground: [245, 245, 245],
    popover: [22, 22, 24],
    popoverForeground: [245, 245, 245],
    primary: [245, 245, 245],
    primaryForeground: [38, 38, 38],
    secondary: [32, 32, 34],
    secondaryForeground: [245, 245, 245],
    muted: [32, 32, 34],
    mutedForeground: [166, 166, 166],
    accent: [32, 32, 34],
    accentForeground: [245, 245, 245],
    destructive: [248, 113, 113],
    destructiveForeground: [248, 113, 113],
    success: [52, 211, 153],
    successForeground: [52, 211, 153],
    warning: [251, 191, 36],
    warningForeground: [251, 191, 36],
    info: [96, 165, 250],
    infoForeground: [96, 165, 250],
    border: [38, 38, 40],
    input: [46, 46, 49],
    ring: [115, 115, 115],
  },
};

const DEFAULT_LIGHT_THEME_PROFILE: ThemeProfile = {
  tokens: DEFAULT_THEME_TOKENS.light,
  sansFont: DEFAULT_SANS_FONT,
  monoFont: DEFAULT_MONO_FONT,
  sansFontSize: DEFAULT_SANS_FONT_SIZE,
  monoFontSize: DEFAULT_MONO_FONT_SIZE,
  rounding: 1,
};

const DEFAULT_DARK_THEME_PROFILE: ThemeProfile = {
  tokens: DEFAULT_THEME_TOKENS.dark,
  sansFont: DEFAULT_SANS_FONT,
  monoFont: DEFAULT_MONO_FONT,
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
const decodeThemeTokenName = Schema.decodeUnknownOption(ThemeTokenNameSchema);
const decodeThemeRgb = Schema.decodeUnknownOption(ThemeRgbSchema);
const decodeRecord = Schema.decodeUnknownOption(UnknownRecordSchema);
const decodeBoolean = Schema.decodeUnknownOption(Schema.Boolean);
const decodeFinite = Schema.decodeUnknownOption(Schema.Finite);
const decodeString = Schema.decodeUnknownOption(Schema.String);

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

const isThemeTokenName = (value: string): value is ThemeTokenName =>
  Option.isSome(decodeThemeTokenName(value));

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
  return Option.isSome(tupleValue) ? (tupleValue.value as ThemeRgb) : undefined;
};

const rgbToHex = (rgb: ThemeRgb): string =>
  `#${rgb.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;

const normalizeFont = (value: unknown, fallback: string): string => {
  const decoded = decodeString(value);
  if (Option.isNone(decoded)) {
    return fallback;
  }

  const font = decoded.value.trim();
  return font.length >= THEME_FONT_MIN_LENGTH &&
    font.length <= THEME_FONT_MAX_LENGTH
    ? font
    : fallback;
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

const normalizeThemeTokens = (
  value: unknown,
  fallback: ThemeTokenValues,
): ThemeTokenValues => {
  const tokenRecord = decodeRecord(value);
  if (Option.isNone(tokenRecord)) {
    return fallback;
  }

  const tokens: Partial<Record<ThemeTokenName, ThemeRgb>> = {};
  for (const [key, rawToken] of Object.entries(tokenRecord.value)) {
    if (!isThemeTokenName(key)) {
      continue;
    }

    const token = normalizeRgb(rawToken);
    if (token !== undefined) {
      tokens[key] = token;
    }
  }

  return { ...fallback, ...tokens };
};

const normalizeThemeProfile = (
  value: unknown,
  fallback: ThemeProfile,
): ThemeProfile => {
  const profile = decodeRecord(value);
  if (Option.isNone(profile)) {
    return fallback;
  }

  return {
    tokens: normalizeThemeTokens(profile.value["tokens"], fallback.tokens),
    sansFont: normalizeFont(profile.value["sansFont"], fallback.sansFont),
    monoFont: normalizeFont(profile.value["monoFont"], fallback.monoFont),
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
          DEFAULT_APP_SETTINGS.appearance.themes.light,
        ),
        dark: normalizeThemeProfile(
          themes["dark"],
          DEFAULT_APP_SETTINGS.appearance.themes.dark,
        ),
      },
    },
    hotkeys: normalizeHotkeySettings(settings["hotkeys"]),
  };
};

const serializeTokens = (
  tokens: ThemeTokenValues,
): Record<ThemeTokenName, string> => {
  const serialized = {} as Record<ThemeTokenName, string>;
  for (const [name, value] of Object.entries(tokens)) {
    const tokenName = name as ThemeTokenName;
    const rgb = normalizeRgb(value);
    if (rgb !== undefined) {
      serialized[tokenName] = rgbToHex(rgb);
    }
  }
  return serialized;
};

const serializeThemeProfile = (
  profile: ThemeProfile,
): Omit<ThemeProfile, "tokens"> & {
  readonly tokens: Partial<Record<ThemeTokenName, string>>;
} => ({
  tokens: serializeTokens(profile.tokens),
  sansFont: profile.sansFont,
  monoFont: profile.monoFont,
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
