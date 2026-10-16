import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  DEFAULT_MONO_FONT,
  DEFAULT_SANS_FONT,
  DEFAULT_THEME_COLORS,
  MotionModeSchema,
  ThemeFontSchema,
  ThemeFontSizeSchema,
  ThemeRoundingSchema,
  ThemeColorsSchema,
  ThemeVariantSchema,
  UnknownRecordSchema,
  normalizeAppSettings,
  type AppSettings,
  type ThemeRgb,
  type ThemeColorName,
  type ThemeVariant,
} from "./settings";

export const AppearanceSnapshotSchema = Schema.Struct({
  backgroundColor: Schema.String,
  monoFont: ThemeFontSchema,
  monoFontSize: ThemeFontSizeSchema,
  reduceMotion: MotionModeSchema,
  rounding: ThemeRoundingSchema,
  sansFont: ThemeFontSchema,
  sansFontSize: ThemeFontSizeSchema,
  colors: ThemeColorsSchema,
  useCursorPointers: Schema.Boolean,
  variant: ThemeVariantSchema,
});

export type AppearanceSnapshot = typeof AppearanceSnapshotSchema.Type;

export const APPEARANCE_SNAPSHOT_ARGUMENT = "--lucent__appearance";
export const SETTINGS_SNAPSHOT_ARGUMENT = "--lucent__settings";

const decodeAppearanceSnapshot = Schema.decodeUnknownOption(
  AppearanceSnapshotSchema,
);
const decodeUnknownRecord = Schema.decodeUnknownOption(UnknownRecordSchema);

const textSizeRatios = {
  "--text-2xs": 10 / 14,
  "--text-xs": 11 / 14,
  "--text-sm": 12 / 14,
  "--text-base": 1,
  "--text-md": 14 / 14,
  "--text-lg": 15 / 14,
  "--text-xl": 16 / 14,
  "--text-2xl": 18 / 14,
  "--text-3xl": 20 / 14,
  "--text-4xl": 24 / 14,
  "--text-5xl": 28 / 14,
} as const;

type TextSizeTokenName = keyof typeof textSizeRatios;

const HEX_RGB_PATTERN = /^#?([0-9a-f]{6})$/i;

const toHexPair = (value: number): string =>
  Math.max(0, Math.min(255, value)).toString(16).padStart(2, "0");

export const rgbEquals = (left: ThemeRgb, right: ThemeRgb): boolean =>
  left[0] === right[0] && left[1] === right[1] && left[2] === right[2];

export const rgbToCssValue = (rgb: ThemeRgb): string => rgb.join(", ");

export const rgbToHex = (rgb: ThemeRgb): string =>
  `#${toHexPair(rgb[0])}${toHexPair(rgb[1])}${toHexPair(rgb[2])}`;

export const hexToRgb = (hex: string): ThemeRgb | null => {
  const match = HEX_RGB_PATTERN.exec(hex.trim());
  const value = match?.[1];
  if (value === undefined) {
    return null;
  }

  return [
    Number.parseInt(value.slice(0, 2), 16),
    Number.parseInt(value.slice(2, 4), 16),
    Number.parseInt(value.slice(4, 6), 16),
  ];
};

export const getTextSizeTokens = (
  baseSize: number,
): Record<TextSizeTokenName, string> => {
  const tokens = {} as Record<TextSizeTokenName, string>;
  for (const [name, ratio] of Object.entries(textSizeRatios) as Array<
    [TextSizeTokenName, number]
  >) {
    tokens[name] = `${Number((baseSize * ratio).toFixed(4))}px`;
  }
  return tokens;
};

export const resolveThemeVariant = (
  settings: AppSettings,
  systemPrefersDark: boolean,
): ThemeVariant => {
  const mode = settings.appearance.themeMode;
  if (mode === "light" || mode === "dark") {
    return mode;
  }
  return systemPrefersDark ? "dark" : "light";
};

