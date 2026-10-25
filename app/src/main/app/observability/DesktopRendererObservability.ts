import { app, type Event as ElectronEvent, type WebContents } from "electron";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FiberSet from "effect/FiberSet";
import * as Scope from "effect/Scope";

import { listen } from "../../electron/NativeListener";

export const installDesktopRendererObservability = Effect.gen(function* () {
  const runFork = yield* FiberSet.makeRuntime();
  const scope = yield* Effect.scope;

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
    Effect.runSync(
      Effect.gen(function* () {
        const contentsScope = yield* Scope.fork(scope);
        yield* Effect.gen(function* () {
          yield* listen(contents, "did-fail-load", handleDidFailLoad);
          yield* listen(contents, "responsive", handleResponsive);
          yield* listen(contents, "unresponsive", handleUnresponsive);
          yield* listen(contents, "destroyed", () => {
            Effect.runSync(Scope.close(contentsScope, Exit.void));
          });
        }).pipe(Scope.provide(contentsScope));
      }),
    );
  };

  const handleWebContentsCreated = (
    _event: ElectronEvent,
    contents: WebContents,
  ): void => {
    observeWebContents(contents);
  };

  yield* listen(app, "child-process-gone", handleChildProcessGone);
  yield* listen(app, "render-process-gone", handleRenderProcessGone);
  yield* listen(app, "web-contents-created", handleWebContentsCreated);
});
