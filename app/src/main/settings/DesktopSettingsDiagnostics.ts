import { isDeepStrictEqual } from "node:util";

import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { hexToRgb } from "@lucent/core/appearance";
import {
  isSettingsCommandId,
  normalizeHotkeyBindingValue,
} from "@lucent/core/hotkeys";
import {
  DEFAULT_APP_SETTINGS,
  normalizeAppSettings,
  ThemeRgbSchema,
  UnknownRecordSchema,
  type AppSettings,
} from "@lucent/core/settings";

const decodeRecord = Schema.decodeUnknownOption(UnknownRecordSchema);
const isThemeRgb = Schema.is(ThemeRgbSchema);

const decodeSavedHotkeys = Schema.decodeUnknownOption(
  Schema.Struct({
    bindings: Schema.Array(
      Schema.Struct({ id: Schema.String, value: Schema.String }),
    ),
  }),
);

const settingsResetFields = (raw: unknown, settings: AppSettings): string[] => {
  const reset: string[] = [];
  const inspect = (value: unknown, normalized: unknown, path: string): void => {
    if (value === undefined) return;
    const record = decodeRecord(value);
    if (path === "hotkeys") {
      if (Option.isNone(record)) {
        reset.push(path);
        return;
      }
      if (!Object.hasOwn(record.value, "bindings")) return;
      const decoded = decodeSavedHotkeys(value);
      const seen = new Set<string>();
      if (
        Option.isNone(decoded) ||
        decoded.value.bindings.some((binding) => {
          const duplicate = seen.has(binding.id);
          seen.add(binding.id);
          return (
            duplicate ||
            !isSettingsCommandId(binding.id) ||
            normalizeHotkeyBindingValue(binding.value) === null ||
            settings.hotkeys.bindings.find((saved) => saved.id === binding.id)
              ?.value !== normalizeHotkeyBindingValue(binding.value)
          );
        })
      )
        reset.push("hotkeys.bindings");
      return;
    }
    const normalizedRecord = decodeRecord(normalized);
    if (Option.isSome(normalizedRecord)) {
      if (Option.isNone(record)) {
        reset.push(path);
        return;
      }
      for (const [name, field] of Object.entries(normalizedRecord.value)) {
        inspect(
          record.value[name],
          field,
          path === "" ? name : `${path}.${name}`,
        );
      }
      return;
    }
    if (
      !isDeepStrictEqual(
        typeof value === "string" &&
          (path.endsWith(".sansFont") || path.endsWith(".monoFont"))
          ? value.trim()
          : value,
        normalized,
      )
    )
      reset.push(path);
  };
  inspect(raw, settings, "");
  return reset;
};

const isValidThemeToken = (token: unknown): boolean =>
  typeof token === "string" ? hexToRgb(token) !== null : isThemeRgb(token);

const migrateThemeTokensToColors = (
  document: Readonly<Record<string, unknown>>,
) => {
  const appearance = decodeRecord(document["appearance"]);
  const themes = Option.flatMap(appearance, (value) =>
    decodeRecord(value["themes"]),
  );
  if (Option.isNone(appearance) || Option.isNone(themes)) {
    return { value: document, issues: {} };
  }

  const migrated = normalizeAppSettings(document).appearance.themes;
  const reset: string[] = [];
  const nextThemes: Record<string, unknown> = { ...themes.value };
  for (const variant of ["light", "dark"] as const) {
    const theme = decodeRecord(themes.value[variant]);
    if (Option.isNone(theme) || !Object.hasOwn(theme.value, "tokens")) {
      continue;
    }
    const { tokens, ...rest } = theme.value;
    const tokenRecord = decodeRecord(tokens);
    if (
      Option.isNone(tokenRecord) ||
      !Object.values(tokenRecord.value).every(isValidThemeToken)
    ) {
      reset.push(`appearance.themes.${variant}.tokens`);
    }
    nextThemes[variant] = { ...rest, colors: migrated[variant].colors };
  }

  return {
    value: {
      ...document,
      appearance: { ...appearance.value, themes: nextThemes },
    },
    issues: reset.length === 0 ? {} : { reset },
  };
};

export const settingsVersions = {
  current: DEFAULT_APP_SETTINGS.version,
  migrations: { 1: migrateThemeTokensToColors },
};

export const decodeSettings = (document: Readonly<Record<string, unknown>>) => {
  const value = normalizeAppSettings(document);
  return { value, issues: { reset: settingsResetFields(document, value) } };
};
