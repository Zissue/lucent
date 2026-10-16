import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpBody, HttpClient, HttpClientRequest } from "effect/http";
import type { HttpClientResponse } from "effect/http/HttpClientResponse";
import type { HttpMethod } from "effect/http/HttpMethod";
import { NodeHttpIncomingMessage } from "@effect/platform-node/NodeHttpIncomingMessage";
import {
  clientError,
  crossOriginRedirectHeaders,
  type DesktopHttpClientError,
} from "./DesktopHttpError";

interface RequestOptions {
  readonly url: URL;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: Uint8Array;
  readonly maxRedirects: number;
  readonly redirect?: "follow" | "manual" | "error";
  readonly timeoutMs?: number;
  readonly socketTimeoutMs?: number;
  readonly httpsOnly: boolean;
}

const decodeMethod = Schema.decodeUnknownEffect(
  Schema.String.check(Schema.isPattern(/^[!#$%&'*+.^_`|~0-9A-Z-]+$/u)),
);

const validateUrl = (
  url: URL,
  httpsOnly: boolean,
): Effect.Effect<void, DesktopHttpClientError> =>
  (url.protocol !== "https:" && (httpsOnly || url.protocol !== "http:")) ||
  url.username !== "" ||
  url.password !== ""
    ? Effect.fail(
        clientError(
          "invalid-url",
          `HTTP requests require an absolute ${httpsOnly ? "HTTPS" : "HTTP or HTTPS"} URL without embedded credentials.`,
          url,
        ),
      )
    : Effect.void;

export const requestFollowingRedirects = <A, E, R>(
  client: HttpClient.HttpClient,
  options: RequestOptions,
  consume: (response: HttpClientResponse, url: URL) => Effect.Effect<A, E, R>,
) =>
  Effect.suspend(() => {
    let url = options.url;
    let method = options.method;
    let headers = options.headers;
    let body = options.body;
    const scopedClient = HttpClient.withScope(client);
    const request = Effect.gen(function* () {
      yield* decodeMethod(method).pipe(
        Effect.mapError((cause) =>
          clientError("request-failed", "Invalid HTTP method.", url, cause),
        ),
      );
      if (method === "CONNECT")
        return yield* clientError(
          "request-failed",
          "HTTP tunnels are not supported.",
          url,
        );
      for (let redirects = 0; ; redirects += 1) {
        yield* validateUrl(url, options.httpsOnly);
        const result = yield* Effect.scoped(
          Effect.gen(function* () {
            // Effect's Node transport forwards extension methods, though its type lists only common methods.
            const outgoing = HttpClientRequest.make(method as HttpMethod)(
              url.href,
            ).pipe(
              body === undefined
                ? (request) => request
                : HttpClientRequest.setBody(HttpBody.raw(body)),
              HttpClientRequest.setHeaders(headers),
            );
            const waiting = scopedClient.execute(outgoing);
            const response = yield* options.socketTimeoutMs === undefined
              ? waiting
              : waiting.pipe(Effect.timeout(options.socketTimeoutMs));
            if (response instanceof NodeHttpIncomingMessage) {
              if (response.status === 101) {
                response.source.socket.destroy();
                return yield* clientError(
                  "request-failed",
                  "HTTP protocol upgrades are not supported.",
                  url,
                );
              }
              if (options.socketTimeoutMs !== undefined)
                response.source.setTimeout(options.socketTimeoutMs, () =>
                  response.source.destroy(
                    new Error("HTTP response timed out."),
                  ),
                );
            }
            const location = response.headers["location"];
            if (
              ![301, 302, 303, 307, 308].includes(response.status) ||
              location === undefined ||
              options.redirect === "manual"
            ) {
              return {
                done: true,
                value: yield* consume(response, url),
              } as const;
            }
            if (
              options.redirect === "error" ||
              redirects >= options.maxRedirects
            ) {
              return yield* clientError(
                "redirect-failed",
                options.redirect === "error"
                  ? "HTTP redirects are disabled."
                  : "HTTP request exceeded its redirect limit.",
                url,
              );
            }
            const nextUrl = yield* Effect.try({
              try: () => new URL(location, url),
              catch: (cause) =>
                clientError(
                  "redirect-failed",
                  "HTTP response contained an invalid redirect URL.",
                  url,
                  cause,
                ),
            });
            yield* validateUrl(nextUrl, options.httpsOnly).pipe(
              Effect.mapError((cause) =>
                clientError(
                  "redirect-failed",
                  "HTTP response contained an invalid redirect URL.",
                  url,
                  cause,
                ),
              ),
            );
            headers =
              nextUrl.origin === url.origin
                ? { ...headers }
                : crossOriginRedirectHeaders(headers);
            if (
              ((response.status === 301 || response.status === 302) &&
                method === "POST") ||
              (response.status === 303 && method !== "GET" && method !== "HEAD")
            ) {
              method = "GET";
              body = undefined;
              headers = Object.fromEntries(
                Object.entries(headers).filter(
                  ([name]) =>
                    ![
                      "content-type",
                      "content-length",
                      "content-encoding",
                      "content-language",
                      "content-location",
                      "transfer-encoding",
                    ].includes(name.toLowerCase()),
                ),
              );
            }
            url = nextUrl;
            return { done: false } as const;
          }),
        );
        if (result.done) return result.value;
      }
    }).pipe(Effect.provideService(HttpClient.TracerPropagationEnabled, false));
    return options.timeoutMs === undefined
      ? request
      : options.timeoutMs === 0
        ? Effect.fail(clientError("timeout", "HTTP request timed out.", url))
        : request.pipe(
            Effect.timeoutOrElse({
              duration: options.timeoutMs,
              orElse: () =>
                Effect.fail(
                  clientError(
                    "timeout",
                    `HTTP request timed out after ${options.timeoutMs} milliseconds.`,
                    url,
                  ),
                ),
            }),
          );
  });
