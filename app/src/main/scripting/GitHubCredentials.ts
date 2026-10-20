import { randomBytes } from "node:crypto";
import { join } from "node:path";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import type { GitHubCredentialSummary } from "@lucent/core/scriptPackages";
import { DesktopEnvironment } from "../app/DesktopEnvironment";
import { FileSystem } from "effect/FileSystem";
import { makeJsonFile } from "../filesystem/JsonFile";

const NonEmptyStringSchema = Schema.String.check(
  Schema.makeFilter((value) => value.trim() !== "", {
    expected: "a non-empty string",
  }),
);

const GitHubCredentialSchema = Schema.Struct({
  id: NonEmptyStringSchema,
  label: NonEmptyStringSchema,
  token: NonEmptyStringSchema,
});

const GitHubCredentialsFileSchema = Schema.Struct({
  version: Schema.Literal(1),
  credentials: Schema.Array(GitHubCredentialSchema),
});

const decodeCredentialsFile = Schema.decodeUnknownOption(
  GitHubCredentialsFileSchema,
);

interface GitHubCredential {
  readonly id: string;
  readonly label: string;
  readonly token: string;
}

export class GitHubCredentialsError extends Schema.TaggedError<GitHubCredentialsError>()(
  "GitHubCredentialsError",
  {
    operation: Schema.Literals(["delete", "list", "load", "resolve", "save"]),
    detail: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export interface GitHubCredentialsShape {
  readonly delete: (id: string) => Effect.Effect<void, GitHubCredentialsError>;
  readonly list: Effect.Effect<
    readonly GitHubCredentialSummary[],
    GitHubCredentialsError
  >;
  readonly resolveToken: (
    id: string | undefined,
  ) => Effect.Effect<string | undefined, GitHubCredentialsError>;
  readonly save: (input: {
    readonly id?: string;
    readonly label: string;
    readonly token: string;
  }) => Effect.Effect<GitHubCredentialSummary, GitHubCredentialsError>;
}

export class GitHubCredentials extends Context.Service<
  GitHubCredentials,
  GitHubCredentialsShape
>()("lucent/desktop/scripting/GitHubCredentials") {}

type CredentialLoadState =
  | {
      readonly status: "loaded";
      readonly credentials: Map<string, GitHubCredential>;
    }
  | { readonly status: "failed"; readonly error: GitHubCredentialsError };

const summary = (credential: GitHubCredential): GitHubCredentialSummary => ({
  id: credential.id,
  label: credential.label,
});

const credentialsFromUnknown = (value: unknown): CredentialLoadState => {
  const decoded = decodeCredentialsFile(value);
  if (Option.isNone(decoded)) {
    return {
      status: "failed",
      error: new GitHubCredentialsError({
        operation: "load",
        detail: "GitHub credential storage has an invalid format.",
      }),
    };
  }
  return {
    status: "loaded",
    credentials: new Map(
      decoded.value.credentials.map((credential) => [
        credential.id,
        credential,
      ]),
    ),
  };
};

export const layer = Layer.effect(
  GitHubCredentials,
  Effect.gen(function* () {
    const env = yield* DesktopEnvironment;
    const jsonFile = makeJsonFile(yield* FileSystem);
    const credentialsPath = join(env.appDataDir, "github-credentials.json");
    const loaded = yield* jsonFile.read(credentialsPath).pipe(
      Effect.match({
        onFailure: (cause): CredentialLoadState => ({
          status: "failed",
          error: new GitHubCredentialsError({
            operation: "load",
            detail: "Failed to read GitHub credential storage.",
            cause,
          }),
        }),
        onSuccess: (result): CredentialLoadState =>
          result.status === "missing"
            ? { status: "loaded", credentials: new Map() }
            : credentialsFromUnknown(result.value),
      }),
    );
    const stateRef = yield* Ref.make(loaded);
    const writeGate = yield* Semaphore.make(1);

    const getCredentials = Ref.get(stateRef).pipe(
      Effect.flatMap((state) =>
        state.status === "loaded"
          ? Effect.succeed(state.credentials)
          : state.error,
      ),
    );

    const persist = (credentials: ReadonlyMap<string, GitHubCredential>) =>
      jsonFile
        .write(
          credentialsPath,
          {
            version: 1,
            credentials: [...credentials.values()].sort((left, right) =>
              left.label.localeCompare(right.label),
            ),
          },
          { mode: 0o600 },
        )
        .pipe(
          Effect.mapError(
            (cause) =>
              new GitHubCredentialsError({
                operation: "save",
                detail: "Failed to save GitHub credentials.",
                cause,
              }),
          ),
        );

    const mutate = <Value>(
      update: (
        credentials: ReadonlyMap<string, GitHubCredential>,
      ) => readonly [Map<string, GitHubCredential>, Value],
    ) =>
      writeGate.withPermits(1)(
        Effect.gen(function* () {
          const current = yield* getCredentials;
          const [next, value] = update(current);
          yield* persist(next);
          yield* Ref.set(stateRef, { status: "loaded", credentials: next });
          return value;
        }),
      );

    return GitHubCredentials.of({
      delete: (id) =>
        mutate((current) => {
          const next = new Map(current);
          next.delete(id);
          return [next, undefined] as const;
        }),
      list: getCredentials.pipe(
        Effect.map((credentials) =>
          [...credentials.values()]
            .map(summary)
            .sort((left, right) => left.label.localeCompare(right.label)),
        ),
      ),
      resolveToken: (id) =>
        id === undefined
          ? Effect.sync((): string | undefined => undefined)
          : getCredentials.pipe(
              Effect.flatMap((credentials) => {
                const credential = credentials.get(id);
                return credential === undefined
                  ? new GitHubCredentialsError({
                      operation: "resolve",
                      detail:
                        "The selected GitHub credential no longer exists.",
                    })
                  : Effect.succeed(credential.token);
              }),
            ),
      save: (input) =>
        mutate((current) => {
          const id =
            input.id?.trim() || `github:${randomBytes(12).toString("hex")}`;
          const credential: GitHubCredential = {
            id,
            label: input.label.trim(),
            token: input.token.trim(),
          };
          const next = new Map(current);
          next.set(id, credential);
          return [next, summary(credential)] as const;
        }),
    });
  }),
);
