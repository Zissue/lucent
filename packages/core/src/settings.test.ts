import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  AppSettingsSchema,
  ThemeProfilePatchSchema,
  ThemeProfileSchema,
  normalizeAppSettings,
  serializeAppSettings,
} from "./settings";

const legacyTokens = {
  light: {
    background: "#ffffff",
    foreground: "#262626",
    card: "#ffffff",
    cardForeground: "#262626",
    popover: "#ffffff",
    popoverForeground: "#262626",
    primary: "#262626",
    primaryForeground: "#fafafa",
    secondary: "#f5f5f5",
    secondaryForeground: "#262626",
    muted: "#f5f5f5",
    mutedForeground: "#5c5c5c",
    accent: "#f5f5f5",
    accentForeground: "#262626",
    destructive: "#ef4444",
    destructiveForeground: "#b91c1c",
    success: "#10b981",
    successForeground: "#047857",
    warning: "#f59e0b",
    warningForeground: "#b45309",
    info: "#3b82f6",
    infoForeground: "#1d4ed8",
    border: "#ebebeb",
    input: "#e5e5e5",
    ring: "#a3a3a3",
  },
  dark: {
    background: "#0e0e0f",
    foreground: "#f5f5f5",
    card: "#121214",
    cardForeground: "#f5f5f5",
    popover: "#161618",
    popoverForeground: "#f5f5f5",
    primary: "#f5f5f5",
    primaryForeground: "#262626",
    secondary: "#202022",
    secondaryForeground: "#f5f5f5",
    muted: "#202022",
    mutedForeground: "#a6a6a6",
    accent: "#202022",
    accentForeground: "#f5f5f5",
    destructive: "#f87171",
    destructiveForeground: "#f87171",
    success: "#34d399",
    successForeground: "#34d399",
    warning: "#fbbf24",
    warningForeground: "#fbbf24",
    info: "#60a5fa",
    infoForeground: "#60a5fa",
    border: "#262628",
    input: "#2e2e31",
    ring: "#737373",
  },
};

