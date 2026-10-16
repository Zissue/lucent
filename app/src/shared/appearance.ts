import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  getTextSizeTokens,
  pickOnAccentColor,
  rgbToCssValue,
  type AppearanceSnapshot,
} from "@lucent/core/appearance";
import {
  DEFAULT_THEME_COLORS,
  type ThemeRgb,
  type ThemeVariant,
} from "@lucent/core/settings";
import type { DesktopBridgeView } from "./desktopBridge";
import { readArgumentValue } from "./rendererBootstrapArguments";

export * from "@lucent/core/appearance";

export const DESKTOP_VIEW_ARGUMENT = "--lucent__view";

const DesktopBridgeViewSchema = Schema.Literals([
  "about",
  "account-manager",
  "combat-profiles",
  "environment",
  "follower",
  "game",
  "game-group-controls",
  "game-host",
  "loader-grabber",
  "packets",
  "settings",
]);
const decodeDesktopBridgeView = Schema.decodeUnknownOption(
  DesktopBridgeViewSchema,
);

const legacyThemeTokens: Record<ThemeVariant, Record<string, ThemeRgb>> = {
  light: {
    "--background": [255, 255, 255],
    "--foreground": [38, 38, 38],
    "--card": [255, 255, 255],
    "--card-foreground": [38, 38, 38],
    "--popover": [255, 255, 255],
    "--popover-foreground": [38, 38, 38],
    "--primary": [38, 38, 38],
    "--primary-foreground": [250, 250, 250],
    "--secondary": [245, 245, 245],
    "--secondary-foreground": [38, 38, 38],
    "--muted": [245, 245, 245],
    "--muted-foreground": [92, 92, 92],
    "--accent": [245, 245, 245],
    "--accent-foreground": [38, 38, 38],
    "--destructive": [239, 68, 68],
    "--destructive-foreground": [185, 28, 28],
    "--success": [16, 185, 129],
    "--success-foreground": [4, 120, 87],
    "--warning": [245, 158, 11],
    "--warning-foreground": [180, 83, 9],
    "--info": [59, 130, 246],
    "--info-foreground": [29, 78, 216],
    "--border": [235, 235, 235],
    "--input": [229, 229, 229],
    "--ring": [163, 163, 163],
  },
  dark: {
    "--background": [14, 14, 15],
    "--foreground": [245, 245, 245],
    "--card": [18, 18, 20],
    "--card-foreground": [245, 245, 245],
    "--popover": [22, 22, 24],
    "--popover-foreground": [245, 245, 245],
    "--primary": [245, 245, 245],
    "--primary-foreground": [38, 38, 38],
    "--secondary": [32, 32, 34],
    "--secondary-foreground": [245, 245, 245],
    "--muted": [32, 32, 34],
    "--muted-foreground": [166, 166, 166],
    "--accent": [32, 32, 34],
    "--accent-foreground": [245, 245, 245],
    "--destructive": [248, 113, 113],
    "--destructive-foreground": [248, 113, 113],
    "--success": [52, 211, 153],
    "--success-foreground": [52, 211, 153],
    "--warning": [251, 191, 36],
    "--warning-foreground": [251, 191, 36],
    "--info": [96, 165, 250],
    "--info-foreground": [96, 165, 250],
    "--border": [38, 38, 40],
    "--input": [46, 46, 49],
    "--ring": [115, 115, 115],
  },
};

const radiusBaseRem = {
  "--radius": 0.625,
  "--radius-xs": 0.25,
  "--radius-sm": 0.375,
  "--radius-md": 0.5,
  "--radius-lg": 0.5,
  "--radius-xl": 0.75,
} as const;

type RadiusTokenName = keyof typeof radiusBaseRem;
type TextSizeTokenName = keyof ReturnType<typeof getTextSizeTokens>;

export const serializeDesktopViewArgument = (view: DesktopBridgeView): string =>
  `${DESKTOP_VIEW_ARGUMENT}=${view}`;

export const readDesktopViewArgument = (
  argv: readonly string[],
): DesktopBridgeView | null => {
  const value = readArgumentValue(argv, DESKTOP_VIEW_ARGUMENT);
  const decoded = decodeDesktopBridgeView(value);
  return Option.isSome(decoded) ? decoded.value : null;
};

const applyRounding = (
  style: CSSStyleDeclaration,
  multiplier: number,
): void => {
  for (const [name, base] of Object.entries(radiusBaseRem) as Array<
    [RadiusTokenName, number]
  >) {
    style.setProperty(name, `${base * multiplier}rem`);
  }
};

const applyTypography = (
  style: CSSStyleDeclaration,
  snapshot: AppearanceSnapshot,
): void => {
  style.setProperty("--font-sans", snapshot.sansFont);
  style.setProperty("--font-mono", snapshot.monoFont);
  style.setProperty("--font-mono-size", `${snapshot.monoFontSize}px`);

  for (const [name, value] of Object.entries(
    getTextSizeTokens(snapshot.sansFontSize),
  ) as Array<[TextSizeTokenName, string]>) {
    style.setProperty(name, value);
  }
};

export const applyAppearanceSnapshotToDocument = (
  root: HTMLElement,
  snapshot: AppearanceSnapshot,
): void => {
  const style = root.style;

  root.dataset["theme"] = snapshot.variant;
  root.dataset["reduceMotion"] = snapshot.reduceMotion;
  root.classList.toggle("dark", snapshot.variant === "dark");
  if (snapshot.useCursorPointers) {
    root.dataset["useCursorPointers"] = "true";
  } else {
    delete root.dataset["useCursorPointers"];
  }

  style.setProperty("color-scheme", snapshot.variant);
  style.setProperty(
    "--cursor-interactive",
    snapshot.useCursorPointers ? "pointer" : "default",
  );

  const colors = {
    ...DEFAULT_THEME_COLORS[snapshot.variant],
    ...snapshot.colors,
  };
  style.setProperty("--color-bg", `rgb(${colors.background.join(" ")})`);
  style.setProperty("--color-text", `rgb(${colors.foreground.join(" ")})`);
  style.setProperty("--color-accent", `rgb(${colors.accent.join(" ")})`);
  style.setProperty(
    "--color-on-accent",
    `rgb(${pickOnAccentColor(colors.accent).join(" ")})`,
  );
  style.setProperty("--font-size-base", `${snapshot.sansFontSize}px`);
  style.setProperty("--font-size-mono", `${snapshot.monoFontSize}px`);
  style.setProperty("--radius-scale", String(snapshot.rounding));

  const legacyTokens = { ...legacyThemeTokens[snapshot.variant] };
  if (snapshot.colors.background !== undefined) {
    legacyTokens["--background"] = snapshot.colors.background;
  }
  if (snapshot.colors.foreground !== undefined) {
    legacyTokens["--foreground"] = snapshot.colors.foreground;
  }
  if (snapshot.colors.accent !== undefined) {
    legacyTokens["--primary"] = snapshot.colors.accent;
    legacyTokens["--primary-foreground"] = pickOnAccentColor(
      snapshot.colors.accent,
    );
  }
  for (const [name, value] of Object.entries(legacyTokens)) {
    style.setProperty(name, rgbToCssValue(value));
  }

  applyTypography(style, snapshot);
  applyRounding(style, snapshot.rounding);
};
