import type { IncomingHttpHeaders } from "node:http";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { FileSystem } from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientError } from "effect/http";
import type { HttpClientResponse } from "effect/http/HttpClientResponse";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import { NodeHttpIncomingMessage } from "@effect/platform-node/NodeHttpIncomingMessage";
import { clientError, DesktopHttpClientError } from "./DesktopHttpError";
import { requestFollowingRedirects } from "./DesktopHttpRequest";
export {
  DesktopHttpClientError,
  crossOriginRedirectHeaders,
} from "./DesktopHttpError";

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_ERROR_RESPONSE_MAX_BYTES = 1024 * 1024;

export interface DesktopHttpResponse {
  readonly body: Buffer;
  readonly headers: IncomingHttpHeaders;
  readonly statusCode: number;
  readonly statusMessage: string;
  readonly url: string;
}

export interface DesktopHttpGetOptions {
  readonly headers?: Readonly<Record<string, string>>;
  readonly maxBytes?: number;
  readonly maxRedirects?: number;
  readonly timeoutMs?: number;
  readonly url: URL;
}

export interface DesktopHttpRequestOptions extends DesktopHttpGetOptions {
  readonly method?: string;
  readonly body?: Uint8Array;
  readonly redirect?: "follow" | "manual" | "error";
}

export interface DesktopHttpDownloadOptions {
  readonly errorResponseMaxBytes?: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly maxBytes: number;
  readonly maxRedirects?: number;
  readonly targetPath: string;
  readonly timeoutMs?: number;
  readonly url: URL;
}

export interface DesktopHttpClientShape {
  readonly request: (
    options: DesktopHttpRequestOptions,
  ) => Effect.Effect<DesktopHttpResponse, DesktopHttpClientError>;
  readonly download: (
    options: DesktopHttpDownloadOptions,
  ) => Effect.Effect<DesktopHttpResponse, DesktopHttpClientError>;
  readonly get: (
    options: DesktopHttpGetOptions,
  ) => Effect.Effect<DesktopHttpResponse, DesktopHttpClientError>;
}

export class DesktopHttpClient extends Context.Service<
  DesktopHttpClient,
  DesktopHttpClientShape
>()("lucent/desktop/http/DesktopHttpClient") {}

export const firstHttpHeader = (
  headers: IncomingHttpHeaders,
  name: string,
): string | undefined => {
  const value = headers[name.toLowerCase()];
  if (Array.isArray(value)) return value.find((entry) => entry.trim() !== "");
  return typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : undefined;
};

const boundedBody = (
  response: HttpClientResponse,
  maxBytes: number | undefined,
  url: URL,
) =>
  Stream.suspend(() => {
    if (maxBytes === undefined) return response.stream;
    const tooLarge = () =>
      clientError(
        "response-too-large",
        `HTTP response exceeds the ${maxBytes} byte limit.`,
        url,
      );
    const contentLength = Number(response.headers["content-length"]);
    if (
      response.request.method !== "HEAD" &&
      Number.isSafeInteger(contentLength) &&
      contentLength > maxBytes
    )
      return Stream.fail(tooLarge());
    return response.stream.pipe(
      Stream.limitBytes<
        HttpClientError.HttpClientError | DesktopHttpClientError,
        never
      >(BigInt(maxBytes), () => Stream.fail(tooLarge())),
    );
  });

const responseMetadata = (
  response: HttpClientResponse,
  url: URL,
): Omit<DesktopHttpResponse, "body"> => ({
  headers:
    response instanceof NodeHttpIncomingMessage
      ? response.source.headers
      : response.headers,
  statusCode: response.status,
  statusMessage:
    response instanceof NodeHttpIncomingMessage
      ? (response.source.statusMessage ?? "")
      : "",
  url: url.href,
});

const readResponse = (
  response: HttpClientResponse,
  maxBytes: number | undefined,
  url: URL,
) =>
  boundedBody(response, maxBytes, url).pipe(
    Stream.runCollect,
    Effect.map(
      (chunks): DesktopHttpResponse => ({
        ...responseMetadata(response, url),
        body: Buffer.concat(chunks),
      }),
    ),
  );

const normalizeError = (cause: unknown, url: URL): DesktopHttpClientError => {
  if (cause instanceof DesktopHttpClientError) return cause;
  if (
    HttpClientError.isHttpClientError(cause) &&
    cause.reason.cause instanceof DesktopHttpClientError &&
    cause.reason.cause.kind === "timeout"
  )
    return cause.reason.cause;
  return clientError(
    "request-failed",
    cause instanceof Error && cause.message.trim() !== ""
      ? cause.message
      : "HTTP request failed.",
    url,
    cause,
  );
};

export const makeDesktopHttpClient = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;
  const fileSystem = yield* FileSystem;
  const downloadBody = (
    response: HttpClientResponse,
    input: DesktopHttpDownloadOptions,
    url: URL,
  ) =>
    Effect.suspend(() => {
      let created = false;
      return Effect.scoped(
        Effect.gen(function* () {
          const file = yield* fileSystem.open(input.targetPath, {
            flag: "wx",
            mode: 0o600,
          });
          created = true;
          yield* boundedBody(response, input.maxBytes, url).pipe(
            Stream.runForEach((chunk) =>
              file.writeAll(chunk).pipe(Effect.uninterruptible),
            ),
          );
          return { ...responseMetadata(response, url), body: Buffer.alloc(0) };
        }),
      ).pipe(
        Effect.onExit((exit) =>
          Exit.isFailure(exit) && created
            ? fileSystem
                .remove(input.targetPath, { force: true })
                .pipe(Effect.ignore, Effect.uninterruptible)
            : Effect.void,
        ),
      );
    });
  return DesktopHttpClient.of({
    request: (input) =>
      requestFollowingRedirects(
        client,
        {
          ...input,
          headers: input.headers ?? {},
          method: (input.method ?? "GET").toUpperCase(),
          maxRedirects: input.maxRedirects ?? 5,
          httpsOnly: false,
        },
        (response, url) => readResponse(response, input.maxBytes, url),
      ).pipe(Effect.mapError((cause) => normalizeError(cause, input.url))),
    get: (input) =>
      requestFollowingRedirects(
        client,
        {
          url: input.url,
          headers: input.headers ?? {},
          method: "GET",
          maxRedirects: input.maxRedirects ?? 0,
          httpsOnly: true,
          socketTimeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        },
        (response, url) => readResponse(response, input.maxBytes, url),
      ).pipe(Effect.mapError((cause) => normalizeError(cause, input.url))),
    download: (input) =>
      requestFollowingRedirects(
        client,
        {
          url: input.url,
          headers: input.headers ?? {},
          method: "GET",
          maxRedirects: input.maxRedirects ?? 0,
          httpsOnly: true,
          socketTimeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        },
        (response, url) =>
          response.status >= 200 && response.status < 300
            ? downloadBody(response, input, url)
            : readResponse(
                response,
                input.errorResponseMaxBytes ?? DEFAULT_ERROR_RESPONSE_MAX_BYTES,
                url,
              ),
      ).pipe(Effect.mapError((cause) => normalizeError(cause, input.url))),
  });
});

export const layer = Layer.effect(
  DesktopHttpClient,
  makeDesktopHttpClient,
).pipe(
  Layer.provideMerge(NodeHttpClient.layerNodeHttp),
  Layer.provide(NodeFileSystem.layer),
);
