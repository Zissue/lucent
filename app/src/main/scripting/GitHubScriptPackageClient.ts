import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import {
  GitHubApiClient,
  GitHubApiClientError,
  GitHubApiErrorKind,
} from "../http/GitHubApiClient";
import { firstHttpHeader } from "../http/DesktopHttpClient";
import {
  parseGitHubRepositoryInput,
  type GitHubRepository as ParsedGitHubRepository,
} from "../../shared/githubRepositoryUrl";
import { GitHubCredentials } from "./GitHubCredentials";
import {
  SCRIPT_PACKAGE_ARCHIVE_MAX_BYTES,
  SCRIPT_PACKAGE_METADATA_MAX_BYTES,
} from "./ScriptLimits";

const API_ORIGIN = "https://api.github.com";
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 5;
const MAX_METADATA_ATTEMPTS = 3;
const MAX_ARCHIVE_ATTEMPTS = 2;
const QUEUE_LIMIT = 32;
const CONTENTS_DIRECTORY_LIMIT = 1_000;

const GitHubCommitPayloadSchema = Schema.Struct({
  sha: Schema.String.check(Schema.isNonEmpty()),
});
const decodeCommitPayload = Schema.decodeUnknownSync(GitHubCommitPayloadSchema);

const GitHubContentsEntryPayloadSchema = Schema.Struct({
  name: Schema.String,
  path: Schema.String,
  sha: Schema.String.check(Schema.isNonEmpty()),
  type: Schema.String,
});
const decodeContentsPayload = Schema.decodeUnknownSync(
  Schema.Array(GitHubContentsEntryPayloadSchema),
);

const GitHubTreeEntryPayloadSchema = Schema.Struct({
  path: Schema.String,
  sha: Schema.String.check(Schema.isNonEmpty()),
  type: Schema.String,
});
const GitHubTreePayloadSchema = Schema.Struct({
  sha: Schema.String.check(Schema.isNonEmpty()),
  tree: Schema.Array(GitHubTreeEntryPayloadSchema),
  truncated: Schema.Boolean,
});
const decodeTreePayload = Schema.decodeUnknownSync(GitHubTreePayloadSchema);

export type GitHubRepository = ParsedGitHubRepository;

export const normalizeGitHubRepositoryUrl = (
  value: string,
): GitHubRepository => {
  const input = parseGitHubRepositoryInput(value);
  if (input.kind !== "repository") {
    throw new Error("Enter an https://github.com/<owner>/<repository> URL.");
  }
  return input.repository;
};

