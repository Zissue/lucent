import { promises as fs } from "fs";
import { basename } from "path";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import type {
  ScriptFile,
  ScriptFileResolution,
  ScriptOpenFileResult,
  ScriptSelectFileResult,
} from "@lucent/core/scriptInputs";
import type {
  ScriptCatalogOverview,
  ScriptCatalogPage,
  ScriptCatalogPageRequest,
  ScriptReference,
} from "@lucent/core/scriptPackages";
import { DesktopEnvironment } from "../app/DesktopEnvironment";
import { ElectronDialog } from "../electron/ElectronDialog";
import { ElectronShell } from "../electron/ElectronShell";
import { ScriptFiles } from "./ScriptFiles";
import { ScriptPackageCatalog } from "./ScriptPackageCatalog";
import { normalizeGitHubRepositoryUrl } from "./GitHubScriptPackageClient";
import { ScriptSourceRegistry } from "./ScriptSourceRegistry";
import { resolveScriptWorkspacePaths } from "./ScriptWorkspacePaths";

const scriptLibraryOperationSchema = Schema.Literals(["mkdir", "open", "read"]);

const causeMessage = (cause: unknown): string | undefined => {
  const message =
    cause instanceof Error || Schema.isSchemaError(cause)
      ? cause.message
      : typeof cause === "string"
        ? cause
        : undefined;
  const trimmed = message?.trim();
  return trimmed === "" ? undefined : trimmed;
};

