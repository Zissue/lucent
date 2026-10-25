import { nativeTheme } from "electron";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { ThemeMode } from "@lucent/core/settings";

export interface ElectronThemeShape {
  readonly setThemeMode: (themeMode: ThemeMode) => Effect.Effect<void>;
  readonly shouldUseDarkColors: Effect.Effect<boolean>;
}

export class ElectronTheme extends Context.Service<
  ElectronTheme,
  ElectronThemeShape
>()("lucent/desktop/electron/ElectronTheme") {}

const setThemeMode: ElectronThemeShape["setThemeMode"] = (themeMode) =>
  Effect.sync(() => {
    nativeTheme.themeSource = themeMode;
  });

const shouldUseDarkColors: ElectronThemeShape["shouldUseDarkColors"] =
  Effect.sync(() => nativeTheme.shouldUseDarkColors);

export const layer = Layer.succeed(
  ElectronTheme,
  ElectronTheme.of({
    setThemeMode,
    shouldUseDarkColors,
  }),
);
