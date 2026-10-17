import { promises as fs } from "node:fs";
import { basename, resolve } from "node:path";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SynchronizedRef from "effect/SynchronizedRef";

import type {
  ScriptCatalogChange,
  ScriptCatalogEntry,
  ScriptCatalogOverview,
  ScriptCatalogPage,
  ScriptCatalogPageRequest,
  ScriptReference,
} from "@lucent/core/scriptPackages";
import { DesktopEnvironment } from "../app/DesktopEnvironment";
import { makeListenerRegistry, type Listener } from "../app/ListenerRegistry";
import { ElectronApp } from "../electron/ElectronApp";
import {
  catalogOverview,
  discoverScriptCatalog,
  referenceKey,
  removeDiscoveredPackage,
  replaceDiscoveredPackage,
  updateDiscoveredManagedPackage,
  type DiscoveredScriptCatalog,
  type ScriptPackageCatalogReplacement,
} from "./ScriptCatalogDiscovery";
import { isPathInside } from "./ScriptPackageFileSystem";
import {
  resolveLooseScriptReference,
  logScriptPackageInspectionFailures,
  type ScriptPackageInspectionFailure,
} from "./ScriptPackageInspection";
import {
  ScriptPackageState,
  type ManagedScriptPackage,
} from "./ScriptPackageState";
import { resolveScriptWorkspacePaths } from "./ScriptWorkspacePaths";

export class ScriptPackageCatalogError extends Schema.TaggedError<ScriptPackageCatalogError>()(
  "ScriptPackageCatalogError",
  {
    operation: Schema.Literal("scan"),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Failed to scan the script package catalog.";
  }
}

export interface ScriptPackageCatalogShape {
  readonly getOverview: Effect.Effect<
    ScriptCatalogOverview,
    ScriptPackageCatalogError
  >;
  readonly getDiscovery: Effect.Effect<
    DiscoveredScriptCatalog,
    ScriptPackageCatalogError
  >;
  readonly getPage: (
    request: ScriptCatalogPageRequest,
  ) => Effect.Effect<ScriptCatalogPage, ScriptPackageCatalogError>;
  readonly onChanged: (
    listener: Listener<ScriptCatalogChange>,
  ) => Effect.Effect<() => void>;
  readonly referenceForPath: (
    path: string,
  ) => Effect.Effect<ScriptReference | undefined, ScriptPackageCatalogError>;
  readonly refresh: Effect.Effect<
    ScriptCatalogOverview,
    ScriptPackageCatalogError
  >;
  readonly removePackage: (
    packageName: string,
  ) => Effect.Effect<ScriptCatalogOverview, ScriptPackageCatalogError>;
  readonly replacePackage: (
    replacement: ScriptPackageCatalogReplacement,
  ) => Effect.Effect<ScriptCatalogOverview, ScriptPackageCatalogError>;
  readonly resolveReference: (
    reference: ScriptReference,
  ) => Effect.Effect<ScriptCatalogEntry | undefined, ScriptPackageCatalogError>;
  readonly updateManagedPackage: (
    managed: ManagedScriptPackage,
  ) => Effect.Effect<ScriptCatalogOverview, ScriptPackageCatalogError>;
}

export class ScriptPackageCatalog extends Context.Service<
  ScriptPackageCatalog,
  ScriptPackageCatalogShape
>()("lucent/desktop/scripting/ScriptPackageCatalog") {}

