import { describe, expect, it } from "@effect/vitest";

import {
  applyAppearanceSnapshotToDocument,
  createAppearanceSnapshot,
} from "./appearance";
import { normalizeAppSettings } from "@lucent/core/settings";

const makeRoot = () => {
  const properties = new Map<string, string>();
  const classes = new Set<string>();
  const root = {
    classList: {
      toggle: (name: string, active: boolean) => {
        if (active) {
          classes.add(name);
        } else {
          classes.delete(name);
        }
      },
    },
    dataset: {} as Record<string, string>,
    style: {
      setProperty: (name: string, value: string) => {
        properties.set(name, value);
      },
    },
  } as unknown as HTMLElement;

  return { root, properties, classes };
};

describe("appearance bootstrap", () => {
  it("applies React defaults and preserves every legacy Solid dark color", () => {
    const snapshot = createAppearanceSnapshot(normalizeAppSettings({}), true);
    const { root, properties, classes } = makeRoot();

    applyAppearanceSnapshotToDocument(root, snapshot);

    expect(snapshot.backgroundColor).toBe("#0e0e10");
    expect(root.dataset).toEqual({ theme: "dark", reduceMotion: "system" });
    expect(classes.has("dark")).toBe(true);
    expect(Object.fromEntries(properties)).toMatchObject({
      "color-scheme": "dark",
      "--cursor-interactive": "default",
      "--color-bg": "rgb(14 14 16)",
      "--color-text": "rgb(243 243 245)",
      "--color-accent": "rgb(243 243 245)",
      "--color-on-accent": "rgb(25 25 28)",
      "--font-size-base": "14px",
      "--font-size-mono": "12px",
      "--radius-scale": "1",
      "--background": "14, 14, 15",
      "--foreground": "245, 245, 245",
      "--card": "18, 18, 20",
      "--card-foreground": "245, 245, 245",
      "--popover": "22, 22, 24",
      "--popover-foreground": "245, 245, 245",
      "--primary": "245, 245, 245",
      "--primary-foreground": "38, 38, 38",
      "--secondary": "32, 32, 34",
      "--secondary-foreground": "245, 245, 245",
      "--muted": "32, 32, 34",
      "--muted-foreground": "166, 166, 166",
      "--accent": "32, 32, 34",
      "--accent-foreground": "245, 245, 245",
      "--destructive": "248, 113, 113",
      "--destructive-foreground": "248, 113, 113",
      "--success": "52, 211, 153",
      "--success-foreground": "52, 211, 153",
      "--warning": "251, 191, 36",
      "--warning-foreground": "251, 191, 36",
      "--info": "96, 165, 250",
      "--info-foreground": "96, 165, 250",
      "--border": "38, 38, 40",
      "--input": "46, 46, 49",
      "--ring": "115, 115, 115",
    });
  });

  it("applies React defaults and preserves every legacy Solid light color", () => {
    const snapshot = createAppearanceSnapshot(
      normalizeAppSettings({ appearance: { themeMode: "light" } }),
      true,
    );
    const { root, properties, classes } = makeRoot();

    applyAppearanceSnapshotToDocument(root, snapshot);

    expect(snapshot.backgroundColor).toBe("#f8f8fa");
    expect(root.dataset["theme"]).toBe("light");
    expect(classes.has("dark")).toBe(false);
    expect(Object.fromEntries(properties)).toMatchObject({
      "color-scheme": "light",
      "--color-bg": "rgb(248 248 250)",
      "--color-text": "rgb(25 25 28)",
      "--color-accent": "rgb(25 25 28)",
      "--color-on-accent": "rgb(255 255 255)",
      "--background": "255, 255, 255",
      "--foreground": "38, 38, 38",
      "--card": "255, 255, 255",
      "--card-foreground": "38, 38, 38",
      "--popover": "255, 255, 255",
      "--popover-foreground": "38, 38, 38",
      "--primary": "38, 38, 38",
      "--primary-foreground": "250, 250, 250",
      "--secondary": "245, 245, 245",
      "--secondary-foreground": "38, 38, 38",
      "--muted": "245, 245, 245",
      "--muted-foreground": "92, 92, 92",
      "--accent": "245, 245, 245",
      "--accent-foreground": "38, 38, 38",
      "--destructive": "239, 68, 68",
      "--destructive-foreground": "185, 28, 28",
      "--success": "16, 185, 129",
      "--success-foreground": "4, 120, 87",
      "--warning": "245, 158, 11",
      "--warning-foreground": "180, 83, 9",
      "--info": "59, 130, 246",
      "--info-foreground": "29, 78, 216",
      "--border": "235, 235, 235",
      "--input": "229, 229, 229",
      "--ring": "163, 163, 163",
    });
  });

  it("applies only explicit overrides to Solid and clears them on subsequent snapshots", () => {
    const settings = normalizeAppSettings({
      version: 2,
      appearance: {
        themeMode: "light",
        useCursorPointers: true,
        reduceMotion: "on",
        themes: {
          light: {
            colors: {
              background: [1, 2, 3],
              foreground: [210, 220, 230],
              accent: [18, 52, 86],
            },
            sansFont: "Custom Sans",
            monoFont: "Custom Mono",
            sansFontSize: 21,
            monoFontSize: 15,
            rounding: 0.5,
          },
        },
      },
    });
    const { root, properties, classes } = makeRoot();

    applyAppearanceSnapshotToDocument(
      root,
      createAppearanceSnapshot(settings, true),
    );

    expect(root.dataset).toEqual({
      theme: "light",
      reduceMotion: "on",
      useCursorPointers: "true",
    });
    expect(Object.fromEntries(properties)).toMatchObject({
      "--cursor-interactive": "pointer",
      "--color-bg": "rgb(1 2 3)",
      "--color-text": "rgb(210 220 230)",
      "--color-accent": "rgb(18 52 86)",
      "--color-on-accent": "rgb(255 255 255)",
      "--background": "1, 2, 3",
      "--foreground": "210, 220, 230",
      "--primary": "18, 52, 86",
      "--primary-foreground": "255, 255, 255",
      "--accent": "245, 245, 245",
      "--card": "255, 255, 255",
      "--ring": "163, 163, 163",
      "--font-sans": "Custom Sans",
      "--font-mono": "Custom Mono",
      "--font-size-base": "21px",
      "--font-size-mono": "15px",
      "--font-mono-size": "15px",
      "--text-xs": "16.5px",
      "--text-base": "21px",
      "--text-5xl": "42px",
      "--radius-scale": "0.5",
      "--radius": "0.3125rem",
      "--radius-xs": "0.125rem",
      "--radius-xl": "0.375rem",
    });

    applyAppearanceSnapshotToDocument(
      root,
      createAppearanceSnapshot(normalizeAppSettings({}), true),
    );

    expect(root.dataset).toEqual({ theme: "dark", reduceMotion: "system" });
    expect(classes.has("dark")).toBe(true);
    expect(Object.fromEntries(properties)).toMatchObject({
      "--color-bg": "rgb(14 14 16)",
      "--color-text": "rgb(243 243 245)",
      "--color-accent": "rgb(243 243 245)",
      "--color-on-accent": "rgb(25 25 28)",
      "--background": "14, 14, 15",
      "--foreground": "245, 245, 245",
      "--primary": "245, 245, 245",
      "--primary-foreground": "38, 38, 38",
      "--font-sans":
        '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      "--font-mono":
        'ui-monospace, "SFMono-Regular", "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
      "--font-size-base": "14px",
      "--font-size-mono": "12px",
      "--radius-scale": "1",
      "--cursor-interactive": "default",
    });
  });

  it("chooses dark primary text for a light accent override without overriding other Solid tokens", () => {
    const settings = normalizeAppSettings({
      version: 2,
      appearance: { themes: { dark: { colors: { accent: [255, 255, 0] } } } },
    });
    const { root, properties } = makeRoot();

    applyAppearanceSnapshotToDocument(
      root,
      createAppearanceSnapshot(settings, true),
    );

    expect(Object.fromEntries(properties)).toMatchObject({
      "--color-accent": "rgb(255 255 0)",
      "--color-on-accent": "rgb(25 25 28)",
      "--primary": "255, 255, 0",
      "--primary-foreground": "25, 25, 28",
      "--background": "14, 14, 15",
      "--foreground": "245, 245, 245",
      "--accent": "32, 32, 34",
    });
  });
});
