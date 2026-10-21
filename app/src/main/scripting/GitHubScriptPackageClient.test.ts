import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";

import { GitHubApiClient, GitHubApiClientError } from "../http/GitHubApiClient";
import type { DesktopHttpResponse } from "../http/DesktopHttpClient";
import { GitHubCredentials } from "./GitHubCredentials";
import {
  GitHubScriptPackageClient,
  layer as gitHubScriptPackageClientLayer,
  normalizeGitHubRepositoryUrl,
} from "./GitHubScriptPackageClient";

const jsonResponse = (value: unknown): DesktopHttpResponse => ({
  body: Buffer.from(JSON.stringify(value)),
  headers: {},
  statusCode: 200,
  statusMessage: "OK",
  url: "https://api.github.com/test",
});

const makeClientHarness = (responses: readonly DesktopHttpResponse[]) => {
  const pending = [...responses];
  const requests: URL[] = [];
  const requestEtags: Array<string | undefined> = [];
  const api = GitHubApiClient.of({
    download: () => Effect.die("Unexpected download."),
    get: (options) =>
      Effect.gen(function* () {
        requests.push(options.url);
        requestEtags.push(options.etag);
        const response = pending.shift();
        if (response === undefined)
          throw new Error("Unexpected GitHub request.");
        if (
          options.maxBytes !== undefined &&
          response.body.byteLength > options.maxBytes
        ) {
          return yield* new GitHubApiClientError({
            kind: "response-too-large",
            detail: `HTTP response exceeds the ${options.maxBytes} byte limit.`,
          });
        }
        return response;
      }),
  });
  return { layer: makeClientLayer(api), requests, requestEtags };
};

const makeClientLayer = (api: GitHubApiClient["Service"]) => {
  const credentials = GitHubCredentials.of({
    delete: () => Effect.die("Unexpected credential deletion."),
    list: Effect.succeed([]),
    resolveToken: () => Effect.succeed(undefined),
    save: () => Effect.die("Unexpected credential save."),
  });
  const layer = gitHubScriptPackageClientLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(GitHubApiClient, api),
        Layer.succeed(GitHubCredentials, credentials),
      ),
    ),
  );
  return layer;
};

const makeControlledHarness = Effect.gen(function* () {
  const release = yield* Deferred.make<void>();
  const started = yield* Deferred.make<void>();
  const events: string[] = [];
  const request = (url: URL) =>
    Effect.gen(function* () {
      const ref = url.searchParams.get("ref") ?? url.pathname.split("/").at(-1);
      events.push(`start:${ref}`);
      yield* Deferred.succeed(started, undefined);
      return yield* Deferred.await(release).pipe(
        Effect.as(
          jsonResponse(
            url.pathname.endsWith("/contents")
              ? [{ name: "package", path: "package", sha: "tree", type: "dir" }]
              : { sha: "commit" },
          ),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            events.push(`stop:${ref}`);
          }),
        ),
      );
    });
  const layer = makeClientLayer(
    GitHubApiClient.of({
      get: ({ url }) => request(url),
      download: ({ url }) => request(url),
    }),
  );
  const client = yield* GitHubScriptPackageClient.pipe(Effect.provide(layer));
  return { client, release, started, events };
});

const repositoryUrl = "https://github.com/example/tools";

