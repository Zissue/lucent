import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

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
    readonly known?: { readonly etag: string; readonly commit: string };
    readonly repositoryUrl: string;
    readonly ref?: string;
  }) => Effect.Effect<
    { readonly commit: string; readonly etag?: string },
    GitHubScriptPackageClientError
  >;
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
        const url = new URL(
          `${API_ORIGIN}/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repository)}/commits/${encodeURIComponent(ref)}`,
        );
        return yield* Effect.gen(function* () {
          const response = yield* api.get({
            attempts: MAX_METADATA_ATTEMPTS,
            ...(input.credentialId === undefined
              ? {}
              : { credentialId: input.credentialId }),
            ...(input.known === undefined ? {} : { etag: input.known.etag }),
            maxBytes: SCRIPT_PACKAGE_METADATA_MAX_BYTES,
            timeoutMs: REQUEST_TIMEOUT_MS,
            ...(token === undefined ? {} : { token }),
            url,
          });
          const etag = firstHttpHeader(response.headers, "etag");
          if (response.statusCode === 304) {
            if (input.known === undefined) {
              return yield* new GitHubScriptPackageClientError({
                kind: "unexpected-response",
                detail: "GitHub returned an unexpected not-modified response.",
                statusCode: 304,
              });
            }
            return {
              commit: input.known.commit,
              etag: etag ?? input.known.etag,
            };
          }

          return yield* Effect.try({
            try: () => {
              const payload = decodeCommitPayload(
                JSON.parse(response.body.toString("utf8")),
              );
              return {
                commit: payload.sha,
                ...(etag === undefined ? {} : { etag }),
              };
            },
            catch: clientError,
          });
        }).pipe(Effect.mapError(clientError));
      });

    const resolveDirectory: GitHubScriptPackageClientShape["resolveDirectory"] =
      Effect.fnUntraced(function* (input) {
        const { ref, repository, token } = yield* requestContext(input);
        const segments = input.subdirectory.split("/");
        const directoryName = segments[segments.length - 1];
        const parentSegments = segments.slice(0, -1);
        const base = repositoryApiBase(repository);

        return yield* Effect.gen(function* () {
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
                url: new URL(`${base}/git/trees/${encodeURIComponent(tree)}`),
              });
              const payload = yield* Effect.try({
                try: () =>
                  decodeTreePayload(JSON.parse(response.body.toString("utf8"))),
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
        }).pipe(Effect.mapError(clientError));
      });

    const downloadArchive: GitHubScriptPackageClientShape["downloadArchive"] =
      Effect.fnUntraced(function* (input) {
        const { ref, repository, token } = yield* requestContext(input);
        return yield* api
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
          .pipe(Effect.asVoid, Effect.mapError(clientError));
      });

    return GitHubScriptPackageClient.of({
      downloadArchive,
      resolveCommit,
      resolveDirectory,
    });
  }),
);
