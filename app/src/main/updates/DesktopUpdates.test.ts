import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { afterEach, describe, expect, it } from "@effect/vitest";
// Vitest requires a direct import for hoisted mocks.
import { vi } from "vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import { TestClock } from "effect/testing";

import { DEFAULT_APP_SETTINGS, type AppSettings } from "@lucent/core/settings";
import { makeLifetime } from "../window/RendererLifetimeTesting";
import { DesktopEnvironment } from "../app/DesktopEnvironment";
import { layer as desktopFileSystemLayer } from "@effect/platform-node/NodeFileSystem";
import { ElectronApp } from "../electron/ElectronApp";
import { ElectronShell } from "../electron/ElectronShell";
import { GitHubApiClient, makeGitHubApiClient } from "../http/GitHubApiClient";
import {
  DesktopHttpClient,
  DesktopHttpClientError,
  type DesktopHttpClientShape,
  type DesktopHttpGetOptions,
  type DesktopHttpResponse,
} from "../http/DesktopHttpClient";
import { createDesktopIpcInvokeHandler } from "../ipc/DesktopIpcInvoke";
import type { DesktopIpcSender } from "../ipc/DesktopIpcSenders";
import * as UpdatesIpcMethods from "../ipc/methods/updates";
import { DesktopSettings } from "../settings/DesktopSettings";
import { DesktopUpdates, layer as desktopUpdatesLayer } from "./DesktopUpdates";

vi.mock("electron", () => ({
  app: {},
  ipcMain: {},
  shell: {
    openExternal: vi.fn(),
  },
}));

const httpRequests: DesktopHttpGetOptions[] = [];
const httpResponses: DesktopHttpResponse[] = [];

const httpClient = DesktopHttpClient.of({
  request: () => Effect.die("Unexpected generic HTTP request"),
  get: (options) =>
    Effect.gen(function* () {
      httpRequests.push(options);
      const response = httpResponses.shift();
      if (response === undefined) {
        return yield* new DesktopHttpClientError({
          kind: "request-failed",
          detail: "No test HTTP response was queued.",
          url: options.url.href,
        });
      }
      if (
        options.maxBytes !== undefined &&
        response.body.byteLength > options.maxBytes
      ) {
        return yield* new DesktopHttpClientError({
          kind: "response-too-large",
          detail: `HTTP response exceeds the ${options.maxBytes} byte limit.`,
          url: options.url.href,
        });
      }
      return response;
    }),
  download: (options) =>
    Effect.fail(
      new DesktopHttpClientError({
        kind: "request-failed",
        detail: "The update checker must not download files.",
        url: options.url.href,
      }),
    ),
});

const mockGitHubResponse = (options: {
  readonly body?: string;
  readonly headers?: Record<string, string>;
  readonly statusCode?: number;
  readonly statusMessage?: string;
}): void => {
  httpResponses.push({
    body: Buffer.from(options.body ?? "", "utf8"),
    headers: options.headers ?? {},
    statusCode: options.statusCode ?? 200,
    statusMessage: options.statusMessage ?? "OK",
    url: "https://api.github.com/repos/toommyliu/lucent/releases/latest",
  });
};

const mockGitHubReleasePage = (
  tags: ReadonlyArray<string>,
  headers: Record<string, string> = {},
): void =>
  mockGitHubResponse({
    body: JSON.stringify(
      tags.map((tag) => ({
        draft: false,
        html_url: `https://github.com/toommyliu/lucent/releases/tag/${tag}`,
        prerelease: tag.includes("-"),
        tag_name: tag,
      })),
    ),
    headers,
  });

const testSettings = (checkForUpdates: boolean): AppSettings => ({
  ...DEFAULT_APP_SETTINGS,
  preferences: {
    ...DEFAULT_APP_SETTINGS.preferences,
    checkForUpdates,
  },
});

const tempDirs = new Set<string>();

const makeTempDir = async (prefix: string): Promise<string> => {
  const path = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.add(path);
  return path;
};