export class DesktopScriptLibraryError extends Schema.TaggedError<DesktopScriptLibraryError>()(
  "DesktopScriptLibraryError",
  {
    operation: scriptLibraryOperationSchema,
    path: Schema.optionalKey(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    const context =
      this.path === undefined
        ? `Script library ${this.operation} failed.`
        : `Script library ${this.operation} failed at ${this.path}.`;
    const detail = causeMessage(this.cause);
    return detail === undefined ? context : `${context} ${detail}`;
  }
}

export interface DesktopScriptLibraryShape {
  readonly getCatalog: Effect.Effect<
    ScriptCatalogOverview,
    DesktopScriptLibraryError
  >;
  readonly getCatalogPage: (
    request: ScriptCatalogPageRequest,
  ) => Effect.Effect<ScriptCatalogPage, DesktopScriptLibraryError>;
  readonly loadReference: (
    reference: ScriptReference,
  ) => Effect.Effect<ScriptFile, DesktopScriptLibraryError>;
  readonly openFile: (
    parentWindowId?: number,
  ) => Effect.Effect<ScriptOpenFileResult, DesktopScriptLibraryError>;
  readonly openPath: (path: string) => Effect.Effect<boolean>;
  readonly openRepository: (
    repositoryUrl: string,
  ) => Effect.Effect<boolean, DesktopScriptLibraryError>;
  readonly readFile: (
    path: string,
  ) => Effect.Effect<ScriptFile, DesktopScriptLibraryError>;
  readonly readReference: (
    reference: ScriptReference,
  ) => Effect.Effect<ScriptFile, DesktopScriptLibraryError>;
  readonly refreshCatalog: Effect.Effect<
    ScriptCatalogOverview,
    DesktopScriptLibraryError
  >;
  readonly resolveFile: (path: string) => Effect.Effect<ScriptFileResolution>;
  readonly resolveReference: (
    reference: ScriptReference,
  ) => Effect.Effect<ScriptFileResolution>;
  readonly selectFile: Effect.Effect<
    ScriptSelectFileResult,
    DesktopScriptLibraryError
  >;
}

export class DesktopScriptLibrary extends Context.Service<
  DesktopScriptLibrary,
  DesktopScriptLibraryShape
>()("lucent/desktop/scripting/DesktopScriptLibrary") {}

const wrapError = (
  operation: typeof scriptLibraryOperationSchema.Type,
  cause: unknown,
  path?: string,
) =>
  new DesktopScriptLibraryError({
    operation,
    cause,
    ...(path === undefined ? {} : { path }),
  });

const ensureDirectory = (
  path: string,
): Effect.Effect<void, DesktopScriptLibraryError> =>
  Effect.tryPromise({
    try: () => fs.mkdir(path, { recursive: true }),
    catch: (cause) => wrapError("mkdir", cause, path),
  }).pipe(Effect.asVoid);

export const layer = Layer.effect(
  DesktopScriptLibrary,
  Effect.gen(function* () {
    const dialog = yield* ElectronDialog;
    const env = yield* DesktopEnvironment;
    const files = yield* ScriptFiles;
    const catalog = yield* ScriptPackageCatalog;
    const sources = yield* ScriptSourceRegistry;
    const shell = yield* ElectronShell;
    const { scriptsDir } = resolveScriptWorkspacePaths(env.workspaceDir);

    const readFile = (path: string) =>
      sources
        .readPath(path)
        .pipe(Effect.mapError((cause) => wrapError("read", cause, path)));

    const readReference = (reference: ScriptReference) =>
      sources
        .readReference(reference)
        .pipe(
          Effect.mapError((cause) =>
            wrapError(
              "read",
              cause,
              reference.kind === "loose"
                ? reference.path
                : `${reference.packageName}/${reference.path}`,
            ),
          ),
        );

    const loadReference = (reference: ScriptReference) =>
      catalog.resolveReference(reference).pipe(
        Effect.mapError((cause) => wrapError("read", cause)),
        Effect.flatMap((entry) =>
          entry === undefined
            ? Effect.fail(
                wrapError(
                  "read",
                  new Error("The selected script is no longer available."),
                ),
              )
            : files.read(entry.path).pipe(
                Effect.map((file) => ({
                  ...file,
                  name: entry.name,
                  path: entry.path,
                  reference,
                })),
                Effect.mapError((cause) =>
                  wrapError("read", cause, entry.path),
                ),
              ),
        ),
      );

    const selectPath = Effect.fn("DesktopScriptLibrary.selectPath")(function* (
      parentWindowId?: number,
    ) {
      yield* ensureDirectory(scriptsDir);
      const result = yield* dialog
        .showOpenDialog(
          {
            buttonLabel: "Load Script",
            defaultPath: scriptsDir,
            filters: [
              { extensions: ["js", "cjs"], name: "JavaScript Scripts" },
              { extensions: ["*"], name: "All Files" },
            ],
            properties: ["openFile"],
            title: "Load Script",
          },
          parentWindowId,
        )
        .pipe(Effect.mapError((cause) => wrapError("open", cause)));

      const [path] = result.filePaths;
      if (result.canceled || path === undefined) {
        return null;
      }

      return path;
    });

    const selectFile: DesktopScriptLibraryShape["selectFile"] = Effect.gen(
      function* () {
        const path = yield* selectPath();
        if (path === null) {
          return { canceled: true } satisfies ScriptSelectFileResult;
        }

        const reference = yield* catalog
          .referenceForPath(path)
          .pipe(Effect.mapError((cause) => wrapError("read", cause, path)));
        return {
          canceled: false,
          file: {
            name: basename(path),
            path,
            ...(reference === undefined ? {} : { reference }),
          },
        } satisfies ScriptSelectFileResult;
      },
    );

    const openFile: DesktopScriptLibraryShape["openFile"] = (parentWindowId) =>
      Effect.gen(function* () {
        const path = yield* selectPath(parentWindowId);
        if (path === null) {
          return { canceled: true } satisfies ScriptOpenFileResult;
        }

        const reference = yield* catalog
          .referenceForPath(path)
          .pipe(Effect.mapError((cause) => wrapError("read", cause, path)));
        const file =
          reference?.kind === "package"
            ? yield* loadReference(reference)
            : yield* files.read(path).pipe(
                Effect.map((file) =>
                  reference === undefined ? file : { ...file, reference },
                ),
                Effect.mapError((cause) => wrapError("read", cause, path)),
              );
        return { canceled: false, file } satisfies ScriptOpenFileResult;
      });

    const openPath: DesktopScriptLibraryShape["openPath"] = (path) =>
      shell.openPath(path);

    const openRepository: DesktopScriptLibraryShape["openRepository"] = (
      repositoryUrl,
    ) =>
      Effect.try({
        try: () => new URL(normalizeGitHubRepositoryUrl(repositoryUrl).url),
        catch: (cause) => wrapError("open", cause, repositoryUrl),
      }).pipe(Effect.flatMap(shell.openExternal));

    return DesktopScriptLibrary.of({
      getCatalog: catalog.getOverview.pipe(
        Effect.mapError((cause) => wrapError("read", cause)),
      ),
      getCatalogPage: (request) =>
        catalog
          .getPage(request)
          .pipe(Effect.mapError((cause) => wrapError("read", cause))),
      loadReference,
      openFile,
      openPath,
      openRepository,
      readFile,
      readReference,
      refreshCatalog: catalog.refresh.pipe(
        Effect.mapError((cause) => wrapError("read", cause)),
      ),
      resolveFile: sources.resolvePath,
      resolveReference: sources.resolveReference,
      selectFile,
    });
  }),
);