describe("GitHubScriptPackageClient", () => {
  it.effect.each([
    {
      name: "without an ETag",
      headers: {},
      expected: { commit: "new-commit" },
    },
    {
      name: "with a new ETag",
      headers: { etag: '"new-etag"' },
      expected: { commit: "new-commit", etag: '"new-etag"' },
    },
  ])("returns a modified commit $name", ({ headers, expected }) =>
    Effect.gen(function* () {
      const harness = makeClientHarness([
        { ...jsonResponse({ sha: "new-commit" }), headers },
      ]);
      const client = yield* GitHubScriptPackageClient.pipe(
        Effect.provide(harness.layer),
      );

      const result = yield* client.resolveCommit({
        repositoryUrl,
        known: { commit: "cached-commit", etag: '"cached-etag"' },
      });

      expect(result).toEqual(expected);
      expect(harness.requestEtags).toEqual(['"cached-etag"']);
    }),
  );

  it.effect.each([
    {
      name: "keeps the known ETag when none is returned",
      headers: {},
      expected: { commit: "cached-commit", etag: '"cached-etag"' },
    },
    {
      name: "uses a returned ETag",
      headers: { etag: '"new-etag"' },
      expected: { commit: "cached-commit", etag: '"new-etag"' },
    },
  ])("returns the known commit on 304 and $name", ({ headers, expected }) =>
    Effect.gen(function* () {
      const harness = makeClientHarness([
        {
          ...jsonResponse(null),
          body: Buffer.alloc(0),
          headers,
          statusCode: 304,
          statusMessage: "Not Modified",
        },
      ]);
      const client = yield* GitHubScriptPackageClient.pipe(
        Effect.provide(harness.layer),
      );

      const result = yield* client.resolveCommit({
        repositoryUrl,
        known: { commit: "cached-commit", etag: '"cached-etag"' },
      });

      expect(result).toEqual(expected);
      expect(harness.requestEtags).toEqual(['"cached-etag"']);
    }),
  );

  it.effect("rejects a 304 without a known commit", () =>
    Effect.gen(function* () {
      const harness = makeClientHarness([
        {
          ...jsonResponse(null),
          body: Buffer.alloc(0),
          statusCode: 304,
          statusMessage: "Not Modified",
        },
      ]);
      const client = yield* GitHubScriptPackageClient.pipe(
        Effect.provide(harness.layer),
      );

      const error = yield* client
        .resolveCommit({ repositoryUrl })
        .pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "GitHubScriptPackageClientError",
        kind: "unexpected-response",
        statusCode: 304,
      });
      expect(harness.requestEtags).toEqual([undefined]);
    }),
  );

  it.effect("rejects an oversized commit response", () =>
    Effect.gen(function* () {
      const harness = makeClientHarness([
        jsonResponse({ sha: "commit", padding: "x".repeat(16 * 1024 * 1024) }),
      ]);
      const client = yield* GitHubScriptPackageClient.pipe(
        Effect.provide(harness.layer),
      );

      const error = yield* client
        .resolveCommit({ repositoryUrl })
        .pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "GitHubScriptPackageClientError",
        kind: "response-too-large",
        detail: "HTTP response exceeds the 16777216 byte limit.",
      });
    }),
  );

  it("normalizes repository sources and throws for unsupported source URLs", () => {
    expect(
      normalizeGitHubRepositoryUrl("https://github.com/example/tools.git/"),
    ).toEqual({
      owner: "example",
      repository: "tools",
      url: "https://github.com/example/tools",
    });
    expect(() => normalizeGitHubRepositoryUrl("not-a-url")).toThrow();
    expect(() =>
      normalizeGitHubRepositoryUrl(
        "https://github.com/example/tools/tree/main",
      ),
    ).toThrow();
  });

  it.effect("interrupts running commit HTTP work", () =>
    Effect.gen(function* () {
      const { client, release, started, events } = yield* makeControlledHarness;
      const running = yield* client
        .resolveCommit({ repositoryUrl, ref: "running" })
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(started);
      yield* Fiber.interrupt(running);
      expect(events).toEqual(["start:running", "stop:running"]);
      yield* Deferred.succeed(release, undefined);
      expect(
        yield* client.resolveCommit({ repositoryUrl, ref: "next" }),
      ).toEqual({ commit: "commit" });
    }),
  );

  it.effect("interrupts running directory HTTP work", () =>
    Effect.gen(function* () {
      const { client, release, started, events } = yield* makeControlledHarness;
      const running = yield* client
        .resolveDirectory({
          repositoryUrl,
          ref: "running",
          subdirectory: "package",
        })
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(started);
      yield* Fiber.interrupt(running);
      expect(events).toEqual(["start:running", "stop:running"]);
      yield* Deferred.succeed(release, undefined);
      expect(
        yield* client.resolveDirectory({
          repositoryUrl,
          ref: "next",
          subdirectory: "package",
        }),
      ).toEqual({ tree: "tree" });
    }),
  );

  it.effect("stops an interrupted download before caller finalizers run", () =>
    Effect.gen(function* () {
      const { client, started, events } = yield* makeControlledHarness;
      const running = yield* client
        .downloadArchive({
          repositoryUrl,
          ref: "archive",
          targetPath: "/staging/archive",
        })
        .pipe(
          Effect.ensuring(
            Effect.sync(() => {
              events.push("cleanup:staging");
            }),
          ),
          Effect.forkChild({ startImmediately: true }),
        );
      yield* Deferred.await(started);
      yield* Fiber.interrupt(running);
      expect(events).toEqual([
        "start:archive",
        "stop:archive",
        "cleanup:staging",
      ]);
    }),
  );

  it.effect("waits for download shutdown before cleaning up staging", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const finishShutdown = yield* Deferred.make<void>();
      const events: string[] = [];
      const client = yield* GitHubScriptPackageClient.pipe(
        Effect.provide(
          makeClientLayer(
            GitHubApiClient.of({
              get: () => Effect.die("Unexpected metadata request."),
              download: () =>
                Deferred.succeed(started, undefined).pipe(
                  Effect.andThen(Effect.never),
                  Effect.ensuring(
                    Effect.gen(function* () {
                      events.push("download:stopping");
                      yield* Deferred.await(finishShutdown);
                      events.push("download:stopped");
                    }),
                  ),
                ),
            }),
          ),
        ),
      );
      const running = yield* client
        .downloadArchive({ repositoryUrl, targetPath: "/staging/archive" })
        .pipe(
          Effect.ensuring(
            Effect.sync(() => {
              events.push("staging:removed");
            }),
          ),
          Effect.forkChild({ startImmediately: true }),
        );
      yield* Deferred.await(started);
      const interrupting = yield* Fiber.interrupt(running).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      expect(events).toEqual(["download:stopping"]);
      yield* Deferred.succeed(finishShutdown, undefined);
      yield* Fiber.join(interrupting);
      expect(events).toEqual([
        "download:stopping",
        "download:stopped",
        "staging:removed",
      ]);
    }),
  );

  it.effect("resolves a package directory from the Contents API", () =>
    Effect.gen(function* () {
      const harness = makeClientHarness([
        jsonResponse([
          {
            name: "example",
            path: "packages/example",
            sha: "selected-tree",
            type: "dir",
          },
        ]),
      ]);
      const client = yield* GitHubScriptPackageClient.pipe(
        Effect.provide(harness.layer),
      );

      const result = yield* client.resolveDirectory({
        repositoryUrl: "https://github.com/example/monorepo",
        ref: "main",
        subdirectory: "packages/example",
      });

      expect(result).toEqual({ tree: "selected-tree" });
      expect(harness.requests.map(String)).toEqual([
        "https://api.github.com/repos/example/monorepo/contents/packages?ref=main",
      ]);
    }),
  );

  it.effect(
    "walks Git trees when a Contents listing reaches 1,000 entries",
    () =>
      Effect.gen(function* () {
        const listing = Array.from({ length: 1_000 }, (_, index) => ({
          name: `entry-${index}`,
          path: `packages/entry-${index}`,
          sha: `tree-${index}`,
          type: "dir",
        }));
        const harness = makeClientHarness([
          jsonResponse(listing),
          jsonResponse({
            sha: "root-tree",
            tree: [{ path: "packages", sha: "packages-tree", type: "tree" }],
            truncated: false,
          }),
          jsonResponse({
            sha: "packages-tree",
            tree: [{ path: "example", sha: "selected-tree", type: "tree" }],
            truncated: false,
          }),
        ]);
        const client = yield* GitHubScriptPackageClient.pipe(
          Effect.provide(harness.layer),
        );

        const result = yield* client.resolveDirectory({
          repositoryUrl: "https://github.com/example/monorepo",
          ref: "main",
          subdirectory: "packages/example",
        });

        expect(result).toEqual({ tree: "selected-tree" });
        expect(harness.requests.map(String)).toEqual([
          "https://api.github.com/repos/example/monorepo/contents/packages?ref=main",
          "https://api.github.com/repos/example/monorepo/git/trees/main",
          "https://api.github.com/repos/example/monorepo/git/trees/packages-tree",
        ]);
      }),
  );
});