export class GitHubScriptPackageClientError extends Schema.TaggedError<GitHubScriptPackageClientError>()(
  "GitHubScriptPackageClientError",
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

export type GitHubCommitResolution =
  | {
      readonly status: "modified";
      readonly commit: string;
      readonly etag?: string;
    }
  | {
      readonly status: "not-modified";
      readonly etag?: string;
    };

export interface GitHubDirectoryResolution {
  readonly tree: string;
}

export interface GitHubScriptPackageClientShape {
  readonly downloadArchive: (input: {
    readonly credentialId?: string;
    readonly repositoryUrl: string;
    readonly ref?: string;
    readonly targetPath: string;
  }) => Effect.Effect<void, GitHubScriptPackageClientError>;
  readonly resolveCommit: (input: {
    readonly credentialId?: string;
    readonly etag?: string;
    readonly repositoryUrl: string;
    readonly ref?: string;
  }) => Effect.Effect<GitHubCommitResolution, GitHubScriptPackageClientError>;
  readonly resolveDirectory: (input: {
    readonly credentialId?: string;
    readonly repositoryUrl: string;
    readonly ref?: string;
    readonly subdirectory: string;
  }) => Effect.Effect<
    GitHubDirectoryResolution,
    GitHubScriptPackageClientError
  >;
}

export class GitHubScriptPackageClient extends Context.Service<
  GitHubScriptPackageClient,
  GitHubScriptPackageClientShape
>()("lucent/desktop/scripting/GitHubScriptPackageClient") {}

export class GitHubRequestQueue {
  readonly #requests = new Set<Deferred.Deferred<void>>();

  constructor(private readonly limit: number = QUEUE_LIMIT) {}

  enqueue<Value, Failure, Requirements>(
    task: Effect.Effect<Value, Failure, Requirements>,
  ): Effect.Effect<Value, Failure | Error, Requirements> {
    return Effect.acquireUseRelease(
      Effect.suspend(() => {
        if (this.#requests.size >= this.limit) {
          return Effect.fail(new Error("GitHub request queue is full."));
        }
        const turn = Deferred.makeUnsafe<void>();
        this.#requests.add(turn);
        if (this.#requests.size === 1) {
          Deferred.doneUnsafe(turn, Effect.void);
        }
        return Effect.succeed(turn);
      }),
      (turn) => Effect.andThen(Deferred.await(turn), task),
      (turn) =>
        Effect.sync(() => {
          this.#requests.delete(turn);
          const next = this.#requests.values().next().value;
          if (next !== undefined) {
            Deferred.doneUnsafe(next, Effect.void);
          }
        }),
    );
  }
}

const clientError = (cause: unknown): GitHubScriptPackageClientError =>
  cause instanceof GitHubScriptPackageClientError
    ? cause
    : cause instanceof GitHubApiClientError
      ? new GitHubScriptPackageClientError({
          kind: cause.kind,
          detail: cause.message,
          ...(cause.retryAt === undefined ? {} : { retryAt: cause.retryAt }),
          ...(cause.statusCode === undefined
            ? {}
            : { statusCode: cause.statusCode }),
          cause,
        })
      : new GitHubScriptPackageClientError({
          kind: "unavailable",
          detail:
            cause instanceof Error && cause.message.trim() !== ""
              ? cause.message
              : "GitHub request failed.",
          cause,
        });

const unexpectedPayloadError = (
  detail: string,
  cause: unknown,
): GitHubScriptPackageClientError =>
  new GitHubScriptPackageClientError({
    kind: "unexpected-response",
    detail,
    cause,
  });

const repositoryApiBase = (repository: GitHubRepository): string =>
  `${API_ORIGIN}/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repository)}`;

const encodedRepositoryPath = (segments: readonly string[]): string =>
  segments.map(encodeURIComponent).join("/");

export const layer = Layer.effect(
  GitHubScriptPackageClient,
  Effect.gen(function* () {
    const api = yield* GitHubApiClient;
    const credentials = yield* GitHubCredentials;
    const queue = new GitHubRequestQueue();
    const metadataLock = yield* Semaphore.make(1);
    const inFlightMetadata = new Map<
      string,
      {
        readonly fiber: Fiber.Fiber<
          GitHubCommitResolution,
          GitHubScriptPackageClientError
        >;
        waiters: number;
      }
    >();

    const requestContext = Effect.fn(
      "GitHubScriptPackageClient.requestContext",
    )(function* (input: {
      readonly credentialId?: string;
      readonly repositoryUrl: string;
      readonly ref?: string;
    }) {
      const repository = yield* Effect.try({
        try: () => normalizeGitHubRepositoryUrl(input.repositoryUrl),
        catch: (cause) =>
          new GitHubScriptPackageClientError({
            kind: "invalid-request",
            detail: "Enter a valid GitHub.com repository URL.",
            cause,
          }),
      });
      const token = yield* credentials.resolveToken(input.credentialId).pipe(
        Effect.mapError(
          (cause) =>
            new GitHubScriptPackageClientError({
              kind: "authentication",
              detail: cause.message,
              cause,
            }),
        ),
      );
      return {
        ref: input.ref?.trim() || "HEAD",
        repository,
        token,
      };
    });

    const resolveCommit: GitHubScriptPackageClientShape["resolveCommit"] =
      Effect.fnUntraced(function* (input) {
        const { ref, repository, token } = yield* requestContext(input);
        const key = JSON.stringify({
          credentialId: input.credentialId ?? null,
          etag: input.etag ?? null,
          ref,
          repository: repository.url,
        });
        const url = new URL(
          `${API_ORIGIN}/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repository)}/commits/${encodeURIComponent(ref)}`,
        );
        const operation = queue
          .enqueue(
            Effect.gen(function* () {
              const response = yield* api.get({
                attempts: MAX_METADATA_ATTEMPTS,
                ...(input.credentialId === undefined
                  ? {}
                  : { credentialId: input.credentialId }),
                ...(input.etag === undefined ? {} : { etag: input.etag }),
                maxBytes: SCRIPT_PACKAGE_METADATA_MAX_BYTES,
                timeoutMs: REQUEST_TIMEOUT_MS,
                ...(token === undefined ? {} : { token }),
                url,
              });
              const etag = firstHttpHeader(response.headers, "etag");
              if (response.statusCode === 304) {
                return {
                  status: "not-modified",
                  ...(etag === undefined ? {} : { etag }),
                } satisfies GitHubCommitResolution;
              }

              return yield* Effect.try({
                try: () => {
                  const payload = decodeCommitPayload(
                    JSON.parse(response.body.toString("utf8")),
                  );
                  return {
                    status: "modified",
                    commit: payload.sha,
                    ...(etag === undefined ? {} : { etag }),
                  } satisfies GitHubCommitResolution;
                },
                catch: clientError,
              });
            }),
          )
          .pipe(Effect.mapError(clientError));
        return yield* Effect.acquireUseRelease(
          metadataLock.withPermit(
            Effect.gen(function* () {
              const pending = inFlightMetadata.get(key);
              if (pending !== undefined) {
                pending.waiters += 1;
                return pending;
              }
              const fiber = yield* Effect.forkDetach(operation, {
                startImmediately: true,
              });
              const entry = { fiber, waiters: 1 };
              inFlightMetadata.set(key, entry);
              fiber.addObserver(() => {
                if (inFlightMetadata.get(key) === entry) {
                  inFlightMetadata.delete(key);
                }
              });
              return entry;
            }),
          ),
          (entry) => Fiber.join(entry.fiber),
          (entry) =>
            Effect.suspend(() => {
              entry.waiters -= 1;
              if (entry.waiters > 0) {
                return Effect.void;
              }
              if (inFlightMetadata.get(key) === entry) {
                inFlightMetadata.delete(key);
              }
              return Fiber.interrupt(entry.fiber);
            }),
        );
      });

    const resolveDirectory: GitHubScriptPackageClientShape["resolveDirectory"] =
      Effect.fnUntraced(function* (input) {
        const { ref, repository, token } = yield* requestContext(input);
        const segments = input.subdirectory.split("/");
        const directoryName = segments[segments.length - 1];
        if (directoryName === undefined || directoryName === "") {
          return yield* new GitHubScriptPackageClientError({
            kind: "invalid-request",
            detail: "Enter a valid package directory.",
          });
        }
        const parentSegments = segments.slice(0, -1);
        const base = repositoryApiBase(repository);

        return yield* queue
          .enqueue(
            Effect.gen(function* () {
              const contentsPath = encodedRepositoryPath(parentSegments);
              const contentsUrl = new URL(
                contentsPath === ""
                  ? `${base}/contents`
                  : `${base}/contents/${contentsPath}`,
              );
              contentsUrl.searchParams.set("ref", ref);
              const contentsResponse = yield* api.get({
                attempts: MAX_METADATA_ATTEMPTS,
                ...(input.credentialId === undefined
                  ? {}
                  : { credentialId: input.credentialId }),
                maxBytes: SCRIPT_PACKAGE_METADATA_MAX_BYTES,
                timeoutMs: REQUEST_TIMEOUT_MS,
                ...(token === undefined ? {} : { token }),
                url: contentsUrl,
              });
              const contents = yield* Effect.try({
                try: () =>
                  decodeContentsPayload(
                    JSON.parse(contentsResponse.body.toString("utf8")),
                  ),
                catch: (cause) =>
                  unexpectedPayloadError(
                    "GitHub returned an invalid directory listing.",
                    cause,
                  ),
              });

              if (contents.length < CONTENTS_DIRECTORY_LIMIT) {
                const entry = contents.find(
                  (candidate) =>
                    candidate.name === directoryName &&
                    candidate.path === input.subdirectory,
                );
                if (entry === undefined) {
                  return yield* new GitHubScriptPackageClientError({
                    kind: "not-found",
                    detail: `GitHub couldn't find package directory ${JSON.stringify(input.subdirectory)}.`,
                  });
                }
                if (entry.type !== "dir") {
                  return yield* new GitHubScriptPackageClientError({
                    kind: "invalid-request",
                    detail: `GitHub path ${JSON.stringify(input.subdirectory)} is not a directory.`,
                  });
                }
                return { tree: entry.sha };
              }

              const getTree = Effect.fn("GitHubScriptPackageClient.getTree")(
                function* (tree: string) {
                  const response = yield* api.get({
                    attempts: MAX_METADATA_ATTEMPTS,
                    ...(input.credentialId === undefined
                      ? {}
                      : { credentialId: input.credentialId }),
                    maxBytes: SCRIPT_PACKAGE_METADATA_MAX_BYTES,
                    timeoutMs: REQUEST_TIMEOUT_MS,
                    ...(token === undefined ? {} : { token }),
                    url: new URL(
                      `${base}/git/trees/${encodeURIComponent(tree)}`,
                    ),
                  });
                  const payload = yield* Effect.try({
                    try: () =>
                      decodeTreePayload(
                        JSON.parse(response.body.toString("utf8")),
                      ),
                    catch: (cause) =>
                      unexpectedPayloadError(
                        "GitHub returned an invalid Git tree.",
                        cause,
                      ),
                  });
                  if (payload.truncated) {
                    return yield* new GitHubScriptPackageClientError({
                      kind: "response-too-large",
                      detail: "GitHub returned an incomplete Git tree.",
                    });
                  }
                  return payload;
                },
              );

              let tree = yield* getTree(ref);
              for (let index = 0; index < segments.length; index += 1) {
                const segment = segments[index];
                const entry = tree.tree.find(
                  (candidate) => candidate.path === segment,
                );
                if (entry === undefined) {
                  return yield* new GitHubScriptPackageClientError({
                    kind: "not-found",
                    detail: `GitHub couldn't find package directory ${JSON.stringify(input.subdirectory)}.`,
                  });
                }
                if (entry.type !== "tree") {
                  return yield* new GitHubScriptPackageClientError({
                    kind: "invalid-request",
                    detail: `GitHub path ${JSON.stringify(input.subdirectory)} is not a directory.`,
                  });
                }
                if (index === segments.length - 1) {
                  return { tree: entry.sha };
                }
                tree = yield* getTree(entry.sha);
              }

              return yield* new GitHubScriptPackageClientError({
                kind: "unexpected-response",
                detail: "GitHub returned an incomplete package directory.",
              });
            }),
          )
          .pipe(Effect.mapError(clientError));
      });

    const downloadArchive: GitHubScriptPackageClientShape["downloadArchive"] =
      Effect.fnUntraced(function* (input) {
        const { ref, repository, token } = yield* requestContext(input);
        return yield* queue
          .enqueue(
            api
              .download({
                attempts: MAX_ARCHIVE_ATTEMPTS,
                ...(input.credentialId === undefined
                  ? {}
                  : { credentialId: input.credentialId }),
                maxBytes: SCRIPT_PACKAGE_ARCHIVE_MAX_BYTES,
                maxRedirects: MAX_REDIRECTS,
                targetPath: input.targetPath,
                timeoutMs: REQUEST_TIMEOUT_MS,
                ...(token === undefined ? {} : { token }),
                url: new URL(
                  `${API_ORIGIN}/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repository)}/tarball/${encodeURIComponent(ref)}`,
                ),
              })
              .pipe(Effect.asVoid),
          )
          .pipe(Effect.mapError(clientError));
      });

    return GitHubScriptPackageClient.of({
      downloadArchive,
      resolveCommit,
      resolveDirectory,
    });
  }),
);
