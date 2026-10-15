import { promises as fs, type Dirent } from "fs";
import { basename, extname, join, relative, resolve, sep } from "path";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SynchronizedRef from "effect/SynchronizedRef";
import { satisfies, valid, validRange } from "semver";

import type {
  ScriptCatalog,
  ScriptCatalogChange,
  ScriptCatalogEntry,
  ScriptCatalogOverview,
  ScriptCatalogPage,
  ScriptCatalogPageRequest,
  ScriptPackageCompatibility,
  ScriptPackageDependencyIssue,
  ScriptPackageDependencyStatus,
  ScriptPackageDirectory,
  ScriptPackageIntegrity,
  ScriptPackageName,
  ScriptPackageSummary,
  ScriptReference,
} from "@lucent/core/scriptPackages";
import {
  ScriptPackageDirectorySchema,
  ScriptPackageNameSchema,
  ScriptRelativePathSchema,
} from "@lucent/core/scriptPackages";
import { DesktopEnvironment } from "../app/DesktopEnvironment";
import { makeListenerRegistry, type Listener } from "../app/ListenerRegistry";
import { ElectronApp } from "../electron/ElectronApp";
import {
  hashDirectory,
  isMissingFileError,
  isPathInside,
  listRegularFilePaths,
  portablePath,
  sha256Revision,
} from "./ScriptPackageFileSystem";
import {
  formatBytes,
  SCRIPT_PACKAGE_MANIFEST_MAX_BYTES,
  SCRIPT_PACKAGE_MAX_FILES,
} from "./ScriptLimits";
import {
  ScriptPackageState,
  type ManagedScriptPackage,
} from "./ScriptPackageState";
import { resolveScriptWorkspacePaths } from "./ScriptWorkspacePaths";

const NonEmptyManifestStringSchema = Schema.String.check(
  Schema.makeFilter((value) => value.trim() !== "", {
    expected: "a non-empty string",
  }),
);

const ScriptPackageManifestJsonSchema = Schema.Struct({
  name: NonEmptyManifestStringSchema,
  description: Schema.optionalKey(Schema.String),
  lucent: Schema.optionalKey(
    Schema.Struct({
      dependencies: Schema.optionalKey(
        Schema.Record(Schema.String, Schema.String),
      ),
      version: Schema.optionalKey(Schema.String),
    }),
  ),
  main: Schema.optionalKey(Schema.String),
  type: Schema.optionalKey(Schema.String),
  version: Schema.optionalKey(Schema.String),
});

const decodeManifestJson = Schema.decodeUnknownSync(
  ScriptPackageManifestJsonSchema,
);
const decodePackageDirectory = Schema.decodeUnknownSync(
  ScriptPackageDirectorySchema,
);
const decodePackageName = Schema.decodeUnknownSync(ScriptPackageNameSchema);
const decodeRelativePath = Schema.decodeUnknownSync(ScriptRelativePathSchema);

/** Parses the manifest while keeping catalog diagnostics readable. */
const parseManifestJson = (
  source: string,
): typeof ScriptPackageManifestJsonSchema.Type => {
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch {
    throw new Error("package.json contains invalid JSON.");
  }

  try {
    return decodeManifestJson(value);
  } catch {
    throw new Error("package.json contains invalid fields.");
  }
};

export interface ScriptPackageManifest {
  readonly dependencies: Readonly<Record<string, string>>;
  readonly description?: string;
  readonly lucentVersion?: string;
  readonly main: string;
  readonly name: string;
  readonly type?: string;
  readonly version?: string;
}

export interface DiscoveredScriptPackage {
  readonly compatibility: ScriptPackageCompatibility;
  readonly dependencyStatus: ScriptPackageDependencyStatus;
  readonly directory: ScriptPackageDirectory;
  readonly files: readonly string[];
  readonly mainPath: string | null;
  readonly manifest: ScriptPackageManifest;
  readonly modules: ReadonlyMap<string, string>;
  readonly name: string;
  readonly rootPath: string;
}

