import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";

import {
  GitHubApiClient,
  GitHubApiClientError,
} from "../github/GitHubApiClient";
import type { DesktopHttpResponse } from "../http/DesktopHttpClient";
import { GitHubCredentials } from "./GitHubCredentials";
import {
  GitHubRequestQueue,
  GitHubScriptPackageClient,
  GitHubScriptPackageClientError,
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
  const api = GitHubApiClient.of({
    download: () => Effect.die("Unexpected download."),
    get: (options) =>
      Effect.gen(function* () {
        requests.push(options.url);
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
  return { layer: makeClientLayer(api), requests };
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

  it.effect(
    "preserves queued admission order when a finishing caller submits again",
    () =>
      Effect.gen(function* () {
        const queue = new GitHubRequestQueue(2);
        const release = yield* Deferred.make<void>();
        const order: string[] = [];
        const first = yield* queue.enqueue(Deferred.await(release)).pipe(
          Effect.andThen(
            queue.enqueue(
              Effect.sync(() => {
                order.push("new");
              }),
            ),
          ),
          Effect.forkChild({ startImmediately: true }),
        );
        const waiting = yield* queue
          .enqueue(
            Effect.sync(() => {
              order.push("waiting");
            }),
          )
          .pipe(Effect.forkChild({ startImmediately: true }));
        const error = yield* queue.enqueue(Effect.void).pipe(Effect.flip);
        expect(error).toBeInstanceOf(Error);
        expect(error.message).toBe("GitHub request queue is full.");
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(first);
        yield* Fiber.join(waiting);
        expect(order).toEqual(["waiting", "new"]);
      }),
  );

  it.effect("admits 32 requests and rejects the 33rd immediately", () =>
    Effect.gen(function* () {
      const { client, release, started, events } = yield* makeControlledHarness;
      const requests = [];
      for (let index = 0; index < 32; index += 1) {
        requests.push(
          yield* client
            .downloadArchive({
              repositoryUrl,
              ref: String(index),
              targetPath: "/staging/archive",
            })
            .pipe(Effect.forkChild({ startImmediately: true })),
        );
      }
      yield* Deferred.await(started);
      const error = yield* client
        .downloadArchive({
          repositoryUrl,
          ref: "overflow",
          targetPath: "/staging/archive",
        })
        .pipe(Effect.flip);
      expect(error).toBeInstanceOf(GitHubScriptPackageClientError);
      expect({ kind: error.kind, message: error.message }).toEqual({
        kind: "unavailable",
        message: "GitHub request queue is full.",
      });
      expect(events).toEqual(["start:0"]);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.joinAll(requests);
      expect(events.filter((event) => event.startsWith("start:"))).toHaveLength(
        32,
      );
    }),
  );

  it.effect("runs mixed requests one at a time in FIFO admission order", () =>
    Effect.gen(function* () {
      const { client, release, started, events } = yield* makeControlledHarness;
      const first = yield* client
        .resolveCommit({ repositoryUrl, ref: "first" })
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(started);
      const second = yield* client
        .downloadArchive({
          repositoryUrl,
          ref: "second",
          targetPath: "/staging/archive",
        })
        .pipe(Effect.forkChild({ startImmediately: true }));
      const third = yield* client
        .resolveDirectory({
          repositoryUrl,
          ref: "third",
          subdirectory: "package",
        })
        .pipe(Effect.forkChild({ startImmediately: true }));
      expect(events).toEqual(["start:first"]);
      yield* Deferred.succeed(release, undefined);
      expect(yield* Fiber.join(first)).toEqual({
        status: "modified",
        commit: "commit",
      });
      yield* Fiber.join(second);
      expect(yield* Fiber.join(third)).toEqual({ tree: "tree" });
      expect(events).toEqual([
        "start:first",
        "stop:first",
        "start:second",
        "stop:second",
        "start:third",
        "stop:third",
      ]);
    }),
  );

  it.effect("removes an interrupted queued request before it starts", () =>
    Effect.gen(function* () {
      const { client, release, started, events } = yield* makeControlledHarness;
      const first = yield* client
        .downloadArchive({
          repositoryUrl,
          ref: "first",
          targetPath: "/staging/first",
        })
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(started);
      const cancelled = yield* client
        .downloadArchive({
          repositoryUrl,
          ref: "cancelled",
          targetPath: "/staging/cancelled",
        })
        .pipe(Effect.forkChild({ startImmediately: true }));
      const last = yield* client
        .resolveDirectory({
          repositoryUrl,
          ref: "last",
          subdirectory: "package",
        })
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Fiber.interrupt(cancelled);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(first);
      expect(yield* Fiber.join(last)).toEqual({ tree: "tree" });
      expect(events).toEqual([
        "start:first",
        "stop:first",
        "start:last",
        "stop:last",
      ]);
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

  it.effect(
    "keeps shared metadata running for remaining waiters and deletes it on success",
    () =>
      Effect.gen(function* () {
        const { client, release, started, events } =
          yield* makeControlledHarness;
        const input = { repositoryUrl, ref: "shared" };
        const first = yield* client
          .resolveCommit(input)
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(started);
        const second = yield* client
          .resolveCommit(input)
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Fiber.interrupt(first);
        expect(events).toEqual(["start:shared"]);
        yield* Deferred.succeed(release, undefined);
        expect(yield* Fiber.join(second)).toEqual({
          status: "modified",
          commit: "commit",
        });
        expect(events).toEqual(["start:shared", "stop:shared"]);
        expect(yield* client.resolveCommit(input)).toEqual({
          status: "modified",
          commit: "commit",
        });
        expect(events).toEqual([
          "start:shared",
          "stop:shared",
          "start:shared",
          "stop:shared",
        ]);
      }),
  );

  it.effect(
    "cancels shared metadata when every waiter leaves and allows a fresh lookup",
    () =>
      Effect.gen(function* () {
        const { client, release, started, events } =
          yield* makeControlledHarness;
        const input = { repositoryUrl, ref: "shared" };
        const first = yield* client
          .resolveCommit(input)
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(started);
        const second = yield* client
          .resolveCommit(input)
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Fiber.interrupt(first);
        expect(events).toEqual(["start:shared"]);
        yield* Fiber.interrupt(second);
        expect(events).toEqual(["start:shared", "stop:shared"]);
        yield* Deferred.succeed(release, undefined);
        expect(yield* client.resolveCommit(input)).toEqual({
          status: "modified",
          commit: "commit",
        });
        expect(events).toEqual([
          "start:shared",
          "stop:shared",
          "start:shared",
          "stop:shared",
        ]);
      }),
  );

  it.effect(
    "releases admission capacity when a queued caller is interrupted",
    () =>
      Effect.gen(function* () {
        const { client, release, started, events } =
          yield* makeControlledHarness;
        const requests = [];
        for (let index = 0; index < 32; index += 1) {
          requests.push(
            yield* client
              .downloadArchive({
                repositoryUrl,
                ref: String(index),
                targetPath: "/staging/archive",
              })
              .pipe(Effect.forkChild({ startImmediately: true })),
          );
        }
        yield* Deferred.await(started);
        const cancelled = requests[1];
        if (cancelled === undefined)
          return yield* Effect.die("Missing queued request.");
        yield* Fiber.interrupt(cancelled);
        const replacement = yield* client
          .downloadArchive({
            repositoryUrl,
            ref: "replacement",
            targetPath: "/staging/archive",
          })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.succeed(release, undefined);
        for (const [index, request] of requests.entries()) {
          if (index !== 1) yield* Fiber.join(request);
        }
        yield* Fiber.join(replacement);
        expect(events.slice(0, 4)).toEqual([
          "start:0",
          "stop:0",
          "start:2",
          "stop:2",
        ]);
        expect(events.slice(-2)).toEqual([
          "start:replacement",
          "stop:replacement",
        ]);
        expect(events).toHaveLength(64);
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

  it.effect(
    "keeps replacement metadata shared while an abandoned lookup shuts down",
    () =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const replacementStarted = yield* Deferred.make<void>();
        const finishShutdown = yield* Deferred.make<void>();
        const finishReplacement = yield* Deferred.make<void>();
        const events: string[] = [];
        let attempts = 0;
        const client = yield* GitHubScriptPackageClient.pipe(
          Effect.provide(
            makeClientLayer(
              GitHubApiClient.of({
                download: () => Effect.die("Unexpected download."),
                get: () =>
                  Effect.gen(function* () {
                    attempts += 1;
                    events.push(`start:${attempts}`);
                    if (attempts === 1) {
                      yield* Deferred.succeed(started, undefined);
                      return yield* Effect.never.pipe(
                        Effect.ensuring(
                          Effect.gen(function* () {
                            events.push("stopping:1");
                            yield* Deferred.await(finishShutdown);
                            events.push("stop:1");
                          }),
                        ),
                      );
                    }
                    yield* Deferred.succeed(replacementStarted, undefined);
                    yield* Deferred.await(finishReplacement);
                    return jsonResponse({ sha: "replacement" });
                  }),
              }),
            ),
          ),
        );
        const input = { repositoryUrl };
        const first = yield* client
          .resolveCommit(input)
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(started);
        const interrupting = yield* Fiber.interrupt(first).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        expect(events).toEqual(["start:1", "stopping:1"]);
        const replacement = yield* client
          .resolveCommit(input)
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.succeed(finishShutdown, undefined);
        yield* Fiber.join(interrupting);
        yield* Deferred.await(replacementStarted);
        const sharing = yield* client
          .resolveCommit(input)
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.succeed(finishReplacement, undefined);
        expect(yield* Fiber.join(replacement)).toEqual({
          status: "modified",
          commit: "replacement",
        });
        expect(yield* Fiber.join(sharing)).toEqual({
          status: "modified",
          commit: "replacement",
        });
        expect(events).toEqual(["start:1", "stopping:1", "stop:1", "start:2"]);
      }),
  );

  it.effect("removes queued shared metadata after its last waiter leaves", () =>
    Effect.gen(function* () {
      const { client, release, started, events } = yield* makeControlledHarness;
      const blocker = yield* client
        .downloadArchive({
          repositoryUrl,
          ref: "blocker",
          targetPath: "/staging/archive",
        })
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(started);
      const first = yield* client
        .resolveCommit({ repositoryUrl, ref: "abandoned" })
        .pipe(Effect.forkChild({ startImmediately: true }));
      const second = yield* client
        .resolveCommit({ repositoryUrl, ref: "abandoned" })
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Fiber.interrupt(first);
      yield* Fiber.interrupt(second);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(blocker);
      expect(
        yield* client.resolveCommit({ repositoryUrl, ref: "fresh" }),
      ).toEqual({ status: "modified", commit: "commit" });
      expect(events).toEqual([
        "start:blocker",
        "stop:blocker",
        "start:fresh",
        "stop:fresh",
      ]);
    }),
  );

  it.effect(
    "deletes failed metadata lookups before the next caller retries",
    () =>
      Effect.gen(function* () {
        const harness = makeClientHarness([
          jsonResponse({ sha: "" }),
          jsonResponse({ sha: "recovered" }),
        ]);
        const client = yield* GitHubScriptPackageClient.pipe(
          Effect.provide(harness.layer),
        );
        const error = yield* client
          .resolveCommit({ repositoryUrl })
          .pipe(Effect.flip);
        expect(error._tag).toBe("GitHubScriptPackageClientError");
        expect(yield* client.resolveCommit({ repositoryUrl })).toEqual({
          status: "modified",
          commit: "recovered",
        });
        expect(harness.requests.map(String)).toEqual([
          "https://api.github.com/repos/example/tools/commits/HEAD",
          "https://api.github.com/repos/example/tools/commits/HEAD",
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
