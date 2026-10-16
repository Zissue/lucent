import * as Effect from "effect/Effect";

import {
  HttpError,
  type DesktopHttpBridge,
  type HttpRequestPayload,
} from "../../../../../shared/http";
import type { HttpResponse } from "../ScriptApi";
import type { ScriptAsyncScope } from "../scriptAsyncScope";
import { makeHttpResponse } from "./response";

export const requestFailure = (cause: unknown, url: string) =>
  cause instanceof HttpError
    ? cause
    : new HttpError({
        reason: "request",
        url,
        detail: cause instanceof Error ? cause.message : "HTTP request failed.",
        cause,
      });

/** Keeps IPC cancellation attached until main has released the request. */
export const executeRequest = (
  bridge: DesktopHttpBridge,
  scope: ScriptAsyncScope,
  signal: AbortSignal | undefined,
  payload: HttpRequestPayload,
): Effect.Effect<HttpResponse, HttpError> =>
  Effect.callback((resume) => {
    let settled = false;
    let sent = false;
    let cancelling = false;
    let cancellation: Promise<void> | undefined;
    const detach = () => {
      scope.signal.removeEventListener("abort", onStop);
      signal?.removeEventListener("abort", onAbort);
    };
    const finish = (result: Effect.Effect<HttpResponse, HttpError>) => {
      if (settled) return;
      settled = true;
      detach();
      resume(result);
    };
    const cancel = () => {
      cancelling = true;
      cancellation ??= sent
        ? bridge.cancel(payload.sessionId, payload.requestId)
        : Promise.resolve();
      return cancellation;
    };
    const abort = (stopping: boolean) => {
      void cancel().then(
        () =>
          finish(
            stopping
              ? Effect.interrupt
              : Effect.fail(
                  new HttpError({
                    reason: "aborted",
                    detail: "HTTP request was aborted.",
                    url: payload.url,
                  }),
                ),
          ),
        (cause: unknown) =>
          finish(
            stopping
              ? Effect.interrupt
              : Effect.fail(requestFailure(cause, payload.url)),
          ),
      );
    };
    const onStop = () => abort(true);
    const onAbort = () => abort(false);
    scope.signal.addEventListener("abort", onStop, { once: true });
    signal?.addEventListener("abort", onAbort, { once: true });
    if (scope.signal.aborted) onStop();
    else if (signal?.aborted) onAbort();
    else {
      sent = true;
      try {
        void bridge.request(payload).then(
          (result) => {
            if (cancelling || settled) return;
            finish(
              result.ok
                ? Effect.try({
                    try: () => makeHttpResponse(result.value),
                    catch: (cause) => requestFailure(cause, payload.url),
                  })
                : Effect.fail(new HttpError(result.error)),
            );
          },
          (cause: unknown) => {
            if (!cancelling)
              finish(Effect.fail(requestFailure(cause, payload.url)));
          },
        );
      } catch (cause) {
        finish(Effect.fail(requestFailure(cause, payload.url)));
      }
    }
    return Effect.suspend(() => {
      settled = true;
      detach();
      return Effect.tryPromise({
        try: cancel,
        catch: (cause) => requestFailure(cause, payload.url),
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("HTTP cancellation failed", cause).pipe(
            Effect.annotateLogs({ component: "scripting" }),
          ),
        ),
      );
    });
  });
