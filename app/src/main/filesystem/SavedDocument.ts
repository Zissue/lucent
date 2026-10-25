import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { JsonFileError, type makeJsonFile } from "./JsonFile";

const recoveryWarnings = {
  accounts: {
    unreadable: (...cause: ReadonlyArray<Cause.Cause<JsonFileError>>) =>
      Effect.logWarning(
        "Saved accounts could not be read; using defaults until the next save",
        ...cause,
      ),
    invalid: Effect.logWarning(
      "Saved accounts had invalid entries; ignoring them until the next save",
    ),
  },
  settings: {
    unreadable: (...cause: ReadonlyArray<Cause.Cause<JsonFileError>>) =>
      Effect.logWarning(
        "Saved settings could not be read; using defaults until the next save",
        ...cause,
      ),
    invalid: Effect.logWarning(
      "Saved settings had invalid entries; ignoring them until the next save",
    ),
  },
  "combat-profiles": {
    unreadable: (...cause: ReadonlyArray<Cause.Cause<JsonFileError>>) =>
      Effect.logWarning(
        "Saved combat profiles could not be read; using defaults until the next save",
        ...cause,
      ),
    invalid: Effect.logWarning(
      "Saved combat profiles had invalid entries; ignoring them until the next save",
    ),
  },
  "account-settings": {
    unreadable: (...cause: ReadonlyArray<Cause.Cause<JsonFileError>>) =>
      Effect.logWarning(
        "Saved account settings could not be read; using defaults until the next save",
        ...cause,
      ),
    invalid: Effect.logWarning(
      "Saved account settings had invalid entries; ignoring them until the next save",
    ),
  },
  "script-inputs": {
    unreadable: (...cause: ReadonlyArray<Cause.Cause<JsonFileError>>) =>
      Effect.logWarning(
        "Saved script inputs could not be read; using defaults until the next save",
        ...cause,
      ),
    invalid: Effect.logWarning(
      "Saved script inputs had invalid entries; ignoring them until the next save",
    ),
  },
};

type Document = Readonly<Record<string, unknown>>;
interface Issues {
  readonly reset?: ReadonlyArray<string>;
  readonly ignored?: Readonly<Record<string, number>>;
}
interface Decoded<A> {
  readonly value: A;
  readonly issues: Issues;
}

export interface SavedDocumentSpec<A, E> {
  readonly kind: keyof typeof recoveryWarnings;
  readonly path: string;
  readonly logPath?: string;
  readonly versions?: {
    readonly current: number;
    readonly migrations: Readonly<
      Record<number, (document: Document) => Decoded<Document>>
    >;
  };
  readonly defaults: () => A;
  readonly decode: (document: Document) => Decoded<A> | undefined;
  readonly encode: (value: A) => unknown;
  readonly mapError: (error: JsonFileError) => E;
}

export interface SavedDocument<A, E> {
  readonly load: (options: {
    readonly diagnostics: boolean;
  }) => Effect.Effect<A, E>;
  readonly save: (value: A) => Effect.Effect<A, E>;
}

const isDocument = Schema.is(Schema.Record(Schema.String, Schema.Unknown));
const isVersion = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

const mergeIssues = (issues: ReadonlyArray<Issues>): Issues => {
  const reset = [...new Set(issues.flatMap((issue) => issue.reset ?? []))];
  const ignored: Record<string, number> = {};
  for (const issue of issues) {
    for (const [key, count] of Object.entries(issue.ignored ?? {}))
      ignored[key] = (ignored[key] ?? 0) + count;
  }
  return {
    ...(reset.length > 0 ? { reset } : {}),
    ...(Object.values(ignored).some((count) => count > 0) ? { ignored } : {}),
  };
};

export const makeSavedDocument = <A, E>(
  jsonFile: ReturnType<typeof makeJsonFile>,
  spec: SavedDocumentSpec<A, E>,
): Effect.Effect<SavedDocument<A, E>> => {
  const versions = spec.versions;
  const logPath = spec.logPath ?? spec.path;
  const warnings = recoveryWarnings[spec.kind];
  const annotate = (data: object) =>
    Effect.annotateLogs({
      component: spec.kind,
      data: { path: logPath, ...data },
    });

  const load = Effect.fnUntraced(function* ({
    diagnostics,
  }: {
    readonly diagnostics: boolean;
  }) {
    const source = yield* jsonFile.read(spec.path).pipe(
      Effect.catch((error) =>
        error.operation === "parse"
          ? Effect.succeed({ status: "malformed" as const, error })
          : Effect.fail(error),
      ),
      Effect.mapError(spec.mapError),
    );
    if (source.status === "missing") return spec.defaults();
    if (source.status === "malformed" || !isDocument(source.value)) {
      if (diagnostics)
        yield* warnings
          .unreadable(
            ...(source.status === "malformed"
              ? [
                  Cause.fail(
                    new JsonFileError({
                      operation: "parse",
                      path: logPath,
                      cause: source.error.cause,
                    }),
                  ),
                ]
              : []),
          )
          .pipe(annotate({ ignored: { file: 1 } }));
      return spec.defaults();
    }

    let document = source.value;
    const issues: Issues[] = [];
    let newer = false;
    if (versions !== undefined) {
      const saved = Object.hasOwn(document, "version")
        ? document["version"]
        : 0;
      newer = isVersion(saved) && saved > versions.current;
      if (!isVersion(saved)) issues.push({ reset: ["version"] });
      else if (saved < versions.current) {
        for (let version = saved; version < versions.current; version++) {
          const step = versions.migrations[version]?.(document);
          document = { ...(step?.value ?? document), version: version + 1 };
          if (step !== undefined) issues.push(step.issues);
        }
      }
      document = { ...document, version: versions.current };
    }
    const decoded = spec.decode(document);
    if (decoded === undefined) {
      if (diagnostics)
        yield* warnings.unreadable().pipe(annotate({ ignored: { file: 1 } }));
      return spec.defaults();
    }
    if (newer) return decoded.value;
    issues.push(decoded.issues);
    const combined = mergeIssues(issues);
    if (diagnostics && (combined.reset || combined.ignored))
      yield* warnings.invalid.pipe(annotate(combined));
    return decoded.value;
  });

  const save = (value: A) =>
    jsonFile
      .write(spec.path, spec.encode(value))
      .pipe(Effect.mapError(spec.mapError), Effect.as(value));

  return Effect.succeed({ load, save });
};