describe("settings", () => {
  it.each([1, 2])(
    "omits default fonts from v%s settings and serialization",
    (version) => {
      const profile = {
        sansFont: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        monoFont:
          'ui-monospace, "SFMono-Regular", "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
      };
      const normalized = normalizeAppSettings({
        version,
        appearance: { themes: { light: profile, dark: profile } },
      });

      expect(normalized.version).toBe(2);
      expect(normalized.appearance.themes).toStrictEqual({
        light: { colors: {}, sansFontSize: 14, monoFontSize: 12, rounding: 1 },
        dark: { colors: {}, sansFontSize: 14, monoFontSize: 12, rounding: 1 },
      });
      const serialized = serializeAppSettings(normalized);
      expect(serialized).not.toHaveProperty("appearance.themes.light.sansFont");
      expect(serialized).not.toHaveProperty("appearance.themes.light.monoFont");
      expect(serialized).not.toHaveProperty("appearance.themes.dark.sansFont");
      expect(serialized).not.toHaveProperty("appearance.themes.dark.monoFont");
    },
  );

  it.each([1, 2])(
    "keeps trimmed custom fonts in v%s settings and serialization",
    (version) => {
      const normalized = normalizeAppSettings({
        version,
        appearance: {
          themes: {
            light: { sansFont: " Custom Sans ", monoFont: " Custom Mono " },
            dark: { sansFont: " Dark Sans ", monoFont: " Dark Mono " },
          },
        },
      });

      expect(normalized.appearance.themes).toStrictEqual({
        light: {
          colors: {},
          sansFont: "Custom Sans",
          monoFont: "Custom Mono",
          sansFontSize: 14,
          monoFontSize: 12,
          rounding: 1,
        },
        dark: {
          colors: {},
          sansFont: "Dark Sans",
          monoFont: "Dark Mono",
          sansFontSize: 14,
          monoFontSize: 12,
          rounding: 1,
        },
      });
      expect(serializeAppSettings(normalized)).toMatchObject({
        appearance: {
          themes: {
            light: { sansFont: "Custom Sans", monoFont: "Custom Mono" },
            dark: { sansFont: "Dark Sans", monoFont: "Dark Mono" },
          },
        },
      });
    },
  );

  it.each([1, 2])(
    "omits missing, invalid, and blank fonts from v%s settings",
    (version) => {
      for (const font of [undefined, null, 42, "", " \t ", "x".repeat(257)]) {
        const normalized = normalizeAppSettings({
          version,
          appearance: {
            themes: {
              light: { sansFont: font, monoFont: font },
              dark: { sansFont: font, monoFont: font },
            },
          },
        });

        expect(normalized.appearance.themes).toStrictEqual({
          light: {
            colors: {},
            sansFontSize: 14,
            monoFontSize: 12,
            rounding: 1,
          },
          dark: { colors: {}, sansFontSize: 14, monoFontSize: 12, rounding: 1 },
        });
      }
    },
  );

  it("validates optional profile fonts and font patch resets", () => {
    const decodeProfile = Schema.decodeUnknownSync(ThemeProfileSchema);
    const profile = {
      colors: {},
      sansFontSize: 14,
      monoFontSize: 12,
      rounding: 1,
    };
    expect(decodeProfile(profile)).toStrictEqual({
      colors: {},
      sansFontSize: 14,
      monoFontSize: 12,
      rounding: 1,
    });
    expect(
      decodeProfile({
        ...profile,
        sansFont: "Custom Sans",
        monoFont: "Custom Mono",
      }),
    ).toStrictEqual({
      colors: {},
      sansFont: "Custom Sans",
      monoFont: "Custom Mono",
      sansFontSize: 14,
      monoFontSize: 12,
      rounding: 1,
    });
    for (const font of [null, "", "x".repeat(257)]) {
      expect(() => decodeProfile({ ...profile, sansFont: font })).toThrow();
      expect(() => decodeProfile({ ...profile, monoFont: font })).toThrow();
    }

    const decodePatch = Schema.decodeUnknownSync(ThemeProfilePatchSchema);
    expect(decodePatch({})).toStrictEqual({});
    expect(
      decodePatch({ sansFont: " Custom Sans ", monoFont: "Custom Mono" }),
    ).toStrictEqual({
      sansFont: " Custom Sans ",
      monoFont: "Custom Mono",
    });
    expect(decodePatch({ sansFont: null, monoFont: null })).toStrictEqual({
      sansFont: null,
      monoFont: null,
    });
    expect(decodePatch({ sansFont: "", monoFont: "   " })).toStrictEqual({
      sansFont: "",
      monoFont: "   ",
    });
    for (const font of [42, "x".repeat(257)]) {
      expect(() => decodePatch({ sansFont: font })).toThrow();
      expect(() => decodePatch({ monoFont: font })).toThrow();
    }
  });

  it.each([1, undefined])(
    "migrates default legacy tokens with version %s into empty overrides",
    (version) => {
      const normalized = normalizeAppSettings({
        version,
        appearance: {
          themes: {
            light: { tokens: legacyTokens.light },
            dark: { tokens: legacyTokens.dark },
          },
        },
      });
      const serialized = serializeAppSettings(normalized);

      expect(normalized.version).toBe(2);
      expect(normalized.appearance.themes.light.colors).toEqual({});
      expect(normalized.appearance.themes.dark.colors).toEqual({});
      expect(serialized).toMatchObject({
        version: 2,
        appearance: { themes: { light: { colors: {} }, dark: { colors: {} } } },
      });
      expect(JSON.stringify(serialized)).not.toContain('"tokens"');
      expect(normalizeAppSettings(serialized)).toEqual(normalized);
    },
  );

  it("migrates only customized legacy background, foreground, and primary", () => {
    const normalized = normalizeAppSettings({
      version: 1,
      preferences: {
        checkForUpdates: true,
        launchMode: "account-manager",
        showGameUsernameInWindowTitle: true,
        useGameTabs: true,
      },
      hotkeys: {
        bindings: [{ id: "loadScript", value: "ctrl shift l" }],
      },
      appearance: {
        themeMode: "light",
        reduceMotion: "off",
        useCursorPointers: true,
        themes: {
          light: {
            tokens: {
              ...legacyTokens.light,
              primary: [10, 20, 30],
              accent: "#abcdef",
              card: "#010203",
            },
            sansFont: " Custom Sans ",
            monoFont: "Custom Mono",
            sansFontSize: 42,
            monoFontSize: 8,
            rounding: 4,
          },
          dark: {
            tokens: {
              ...legacyTokens.dark,
              background: " #0a0B0c ",
              foreground: [210, 220, 230],
              accent: "#010203",
              card: "#abcdef",
            },
          },
        },
      },
    });

    expect(normalized.preferences).toEqual({
      checkForUpdates: true,
      launchMode: "account-manager",
      showGameUsernameInWindowTitle: true,
      useGameTabs: true,
    });
    expect(
      normalized.hotkeys.bindings.find(({ id }) => id === "loadScript")?.value,
    ).toBe("Control+Shift+L");
    expect(normalized.appearance).toMatchObject({
      themeMode: "light",
      reduceMotion: "off",
      useCursorPointers: true,
      themes: {
        light: {
          colors: { accent: [10, 20, 30] },
          sansFont: "Custom Sans",
          monoFont: "Custom Mono",
          sansFontSize: 24,
          monoFontSize: 10,
          rounding: 2,
        },
        dark: {
          colors: { background: [10, 11, 12], foreground: [210, 220, 230] },
        },
      },
    });
    expect(normalized.appearance.themes.light.colors).toEqual({
      accent: [10, 20, 30],
    });
    expect(normalized.appearance.themes.dark.colors).toEqual({
      background: [10, 11, 12],
      foreground: [210, 220, 230],
    });
    expect(serializeAppSettings(normalized)).toMatchObject({
      version: 2,
      appearance: {
        themes: {
          light: { colors: { accent: "#0a141e" } },
          dark: { colors: { background: "#0a0b0c", foreground: "#d2dce6" } },
        },
      },
    });
  });

  it("does not migrate invalid colors or treat RGB defaults as overrides", () => {
    const normalized = normalizeAppSettings({
      appearance: {
        themes: {
          light: {
            tokens: {
              background: [255, 255, 255],
              foreground: [38, 38, 38],
              primary: [38, 38, 38],
              accent: "#010203",
            },
          },
          dark: {
            tokens: {
              background: "#abc",
              foreground: [-1, 0, 0],
              primary: [0, 0, 256],
            },
          },
        },
      },
    });

    expect(normalized.appearance.themes.light.colors).toEqual({});
    expect(normalized.appearance.themes.dark.colors).toEqual({});
  });

  it("round trips sparse v2 colors and ignores legacy tokens and unknown colors", () => {
    const normalized = normalizeAppSettings({
      version: 2,
      appearance: {
        themes: {
          light: {
            colors: {
              accent: " 262626 ",
              foreground: [25, 25, 28],
              card: "#abcdef",
            },
          },
          dark: {
            colors: {
              background: "#0A0B0C",
              accent: null,
              foreground: [1.5, 2, 3],
            },
            tokens: { primary: "#123456", foreground: "#abcdef" },
          },
        },
      },
    });
    const serialized = serializeAppSettings(normalized);

    expect(normalized.appearance.themes.light.colors).toEqual({
      accent: [38, 38, 38],
      foreground: [25, 25, 28],
    });
    expect(normalized.appearance.themes.dark.colors).toEqual({
      background: [10, 11, 12],
    });
    expect(serialized).toMatchObject({
      version: 2,
      appearance: {
        themes: {
          light: { colors: { accent: "#262626", foreground: "#19191c" } },
          dark: { colors: { background: "#0a0b0c" } },
        },
      },
    });
    expect(JSON.stringify(serialized)).not.toContain('"tokens"');
    expect(normalizeAppSettings(serialized)).toEqual(normalized);
    expect(Schema.is(AppSettingsSchema)(normalized)).toBe(true);
    expect(Schema.is(AppSettingsSchema)({ ...normalized, version: 1 })).toBe(
      false,
    );
  });

  it("validates color patches with null resets and rejects invalid RGB values", () => {
    const decode = Schema.decodeUnknownSync(ThemeProfilePatchSchema);

    expect(decode({ colors: { accent: [1, 2, 3], background: null } })).toEqual(
      { colors: { accent: [1, 2, 3], background: null } },
    );
    expect(() => decode({ colors: { accent: [256, 0, 0] } })).toThrow();
    expect(() => decode({ colors: { accent: "#010203" } })).toThrow();
  });
});