const makeUpdatesHarness = (options: {
  readonly cache?: unknown;
  readonly checkForUpdates: boolean;
  readonly currentVersion: string;
  readonly httpClient?: DesktopHttpClientShape;
}) =>
  Effect.gen(function* () {
    const appDataDir = yield* Effect.promise(() =>
      makeTempDir("lucent-updates-data-"),
    );
    const workspaceDir = yield* Effect.promise(() =>
      makeTempDir("lucent-updates-workspace-"),
    );
    const env = DesktopEnvironment.of({
      appDataDir,
      assetsDir: join(appDataDir, "assets"),
      isDev: true,
      platform: "darwin",
      workspaceDir,
    });
    if (options.cache !== undefined) {
      yield* Effect.promise(() =>
        writeFile(
          join(env.appDataDir, "release-cache.json"),
          JSON.stringify(options.cache),
          "utf8",
        ),
      );
    }

    const settings = testSettings(options.checkForUpdates);
    const settingsService = DesktopSettings.of({
      get: Effect.succeed(settings),
      load: Effect.succeed(settings),
      onChanged: () => Effect.succeed(() => undefined),
      resetAppearance: Effect.succeed(settings),
      resetHotkeys: Effect.succeed(settings),
      updateAppearance: () => Effect.succeed(settings),
      updateHotkeys: () => Effect.succeed(settings),
      updatePreferences: () => Effect.succeed(settings),
    });
    const app = ElectronApp.of({
      exit: () => Effect.void,
      getAppMetrics: Effect.succeed([]),
      getVersion: Effect.succeed(options.currentVersion),
      on: () => Effect.succeed(() => undefined),
      relaunch: Effect.void,
      quit: Effect.void,
      whenReady: Effect.void,
    });
    const shell = ElectronShell.of({
      openExternal: () => Effect.succeed(true),
      openPath: () => Effect.succeed(true),
      showItemInFolder: () => Effect.void,
    });
    const layer = desktopUpdatesLayer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(DesktopEnvironment, env),
          desktopFileSystemLayer,
          Layer.succeed(ElectronApp, app),
          Layer.succeed(ElectronShell, shell),
          Layer.succeed(
            GitHubApiClient,
            makeGitHubApiClient(
              options.httpClient ?? httpClient,
              `Lucent/${options.currentVersion}`,
            ),
          ),
          Layer.succeed(DesktopSettings, settingsService),
        ),
      ),
    );

    return { env, layer };
  });

const makeHangingCheckHarness = Effect.gen(function* () {
  const started = yield* Deferred.make<void>();
  const events: string[] = [];
  const { layer } = yield* makeUpdatesHarness({
    checkForUpdates: true,
    currentVersion: "1.0.0",
    httpClient: {
      ...httpClient,
      get: () =>
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.onInterrupt(() =>
            Effect.sync(() => {
              events.push("check-interrupted");
            }),
          ),
        ),
    },
  });
  return { events, layer, started };
});

afterEach(async () => {
  vi.clearAllMocks();
  httpRequests.length = 0;
  httpResponses.length = 0;
  await Promise.all(
    [...tempDirs].map((path) => rm(path, { force: true, recursive: true })),
  );
  tempDirs.clear();
});