export interface InspectedScriptPackageDirectory {
  readonly files: readonly string[];
  readonly mainPath: string | null;
  readonly manifest: ScriptPackageManifest & {
    readonly name: ScriptPackageName;
  };
}

export interface DiscoveredScriptCatalog {
  readonly catalog: ScriptCatalog;
  readonly paths: ReadonlyMap<string, ScriptReference>;
  readonly packages: ReadonlyMap<string, DiscoveredScriptPackage>;
  readonly scripts: ReadonlyMap<string, ScriptCatalogEntry>;
}

export interface ScriptPackageCatalogReplacement {
  readonly integrity?: ScriptPackageIntegrity;
  readonly inspected: InspectedScriptPackageDirectory;
  readonly managed: ManagedScriptPackage;
  readonly rootPath: string;
  readonly sourceRoot: string;
}

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

const optionalString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;

export const readScriptPackageManifest = async (
  path: string,
): Promise<ScriptPackageManifest> => {
  const stat = await fs.lstat(path);
  if (!stat.isFile()) throw new Error("package.json must be a file.");
  if (stat.size > SCRIPT_PACKAGE_MANIFEST_MAX_BYTES) {
    throw new Error(
      `package.json exceeds the ${formatBytes(SCRIPT_PACKAGE_MANIFEST_MAX_BYTES)} limit.`,
    );
  }

  const record = parseManifestJson(await fs.readFile(path, "utf8"));
  const lucentVersion = optionalString(record.lucent?.version);
  const description = optionalString(record.description);
  const type = optionalString(record.type);
  const declaredVersion = optionalString(record.version);
  const version =
    declaredVersion === undefined ? undefined : valid(declaredVersion);
  if (declaredVersion !== undefined && version === null) {
    throw new Error("The package version must be an exact semantic version.");
  }
  const dependencies: Record<string, string> = Object.create(null) as Record<
    string,
    string
  >;
  for (const [dependencyName, rawRange] of Object.entries(
    record.lucent?.dependencies ?? {},
  )) {
    try {
      decodePackageName(dependencyName);
    } catch {
      throw new Error(
        `The Lucent dependency name (${JSON.stringify(dependencyName)}) is invalid.`,
      );
    }
    if (dependencyName === record.name) {
      throw new Error(
        "A package must not declare itself as a Lucent dependency.",
      );
    }
    const dependencyRange = optionalString(rawRange);
    if (dependencyRange === undefined || validRange(dependencyRange) === null) {
      throw new Error(
        `The Lucent dependency version for ${JSON.stringify(dependencyName)} is invalid.`,
      );
    }
    dependencies[dependencyName] = dependencyRange;
  }
  return {
    dependencies,
    name: record.name,
    main: optionalString(record.main) ?? "index.js",
    ...(description === undefined ? {} : { description }),
    ...(lucentVersion === undefined ? {} : { lucentVersion }),
    ...(type === undefined ? {} : { type }),
    ...(version === undefined || version === null ? {} : { version }),
  };
};

const parsePackageName = (name: string): ScriptPackageName => {
  try {
    return decodePackageName(name);
  } catch {
    throw new Error("The package name contains unsupported characters.");
  }
};

const compatibilityFor = (
  currentVersion: string,
  requiredVersion: string | undefined,
): ScriptPackageCompatibility => {
  if (requiredVersion === undefined) {
    return { status: "unknown", currentVersion };
  }
  const normalizedRange = validRange(requiredVersion, {
    includePrerelease: true,
  });
  if (normalizedRange === null) {
    return {
      status: "unknown",
      currentVersion,
      warning: `The Lucent version requirement is invalid: ${requiredVersion}.`,
    };
  }
  return {
    status: satisfies(currentVersion, normalizedRange, {
      includePrerelease: true,
    })
      ? "compatible"
      : "incompatible",
    currentVersion,
    requiredVersion,
  };
};

const isJavaScriptFile = (path: string): boolean => {
  const extension = extname(path).toLowerCase();
  return extension === ".js" || extension === ".cjs";
};

