import { randomBytes } from "crypto";

import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";

import {
  HttpError,
  SCRIPT_HTTP_MAX_BYTES,
  type HttpRequestPayload,
  type HttpResult,
  type HttpErrorReason,
} from "../../shared/http";
import {
  DesktopHttpClient,
  type DesktopHttpClientShape,
  type DesktopHttpClientError,
} from "../http/DesktopHttpClient";
import { DesktopWindows } from "../window/DesktopWindows";

interface Session {
  readonly rendererId: number;
  readonly requests: Map<number, Effect.Effect<void>>;
  readonly cancelled: Set<number>;
}

const errorReasons: Record<DesktopHttpClientError["kind"], HttpErrorReason> = {
  "invalid-url": "request",
  "redirect-failed": "redirect",
  "request-failed": "request",
  "response-too-large": "too-large",
  timeout: "timeout",
  aborted: "aborted",
};

/** Owns HTTP operations by renderer and script run, including renderer loss. */
export const makeScriptHttp = (
  http: Pick<DesktopHttpClientShape, "request">,
) => {
  const sessions = new Map<string, Session>();
  const openSession = (rendererId: number) =>
    Effect.sync(() => {
      const sessionId = randomBytes(32).toString("hex");
      sessions.set(sessionId, {
        rendererId,
        requests: new Map(),
        cancelled: new Set(),
      });
      return sessionId;
    });
  const closeSession = (rendererId: number, sessionId: string) =>
    Effect.suspend(() => {
      const session = sessions.get(sessionId);
      if (session?.rendererId !== rendererId) return Effect.void;
      sessions.delete(sessionId);
      return Effect.all([...session.requests.values()], {
        concurrency: "unbounded",
        discard: true,
      });
    });
  const cancel = (rendererId: number, sessionId: string, requestId: number) =>
    Effect.suspend(() => {
      const session = sessions.get(sessionId);
      if (session?.rendererId !== rendererId) return Effect.void;
      const interrupt = session.requests.get(requestId);
      if (interrupt !== undefined) return interrupt;
      session.cancelled.add(requestId);
      return Effect.void;
    });
  const closeRenderer = (rendererId: number) =>
    Effect.suspend(() =>
      Effect.forEach(
        [...sessions.keys()],
        (sessionId) => closeSession(rendererId, sessionId),
        { concurrency: "unbounded", discard: true },
      ),
    );

  const request = (
    rendererId: number,
    payload: HttpRequestPayload,
  ): Effect.Effect<HttpResult> =>
    Effect.withFiber((fiber) =>
      Effect.acquireUseRelease(
        Effect.suspend(() => {
          const session = sessions.get(payload.sessionId);
          if (session?.rendererId !== rendererId)
            return Effect.fail(
              new HttpError({
                reason: "aborted",
                detail: "The script HTTP session is closed.",
                url: payload.url,
              }),
            );
          if (session.cancelled.delete(payload.requestId))
            return Effect.fail(
              new HttpError({
                reason: "aborted",
                detail: "HTTP request was aborted.",
                url: payload.url,
              }),
            );
          if (session.requests.has(payload.requestId))
            return Effect.fail(
              new HttpError({
                reason: "request",
                detail: "Duplicate HTTP request ID.",
                url: payload.url,
              }),
            );
          session.requests.set(payload.requestId, Fiber.interrupt(fiber));
          return Effect.succeed(session);
        }),
        () =>
          Effect.try({
            try: () => new URL(payload.url),
            catch: (cause) =>
              new HttpError({
                reason: "request",
                detail: "Invalid HTTP request URL.",
                url: payload.url,
                cause,
              }),
          }).pipe(
            Effect.flatMap((url) =>
              http
                .request({
                  url,
                  method: payload.method,
                  headers: payload.headers,
                  ...(payload.body === undefined ? {} : { body: payload.body }),
                  ...(payload.deadline === undefined
                    ? {}
                    : {
                        timeoutMs: Math.min(
                          2_147_483_647,
                          Math.max(0, payload.deadline - Date.now()),
                        ),
                      }),
                  redirect: payload.redirect,
                  maxRedirects: payload.maxRedirects,
                  maxBytes: SCRIPT_HTTP_MAX_BYTES,
                })
                .pipe(
                  Effect.mapError(
                    (error) =>
                      new HttpError({
                        reason: errorReasons[error.kind],
                        detail: error.detail,
                        url: error.url,
                        cause: error.cause,
                      }),
                  ),
                ),
            ),
            Effect.map(
              (response): HttpResult => ({
                ok: true,
                value: {
                  body: new Uint8Array(
                    response.body.buffer,
                    response.body.byteOffset,
                    response.body.byteLength,
                  ),
                  headers: Object.entries(response.headers).flatMap(
                    ([name, value]): [string, string][] =>
                      value === undefined
                        ? []
                        : (Array.isArray(value) ? value : [value]).map(
                            (entry) => [name, entry],
                          ),
                  ),
                  status: response.statusCode,
                  statusText: response.statusMessage,
                  url: response.url,
                },
              }),
            ),
          ),
        (session) =>
          Effect.sync(() => {
            session.requests.delete(payload.requestId);
          }),
      ),
    ).pipe(
      // Keep the IPC handler alive so cancellation can return a typed result.
      Effect.forkChild({ startImmediately: true }),
      Effect.flatMap(Fiber.await),
      Effect.map((exit): HttpResult => {
        if (Exit.isSuccess(exit)) return exit.value;
        const cause = exit.cause;
        const error = Cause.squash(cause);
        return {
          ok: false,
          error:
            error instanceof HttpError
              ? { reason: error.reason, detail: error.detail, url: error.url }
              : {
                  reason: Cause.hasInterrupts(cause) ? "aborted" : "request",
                  detail: Cause.hasInterrupts(cause)
                    ? "HTTP request was aborted."
                    : "HTTP request failed.",
                  url: payload.url,
                },
        };
      }),
    );

  return { openSession, closeSession, cancel, closeRenderer, request };
};

export class ScriptHttp extends Context.Service<
  ScriptHttp,
  ReturnType<typeof makeScriptHttp>
>()("lucent/desktop/scripting/ScriptHttp") {}

export const layer = Layer.effect(
  ScriptHttp,
  Effect.gen(function* () {
    const http = yield* DesktopHttpClient;
    const windows = yield* DesktopWindows;
    const service = makeScriptHttp(http);
    yield* windows.observe({}, (event) =>
      event.type === "closed" ||
      event.type === "reloaded" ||
      event.type === "crashed"
        ? service.closeRenderer(event.rendererId)
        : Effect.void,
    );
    return service;
  }),
);
