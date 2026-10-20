import type { WebContents } from "electron";
import { watchFile, unwatchFile, type Stats } from "node:fs";

import { electronRendererRegistry } from "../electron/ElectronRendererRegistry";

import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";

export type RendererReloadContentTarget = Pick<
  WebContents,
  "isDestroyed" | "reloadIgnoringCache"
>;

export const reloadUsableRendererContents = (
  contents: Iterable<RendererReloadContentTarget>,
): number => {
  let reloadCount = 0;
  for (const renderer of contents) {
    if (renderer.isDestroyed()) {
      continue;
    }

    renderer.reloadIgnoringCache();
    reloadCount += 1;
  }
  return reloadCount;
};

const RELOAD_WATCH_INTERVAL_MS = 100;

const shouldIgnoreReloadFileChange = (
  current: Stats,
  previous: Stats,
): boolean =>
  current.mtimeMs === 0 ||
  (current.mtimeMs === previous.mtimeMs && current.size === previous.size);

// The owned registry includes detached views, such as preloaded group controls.
const reloadOpenRendererContents = (): number =>
  reloadUsableRendererContents(electronRendererRegistry.getAllWebContents());

export const installDesktopDevRendererReload = Effect.gen(function* () {
  const reloadPath = process.env["LUCENT_DEV_RENDERER_RELOAD"];
  if (reloadPath === undefined || reloadPath.trim().length === 0) {
    return;
  }

  const runFork = yield* FiberSet.makeRuntime();
  const listener = (current: Stats, previous: Stats): void => {
    if (shouldIgnoreReloadFileChange(current, previous)) {
      return;
    }

    const rendererCount = reloadOpenRendererContents();
    runFork(
      Effect.logDebug("Renderer reload requested").pipe(
        Effect.annotateLogs({
          component: "dev",
          data: {
            reloadPath,
            rendererCount,
          },
        }),
      ),
    );
  };

  yield* Effect.sync(() => {
    watchFile(reloadPath, { interval: RELOAD_WATCH_INTERVAL_MS }, listener);
  });
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      unwatchFile(reloadPath, listener);
    }),
  );
});