export const resolveThemeColors = (
  settings: AppSettings,
  variant: ThemeVariant,
): Record<ThemeColorName, ThemeRgb> => ({
  ...DEFAULT_THEME_COLORS[variant],
  ...settings.appearance.themes[variant].colors,
});

const linearizeChannel = (channel: number): number => {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
};

const relativeLuminance = (rgb: ThemeRgb): number =>
  0.2126 * linearizeChannel(rgb[0]) +
  0.7152 * linearizeChannel(rgb[1]) +
  0.0722 * linearizeChannel(rgb[2]);

const ON_ACCENT_DARK: ThemeRgb = [25, 25, 28];
const ON_ACCENT_LIGHT: ThemeRgb = [255, 255, 255];
const ON_ACCENT_DARK_LUMINANCE = relativeLuminance(ON_ACCENT_DARK);

export const pickOnAccentColor = (accent: ThemeRgb): ThemeRgb => {
  const luminance = relativeLuminance(accent);
  const lightContrast = 1.05 / (luminance + 0.05);
  const darkContrast =
    (Math.max(luminance, ON_ACCENT_DARK_LUMINANCE) + 0.05) /
    (Math.min(luminance, ON_ACCENT_DARK_LUMINANCE) + 0.05);
  return lightContrast >= darkContrast ? ON_ACCENT_LIGHT : ON_ACCENT_DARK;
};

export const createAppearanceSnapshot = (
  settings: AppSettings,
  systemPrefersDark: boolean,
): AppearanceSnapshot => {
  const variant = resolveThemeVariant(settings, systemPrefersDark);
  const profile = settings.appearance.themes[variant];
  const colors = resolveThemeColors(settings, variant);

  return {
    backgroundColor: rgbToHex(colors.background),
    monoFont: profile.monoFont ?? DEFAULT_MONO_FONT,
    monoFontSize: profile.monoFontSize,
    reduceMotion: settings.appearance.reduceMotion,
    rounding: profile.rounding,
    sansFont: profile.sansFont ?? DEFAULT_SANS_FONT,
    sansFontSize: profile.sansFontSize,
    colors: profile.colors,
    useCursorPointers: settings.appearance.useCursorPointers,
    variant,
  };
};

const parseSerializedJson = (value: string): unknown | null => {
  try {
    return JSON.parse(decodeURIComponent(value));
  } catch {
    return null;
  }
};

const readArgumentValue = (
  argv: readonly string[],
  name: string,
): string | null => {
  const prefix = `${name}=`;
  const value = argv.find((argument) => argument.startsWith(prefix));
  return value === undefined ? null : value.slice(prefix.length);
};

export const serializeAppearanceSnapshotArgument = (
  snapshot: AppearanceSnapshot,
): string =>
  `${APPEARANCE_SNAPSHOT_ARGUMENT}=${encodeURIComponent(
    JSON.stringify(snapshot),
  )}`;

export const readAppearanceSnapshotArgument = (
  argv: readonly string[],
): AppearanceSnapshot | null => {
  const value = readArgumentValue(argv, APPEARANCE_SNAPSHOT_ARGUMENT);
  if (value === null) {
    return null;
  }

  const parsed = parseSerializedJson(value);
  if (parsed === null) {
    return null;
  }

  const decoded = decodeAppearanceSnapshot(parsed);
  return Option.isSome(decoded) ? decoded.value : null;
};

export const serializeSettingsSnapshotArgument = (
  settings: AppSettings,
): string =>
  `${SETTINGS_SNAPSHOT_ARGUMENT}=${encodeURIComponent(JSON.stringify(settings))}`;

export const readSettingsSnapshotArgument = (
  argv: readonly string[],
): AppSettings | null => {
  const value = readArgumentValue(argv, SETTINGS_SNAPSHOT_ARGUMENT);
  if (value === null) {
    return null;
  }

  const parsed = parseSerializedJson(value);
  if (parsed === null) {
    return null;
  }

  const decoded = decodeUnknownRecord(parsed);
  return Option.isSome(decoded) ? normalizeAppSettings(decoded.value) : null;
};
