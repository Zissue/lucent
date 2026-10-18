import {
  getTextSizeTokens,
  rgbToCssValue,
  type AppearanceSnapshot,
} from "@lucent/core/appearance";
import { THEME_TOKEN_NAMES, type ThemeTokenName } from "@lucent/core/settings";

export * from "@lucent/core/appearance";

const tokenCssNames = new Map<ThemeTokenName, string>(
  THEME_TOKEN_NAMES.map((name) => [
    name,
    `--${name.replace(/[A-Z]/g, (match) => `-${match.toLowerCase()}`)}`,
  ]),
);

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

  for (const name of THEME_TOKEN_NAMES) {
    const cssName = tokenCssNames.get(name);
    if (cssName !== undefined) {
      style.setProperty(cssName, rgbToCssValue(snapshot.tokens[name]));
    }
  }

  applyTypography(style, snapshot);
  applyRounding(style, snapshot.rounding);
};