/** Resolves a selected loose script without enumerating the script library. */
export const resolveLooseScriptReference = async (
  scriptsDir: string,
  path: string,
): Promise<
  Extract<ScriptReference, { readonly kind: "loose" }> | undefined
> => {
  const rootPath = resolve(scriptsDir);
  const selectedPath = resolve(path);
  const selectedName = basename(selectedPath);
  if (
    selectedPath === rootPath ||
    !isPathInside(rootPath, selectedPath) ||
    !isJavaScriptFile(selectedPath) ||
    selectedName.startsWith("._")
  ) {
    return undefined;
  }

  const nativeRelativePath = relative(rootPath, selectedPath);
  const segments = nativeRelativePath.split(sep);
  let currentPath = rootPath;
  try {
    for (const [index, segment] of segments.entries()) {
      currentPath = join(currentPath, segment);
      const stat = await fs.lstat(currentPath);
      if (stat.isSymbolicLink()) return undefined;

      const isSelectedFile = index === segments.length - 1;
      if (isSelectedFile ? !stat.isFile() : !stat.isDirectory()) {
        return undefined;
      }
    }
  } catch {
    return undefined;
  }

  return { kind: "loose", path: portablePath(nativeRelativePath) };
};

const referenceKey = (reference: ScriptReference): string =>
  reference.kind === "loose"
    ? `loose:${reference.path}`
    : `package:${reference.packageName}:${reference.path}`;

const resolveMainPath = async (
  packageRoot: string,
  value: string,
): Promise<string | null> => {
  try {
    decodeRelativePath(value);
  } catch {
    throw new Error("The package.json main path is invalid.");
  }
  const segments = value.split("/");

  const initial = resolve(packageRoot, ...segments);
  if (!isPathInside(packageRoot, initial)) {
    throw new Error(
      "The package.json main path points outside the package folder.",
    );
  }
  const extension = extname(initial).toLowerCase();
  const candidates =
    extension === ".js" || extension === ".cjs"
      ? [initial]
      : [
          initial,
          `${initial}.js`,
          `${initial}.cjs`,
          join(initial, "index.js"),
          join(initial, "index.cjs"),
        ];

  for (const candidate of candidates) {
    try {
      const stat = await fs.lstat(candidate);
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      const realPath = await fs.realpath(candidate);
      if (!isPathInside(await fs.realpath(packageRoot), realPath)) {
        throw new Error(
          "The package.json main path points outside the package folder.",
        );
      }
      return candidate;
    } catch (cause) {
      if (isMissingFileError(cause)) continue;
      throw cause;
    }
  }
  return null;
};

/** Validates one package boundary and returns its loadable JavaScript inventory. */
export const inspectScriptPackageDirectory = async (
  rootPath: string,
): Promise<InspectedScriptPackageDirectory> => {
  const manifest = await readScriptPackageManifest(
    join(rootPath, "package.json"),
  );
  const name = parsePackageName(manifest.name);
  const [mainPath, inventory] = await Promise.all([
    resolveMainPath(rootPath, manifest.main),
    listRegularFilePaths(rootPath, { maxFiles: SCRIPT_PACKAGE_MAX_FILES }),
  ]);
  return {
    files: inventory
      .filter((file) => isJavaScriptFile(file.relativePath))
      .map((file) => file.absolutePath),
    mainPath,
    manifest: { ...manifest, name },
  };
};

const hashesMatch = (
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>,
): boolean => {
  const leftEntries = Object.entries(left);
  const rightEntries = Object.entries(right);
  return (
    leftEntries.length === rightEntries.length &&
    leftEntries.every(([path, hash]) => right[path] === hash)
  );
};

