import { promises as fs } from "node:fs";
import { basename, extname, join, relative, resolve, sep } from "node:path";

import * as Schema from "effect/Schema";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { FileSystem } from "effect/FileSystem";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import { satisfies, valid, validRange } from "semver";

import type {
  ScriptPackageCompatibility,
  ScriptPackageName,
  ScriptReference,
} from "@lucent/core/scriptPackages";
import {
  ScriptPackageDirectorySchema,
  ScriptPackageNameSchema,
  ScriptRelativePathSchema,
} from "@lucent/core/scriptPackages";
import {
  hashDirectory,
  isPathInside,
  listRegularFilePaths,
  portablePath,
} from "./ScriptPackageFileSystem";
import {
  formatBytes,
  SCRIPT_PACKAGE_MANIFEST_MAX_BYTES,
  SCRIPT_PACKAGE_MAX_FILES,
} from "./ScriptLimits";
import type { ManagedScriptPackage } from "./ScriptPackageState";
import { logFailure } from "../../shared/logFailure";
import {
  isMissingFileError,
  readFileBounded,
} from "../filesystem/BoundedFileSystem";

export interface ScriptPackageInspectionFailure {
  readonly packageName: string;
  readonly cause: unknown;
}

export const isUnexpectedPackageFileError = (cause: unknown): boolean =>
  cause instanceof Error &&
  "code" in cause &&
  typeof cause.code === "string" &&
  !isMissingFileError(cause);

export const logScriptPackageInspectionFailures = Effect.fnUntraced(function* (
  failures: readonly ScriptPackageInspectionFailure[],
) {
  if (failures.length === 0) return;
  const packageNames = [
    ...new Set(failures.map((failure) => failure.packageName)),
  ].toSorted();
  const cause = failures.reduce<Cause.Cause<unknown>>(
    (combined, failure) => Cause.combine(combined, Cause.fail(failure.cause)),
    Cause.empty,
  );
  yield* logFailure("Failed to inspect script package files", cause, {
    failure: "warning",
  }).pipe(
    Effect.annotateLogs({
      component: "script-packages",
      repeatKey: packageNames.join(","),
      data: { packageNames },
    }),
  );
});

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

export const decodePackageDirectory = Schema.decodeUnknownSync(
  ScriptPackageDirectorySchema,
);

const decodePackageName = Schema.decodeUnknownSync(ScriptPackageNameSchema);
export { decodePackageName };

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

export interface InspectedScriptPackageDirectory {
  readonly files: readonly string[];
  readonly mainPath: string | null;
  readonly manifest: ScriptPackageManifest & {
    readonly name: ScriptPackageName;
  };
}

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

  const read = await Effect.runPromiseExit(
    Effect.flatMap(FileSystem, (fileSystem) =>
      readFileBounded(fileSystem, path, SCRIPT_PACKAGE_MANIFEST_MAX_BYTES).pipe(
        Effect.mapError((cause) =>
          cause._tag === "FileSystemLimitError"
            ? new Error(
                `package.json exceeds the ${formatBytes(SCRIPT_PACKAGE_MANIFEST_MAX_BYTES)} limit.`,
              )
            : (cause.reason.cause ?? cause),
        ),
      ),
    ).pipe(Effect.provide(NodeFileSystem.layer)),
  );
  if (Exit.isFailure(read)) {
    throw Cause.squash(read.cause);
  }
  const bytes = read.value;
  const record = parseManifestJson(
    Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString(
      "utf8",
    ),
  );
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

export const compatibilityFor = (
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

export const isJavaScriptFile = (path: string): boolean => {
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
  onFailure?: (failure: ScriptPackageInspectionFailure) => void,
): Promise<"modified" | "unmanaged" | "verified"> => {
  if (managed === undefined) return "unmanaged";
  try {
    return hashesMatch(await hashDirectory(rootPath), managed.files)
      ? "verified"
      : "modified";
  } catch (cause) {
    if (isUnexpectedPackageFileError(cause))
      onFailure?.({ packageName: managed.name, cause });
    return "modified";
  }
};
