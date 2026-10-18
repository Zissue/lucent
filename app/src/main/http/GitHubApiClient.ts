import type { IncomingHttpHeaders } from "http";

import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

import { ElectronApp } from "../electron/ElectronApp";
import {
  DesktopHttpClient,
  DesktopHttpClientError,
  firstHttpHeader,
  type DesktopHttpClientShape,
  type DesktopHttpDownloadOptions,
  type DesktopHttpGetOptions,
  type DesktopHttpResponse,
} from "./DesktopHttpClient";

const API_VERSION = "2022-11-28";
const RETRY_BASE_DELAY = "200 millis";

export const GitHubApiErrorKind = Schema.Literals([
  "authentication",
  "invalid-request",
  "not-found",
  "permission",
  "rate-limited",
  "response-too-large",
  "unavailable",
  "unexpected-response",
]);

export class GitHubApiClientError extends Schema.TaggedError<GitHubApiClientError>()(
  "GitHubApiClientError",
  {
    kind: GitHubApiErrorKind,
    detail: Schema.String,
    retryAt: Schema.optionalKey(Schema.String),
    statusCode: Schema.optionalKey(Schema.Number),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

interface GitHubRequestOptions {
  readonly attempts?: number;
  readonly credentialId?: string;
  readonly etag?: string;
  readonly token?: string;
}

export interface GitHubApiGetOptions
  extends Omit<DesktopHttpGetOptions, "headers">, GitHubRequestOptions {}

export interface GitHubApiDownloadOptions
  extends Omit<DesktopHttpDownloadOptions, "headers">, GitHubRequestOptions {}

export interface GitHubApiClientShape {
  readonly download: (
    options: GitHubApiDownloadOptions,
  ) => Effect.Effect<DesktopHttpResponse, GitHubApiClientError>;
  readonly get: (
    options: GitHubApiGetOptions,
  ) => Effect.Effect<DesktopHttpResponse, GitHubApiClientError>;
}

export class GitHubApiClient extends Context.Service<
  GitHubApiClient,
  GitHubApiClientShape
>()("lucent/desktop/github/GitHubApiClient") {}

interface RateLimitState {
  readonly strikes: number;
  readonly until: number;
}

/** Resolves GitHub's supported rate-limit headers to an absolute timestamp. */
export const retryAtFromGitHubHeaders = (
  headers: IncomingHttpHeaders,
  now: number,
): number | undefined => {
  const retryAfter = firstHttpHeader(headers, "retry-after");
  if (retryAfter !== undefined) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return now + Math.max(0, seconds) * 1000;
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.max(now, date);
  }
  if (firstHttpHeader(headers, "x-ratelimit-remaining") === "0") {
    const resetSeconds = Number(firstHttpHeader(headers, "x-ratelimit-reset"));
    if (Number.isFinite(resetSeconds)) {
      return Math.max(now, resetSeconds * 1000);
    }
  }
  return undefined;
};

/** Distinguishes GitHub throttling responses from ordinary permission errors. */
export const isGitHubRateLimitResponse = (response: {
  readonly body: Buffer;
  readonly headers: IncomingHttpHeaders;
  readonly statusCode: number;
}): boolean => {
  if (response.statusCode === 429) return true;
  if (response.statusCode !== 403) return false;
  return (
    retryAtFromGitHubHeaders(response.headers, Date.now()) !== undefined ||
    /(?:secondary|rate) limit/i.test(response.body.toString("utf8").trim())
  );
};

const requestHeaders = (
  userAgent: string,
  options: GitHubRequestOptions,
): Record<string, string> => ({
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": API_VERSION,
  "User-Agent": userAgent,
  ...(options.token === undefined
    ? {}
    : { Authorization: `Bearer ${options.token}` }),
  ...(options.etag === undefined ? {} : { "If-None-Match": options.etag }),
});

const httpClientError = (cause: DesktopHttpClientError): GitHubApiClientError =>
  cause.kind === "response-too-large"
    ? new GitHubApiClientError({
        kind: "response-too-large",
        detail: cause.message,
        cause,
      })
    : new GitHubApiClientError({
        kind: "unavailable",
        detail: cause.message,
        cause,
      });

const rateLimitError = (
  rateLimit: RateLimitState,
  statusCode?: number,
): GitHubApiClientError => {
  const retryAt = new Date(rateLimit.until).toISOString();
  return new GitHubApiClientError({
    kind: "rate-limited",
    detail: `GitHub's request limit has been reached. Try again after ${retryAt}.`,
    retryAt,
    ...(statusCode === undefined ? {} : { statusCode }),
  });
};

const responseError = (
  response: DesktopHttpResponse,
  rateLimit: RateLimitState | undefined,
): GitHubApiClientError => {
  const statusCode = response.statusCode;
  if (rateLimit !== undefined) {
    return rateLimitError(rateLimit, statusCode);
  }
  if (statusCode === 401) {
    return new GitHubApiClientError({
      kind: "authentication",
      detail: "The GitHub credential is invalid, expired, or revoked.",
      statusCode,
    });
  }
  if (statusCode === 403) {
    return new GitHubApiClientError({
      kind: "permission",
      detail: "GitHub denied access to the requested resource.",
      statusCode,
    });
  }
  if (statusCode === 404) {
    return new GitHubApiClientError({
      kind: "not-found",
      detail: "GitHub couldn't find the requested resource.",
      statusCode,
    });
  }
  if (statusCode === 422) {
    return new GitHubApiClientError({
      kind: "invalid-request",
      detail: "GitHub rejected the request.",
      statusCode,
    });
  }
  if (statusCode >= 500) {
    return new GitHubApiClientError({
      kind: "unavailable",
      detail: `GitHub is unavailable (HTTP ${statusCode}).`,
      statusCode,
    });
  }
  return new GitHubApiClientError({
    kind: "unexpected-response",
    detail:
      `GitHub returned HTTP ${statusCode} ${response.statusMessage}.`.trim(),
    statusCode,
  });
};

const retrySchedule = (attempts: number) =>
  Schedule.max([
    Schedule.exponential(RETRY_BASE_DELAY).pipe(Schedule.jittered),
    Schedule.recurs(Math.max(0, attempts - 1)),
  ]);

const rateLimitKey = (credentialId: string | undefined): string =>
  `${credentialId ?? "public"}:core`;

export const makeGitHubApiClient = (
  http: Pick<DesktopHttpClientShape, "get" | "download">,
  userAgent: string,
): GitHubApiClientShape => {
  const rateLimits = new Map<string, RateLimitState>();

  const applyResponse = (
    key: string,
    observed: RateLimitState | undefined,
    response: DesktopHttpResponse,
    now: number,
  ): RateLimitState | undefined => {
    const current = rateLimits.get(key);
    if (!isGitHubRateLimitResponse(response)) {
      if (current === observed) rateLimits.delete(key);
      return undefined;
    }
    const superseded = current !== undefined && current !== observed;
    const strikes = superseded ? current.strikes : (current?.strikes ?? 0) + 1;
    const until =
      retryAtFromGitHubHeaders(response.headers, now) ??
      now + Math.min(15 * 60_000, 60_000 * 2 ** (strikes - 1));
    if (superseded && until <= current.until) return current;
    const state = { strikes, until };
    rateLimits.set(key, state);
    return state;
  };

  const execute = Effect.fn("GitHubApiClient.execute")(function* (
    credentialId: string | undefined,
    acceptNotModified: boolean,
    request: Effect.Effect<DesktopHttpResponse, DesktopHttpClientError>,
  ) {
    const key = rateLimitKey(credentialId);
    const requestStartedAt = yield* Clock.currentTimeMillis;
    const observed = rateLimits.get(key);
    if (observed !== undefined && observed.until > requestStartedAt) {
      return yield* rateLimitError(observed);
    }

    const response = yield* request.pipe(Effect.mapError(httpClientError));
    const responseReceivedAt = yield* Clock.currentTimeMillis;
    const recordedLimit = applyResponse(
      key,
      observed,
      response,
      responseReceivedAt,
    );
    if (
      (response.statusCode >= 200 && response.statusCode < 300) ||
      (acceptNotModified && response.statusCode === 304)
    ) {
      return response;
    }
    return yield* responseError(response, recordedLimit);
  });

  const withRetry = (
    options: GitHubRequestOptions,
    acceptNotModified: boolean,
    request: Effect.Effect<DesktopHttpResponse, DesktopHttpClientError>,
  ): Effect.Effect<DesktopHttpResponse, GitHubApiClientError> =>
    execute(options.credentialId, acceptNotModified, request).pipe(
      Effect.retry({
        schedule: retrySchedule(options.attempts ?? 1),
        while: (error) => error.kind === "unavailable",
      }),
    );

  const get: GitHubApiClientShape["get"] = (options) =>
    withRetry(
      options,
      true,
      http.get({
        headers: requestHeaders(userAgent, options),
        ...(options.maxBytes === undefined
          ? {}
          : { maxBytes: options.maxBytes }),
        ...(options.maxRedirects === undefined
          ? {}
          : { maxRedirects: options.maxRedirects }),
        ...(options.timeoutMs === undefined
          ? {}
          : { timeoutMs: options.timeoutMs }),
        url: options.url,
      }),
    );

  const download: GitHubApiClientShape["download"] = (options) =>
    withRetry(
      options,
      false,
      http.download({
        ...(options.errorResponseMaxBytes === undefined
          ? {}
          : { errorResponseMaxBytes: options.errorResponseMaxBytes }),
        headers: requestHeaders(userAgent, options),
        maxBytes: options.maxBytes,
        ...(options.maxRedirects === undefined
          ? {}
          : { maxRedirects: options.maxRedirects }),
        targetPath: options.targetPath,
        ...(options.timeoutMs === undefined
          ? {}
          : { timeoutMs: options.timeoutMs }),
        url: options.url,
      }),
    );

  return GitHubApiClient.of({ download, get });
};

export const layer = Layer.effect(
  GitHubApiClient,
  Effect.gen(function* () {
    const app = yield* ElectronApp;
    const http = yield* DesktopHttpClient;
    const version = yield* app.getVersion;
    return makeGitHubApiClient(http, `Lucent/${version}`);
  }),
);