export const inspectManagedPackageFolder = async (
  packagesDir: string,
  rootPath: string,
  managed: ManagedScriptPackage | undefined,
): Promise<InspectedScriptPackageDirectory> => {
  if (!(await fs.lstat(rootPath)).isDirectory()) {
    throw new Error("The package folder is not a regular directory.");
  }
  const inspected = await inspectScriptPackageDirectory(rootPath);
  if (managed !== undefined && managed.name !== inspected.manifest.name) {
    throw new Error(
      `The installed package name is ${JSON.stringify(managed.name)}, but package.json declares ${JSON.stringify(inspected.manifest.name)}.`,
    );
  }
  if (
    !isPathInside(await fs.realpath(packagesDir), await fs.realpath(rootPath))
  ) {
    throw new Error("The package points outside Lucent's packages folder.");
  }
  return inspected;
};

export const integrityFor = async (
  rootPath: string,
  managed: ManagedScriptPackage | undefined,
): Promise<"modified" | "unmanaged" | "verified"> => {
  if (managed === undefined) return "unmanaged";
  try {
    return hashesMatch(await hashDirectory(rootPath), managed.files)
      ? "verified"
      : "modified";
  } catch {
    return "modified";
  }
};

const naturalCompare = (left: string, right: string): number =>
  left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" });

/** Returns the script's parent directory relative to its loose or package root. */
const scriptDirectory = (entry: ScriptCatalogEntry): string => {
  const separatorIndex = entry.relativePath.lastIndexOf("/");
  return separatorIndex === -1
    ? ""
    : entry.relativePath.slice(0, separatorIndex);
};

const compareScripts = (
  left: ScriptCatalogEntry,
  right: ScriptCatalogEntry,
): number => {
  const packageOrder = naturalCompare(
    left.packageName ?? "",
    right.packageName ?? "",
  );
  if (packageOrder !== 0) return packageOrder;

  const directoryOrder = naturalCompare(
    scriptDirectory(left),
    scriptDirectory(right),
  );
  if (directoryOrder !== 0) return directoryOrder;

  const nameOrder = naturalCompare(left.name, right.name);
  return nameOrder !== 0
    ? nameOrder
    : naturalCompare(left.relativePath, right.relativePath);
};

const comparePackages = (
  left: ScriptPackageSummary,
  right: ScriptPackageSummary,
): number => naturalCompare(left.name ?? left.path, right.name ?? right.path);

const catalogRevision = (
  packages: readonly ScriptPackageSummary[],
  scripts: readonly ScriptCatalogEntry[],
): string =>
  sha256Revision(
    JSON.stringify({
      packages,
      scripts: scripts.map(
        ({ name, packageName, reference, relativePath }) => ({
          name,
          packageName,
          reference,
          relativePath,
        }),
      ),
    }),
  );

const dependencyStatusesFor = (
  packageIndex: ReadonlyMap<string, DiscoveredScriptPackage>,
): ReadonlyMap<string, ScriptPackageDependencyStatus> => {
  const issuesByPackage = new Map<string, ScriptPackageDependencyIssue[]>();
  const resolvedDependencies = new Map<
    string,
    readonly (readonly [packageName: string, requiredVersion: string])[]
  >();

  for (const packageEntry of packageIndex.values()) {
    const issues: ScriptPackageDependencyIssue[] = [];
    const dependencies: (readonly [string, string])[] = [];
    for (const [packageName, requiredVersion] of Object.entries(
      packageEntry.manifest.dependencies,
    ).toSorted(([left], [right]) => naturalCompare(left, right))) {
      const dependency = packageIndex.get(packageName);
      if (dependency === undefined) {
        issues.push({ reason: "missing", packageName, requiredVersion });
        continue;
      }

      const installedVersion =
        dependency.manifest.version === undefined
          ? null
          : valid(dependency.manifest.version);
      if (installedVersion === null) {
        issues.push({
          reason: "version-unavailable",
          packageName,
          requiredVersion,
        });
        continue;
      }
      if (!satisfies(installedVersion, requiredVersion)) {
        issues.push({
          reason: "version-mismatch",
          installedVersion,
          packageName,
          requiredVersion,
        });
        continue;
      }
      if (
        dependency.compatibility.status === "incompatible" ||
        dependency.mainPath === null
      ) {
        issues.push({ reason: "unavailable", packageName, requiredVersion });
        continue;
      }

      dependencies.push([packageName, requiredVersion]);
    }
    issuesByPackage.set(packageEntry.name, issues);
    resolvedDependencies.set(packageEntry.name, dependencies);
  }

  // Propagate failures until stable. A dependency cycle stays ready unless one
  // of its members has a concrete failure outside the cycle.
  let changed = true;
  while (changed) {
    changed = false;
    for (const packageEntry of packageIndex.values()) {
      const issues = issuesByPackage.get(packageEntry.name);
      if (issues === undefined || issues.length > 0) continue;
      const unavailable = (resolvedDependencies.get(packageEntry.name) ?? [])
        .filter(
          ([packageName]) =>
            (issuesByPackage.get(packageName)?.length ?? 0) > 0,
        )
        .map(
          ([packageName, requiredVersion]): ScriptPackageDependencyIssue => ({
            reason: "unavailable",
            packageName,
            requiredVersion,
          }),
        );
      if (unavailable.length === 0) continue;
      issues.push(...unavailable);
      changed = true;
    }
  }

  return new Map(
    [...packageIndex.keys()].map((name) => {
      const issues = issuesByPackage.get(name) ?? [];
      return [
        name,
        issues.length === 0
          ? { status: "ready" }
          : { status: "blocked", issues },
      ] as const;
    }),
  );
};

