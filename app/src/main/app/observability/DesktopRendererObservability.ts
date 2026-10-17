import { app, type Event as ElectronEvent, type WebContents } from "electron";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";

export const installDesktopRendererObservability = Effect.gen(function* () {
  const runFork = yield* FiberSet.makeRuntime();
  const webContentsCleanups = new Set<() => void>();

  const handleChildProcessGone = (
    _event: ElectronEvent,
    details: Electron.Details,
  ): void => {
    runFork(
      (details.reason === "clean-exit"
        ? Effect.logInfo("Child process gone")
        : Effect.logError("Child process gone")
      ).pipe(
        Effect.annotateLogs({
          component: "process",
          repeatKey: [
            details.type,
            details.serviceName ?? details.name,
            details.reason,
          ]
            .filter(Boolean)
            .join(":"),
          data: details,
        }),
      ),
    );
  };

  const handleRenderProcessGone = (
    _event: ElectronEvent,
    contents: WebContents,
    details: Electron.RenderProcessGoneDetails,
  ): void => {
    runFork(
      (details.reason === "clean-exit"
        ? Effect.logInfo("Renderer process gone")
        : Effect.logError("Renderer process gone")
      ).pipe(
        Effect.annotateLogs({
          component: "renderer",
          repeatKey: `${contents.id}:${details.reason}`,
          data: { rendererId: contents.id, ...details },
        }),
      ),
    );
  };

  const observeWebContents = (contents: WebContents): void => {
    const handleDidFailLoad = (
      _event: ElectronEvent,
      errorCode: number,
      errorDescription: string,
      validatedUrl: string,
      isMainFrame: boolean,
    ): void => {
      if (errorCode === -3 || errorDescription === "ERR_ABORTED") return;
      const host = URL.parse(validatedUrl)?.host;
      runFork(
        Effect.logWarning("Renderer load failed").pipe(
          Effect.annotateLogs({
            component: "renderer",
            repeatKey: `${contents.id}:${errorCode}`,
            data: {
              errorCode,
              errorDescription,
              isMainFrame,
              rendererId: contents.id,
              ...(host ? { host } : {}),
            },
          }),
        ),
      );
    };
    const handleResponsive = (): void => {
      runFork(
        Effect.logInfo("Renderer responsive").pipe(
          Effect.annotateLogs({
            component: "renderer",
            repeatKey: String(contents.id),
            data: { rendererId: contents.id },
          }),
        ),
      );
    };
    const handleUnresponsive = (): void => {
      runFork(
        Effect.logWarning("Renderer unresponsive").pipe(
          Effect.annotateLogs({
            component: "renderer",
            repeatKey: String(contents.id),
            data: { rendererId: contents.id },
          }),
        ),
      );
    };
    let cleanedUp = false;
    const cleanup = (): void => {
      if (cleanedUp) {
        return;
      }
      cleanedUp = true;
      contents.removeListener("did-fail-load", handleDidFailLoad);
      contents.removeListener("responsive", handleResponsive);
      contents.removeListener("unresponsive", handleUnresponsive);
      contents.removeListener("destroyed", cleanup);
      webContentsCleanups.delete(cleanup);
    };

    contents.on("did-fail-load", handleDidFailLoad);
    contents.on("responsive", handleResponsive);
    contents.on("unresponsive", handleUnresponsive);
    contents.once("destroyed", cleanup);
    webContentsCleanups.add(cleanup);
  };

  const handleWebContentsCreated = (
    _event: ElectronEvent,
    contents: WebContents,
  ): void => {
    observeWebContents(contents);
  };

  yield* Effect.sync(() => {
    app.on("child-process-gone", handleChildProcessGone);
    app.on("render-process-gone", handleRenderProcessGone);
    app.on("web-contents-created", handleWebContentsCreated);
  });
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      app.removeListener("child-process-gone", handleChildProcessGone);
      app.removeListener("render-process-gone", handleRenderProcessGone);
      app.removeListener("web-contents-created", handleWebContentsCreated);
      for (const cleanup of webContentsCleanups) {
        cleanup();
      }
    }),
  );
});
