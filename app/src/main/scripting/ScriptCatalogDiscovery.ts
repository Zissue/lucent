import { promises as fs, type Dirent } from "node:fs";
import { basename, join, relative, resolve } from "node:path";

import { satisfies, valid } from "semver";

import type {
  ScriptCatalog,
  ScriptCatalogEntry,
  ScriptCatalogOverview,
  ScriptPackageCompatibility,
  ScriptPackageDependencyIssue,
  ScriptPackageDependencyStatus,
  ScriptPackageDirectory,
  ScriptPackageIntegrity,
  ScriptPackageSummary,
  ScriptReference,
} from "@lucent/core/scriptPackages";
import {
  isMissingFileError,
  isPathInside,
  listRegularFilePaths,
  portablePath,
  sha256Revision,
} from "./ScriptPackageFileSystem";
import {
  compatibilityFor,
  decodePackageDirectory,
  decodePackageName,
  inspectManagedPackageFolder,
  integrityFor,
  isJavaScriptFile,
  readScriptPackageManifest,
  type InspectedScriptPackageDirectory,
  type ScriptPackageManifest,
} from "./ScriptPackageInspection";
import type { ManagedScriptPackage } from "./ScriptPackageState";

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

export const referenceKey = (reference: ScriptReference): string =>
  reference.kind === "loose"
    ? `loose:${reference.path}`
    : `package:${reference.packageName}:${reference.path}`;

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

export const catalogOverview = (
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

export const replaceDiscoveredPackage = (
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

export const removeDiscoveredPackage = (
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

export const updateDiscoveredManagedPackage = (
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