export const layer = Layer.effect(
  ScriptPackageCatalog,
  Effect.gen(function* () {
    const app = yield* ElectronApp;
    const env = yield* DesktopEnvironment;
    const state = yield* ScriptPackageState;
    const currentVersion = yield* app.getVersion;
    const { packagesDir, scriptsDir } = resolveScriptWorkspacePaths(
      env.workspaceDir,
    );
    const changes = makeListenerRegistry<ScriptCatalogChange>();
    const discoveryRef = yield* SynchronizedRef.make<{
      readonly value: DiscoveredScriptCatalog | null;
      readonly publicationRevision: number;
    }>({ value: null, publicationRevision: 0 });
    const scan = Effect.gen(function* () {
      const managedPackages = yield* state.getAll;
      const failures: ScriptPackageInspectionFailure[] = [];
      const discovery = yield* Effect.tryPromise({
        try: async () => {
          await Promise.all([
            fs.mkdir(scriptsDir, { recursive: true }),
            fs.mkdir(packagesDir, { recursive: true }),
          ]);
          return discoverScriptCatalog({
            currentVersion,
            managedPackages,
            packagesDir,
            scriptsDir,
            onInspectionFailure: (failure) => failures.push(failure),
          });
        },
        catch: (cause) =>
          new ScriptPackageCatalogError({ operation: "scan", cause }),
      });
      if (failures.length > 0)
        yield* logScriptPackageInspectionFailures(failures);
      return discovery;
    });
    const publishCurrent = SynchronizedRef.get(discoveryRef).pipe(
      Effect.flatMap(({ value, publicationRevision }) =>
        value === null || publicationRevision === 0
          ? Effect.void
          : changes.publishLatest(publicationRevision, {
              revision: value.catalog.revision,
            }),
      ),
    );
    const getDiscovery = SynchronizedRef.modifyEffect(discoveryRef, (current) =>
      (current.value === null ? scan : Effect.succeed(current.value)).pipe(
        Effect.map((next) => [next, { ...current, value: next }] as const),
      ),
    );
    const refresh = SynchronizedRef.modifyEffect(discoveryRef, (current) =>
      scan.pipe(
        Effect.map(
          (next) =>
            [
              next,
              {
                value: next,
                publicationRevision: current.publicationRevision + 1,
              },
            ] as const,
        ),
      ),
    ).pipe(Effect.ensuring(publishCurrent), Effect.map(catalogOverview));
    const updateDiscovery = Effect.fn("ScriptPackageCatalog.updateDiscovery")(
      function* (
        transform: (
          current: DiscoveredScriptCatalog,
        ) => DiscoveredScriptCatalog | undefined,
      ) {
        const next = yield* SynchronizedRef.modifyEffect(
          discoveryRef,
          (current) =>
            (current.value === null
              ? scan
              : Effect.succeed(current.value)
            ).pipe(
              Effect.flatMap((previous) => {
                const transformed = transform(previous);
                return (
                  transformed === undefined ? scan : Effect.succeed(transformed)
                ).pipe(
                  Effect.map(
                    (next) =>
                      [
                        next,
                        {
                          value: next,
                          publicationRevision:
                            current.publicationRevision +
                            (previous === next ? 0 : 1),
                        },
                      ] as const,
                  ),
                );
              }),
            ),
        ).pipe(Effect.ensuring(publishCurrent));
        return catalogOverview(next);
      },
    );

    const referenceForPath = Effect.fn("ScriptPackageCatalog.referenceForPath")(
      function* (
        path: string,
      ): Effect.fn.Return<
        ScriptReference | undefined,
        ScriptPackageCatalogError
      > {
        const looseReference = yield* Effect.promise(() =>
          resolveLooseScriptReference(scriptsDir, path),
        );
        if (looseReference !== undefined) {
          return looseReference;
        }
        if (!isPathInside(packagesDir, path)) {
          return undefined;
        }

        const discovery = yield* getDiscovery;
        return discovery.paths.get(resolve(path));
      },
    );

    return ScriptPackageCatalog.of({
      getDiscovery,
      getOverview: getDiscovery.pipe(Effect.map(catalogOverview)),
      getPage: (request) =>
        getDiscovery.pipe(
          Effect.map((discovery) => {
            const query = request.query.trim().toLocaleLowerCase();
            const matching =
              query === ""
                ? discovery.catalog.scripts
                : discovery.catalog.scripts.filter((entry) =>
                    [
                      entry.name,
                      entry.relativePath,
                      entry.packageName ?? "",
                    ].some((value) =>
                      value.toLocaleLowerCase().includes(query),
                    ),
                  );
            return {
              entries: matching.slice(
                request.offset,
                request.offset + request.limit,
              ),
              offset: request.offset,
              revision: discovery.catalog.revision,
              total: matching.length,
            } satisfies ScriptCatalogPage;
          }),
        ),
      onChanged: changes.subscribe,
      referenceForPath,
      refresh,
      removePackage: (packageName) =>
        updateDiscovery((current) =>
          removeDiscoveredPackage(current, packageName),
        ),
      replacePackage: (replacement) =>
        updateDiscovery((current) =>
          replaceDiscoveredPackage(current, replacement, currentVersion),
        ),
      resolveReference: Effect.fn("ScriptPackageCatalog.resolveReference")(
        function* (reference) {
          if (reference.kind === "loose") {
            const path = resolve(scriptsDir, reference.path);
            const resolved = yield* Effect.promise(() =>
              resolveLooseScriptReference(scriptsDir, path),
            );
            if (resolved === undefined || resolved.path !== reference.path) {
              return undefined;
            }
            return {
              name: basename(path),
              path,
              reference: resolved,
              relativePath: resolved.path,
            } satisfies ScriptCatalogEntry;
          }
          const discovery = yield* getDiscovery;
          return discovery.scripts.get(referenceKey(reference));
        },
      ),
      updateManagedPackage: (managed) =>
        updateDiscovery((current) =>
          updateDiscoveredManagedPackage(current, managed),
        ),
    });
  }),
);
