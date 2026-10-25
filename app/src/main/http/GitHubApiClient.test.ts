import { describe, expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Random from "effect/Random";
import * as Result from "effect/Result";
import { TestClock } from "effect/testing";

import {
  DesktopHttpClientError,
  type DesktopHttpClientShape,
  type DesktopHttpResponse,
} from "./DesktopHttpClient";
import {
  type GitHubApiClientError,
  isGitHubRateLimitResponse,
  makeGitHubApiClient,
  retryAtFromGitHubHeaders,
} from "./GitHubApiClient";

const API_URL = new URL("https://api.github.com/repos/example/tools");

const response = (options: {
  readonly body?: string;
  readonly headers?: Record<string, string>;
  readonly statusCode: number;
  readonly statusMessage?: string;
}): DesktopHttpResponse => ({
  body: Buffer.from(options.body ?? "", "utf8"),
  headers: options.headers ?? {},
  statusCode: options.statusCode,
  statusMessage: options.statusMessage ?? "",
  url: API_URL.href,
});

const secondaryLimit = (headers: Record<string, string> = {}) =>
  response({
    body: "You have exceeded a secondary rate limit.",
    headers,
    statusCode: 403,
  });

const cooldownMillis = (error: GitHubApiClientError, startedAt: number) =>
  Date.parse(error.retryAt ?? "") - startedAt;

const gatedResponse = Effect.gen(function* () {
  const started = yield* Deferred.make<void>();
  const response = yield* Deferred.make<DesktopHttpResponse>();
  return {
    request: Deferred.succeed(started, undefined).pipe(
      Effect.andThen(Deferred.await(response)),
    ),
    respond: (value: DesktopHttpResponse) => Deferred.succeed(response, value),
    started: Deferred.await(started),
  };
});

const makeHttpClient = (
  responses: (
    | DesktopHttpResponse
    | Effect.Effect<DesktopHttpResponse, DesktopHttpClientError>
  )[],
  requestCount: { value: number },
): Pick<DesktopHttpClientShape, "get" | "download"> => ({
  get: (options) =>
    Effect.gen(function* () {
      requestCount.value += 1;
      const next = responses.shift();
      if (next === undefined) {
        return yield* new DesktopHttpClientError({
          kind: "request-failed",
          detail: "No test response was queued.",
          url: options.url.href,
        });
      }
      return Effect.isEffect(next) ? yield* next : next;
    }),
  download: (options) =>
    Effect.fail(
      new DesktopHttpClientError({
        kind: "request-failed",
        detail: "Downloads are not used by this test client.",
        url: options.url.href,
      }),
    ),
});

describe("GitHubApiClient", () => {
  it.effect(
    "pins response retry timestamps and cooldown admission to the clock",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(1234567890000);
        const requestCount = { value: 0 };
        const client = makeGitHubApiClient(
          makeHttpClient(
            [
              response({ statusCode: 403, headers: { "retry-after": "30" } }),
              response({ statusCode: 200 }),
            ],
            requestCount,
          ),
          "Lucent/test",
        );
        const limited = yield* client.get({ url: API_URL }).pipe(Effect.flip);
        expect(limited).toMatchObject({
          kind: "rate-limited",
          retryAt: "2009-02-13T23:32:00.000Z",
        });
        yield* TestClock.adjust(29999);
        const blocked = yield* client.get({ url: API_URL }).pipe(Effect.flip);
        expect(blocked.retryAt).toBe("2009-02-13T23:32:00.000Z");
        expect(requestCount.value).toBe(1);
        yield* TestClock.adjust(1);
        expect((yield* client.get({ url: API_URL })).statusCode).toBe(200);
        expect(requestCount.value).toBe(2);
      }),
  );
  it("derives cooldowns from Retry-After and primary reset headers", () => {
    const now = Date.parse("2026-08-01T00:00:00.000Z");
    expect(retryAtFromGitHubHeaders({ "retry-after": "30" }, now)).toBe(
      now + 30_000,
    );
    expect(
      retryAtFromGitHubHeaders(
        {
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": String(now / 1000 + 45),
        },
        now,
      ),
    ).toBe(now + 45_000);
  });

  it("distinguishes rate limits from ordinary permission failures", () => {
    expect(
      isGitHubRateLimitResponse(
        {
          body: Buffer.from("secondary rate limit"),
          headers: {},
          statusCode: 403,
        },
        0,
      ),
    ).toBe(true);
    expect(
      isGitHubRateLimitResponse(
        {
          body: Buffer.from("organization policy denied access"),
          headers: {},
          statusCode: 403,
        },
        0,
      ),
    ).toBe(false);
    expect(
      isGitHubRateLimitResponse(
        {
          body: Buffer.alloc(0),
          headers: {},
          statusCode: 429,
        },
        0,
      ),
    ).toBe(true);
  });

  it.effect.each([200, 503])(
    "backs off and stops after three attempts when the final response is %i",
    (lastStatus) =>
      Effect.gen(function* () {
        const requestCount = { value: 0 };
        const client = makeGitHubApiClient(
          makeHttpClient(
            [
              response({ statusCode: 503 }),
              response({ statusCode: 502 }),
              response({ statusCode: lastStatus }),
            ],
            requestCount,
          ),
          "Lucent/test",
        );
        const fiber = yield* client
          .get({ attempts: 3, url: API_URL })
          .pipe(Effect.result, Effect.forkChild);
        yield* TestClock.adjust("199 millis");
        expect(requestCount.value).toBe(1);
        yield* TestClock.adjust("1 millis");
        expect(requestCount.value).toBe(2);
        yield* TestClock.adjust("399 millis");
        expect(requestCount.value).toBe(2);
        expect(fiber.pollUnsafe()).toBeUndefined();
        yield* TestClock.adjust("1 millis");
        const result = yield* Fiber.join(fiber);
        if (lastStatus === 200) {
          expect(Result.isSuccess(result)).toBe(true);
          if (Result.isSuccess(result))
            expect(result.success.statusCode).toBe(200);
        } else {
          expect(Result.isFailure(result)).toBe(true);
          if (Result.isFailure(result))
            expect(result.failure).toMatchObject({
              kind: "unavailable",
              statusCode: 503,
            });
        }
        yield* TestClock.adjust("10 seconds");
        expect(requestCount.value).toBe(3);
      }).pipe(
        Effect.provideService(Random.Random, {
          nextDoubleUnsafe: () => 0.5,
          nextIntUnsafe: () => 0,
        }),
      ),
  );

  it.effect("fails permission errors without retrying", () =>
    Effect.gen(function* () {
      const requestCount = { value: 0 };
      const client = makeGitHubApiClient(
        makeHttpClient(
          [response({ body: "organization policy denied", statusCode: 403 })],
          requestCount,
        ),
        "Lucent/test",
      );

      const error = yield* client
        .get({ attempts: 3, url: API_URL })
        .pipe(Effect.flip);

      expect(error.kind).toBe("permission");
      expect(requestCount.value).toBe(1);
    }),
  );

  it.effect("does not accept not-modified archive responses", () =>
    Effect.gen(function* () {
      const requestCount = { value: 0 };
      const base = makeHttpClient([], requestCount);
      const client = makeGitHubApiClient(
        {
          ...base,
          download: () => Effect.succeed(response({ statusCode: 304 })),
        },
        "Lucent/test",
      );

      const error = yield* client
        .download({
          attempts: 1,
          maxBytes: 1024,
          targetPath: "/tmp/lucent-unused-test-archive",
          url: API_URL,
        })
        .pipe(Effect.flip);

      expect(error.kind).toBe("unexpected-response");
      expect(error.statusCode).toBe(304);
    }),
  );

  it.effect("shares public rate-limit cooldowns across requests", () =>
    Effect.gen(function* () {
      const requestCount = { value: 0 };
      const client = makeGitHubApiClient(
        makeHttpClient(
          [response({ headers: { "retry-after": "30" }, statusCode: 429 })],
          requestCount,
        ),
        "Lucent/test",
      );

      const first = yield* client
        .get({ attempts: 3, url: API_URL })
        .pipe(Effect.flip);
      const second = yield* client
        .get({ attempts: 3, url: API_URL })
        .pipe(Effect.flip);

      expect(first.kind).toBe("rate-limited");
      expect(second.kind).toBe("rate-limited");
      expect(second.retryAt).toBe(first.retryAt);
      expect(requestCount.value).toBe(1);
    }),
  );

  it.effect(
    "resets cooldown escalation after a response that is not rate limited",
    () =>
      Effect.gen(function* () {
        const requestCount = { value: 0 };
        const client = makeGitHubApiClient(
          makeHttpClient(
            [secondaryLimit(), response({ statusCode: 200 }), secondaryLimit()],
            requestCount,
          ),
          "Lucent/test",
        );

        const first = yield* client.get({ url: API_URL }).pipe(Effect.flip);
        expect(first.kind).toBe("rate-limited");
        yield* TestClock.adjust("60 seconds");
        const success = yield* client.get({ url: API_URL });
        expect(success.statusCode).toBe(200);

        const startedAt = yield* Clock.currentTimeMillis;
        const second = yield* client.get({ url: API_URL }).pipe(Effect.flip);
        expect(cooldownMillis(second, startedAt)).toBe(60_000);
        expect(requestCount.value).toBe(3);
      }),
  );

  it.effect(
    "does not reset escalation when a request admitted before the limit succeeds later",
    () =>
      Effect.gen(function* () {
        const requestCount = { value: 0 };
        const stale = yield* gatedResponse;
        const client = makeGitHubApiClient(
          makeHttpClient(
            [stale.request, secondaryLimit(), secondaryLimit()],
            requestCount,
          ),
          "Lucent/test",
        );

        const first = yield* client
          .get({ url: API_URL })
          .pipe(Effect.forkChild);
        yield* stale.started;
        const secondStartedAt = yield* Clock.currentTimeMillis;
        const second = yield* client.get({ url: API_URL }).pipe(Effect.flip);
        expect(cooldownMillis(second, secondStartedAt)).toBe(60_000);

        yield* TestClock.adjust("60 seconds");
        yield* stale.respond(response({ statusCode: 200 }));
        const success = yield* Fiber.join(first);
        expect(success.statusCode).toBe(200);

        const thirdStartedAt = yield* Clock.currentTimeMillis;
        const third = yield* client.get({ url: API_URL }).pipe(Effect.flip);
        expect(cooldownMillis(third, thirdStartedAt)).toBe(120_000);
        expect(requestCount.value).toBe(3);
      }),
  );

  it.effect.each([
    {
      label: "no retry-after",
      firstHeaders: {},
      secondHeaders: {},
      gap: 0,
      firstCooldown: 120_000,
      secondCooldown: 120_000,
    },
    {
      label: "an earlier retry-after",
      firstHeaders: {},
      secondHeaders: { "retry-after": "1" },
      gap: 0,
      firstCooldown: 120_000,
      secondCooldown: 120_000,
    },
    {
      label: "a later retry-after",
      firstHeaders: {},
      secondHeaders: { "retry-after": "600" },
      gap: 0,
      firstCooldown: 120_000,
      secondCooldown: 600_000,
    },
    {
      label: "no retry-after after the first cooldown expired",
      firstHeaders: { "retry-after": "1" },
      secondHeaders: {},
      gap: 2_000,
      firstCooldown: 1_000,
      secondCooldown: 122_000,
    },
  ])(
    "counts concurrent secondary limits once when the later one has $label",
    ({ firstCooldown, firstHeaders, gap, secondCooldown, secondHeaders }) =>
      Effect.gen(function* () {
        const requestCount = { value: 0 };
        const firstGate = yield* gatedResponse;
        const secondGate = yield* gatedResponse;
        const client = makeGitHubApiClient(
          makeHttpClient(
            [
              secondaryLimit(),
              firstGate.request,
              secondGate.request,
              secondaryLimit(),
            ],
            requestCount,
          ),
          "Lucent/test",
        );

        yield* client.get({ url: API_URL }).pipe(Effect.flip);
        yield* TestClock.adjust("60 seconds");
        const admittedAt = yield* Clock.currentTimeMillis;
        const first = yield* client
          .get({ url: API_URL })
          .pipe(Effect.flip, Effect.forkChild);
        yield* firstGate.started;
        const second = yield* client
          .get({ url: API_URL })
          .pipe(Effect.flip, Effect.forkChild);
        yield* secondGate.started;

        yield* firstGate.respond(secondaryLimit(firstHeaders));
        const firstError = yield* Fiber.join(first);
        yield* TestClock.adjust(gap);
        yield* secondGate.respond(secondaryLimit(secondHeaders));
        const secondError = yield* Fiber.join(second);
        expect(cooldownMillis(firstError, admittedAt)).toBe(firstCooldown);
        expect(cooldownMillis(secondError, admittedAt)).toBe(secondCooldown);
        expect(requestCount.value).toBe(3);

        yield* TestClock.adjust(secondCooldown - gap);
        const nextStartedAt = yield* Clock.currentTimeMillis;
        const next = yield* client.get({ url: API_URL }).pipe(Effect.flip);
        expect(cooldownMillis(next, nextStartedAt)).toBe(240_000);
        expect(requestCount.value).toBe(4);
      }),
  );

  it.effect(
    "keeps strikes when a concurrent success lands with a zero retry-after limit",
    () =>
      Effect.gen(function* () {
        const requestCount = { value: 0 };
        const stale = yield* gatedResponse;
        const client = makeGitHubApiClient(
          makeHttpClient(
            [
              stale.request,
              secondaryLimit({ "retry-after": "0" }),
              secondaryLimit(),
            ],
            requestCount,
          ),
          "Lucent/test",
        );

        const first = yield* client
          .get({ url: API_URL })
          .pipe(Effect.forkChild);
        yield* stale.started;
        yield* client.get({ url: API_URL }).pipe(Effect.flip);
        yield* stale.respond(response({ statusCode: 200 }));
        yield* Fiber.join(first);

        const startedAt = yield* Clock.currentTimeMillis;
        const next = yield* client.get({ url: API_URL }).pipe(Effect.flip);
        expect(cooldownMillis(next, startedAt)).toBe(120_000);
        expect(requestCount.value).toBe(3);
      }),
  );

  it.effect("keeps cooldown escalation after a transport failure", () =>
    Effect.gen(function* () {
      const requestCount = { value: 0 };
      const client = makeGitHubApiClient(
        makeHttpClient(
          [
            secondaryLimit(),
            Effect.fail(
              new DesktopHttpClientError({
                kind: "request-failed",
                detail: "offline",
                url: API_URL.href,
              }),
            ),
            secondaryLimit(),
          ],
          requestCount,
        ),
        "Lucent/test",
      );

      const first = yield* client.get({ url: API_URL }).pipe(Effect.flip);
      expect(first.kind).toBe("rate-limited");
      yield* TestClock.adjust("60 seconds");
      const unavailable = yield* client.get({ url: API_URL }).pipe(Effect.flip);
      expect(unavailable.kind).toBe("unavailable");

      const startedAt = yield* Clock.currentTimeMillis;
      const next = yield* client.get({ url: API_URL }).pipe(Effect.flip);
      expect(cooldownMillis(next, startedAt)).toBe(120_000);
      expect(requestCount.value).toBe(3);
    }),
  );

  it.effect(
    "escalates cooldowns across consecutive secondary rate limits",
    () =>
      Effect.gen(function* () {
        const requestCount = { value: 0 };
        const client = makeGitHubApiClient(
          makeHttpClient(
            Array.from({ length: 6 }, () => secondaryLimit()),
            requestCount,
          ),
          "Lucent/test",
        );

        const cooldownSeconds: number[] = [];
        for (let attempt = 0; attempt < 6; attempt += 1) {
          const startedAt = yield* Clock.currentTimeMillis;
          const error = yield* client.get({ url: API_URL }).pipe(Effect.flip);
          const cooldown = cooldownMillis(error, startedAt);
          cooldownSeconds.push(cooldown / 1000);
          yield* TestClock.adjust(cooldown);
        }

        expect(cooldownSeconds).toEqual([60, 120, 240, 480, 900, 900]);
        expect(requestCount.value).toBe(6);
      }),
  );
});
