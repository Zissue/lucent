import "../shared/immediate";

import type { JSX } from "solid-js";
import { render } from "solid-js/web";

import type { AppPlatform } from "../shared/desktopBridge";
import type { AppSettings } from "@lucent/core/settings";
import { installRendererThemeSync } from "./theme";

performance.mark("lucent.renderer.bootstrap");

type RendererCleanup = () => void;

interface RendererLifecycleOptions {
  readonly cleanup?: RendererCleanup | readonly RendererCleanup[];
  readonly markReady?: boolean;
}

interface RendererMountOptions extends RendererLifecycleOptions {
  readonly app: (settings: AppSettings) => JSX.Element;
}

export interface DesktopRendererProps {
  readonly initialSettings: AppSettings | null;
  readonly platform: AppPlatform;
}

const normalizeCleanup = (
  cleanup: RendererLifecycleOptions["cleanup"],
): readonly RendererCleanup[] => {
  if (cleanup === undefined) {
    return [];
  }

  return typeof cleanup === "function" ? [cleanup] : cleanup;
};

const runCleanup = (cleanup: RendererCleanup): void => {
  try {
    cleanup();
  } catch (cause) {
    console.error("[renderer] cleanup failed", cause);
  }
};

const readDesktopRendererProps = (
  initialSettings: AppSettings,
): DesktopRendererProps => ({
  initialSettings,
  platform: window.desktop.platform.os,
});

export const mountRenderer = (options: RendererMountOptions): void => {
  const themeSync = installRendererThemeSync();
  const cleanup = normalizeCleanup(options.cleanup);
  let disposed = false;
  let disposeRender: RendererCleanup | undefined;

  void themeSync.ready.then(() => {
    if (disposed) {
      return;
    }

    const root = document.getElementById("root");
    disposeRender =
      root === null
        ? undefined
        : render(() => options.app(themeSync.currentSettings()), root);
    performance.mark("lucent.renderer.mounted");

    if (options.markReady ?? true) {
      document.documentElement.dataset["ready"] = "true";
      performance.mark("lucent.renderer.ready");
    }
  });

  window.addEventListener(
    "beforeunload",
    () => {
      disposed = true;
      for (const dispose of cleanup) {
        runCleanup(dispose);
      }

      if (disposeRender !== undefined) {
        runCleanup(disposeRender);
      }

      runCleanup(themeSync.dispose);
    },
    { once: true },
  );
};

export const mountDesktopRenderer = (
  app: (props: DesktopRendererProps) => JSX.Element,
  options: RendererLifecycleOptions = {},
): void => {
  mountRenderer({
    ...options,
    app: (settings) => app(readDesktopRendererProps(settings)),
  });
};