const makeDiscoveredScriptCatalog = (
  packages: readonly ScriptPackageSummary[],
  scripts: readonly ScriptCatalogEntry[],
  packageIndex: ReadonlyMap<string, DiscoveredScriptPackage>,
): DiscoveredScriptCatalog => {
  const dependencyStatuses = dependencyStatusesFor(packageIndex);
  const resolvedPackages = packages.map(
    (entry): ScriptPackageSummary =>
      entry.status === "valid"
        ? {
            ...entry,
            dependencyStatus:
              dependencyStatuses.get(entry.name) ?? entry.dependencyStatus,
          }
        : entry,
  );
  const resolvedPackageIndex = new Map(
    [...packageIndex].map(([name, entry]) => [
      name,
      {
        ...entry,
        dependencyStatus:
          dependencyStatuses.get(name) ?? entry.dependencyStatus,
      },
    ]),
  );
  const sortedPackages = resolvedPackages.toSorted(comparePackages);
  const sortedScripts = scripts.toSorted(compareScripts);
  const pathIndex = new Map<string, ScriptReference>();
  const scriptIndex = new Map<string, ScriptCatalogEntry>();
  for (const script of sortedScripts) {
    scriptIndex.set(referenceKey(script.reference), script);
    pathIndex.set(resolve(script.path), script.reference);
  }
  return {
    catalog: {
      packages: sortedPackages,
      revision: catalogRevision(sortedPackages, sortedScripts),
      scripts: sortedScripts,
    },
    packages: resolvedPackageIndex,
    paths: pathIndex,
    scripts: scriptIndex,
  };
};

const catalogOverview = (
  discovery: DiscoveredScriptCatalog,
): ScriptCatalogOverview => ({
  packages: discovery.catalog.packages,
  revision: discovery.catalog.revision,
  scriptCount: discovery.catalog.scripts.length,
});

const packageModuleIndex = (
  rootPath: string,
  files: readonly string[],
): ReadonlyMap<string, string> =>
  new Map(
    files.map(
      (path) => [portablePath(relative(rootPath, path)), path] as const,
    ),
  );

export interface DiscoverScriptCatalogOptions {
  readonly currentVersion: string;
  readonly managedPackages?: readonly ManagedScriptPackage[];
  readonly packagesDir: string;
  readonly scriptsDir: string;
}

type ValidPackageSummary = Extract<
  ScriptPackageSummary,
  { readonly status: "valid" }
>;

type InvalidPackageSummary = Extract<
  ScriptPackageSummary,
  { readonly status: "invalid" }
>;

