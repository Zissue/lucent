import { join } from "path";

import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import { gt, prerelease, valid } from "semver";

import { UpdateReleaseInfo, type UpdateCheckState } from "../../shared/updates";
import { logFailure } from "../../shared/logFailure";
import { DesktopEnvironment } from "../app/DesktopEnvironment";
import { makeListenerRegistry, type Listener } from "../app/ListenerRegistry";
import { ElectronApp } from "../electron/ElectronApp";
import { ElectronShell } from "../electron/ElectronShell";
import {
  GitHubApiClient,
  type GitHubApiClientShape,
} from "../http/GitHubApiClient";
import { firstHttpHeader } from "../http/DesktopHttpClient";
import { FileSystem } from "effect/FileSystem";
import { makeJsonFile } from "../filesystem/JsonFile";
import { DesktopSettings } from "../settings/DesktopSettings";
import { parseAllowedUpdateReleaseUrl } from "./UpdateReleaseOpenPolicy";

const RELEASES_URL = "https://api.github.com/repos/toommyliu/lucent/releases";
const RELEASE_RESPONSE_MAX_BYTES = 16 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;
const CHECK_TIMEOUT_MS = 30_000;
const CHECK_ATTEMPTS = 3;

export class DesktopUpdateError extends Schema.TaggedError<DesktopUpdateError>()(
  "DesktopUpdateError",
  {
    detail: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

type UpdateReleaseFetchResult =
  | {
      readonly status: "modified";
      readonly release: UpdateReleaseInfo;
      readonly etag?: string;
    }
  | {
      readonly status: "not-modified";
      readonly etag?: string;
    };

export interface DesktopUpdatesShape {
  readonly checkNow: (options?: {
    readonly force?: boolean;
  }) => Effect.Effect<UpdateCheckState>;
  readonly getState: Effect.Effect<UpdateCheckState>;
  readonly onStateChanged: (
    listener: Listener<UpdateCheckState>,
  ) => Effect.Effect<() => void>;
  readonly openReleasePage: Effect.Effect<boolean>;
  readonly shouldPromptForAvailableRelease: (
    version: string,
  ) => Effect.Effect<boolean>;
  readonly skipAvailableRelease: (version: string) => Effect.Effect<boolean>;
}

export class DesktopUpdates extends Context.Service<
  DesktopUpdates,
  DesktopUpdatesShape
>()("lucent/desktop/updates/DesktopUpdates") {}

const GitHubReleasePayloadSchema = Schema.Struct({
  body: Schema.optionalKey(Schema.NullOr(Schema.String)),
  draft: Schema.Boolean,
  html_url: Schema.String,
  name: Schema.optionalKey(Schema.NullOr(Schema.String)),
  prerelease: Schema.Boolean,
  published_at: Schema.optionalKey(Schema.NullOr(Schema.String)),
  tag_name: Schema.String,
});
type GitHubReleasePayload = typeof GitHubReleasePayloadSchema.Type;
const decodeGitHubReleasePayload = Schema.decodeUnknownSync(
  GitHubReleasePayloadSchema,
);
const decodeGitHubReleasePayloads = Schema.decodeUnknownSync(
  Schema.Array(GitHubReleasePayloadSchema),
);

const UpdateReleaseCacheSchema = Schema.Struct({
  release: UpdateReleaseInfo,
  etag: Schema.optionalKey(Schema.String),
  skippedVersion: Schema.optionalKey(Schema.String),
});
type UpdateReleaseCache = typeof UpdateReleaseCacheSchema.Type;
const decodeUpdateReleaseCache = Schema.decodeUnknownOption(
  UpdateReleaseCacheSchema,
);

const normalizeVersion = (version: string): string => {
  const value = version.trim();
  const normalized = value.startsWith("v") ? value.slice(1) : value;
  const parsed = valid(normalized);
  if (parsed === null) {
    throw new Error(`Invalid semantic version: ${JSON.stringify(version)}.`);
  }
  return parsed;
};

const optionalString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;

const errorMessage = (cause: unknown, fallback: string): string =>
  cause instanceof Error && cause.message.length > 0 ? cause.message : fallback;

const toUpdateReleaseInfo = (
  payload: GitHubReleasePayload,
): UpdateReleaseInfo => {
  const tagName = payload.tag_name.trim();
  const releaseUrl = parseAllowedUpdateReleaseUrl(payload.html_url.trim());
  if (tagName.length === 0)
    throw new Error("Release payload is missing tag_name.");
  if (releaseUrl === null)
    throw new Error("Release payload has an invalid html_url.");

  const name = optionalString(payload.name);
  const publishedAt = optionalString(payload.published_at);
  const body = typeof payload.body === "string" ? payload.body : undefined;

  return new UpdateReleaseInfo({
    version: normalizeVersion(tagName),
    tagName,
    htmlUrl: releaseUrl.href,
    ...(name === undefined ? {} : { name }),
    ...(publishedAt === undefined ? {} : { publishedAt }),
    ...(body === undefined ? {} : { body }),
  });
};

const parseLatestStableRelease = (
  payload: GitHubReleasePayload,
): UpdateReleaseInfo => {
  if (payload.draft || payload.prerelease) {
    throw new Error("Latest release is not a stable release.");
  }
  return toUpdateReleaseInfo(payload);
};

const findNewestRelease = (
  payloads: ReadonlyArray<GitHubReleasePayload>,
  previous: GitHubReleasePayload | undefined,
): GitHubReleasePayload | undefined => {
  let newest = previous;
  for (const payload of payloads) {
    if (
      !payload.draft &&
      valid(payload.tag_name) !== null &&
      (newest === undefined || gt(payload.tag_name, newest.tag_name))
    ) {
      newest = payload;
    }
  }
  return newest;
};

const desktopUpdateError = (cause: unknown): DesktopUpdateError =>
  cause instanceof DesktopUpdateError
    ? cause
    : new DesktopUpdateError({
        detail: errorMessage(cause, "Failed to check for updates."),
        cause,
      });

const fetchLatestStableGitHubRelease = Effect.fn(
  "DesktopUpdates.fetchLatestStableGitHubRelease",
)(function* (
  api: GitHubApiClientShape,
  options?: { readonly etag?: string },
): Effect.fn.Return<UpdateReleaseFetchResult, DesktopUpdateError> {
  const response = yield* api
    .get({
      attempts: CHECK_ATTEMPTS,
      ...(options?.etag === undefined ? {} : { etag: options.etag }),
      maxBytes: RELEASE_RESPONSE_MAX_BYTES,
      timeoutMs: REQUEST_TIMEOUT_MS,
      url: new URL(`${RELEASES_URL}/latest`),
    })
    .pipe(Effect.mapError(desktopUpdateError));
  const etag = firstHttpHeader(response.headers, "etag");
  if (response.statusCode === 304) {
    return {
      status: "not-modified",
      ...(etag === undefined ? {} : { etag }),
    };
  }

  return yield* Effect.try({
    try: () => ({
      status: "modified" as const,
      release: parseLatestStableRelease(
        decodeGitHubReleasePayload(JSON.parse(response.body.toString("utf8"))),
      ),
      ...(etag === undefined ? {} : { etag }),
    }),
    catch: desktopUpdateError,
  });
});

const fetchNewestGitHubRelease = Effect.fn(
  "DesktopUpdates.fetchNewestGitHubRelease",
)(function* (
  api: GitHubApiClientShape,
): Effect.fn.Return<UpdateReleaseFetchResult, DesktopUpdateError> {
  let newest: GitHubReleasePayload | undefined;
  for (let page = 1; ; page++) {
    const response = yield* api
      .get({
        attempts: CHECK_ATTEMPTS,
        maxBytes: RELEASE_RESPONSE_MAX_BYTES,
        timeoutMs: REQUEST_TIMEOUT_MS,
        url: new URL(`${RELEASES_URL}?per_page=100&page=${page}`),
      })
      .pipe(Effect.mapError(desktopUpdateError));

    newest = yield* Effect.try({
      try: () =>
        findNewestRelease(
          decodeGitHubReleasePayloads(
            JSON.parse(response.body.toString("utf8")),
          ),
          newest,
        ),
      catch: desktopUpdateError,
    });
    if (!firstHttpHeader(response.headers, "link")?.includes('rel="next"')) {
      break;
    }
  }

  return yield* Effect.try({
    try: () => {
      if (newest === undefined) {
        throw new Error("No published releases were found.");
      }
      return {
        status: "modified" as const,
        release: toUpdateReleaseInfo(newest),
      };
    },
    catch: desktopUpdateError,
  });
});

const normalizeUpdateReleaseCache = (
  value: unknown,
): UpdateReleaseCache | null => {
  const decoded = decodeUpdateReleaseCache(value);
  return Option.isSome(decoded) ? decoded.value : null;
};

const serializeUpdateReleaseCache = (cache: UpdateReleaseCache): unknown => ({
  release: {
    version: cache.release.version,
    tagName: cache.release.tagName,
    htmlUrl: cache.release.htmlUrl,
    ...(cache.release.name === undefined ? {} : { name: cache.release.name }),
    ...(cache.release.publishedAt === undefined
      ? {}
      : { publishedAt: cache.release.publishedAt }),
    ...(cache.release.body === undefined ? {} : { body: cache.release.body }),
  },
  ...(cache.etag === undefined ? {} : { etag: cache.etag }),
  ...(cache.skippedVersion === undefined
    ? {}
    : { skippedVersion: cache.skippedVersion }),
});

interface DesktopUpdatesOptions {
  readonly currentVersion: string;
  readonly fetchRelease: (options?: {
    readonly etag?: string;
  }) => Effect.Effect<UpdateReleaseFetchResult, DesktopUpdateError>;
  readonly isEnabled: Effect.Effect<boolean, unknown>;
  readonly loadCache: Effect.Effect<UpdateReleaseCache | null, unknown>;
  readonly now?: () => Date;
  readonly saveCache: (
    cache: UpdateReleaseCache,
  ) => Effect.Effect<void, unknown>;
  readonly openExternal: (url: string) => Effect.Effect<boolean>;
}

const makeDesktopUpdates = (
  options: DesktopUpdatesOptions,
): Effect.Effect<DesktopUpdatesShape, never, Scope.Scope> =>
  Effect.gen(function* () {
    const currentVersion = normalizeVersion(options.currentVersion);
    const now = options.now ?? (() => new Date());
    const context = yield* Effect.context<never>();
    const runFork = Effect.runForkWith(context);
    const disabledState = (): UpdateCheckState => ({
      status: "disabled",
      currentVersion,
      reason: "Update checks are disabled.",
    });
    const updatesEnabled = yield* options.isEnabled.pipe(
      Effect.catch(() => Effect.succeed(true)),
    );
    const stateRef = yield* Ref.make<UpdateCheckState>(
      updatesEnabled
        ? {
            status: "idle",
            currentVersion,
          }
        : disabledState(),
    );
    const cacheRef = yield* Ref.make<UpdateReleaseCache | null>(null);
    const cacheLoadedRef = yield* Ref.make(false);
    const stateChanges = makeListenerRegistry<UpdateCheckState>();
    let inFlight: Fiber.Fiber<UpdateCheckState> | null = null;
    yield* Effect.addFinalizer(() =>
      inFlight === null ? Effect.void : Fiber.interrupt(inFlight),
    );

    const setState = (state: UpdateCheckState): Effect.Effect<void> =>
      Ref.set(stateRef, state).pipe(
        Effect.flatMap(() => stateChanges.publish(state)),
      );

    const loadCacheOnce = Effect.gen(function* () {
      const loaded = yield* Ref.get(cacheLoadedRef);
      if (loaded) {
        return yield* Ref.get(cacheRef);
      }

      const cache = yield* options.loadCache;
      yield* Ref.set(cacheRef, cache);
      yield* Ref.set(cacheLoadedRef, true);
      return cache;
    });

    const saveCache = (cache: UpdateReleaseCache) =>
      options.saveCache(cache).pipe(
        Effect.tap(() => Ref.set(cacheRef, cache)),
        Effect.tap(() => Ref.set(cacheLoadedRef, true)),
      );

    const stateFromRelease = (
      release: UpdateReleaseInfo,
      checkedAt: string,
    ): UpdateCheckState =>
      gt(release.version, currentVersion)
        ? {
            status: "available",
            currentVersion,
            latestVersion: release.version,
            checkedAt,
            release,
          }
        : {
            status: "current",
            currentVersion,
            latestVersion: release.version,
            checkedAt,
          };

    const runCheck = (force: boolean) =>
      Effect.gen(function* () {
        const enabled = yield* options.isEnabled;
        if (!enabled && !force) {
          const disabled = disabledState();
          yield* setState(disabled);
          return disabled;
        }

        const startedAt = now().toISOString();
        yield* setState({
          status: "checking",
          currentVersion,
          startedAt,
        });

        const cache = yield* loadCacheOnce;
        const result = yield* options
          .fetchRelease(
            cache?.etag === undefined ? undefined : { etag: cache.etag },
          )
          .pipe(
            Effect.timeoutOrElse({
              duration: CHECK_TIMEOUT_MS,
              orElse: () =>
                Effect.fail(
                  desktopUpdateError(new Error("Update check timed out.")),
                ),
            }),
          );
        const checkedAt = now().toISOString();

        if (result.status === "not-modified") {
          const release = cache?.release;
          if (release === undefined) {
            const current: UpdateCheckState = {
              status: "current",
              currentVersion,
              latestVersion: currentVersion,
              checkedAt,
            };
            yield* setState(current);
            return current;
          }

          const next = stateFromRelease(release, checkedAt);
          yield* setState(next);
          return next;
        }

        const nextCache: UpdateReleaseCache = {
          release: result.release,
          ...(result.etag === undefined ? {} : { etag: result.etag }),
          ...(cache?.skippedVersion === result.release.version
            ? { skippedVersion: cache.skippedVersion }
            : {}),
        };
        yield* saveCache(nextCache);

        const next = stateFromRelease(result.release, checkedAt);
        yield* setState(next);
        return next;
      }).pipe(
        Effect.catch((error) =>
          Effect.gen(function* () {
            yield* logFailure(
              "Failed to check for updates",
              Cause.fail(error),
              {
                failure: "warning",
              },
            ).pipe(
              Effect.annotateLogs({
                component: "updates",
                data: { currentVersion, force },
              }),
            );
            const checkedAt = now().toISOString();
            const next: UpdateCheckState = {
              status: "error",
              currentVersion,
              checkedAt,
              message: errorMessage(error, "Failed to check for updates."),
            };
            yield* setState(next);
            return next;
          }),
        ),
      );

    const getState: DesktopUpdatesShape["getState"] = Ref.get(stateRef);

    const onStateChanged: DesktopUpdatesShape["onStateChanged"] =
      stateChanges.subscribe;

    const openReleasePage: DesktopUpdatesShape["openReleasePage"] = Ref.get(
      stateRef,
    ).pipe(
      Effect.flatMap((state) =>
        state.status === "available"
          ? options.openExternal(state.release.htmlUrl)
          : Effect.succeed(false),
      ),
    );

    const shouldPromptForAvailableRelease: DesktopUpdatesShape["shouldPromptForAvailableRelease"] =
      Effect.fn("DesktopUpdates.shouldPromptForAvailableRelease")(
        function* (version) {
          const cache = yield* loadCacheOnce;
          return cache?.skippedVersion !== version;
        },
        Effect.orElseSucceed(() => true),
      );

    const skipAvailableRelease: DesktopUpdatesShape["skipAvailableRelease"] =
      Effect.fn("DesktopUpdates.skipAvailableRelease")(
        function* (version) {
          const state = yield* Ref.get(stateRef);
          if (state.status !== "available" || state.latestVersion !== version) {
            return false;
          }

          const cache = yield* loadCacheOnce;
          yield* saveCache({
            release: state.release,
            ...(cache?.etag === undefined ? {} : { etag: cache.etag }),
            skippedVersion: version,
          });
          return true;
        },
        Effect.orElseSucceed(() => false),
      );

    const startCheck = (force: boolean): Fiber.Fiber<UpdateCheckState> => {
      const fiber = runFork(runCheck(force));
      inFlight = fiber;
      fiber.addObserver(() => {
        if (inFlight === fiber) {
          inFlight = null;
        }
      });
      return fiber;
    };

    const checkNow: DesktopUpdatesShape["checkNow"] = (checkOptions) =>
      Effect.suspend(() =>
        Fiber.join(inFlight ?? startCheck(checkOptions?.force === true)),
      ).pipe(Effect.catchCauseIf(Cause.hasInterruptsOnly, () => getState));

    return {
      checkNow,
      getState,
      onStateChanged,
      openReleasePage,
      shouldPromptForAvailableRelease,
      skipAvailableRelease,
    };
  });

export const layer = Layer.effect(
  DesktopUpdates,
  Effect.gen(function* () {
    const app = yield* ElectronApp;
    const env = yield* DesktopEnvironment;
    const jsonFile = makeJsonFile(yield* FileSystem);
    const shell = yield* ElectronShell;
    const settings = yield* DesktopSettings;
    const api = yield* GitHubApiClient;
    const currentVersion = yield* app.getVersion;
    const releaseCachePath = join(env.appDataDir, "release-cache.json");
    const fetchRelease: DesktopUpdatesOptions["fetchRelease"] =
      prerelease(currentVersion) === null
        ? (options) => fetchLatestStableGitHubRelease(api, options)
        : () => fetchNewestGitHubRelease(api);

    const isEnabled: DesktopUpdatesOptions["isEnabled"] = settings.get.pipe(
      Effect.map(
        (currentSettings) => currentSettings.preferences.checkForUpdates,
      ),
    );

    const loadCache: DesktopUpdatesOptions["loadCache"] = jsonFile
      .read(releaseCachePath)
      .pipe(
        Effect.map((result) =>
          result.status === "ok"
            ? normalizeUpdateReleaseCache(result.value)
            : null,
        ),
        Effect.catch((cause) =>
          Effect.logWarning("Failed to load release cache", Cause.fail(cause))
            .pipe(Effect.annotateLogs({ component: "updates" }))
            .pipe(Effect.as(null)),
        ),
      );

    const saveCache: DesktopUpdatesOptions["saveCache"] = (cache) =>
      jsonFile.write(releaseCachePath, serializeUpdateReleaseCache(cache)).pipe(
        Effect.catch((cause) =>
          Effect.logWarning(
            "Failed to save release cache",
            Cause.fail(cause),
          ).pipe(
            Effect.annotateLogs({
              component: "updates",
            }),
          ),
        ),
      );

    const openExternal: DesktopUpdatesOptions["openExternal"] = (rawUrl) => {
      const url = parseAllowedUpdateReleaseUrl(rawUrl);
      return url === null ? Effect.succeed(false) : shell.openExternal(url);
    };

    const updates = yield* makeDesktopUpdates({
      currentVersion,
      fetchRelease,
      isEnabled,
      loadCache,
      openExternal,
      saveCache,
    });

    return DesktopUpdates.of(updates);
  }),
);
