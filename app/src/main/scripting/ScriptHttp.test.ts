import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Logger from "effect/Logger";
import * as References from "effect/References";

import type { HttpRequestPayload } from "../../shared/http";
import { DesktopHttpClientError } from "../http/DesktopHttpClient";
import { makeScriptHttp } from "./ScriptHttp";

const makeLogCapture = () => {
  const records: {
    readonly level: string;
    readonly message: unknown;
    readonly annotations: Readonly<Record<string, unknown>>;
    readonly cause: Cause.Cause<unknown>;
  }[] = [];
  const logger = Logger.make((options) => {
    records.push({
      level: options.logLevel,
      message: options.message,
      annotations: options.fiber.getRef(References.CurrentLogAnnotations),
      cause: options.cause,
    });
  });
  return { records, logger };
};

const requestPayload = (sessionId: string): HttpRequestPayload => ({
  sessionId,
  requestId: 1,
  url: "https://user:password@example.com/private?token=secret",
  method: "POST",
  headers: { Authorization: "Bearer secret" },
  body: new Uint8Array([1, 2, 3]),
  redirect: "follow",
  maxRedirects: 5,
});

describe("script HTTP failure logging", () => {
  it.effect("parses and normalizes an absolute request URL", () =>
    Effect.gen(function* () {
      const http = makeScriptHttp({
        request: ({ url }) =>
          Effect.succeed({
            body: Buffer.from([1, 2]),
            headers: {},
            statusCode: 200,
            statusMessage: "OK",
            url: url.href,
          }),
      });
      const session = yield* http.openSession(42);
      const result = yield* http.request(42, {
        ...requestPayload(session),
        url: "  HTTPS://EXAMPLE.COM/a/../b?q=1#part  ",
      });

      expect(result).toEqual({
        ok: true,
        value: {
          body: new Uint8Array([1, 2]),
          headers: [],
          status: 200,
          statusText: "OK",
          url: "https://example.com/b?q=1#part",
        },
      });
    }),
  );

  it.effect.each(["not a URL", "/relative", "https://[invalid", ""])(
    "returns a request error for the invalid URL %s",
    (url) =>
      Effect.gen(function* () {
        const capture = makeLogCapture();
        const http = makeScriptHttp({
          request: () => Effect.die(new Error("Unexpected HTTP request")),
        });
        const session = yield* http.openSession(42);
        const result = yield* http
          .request(42, { ...requestPayload(session), url })
          .pipe(
            Effect.provideService(
              Logger.CurrentLoggers,
              new Set([capture.logger]),
            ),
          );

        expect(result).toEqual({
          ok: false,
          error: {
            reason: "request",
            detail: "Invalid HTTP request URL.",
            url,
          },
        });
        expect(capture.records).toEqual([]);
      }),
  );

  it.effect("logs a defect once before returning a failed request", () =>
    Effect.gen(function* () {
      const capture = makeLogCapture();
      const defect = new Error("Unexpected HTTP defect");
      const http = makeScriptHttp({ request: () => Effect.die(defect) });
      const session = yield* http.openSession(42);
      const payload = requestPayload(session);
      const result = yield* http
        .request(42, payload)
        .pipe(
          Effect.provideService(
            Logger.CurrentLoggers,
            new Set([capture.logger]),
          ),
        );

      expect(result).toEqual({
        ok: false,
        error: {
          reason: "request",
          detail: "HTTP request failed.",
          url: payload.url,
        },
      });
      expect(
        capture.records.map(({ level, message, annotations }) => ({
          level,
          message,
          annotations,
        })),
      ).toEqual([
        {
          level: "Error",
          message: ["Script HTTP request failed unexpectedly"],
          annotations: {
            component: "script-http",
            data: { rendererId: 42, requestId: 1 },
            repeatKey: "42:1",
          },
        },
      ]);
      expect(
        capture.records.map((record) => Cause.squash(record.cause)),
      ).toEqual([defect]);
    }),
  );

  it.effect.each(["request-failed", "aborted"] as const)(
    "keeps ordinary %s outcomes silent",
    (kind) =>
      Effect.gen(function* () {
        const capture = makeLogCapture();
        const http = makeScriptHttp({
          request: () =>
            Effect.fail(
              new DesktopHttpClientError({
                kind,
                detail: "Expected request failure.",
                url: "https://example.com",
              }),
            ),
        });
        const session = yield* http.openSession(42);
        const result = yield* http
          .request(42, requestPayload(session))
          .pipe(
            Effect.provideService(
              Logger.CurrentLoggers,
              new Set([capture.logger]),
            ),
          );

        expect(result).toEqual({
          ok: false,
          error: {
            reason: kind === "aborted" ? "aborted" : "request",
            detail: "Expected request failure.",
            url: "https://example.com",
          },
        });
        expect(capture.records).toEqual([]);
      }),
  );

  it.effect("keeps renderer closure and cancellation silent", () =>
    Effect.gen(function* () {
      const capture = makeLogCapture();
      const started = yield* Deferred.make<void>();
      const http = makeScriptHttp({
        request: () =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Effect.never),
          ),
      });
      const session = yield* http.openSession(42);
      const payload = requestPayload(session);
      const result = yield* Effect.gen(function* () {
        const pending = yield* http.request(42, payload).pipe(Effect.forkChild);
        yield* Deferred.await(started);
        yield* http.closeRenderer(42);
        return yield* Fiber.join(pending);
      }).pipe(
        Effect.provideService(Logger.CurrentLoggers, new Set([capture.logger])),
      );

      expect(result).toEqual({
        ok: false,
        error: {
          reason: "aborted",
          detail: "HTTP request was aborted.",
          url: payload.url,
        },
      });
      expect(capture.records).toEqual([]);
    }),
  );
});