type ScannedPackage =
  | {
      readonly status: "valid";
      readonly name: string;
      readonly packageEntry: DiscoveredScriptPackage;
      readonly scripts: readonly ScriptCatalogEntry[];
      readonly summary: ValidPackageSummary;
    }
  | {
      readonly status: "invalid";
      readonly summary: InvalidPackageSummary;
      readonly validatedName?: string;
    };

export const discoverScriptCatalog = async (
  options: DiscoverScriptCatalogOptions,
): Promise<DiscoveredScriptCatalog> => {
  const scripts: ScriptCatalogEntry[] = [];
  const packages: ScriptPackageSummary[] = [];
  const packageIndex = new Map<string, DiscoveredScriptPackage>();
  const managedPackages = new Map(
    (options.managedPackages ?? []).map((entry) => [entry.directory, entry]),
  );

  const looseFiles = await listRegularFilePaths(options.scriptsDir);
  for (const file of looseFiles) {
    if (!isJavaScriptFile(file.relativePath)) continue;
    const reference: ScriptReference = {
      kind: "loose",
      path: file.relativePath,
    };
    scripts.push({
      name: basename(file.relativePath),
      path: file.absolutePath,
      reference,
      relativePath: file.relativePath,
    });
  }

  let packageDirectories: Dirent[];
  try {
    packageDirectories = await fs.readdir(options.packagesDir, {
      encoding: "utf8",
      withFileTypes: true,
    });
  } catch (cause) {
    if (!isMissingFileError(cause)) throw cause;
    packageDirectories = [];
  }
  packageDirectories.sort((left, right) =>
    naturalCompare(left.name, right.name),
  );

  const scannedPackages: ScannedPackage[] = [];
  for (const entry of packageDirectories) {
    if (!entry.isDirectory()) continue;
    const directory = join(options.packagesDir, entry.name);
    let parsedName: string | undefined;
    let validatedName: string | undefined;
    try {
      const directoryName = decodePackageDirectory(entry.name);
      parsedName = (
        await readScriptPackageManifest(join(directory, "package.json"))
      ).name;
      validatedName = decodePackageName(parsedName);
      const managed = managedPackages.get(directoryName);
      const inspected = await inspectManagedPackageFolder(
        options.packagesDir,
        directory,
        managed,
      );
      const { mainPath, manifest } = inspected;
      const compatibility = compatibilityFor(
        options.currentVersion,
        manifest.lucentVersion,
      );
      const integrity = await integrityFor(directory, managed);
      const warning =
        compatibility.status === "unknown"
          ? compatibility.warning
          : mainPath === null
            ? `The package's main file was not found: ${manifest.main}.`
            : undefined;
      const summary: ValidPackageSummary = {
        status: "valid",
        compatibility,
        dependencyStatus: { status: "ready" },
        ...(manifest.description === undefined
          ? {}
          : { description: manifest.description }),
        integrity,
        name: manifest.name,
        path: directory,
        ...(managed === undefined ? {} : { source: managed.source }),
        update: managed?.update ?? { status: "unchecked" },
        ...(manifest.version === undefined
          ? {}
          : { version: manifest.version }),
        ...(warning === undefined ? {} : { warning }),
      };
      const packageEntry: DiscoveredScriptPackage = {
        compatibility,
        dependencyStatus: { status: "ready" },
        directory: directoryName,
        files: inspected.files,
        mainPath,
        manifest,
        modules: packageModuleIndex(directory, inspected.files),
        name: manifest.name,
        rootPath: directory,
      };
      const packageScripts: ScriptCatalogEntry[] = [];
      const scriptRoot = join(directory, "scripts");
      for (const absolutePath of inspected.files) {
        if (!isPathInside(scriptRoot, absolutePath)) continue;
        const packageScriptPath = portablePath(
          relative(directory, absolutePath),
        );
        if (packageScriptPath === "scripts") continue;
        const relativePath = portablePath(relative(scriptRoot, absolutePath));
        packageScripts.push({
          name: basename(relativePath),
          packageName: manifest.name,
          path: absolutePath,
          reference: {
            kind: "package",
            packageName: manifest.name,
            path: packageScriptPath,
          },
          relativePath,
        });
      }
      scannedPackages.push({
        status: "valid",
        name: manifest.name,
        packageEntry,
        scripts: packageScripts,
        summary,
      });
    } catch (cause) {
      scannedPackages.push({
        status: "invalid",
        summary: {
          status: "invalid",
          diagnostic:
            parsedName === undefined && isMissingFileError(cause)
              ? "This folder does not contain a package.json."
              : cause instanceof Error && cause.message !== ""
                ? cause.message
                : "This folder isn't a valid package.",
          ...(parsedName === undefined ? {} : { name: parsedName }),
          path: directory,
        },
        ...(validatedName === undefined ? {} : { validatedName }),
      });
    }
  }

  const packageNameCounts = new Map<string, number>();
  for (const scanned of scannedPackages) {
    const name =
      scanned.status === "valid" ? scanned.name : scanned.validatedName;
    if (name !== undefined) {
      packageNameCounts.set(name, (packageNameCounts.get(name) ?? 0) + 1);
    }
  }
  for (const scanned of scannedPackages) {
    const name =
      scanned.status === "valid" ? scanned.name : scanned.validatedName;
    if (name !== undefined && (packageNameCounts.get(name) ?? 0) > 1) {
      packages.push({
        status: "invalid",
        diagnostic: `More than one package folder declares the name ${JSON.stringify(name)}.`,
        name,
        path: scanned.summary.path,
      });
      continue;
    }
    packages.push(scanned.summary);
    if (scanned.status === "valid") {
      packageIndex.set(scanned.name, scanned.packageEntry);
      scripts.push(...scanned.scripts);
    }
  }

  return makeDiscoveredScriptCatalog(packages, scripts, packageIndex);
};