describe("DesktopUpdates", () => {
  it.effect.each(["1.0.0", "1.0.0-beta.1"])(
    "rejects an oversized release response for %s",
    (currentVersion) =>
      Effect.gen(function* () {
        const release = {
          body: "x".repeat(16 * 1024 * 1024),
          draft: false,
          html_url: "https://github.com/toommyliu/lucent/releases/tag/v1.1.0",
          prerelease: false,
          tag_name: "v1.1.0",
        };
        mockGitHubResponse({
          body: JSON.stringify(
            currentVersion.includes("-") ? [release] : release,
          ),
        });
        const { layer } = yield* makeUpdatesHarness({
          checkForUpdates: true,
          currentVersion,
        });
        const updates = yield* DesktopUpdates.pipe(Effect.provide(layer));

        const state = yield* updates.checkNow();

        expect(state.status).toBe("error");
        expect(state).toMatchObject({
          status: "error",
          currentVersion,
          message: "HTTP response exceeds the 16777216 byte limit.",
        });
      }),
  );

  it.effect(
    "answers an IPC check without an error when shutdown cancels it",
    () =>
      Effect.gen(function* () {
        const { layer, started } = yield* makeHangingCheckHarness;
        const errors: string[] = [];
        const sender: DesktopIpcSender = {
          rendererId: 1,
          kind: "settings",
          lifetime: makeLifetime(1),
        };

        const { pending, state } = yield* Effect.gen(function* () {
          const context = yield* Effect.context<DesktopUpdates>();
          const invoke = createDesktopIpcInvokeHandler(
            UpdatesIpcMethods.checkNow.descriptor,
            (payload) => UpdatesIpcMethods.checkNow.handler(payload, sender),
            Effect.runPromiseWith(context),
          );
          const pending = invoke(undefined, { force: true });
          yield* Deferred.await(started);
          const state = yield* (yield* DesktopUpdates).getState;
          return { pending, state };
        }).pipe(
          Effect.provide(
            Layer.merge(
              layer,
              Logger.layer([
                Logger.make((log) => {
                  if (log.logLevel === "Error") {
                    errors.push(String(log.message));
                  }
                }),
              ]),
            ),
          ),
        );
        const envelope = yield* Effect.promise(() => pending);

        expect({ envelope, errors }).toEqual({
          envelope: { ok: true, value: state },
          errors: [],
        });
      }),
  );

  it.effect("keeps a shared check running when one caller is interrupted", () =>
    Effect.gen(function* () {
      const { events, layer, started } = yield* makeHangingCheckHarness;

      const firstExit = yield* Effect.gen(function* () {
        const updates = yield* DesktopUpdates;
        const first = yield* updates.checkNow().pipe(Effect.forkChild);
        yield* Deferred.await(started);
        yield* Fiber.interrupt(first);
        const exit = yield* Fiber.await(first);
        events.push("first-caller-done");
        return exit;
      }).pipe(Effect.provide(layer));

      expect({
        firstInterrupted: Exit.hasInterrupts(firstExit),
        events,
      }).toEqual({
        firstInterrupted: true,
        events: ["first-caller-done", "check-interrupted"],
      });
    }),
  );

  it.effect("reports a defect in the shared check to its caller", () =>
    Effect.gen(function* () {
      const { layer } = yield* makeUpdatesHarness({
        checkForUpdates: true,
        currentVersion: "1.0.0",
        httpClient: { ...httpClient, get: () => Effect.die("boom") },
      });
      const updates = yield* DesktopUpdates.pipe(Effect.provide(layer));

      const exit = yield* Effect.exit(updates.checkNow());

      expect(Exit.hasDies(exit)).toBe(true);
    }),
  );

  it.effect("interrupts an in-flight check when its layer closes", () =>
    Effect.gen(function* () {
      const { events, layer, started } = yield* makeHangingCheckHarness;

      yield* Effect.gen(function* () {
        const updates = yield* DesktopUpdates;
        yield* updates.checkNow().pipe(Effect.forkChild);
        yield* Deferred.await(started);
      }).pipe(Effect.provide(layer));
      events.push("layer-closed");

      expect(events).toEqual(["check-interrupted", "layer-closed"]);
    }),
  );

  it.effect("starts disabled when update checks are disabled", () =>
    Effect.gen(function* () {
      const harness = yield* makeUpdatesHarness({
        checkForUpdates: false,
        currentVersion: "1.0.0",
      });
      const updates = yield* DesktopUpdates.pipe(Effect.provide(harness.layer));

      const state = yield* updates.getState;

      expect(state.status).toBe("disabled");
      if (state.status === "disabled") {
        expect(state.reason).toContain("disabled");
      }
      expect(httpRequests).toHaveLength(0);
    }),
  );

  it.effect(
    "parses stable GitHub releases and reports newer semver versions",
    () =>
      Effect.gen(function* () {
        mockGitHubResponse({
          body: JSON.stringify({
            draft: false,
            html_url: "https://github.com/toommyliu/lucent/releases/tag/v1.2.3",
            name: "Lucent 1.2.3",
            prerelease: false,
            published_at: "2026-06-23T00:00:00Z",
            tag_name: "v1.2.3",
          }),
          headers: { etag: "etag-2" },
        });
        const { env, layer } = yield* makeUpdatesHarness({
          checkForUpdates: true,
          currentVersion: "1.2.2",
        });
        const updates = yield* DesktopUpdates.pipe(Effect.provide(layer));

        const state = yield* updates.checkNow();

        expect(state.status).toBe("available");
        if (state.status === "available") {
          expect(state.latestVersion).toBe("1.2.3");
          expect(state.release.tagName).toBe("v1.2.3");
        }
        expect(httpRequests[0]?.url.href).toBe(
          "https://api.github.com/repos/toommyliu/lucent/releases/latest",
        );
        const cache = JSON.parse(
          yield* Effect.promise(() =>
            readFile(join(env.appDataDir, "release-cache.json"), "utf8"),
          ),
        ) as {
          readonly etag?: string;
          readonly release?: { readonly tagName?: string };
        };
        expect(cache.etag).toBe("etag-2");
        expect(cache.release?.tagName).toBe("v1.2.3");
      }),
  );

  it.effect(
    "offers prerelease builds the newest published release, including prereleases",
    () =>
      Effect.gen(function* () {
        mockGitHubResponse({
          body: JSON.stringify([
            {
              draft: true,
              html_url:
                "https://github.com/toommyliu/lucent/releases/tag/v0.2.0",
              prerelease: false,
              tag_name: "v0.2.0",
            },
            {
              draft: false,
              html_url:
                "https://github.com/toommyliu/lucent/releases/tag/v0.0.2",
              prerelease: false,
              tag_name: "v0.0.2",
            },
            {
              draft: false,
              html_url:
                "https://github.com/toommyliu/lucent/releases/tag/v0.1.0-beta.2",
              prerelease: true,
              tag_name: "v0.1.0-beta.2",
            },
          ]),
        });
        const { layer } = yield* makeUpdatesHarness({
          checkForUpdates: true,
          currentVersion: "0.1.0-beta.1",
        });
        const updates = yield* DesktopUpdates.pipe(Effect.provide(layer));

        const state = yield* updates.checkNow();

        expect(httpRequests[0]?.url.href).toBe(
          "https://api.github.com/repos/toommyliu/lucent/releases?per_page=100&page=1",
        );
        expect(state.status).toBe("available");
        if (state.status === "available") {
          expect(state.latestVersion).toBe("0.1.0-beta.2");
          expect(state.release.htmlUrl).toBe(
            "https://github.com/toommyliu/lucent/releases/tag/v0.1.0-beta.2",
          );
        }
      }),
  );

  it.effect("finds the newest published version across release pages", () =>
    Effect.gen(function* () {
      mockGitHubReleasePage(["nightly"], {
        link: '<https://api.github.com/repos/toommyliu/lucent/releases?per_page=100&page=2>; rel="next", <https://api.github.com/repos/toommyliu/lucent/releases?per_page=100&page=3>; rel="last"',
      });
      mockGitHubReleasePage(["v0.1.0-beta.10"], {
        link: '<https://api.github.com/repos/toommyliu/lucent/releases?per_page=100&page=3>; rel="next"',
      });
      mockGitHubReleasePage(["v0.1.0-beta.9"], {
        link: '<https://api.github.com/repos/toommyliu/lucent/releases?per_page=100&page=2>; rel="prev"',
      });
      const { layer } = yield* makeUpdatesHarness({
        checkForUpdates: true,
        currentVersion: "0.1.0-beta.1",
      });
      const updates = yield* DesktopUpdates.pipe(Effect.provide(layer));

      const state = yield* updates.checkNow();

      expect(state).toMatchObject({
        status: "available",
        latestVersion: "0.1.0-beta.10",
        release: {
          htmlUrl:
            "https://github.com/toommyliu/lucent/releases/tag/v0.1.0-beta.10",
        },
      });
      expect(httpRequests.map((request) => request.url.href)).toEqual([
        "https://api.github.com/repos/toommyliu/lucent/releases?per_page=100&page=1",
        "https://api.github.com/repos/toommyliu/lucent/releases?per_page=100&page=2",
        "https://api.github.com/repos/toommyliu/lucent/releases?per_page=100&page=3",
      ]);
    }),
  );

  it.effect(
    "bounds the whole fetch, cancels pagination, and allows retry",
    () =>
      Effect.gen(function* () {
        const cache = {
          skippedVersion: "0.1.0-beta.2",
          release: {
            htmlUrl:
              "https://github.com/toommyliu/lucent/releases/tag/v0.1.0-beta.2",
            tagName: "v0.1.0-beta.2",
            version: "0.1.0-beta.2",
          },
        };
        for (let page = 1; page <= 5; page++) {
          mockGitHubReleasePage(["v0.1.0-beta.3"], {
            link: `<https://api.github.com/repos/toommyliu/lucent/releases?per_page=100&page=${page + 1}>; rel="next"`,
          });
        }
        const started = yield* Deferred.make<void>();
        let delayMs = 9_000;
        const interrupted: string[] = [];
        const { env, layer } = yield* makeUpdatesHarness({
          cache,
          checkForUpdates: true,
          currentVersion: "0.1.0-beta.1",
          httpClient: {
            ...httpClient,
            get: (options) =>
              httpClient.get(options).pipe(
                Effect.tap(() => Deferred.succeed(started, undefined)),
                Effect.tap(() => Effect.sleep(delayMs)),
                Effect.onInterrupt(() =>
                  Effect.sync(() => {
                    interrupted.push(options.url.href);
                  }),
                ),
              ),
          },
        });
        const updates = yield* DesktopUpdates.pipe(Effect.provide(layer));
        const check = yield* updates.checkNow().pipe(Effect.forkChild);
        yield* Deferred.await(started);
        const manualCheck = yield* updates
          .checkNow({ force: true })
          .pipe(Effect.forkChild);

        yield* TestClock.adjust("30 seconds");

        expect(yield* updates.getState).toMatchObject({ status: "error" });
        expect(yield* Fiber.join(check)).toMatchObject({
          status: "error",
          message: "Update check timed out.",
        });
        expect(yield* Fiber.join(manualCheck)).toMatchObject({
          status: "error",
        });
        expect(interrupted).toEqual([
          "https://api.github.com/repos/toommyliu/lucent/releases?per_page=100&page=4",
        ]);
        expect(
          JSON.parse(
            yield* Effect.promise(() =>
              readFile(join(env.appDataDir, "release-cache.json"), "utf8"),
            ),
          ),
        ).toEqual(cache);
        yield* TestClock.adjust("1 minute");
        expect(httpRequests).toHaveLength(4);

        httpResponses.length = 0;
        delayMs = 0;
        mockGitHubReleasePage(["v0.1.0-beta.4"]);
        expect(yield* updates.checkNow()).toMatchObject({
          status: "available",
          latestVersion: "0.1.0-beta.4",
        });
      }),
  );

  it.effect("rechecks later pages even when the first page is unchanged", () =>
    Effect.gen(function* () {
      const firstPageHeaders = {
        etag: "first-page",
        link: '<https://api.github.com/repos/toommyliu/lucent/releases?per_page=100&page=2>; rel="next"',
      };
      mockGitHubReleasePage(["v0.0.2"], firstPageHeaders);
      mockGitHubReleasePage(["v0.1.0-beta.2"], { etag: "second-page-1" });
      const { env, layer } = yield* makeUpdatesHarness({
        cache: {
          etag: "legacy-first-page",
          release: {
            htmlUrl: "https://github.com/toommyliu/lucent/releases/tag/v0.0.2",
            tagName: "v0.0.2",
            version: "0.0.2",
          },
        },
        checkForUpdates: true,
        currentVersion: "0.1.0-beta.1",
      });
      const updates = yield* DesktopUpdates.pipe(Effect.provide(layer));

      expect(yield* updates.checkNow()).toMatchObject({
        status: "available",
        latestVersion: "0.1.0-beta.2",
      });

      mockGitHubReleasePage(["v0.0.2"], firstPageHeaders);
      mockGitHubReleasePage(["v0.1.0-beta.3"], { etag: "second-page-2" });

      expect(yield* updates.checkNow()).toMatchObject({
        status: "available",
        latestVersion: "0.1.0-beta.3",
      });
      for (const request of httpRequests) {
        expect(request.headers).not.toHaveProperty("If-None-Match");
      }
      const cache = JSON.parse(
        yield* Effect.promise(() =>
          readFile(join(env.appDataDir, "release-cache.json"), "utf8"),
        ),
      );
      expect(cache).toMatchObject({ release: { version: "0.1.0-beta.3" } });
      expect(cache).not.toHaveProperty("etag");
    }),
  );

  it.effect.each([{ statusCode: 404 }, { body: "invalid JSON" }])(
    "preserves the previous cache when a later release page fails (%#)",
    (failedResponse) =>
      Effect.gen(function* () {
        const cache = {
          etag: "legacy-first-page",
          skippedVersion: "0.1.0-beta.2",
          release: {
            htmlUrl:
              "https://github.com/toommyliu/lucent/releases/tag/v0.1.0-beta.2",
            tagName: "v0.1.0-beta.2",
            version: "0.1.0-beta.2",
          },
        };
        mockGitHubReleasePage(["v0.1.0-beta.3"], {
          link: '<https://api.github.com/repos/toommyliu/lucent/releases?per_page=100&page=2>; rel="next"',
        });
        mockGitHubResponse(failedResponse);
        const { env, layer } = yield* makeUpdatesHarness({
          cache,
          checkForUpdates: true,
          currentVersion: "0.1.0-beta.1",
        });
        const updates = yield* DesktopUpdates.pipe(Effect.provide(layer));

        expect((yield* updates.checkNow()).status).toBe("error");
        expect(
          JSON.parse(
            yield* Effect.promise(() =>
              readFile(join(env.appDataDir, "release-cache.json"), "utf8"),
            ),
          ),
        ).toEqual(cache);
      }),
  );

  it.effect("offers prerelease builds the matching stable release", () =>
    Effect.gen(function* () {
      mockGitHubResponse({
        body: JSON.stringify([
          {
            draft: false,
            html_url: "https://github.com/toommyliu/lucent/releases/tag/v0.1.0",
            prerelease: false,
            tag_name: "v0.1.0",
          },
          {
            draft: false,
            html_url:
              "https://github.com/toommyliu/lucent/releases/tag/v0.1.0-beta.2",
            prerelease: true,
            tag_name: "v0.1.0-beta.2",
          },
        ]),
      });
      const { layer } = yield* makeUpdatesHarness({
        checkForUpdates: true,
        currentVersion: "0.1.0-beta.2",
      });
      const updates = yield* DesktopUpdates.pipe(Effect.provide(layer));

      const state = yield* updates.checkNow();

      expect(state.status).toBe("available");
      if (state.status === "available") {
        expect(state.latestVersion).toBe("0.1.0");
      }
    }),
  );

  it.effect("rejects draft and prerelease payloads", () =>
    Effect.gen(function* () {
      mockGitHubResponse({
        body: JSON.stringify({
          draft: true,
          html_url: "https://github.com/toommyliu/lucent/releases/tag/v1.2.3",
          prerelease: false,
          tag_name: "v1.2.3",
        }),
      });
      const draftHarness = yield* makeUpdatesHarness({
        checkForUpdates: true,
        currentVersion: "1.2.2",
      });
      const draftUpdates = yield* DesktopUpdates.pipe(
        Effect.provide(draftHarness.layer),
      );
      const draftState = yield* draftUpdates.checkNow();

      expect(draftState.status).toBe("error");
      if (draftState.status === "error") {
        expect(draftState.message).toContain("stable release");
      }

      mockGitHubResponse({
        body: JSON.stringify({
          draft: false,
          html_url: "https://github.com/toommyliu/lucent/releases/tag/v1.2.3",
          prerelease: true,
          tag_name: "v1.2.3",
        }),
      });
      const prereleaseHarness = yield* makeUpdatesHarness({
        checkForUpdates: true,
        currentVersion: "1.2.2",
      });
      const prereleaseUpdates = yield* DesktopUpdates.pipe(
        Effect.provide(prereleaseHarness.layer),
      );
      const prereleaseState = yield* prereleaseUpdates.checkNow();

      expect(prereleaseState.status).toBe("error");
      if (prereleaseState.status === "error") {
        expect(prereleaseState.message).toContain("stable release");
      }
    }),
  );

  it.effect(
    "reuses cached ETags and skips network work while updates are disabled",
    () =>
      Effect.gen(function* () {
        mockGitHubResponse({
          statusCode: 304,
        });
        const harness = yield* makeUpdatesHarness({
          cache: {
            etag: "etag-1",
            release: {
              htmlUrl:
                "https://github.com/toommyliu/lucent/releases/tag/v1.0.0",
              tagName: "v1.0.0",
              version: "1.0.0",
            },
          },
          checkForUpdates: true,
          currentVersion: "1.0.0",
        });
        const updates = yield* DesktopUpdates.pipe(
          Effect.provide(harness.layer),
        );

        const state = yield* updates.checkNow();

        expect(state.status).toBe("current");
        expect(httpRequests[0]?.headers).toMatchObject({
          "If-None-Match": "etag-1",
        });

        httpRequests.length = 0;
        httpResponses.length = 0;
        const disabledHarness = yield* makeUpdatesHarness({
          checkForUpdates: false,
          currentVersion: "1.0.0",
        });
        const disabledUpdates = yield* DesktopUpdates.pipe(
          Effect.provide(disabledHarness.layer),
        );
        const disabledState = yield* disabledUpdates.checkNow();

        expect(disabledState.status).toBe("disabled");
        expect(httpRequests).toHaveLength(0);
      }),
  );
});