const replaceDiscoveredPackage = (
  current: DiscoveredScriptCatalog,
  replacement: ScriptPackageCatalogReplacement,
  currentVersion: string,
): DiscoveredScriptCatalog | undefined => {
  const { inspected, managed, rootPath, sourceRoot } = replacement;
  const normalizedRoot = resolve(rootPath);
  if (
    current.catalog.packages.some(
      (entry) =>
        entry.status === "valid" &&
        entry.name === managed.name &&
        resolve(entry.path) !== normalizedRoot,
    )
  )
    return undefined;
  const remapPath = (path: string): string =>
    resolve(rootPath, relative(sourceRoot, path));
  const files = inspected.files.map(remapPath);
  const mainPath =
    inspected.mainPath === null ? null : remapPath(inspected.mainPath);
  const compatibility = compatibilityFor(
    currentVersion,
    inspected.manifest.lucentVersion,
  );
  const warning =
    compatibility.status === "unknown"
      ? compatibility.warning
      : mainPath === null
        ? `The package's main file was not found: ${inspected.manifest.main}.`
        : undefined;
  const summary: ScriptPackageSummary = {
    status: "valid",
    compatibility,
    dependencyStatus: { status: "ready" },
    ...(inspected.manifest.description === undefined
      ? {}
      : { description: inspected.manifest.description }),
    integrity: replacement.integrity ?? "verified",
    name: managed.name,
    path: rootPath,
    source: managed.source,
    update: managed.update ?? { status: "unchecked" },
    ...(inspected.manifest.version === undefined
      ? {}
      : { version: inspected.manifest.version }),
    ...(warning === undefined ? {} : { warning }),
  };
  const packageEntry: DiscoveredScriptPackage = {
    compatibility,
    dependencyStatus: { status: "ready" },
    directory: managed.directory,
    files,
    mainPath,
    manifest: inspected.manifest,
    modules: packageModuleIndex(rootPath, files),
    name: managed.name,
    rootPath,
  };
  const scriptRoot = join(rootPath, "scripts");
  const scripts = current.catalog.scripts.filter(
    (entry) =>
      entry.reference.kind !== "package" ||
      entry.reference.packageName !== managed.name,
  );
  for (const absolutePath of files) {
    if (!isPathInside(scriptRoot, absolutePath)) continue;
    const packageScriptPath = portablePath(relative(rootPath, absolutePath));
    if (packageScriptPath === "scripts") continue;
    const relativePath = portablePath(relative(scriptRoot, absolutePath));
    scripts.push({
      name: basename(relativePath),
      packageName: managed.name,
      path: absolutePath,
      reference: {
        kind: "package",
        packageName: managed.name,
        path: packageScriptPath,
      },
      relativePath,
    });
  }

  const packages = current.catalog.packages.filter(
    (entry) => resolve(entry.path) !== normalizedRoot,
  );
  packages.push(summary);
  const packageIndex = new Map(current.packages);
  packageIndex.set(managed.name, packageEntry);
  return makeDiscoveredScriptCatalog(packages, scripts, packageIndex);
};

const removeDiscoveredPackage = (
  current: DiscoveredScriptCatalog,
  packageName: string,
): DiscoveredScriptCatalog => {
  const rootPath = current.packages.get(packageName)?.rootPath;
  const packages = current.catalog.packages.filter(
    (entry) =>
      !(entry.status === "valid" && entry.name === packageName) &&
      (rootPath === undefined || resolve(entry.path) !== resolve(rootPath)),
  );
  const scripts = current.catalog.scripts.filter(
    (entry) =>
      entry.reference.kind !== "package" ||
      entry.reference.packageName !== packageName,
  );
  const packageIndex = new Map(current.packages);
  packageIndex.delete(packageName);
  return makeDiscoveredScriptCatalog(packages, scripts, packageIndex);
};

const updateDiscoveredManagedPackage = (
  current: DiscoveredScriptCatalog,
  managed: ManagedScriptPackage,
): DiscoveredScriptCatalog => {
  let changed = false;
  const packages = current.catalog.packages.map((entry) => {
    if (entry.status !== "valid" || entry.name !== managed.name) return entry;
    changed = true;
    return {
      ...entry,
      source: managed.source,
      update: managed.update ?? { status: "unchecked" },
    } satisfies ScriptPackageSummary;
  });
  return changed
    ? makeDiscoveredScriptCatalog(
        packages,
        current.catalog.scripts,
        current.packages,
      )
    : current;
};

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
    const discoveryRef =
      yield* SynchronizedRef.make<DiscoveredScriptCatalog | null>(null);
    const scan = Effect.gen(function* () {
      const managedPackages = yield* state.getAll;
      return yield* Effect.tryPromise({
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
          });
        },
        catch: (cause) =>
          new ScriptPackageCatalogError({ operation: "scan", cause }),
      });
    });
    const getDiscovery = SynchronizedRef.modifyEffect(discoveryRef, (current) =>
      (current === null ? scan : Effect.succeed(current)).pipe(
        Effect.map((next) => [next, next] as const),
      ),
    );
    const refresh = SynchronizedRef.modifyEffect(discoveryRef, () =>
      scan.pipe(
        Effect.tap((next) =>
          changes.publish({ revision: next.catalog.revision }),
        ),
        Effect.map((next) => [next, next] as const),
      ),
    ).pipe(Effect.map(catalogOverview));
    const updateDiscovery = Effect.fn("ScriptPackageCatalog.updateDiscovery")(
      function* (
        transform: (
          current: DiscoveredScriptCatalog,
        ) => DiscoveredScriptCatalog | undefined,
      ) {
        const next = yield* SynchronizedRef.modifyEffect(
          discoveryRef,
          (current) =>
            (current === null ? scan : Effect.succeed(current)).pipe(
              Effect.flatMap((previous) => {
                const transformed = transform(previous);
                return (
                  transformed === undefined ? scan : Effect.succeed(transformed)
                ).pipe(
                  Effect.flatMap((next) =>
                    (previous === next
                      ? Effect.void
                      : changes.publish({ revision: next.catalog.revision })
                    ).pipe(Effect.as([next, next] as const)),
                  ),
                );
              }),
            ),
        );
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
