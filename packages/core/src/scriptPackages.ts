import * as Schema from "effect/Schema";

import { NonNegativeInt, boundedInt } from "./baseSchemas";
import { parseScriptPathSegments } from "./scriptPath";

const hasScriptPathSyntax = (value: string): boolean =>
  parseScriptPathSegments(value) !== null;

export const isScriptPackageRepositorySubdirectory = (value: string): boolean =>
  value.trim() === value &&
  value.normalize("NFC") === value &&
  hasScriptPathSyntax(value);

export const ScriptPackageRepositorySubdirectorySchema = Schema.String.check(
  Schema.makeFilter(isScriptPackageRepositorySubdirectory, {
    expected: "a portable repository-relative path using forward slashes",
  }),
);

export type ScriptPackageRepositorySubdirectory =
  typeof ScriptPackageRepositorySubdirectorySchema.Type;

export const SCRIPT_BUILTIN_MODULE_SPECIFIERS = [
  "effect",
  "lucent/api",
  "lucent/autorelogin",
  "lucent/autozone",
  "lucent/filesystem",
  "lucent/http",
  "lucent/schema",
  "lucent/script",
] as const;

export type ScriptBuiltinModuleSpecifier =
  (typeof SCRIPT_BUILTIN_MODULE_SPECIFIERS)[number];

const scriptBuiltinModuleSpecifiers = new Set<string>(
  SCRIPT_BUILTIN_MODULE_SPECIFIERS,
);

export const isScriptBuiltinModuleSpecifier = (
  specifier: string,
): specifier is ScriptBuiltinModuleSpecifier =>
  scriptBuiltinModuleSpecifiers.has(specifier);

const isReservedScriptPackageName = (name: string): boolean =>
  name === "effect" ||
  name === "lucent" /* Reserved */ ||
  name.startsWith("lucent/");

export const ScriptPackageNameSchema = Schema.String.check(
  Schema.makeFilter(
    (name) =>
      name.trim() === name &&
      !isReservedScriptPackageName(name) &&
      hasScriptPathSyntax(name),
    {
      expected: "a safe, case-sensitive, non-reserved package name",
    },
  ),
);

export type ScriptPackageName = typeof ScriptPackageNameSchema.Type;

export const ScriptPackageDirectorySchema = Schema.String.check(
  Schema.makeFilter(
    (value) =>
      value.trim() === value &&
      value.normalize("NFC") === value &&
      !value.includes("/") &&
      hasScriptPathSyntax(value),
    { expected: "a portable single folder name" },
  ),
);

export type ScriptPackageDirectory = typeof ScriptPackageDirectorySchema.Type;

export const ScriptRelativePathSchema = Schema.String.check(
  Schema.makeFilter(hasScriptPathSyntax, {
    expected: "a safe relative path using forward slashes",
  }),
);

export const ScriptReferenceSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("loose"),
    path: ScriptRelativePathSchema,
  }),
  Schema.Struct({
    kind: Schema.Literal("package"),
    packageName: ScriptPackageNameSchema,
    path: ScriptRelativePathSchema,
  }),
]);

export type ScriptReference = typeof ScriptReferenceSchema.Type;

export const ScriptPackageCompatibilitySchema = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("compatible"),
    currentVersion: Schema.String,
    requiredVersion: Schema.String,
  }),
  Schema.Struct({
    status: Schema.Literal("incompatible"),
    currentVersion: Schema.String,
    requiredVersion: Schema.String,
  }),
  Schema.Struct({
    status: Schema.Literal("unknown"),
    currentVersion: Schema.String,
    warning: Schema.optionalKey(Schema.String),
  }),
]);

export type ScriptPackageCompatibility =
  typeof ScriptPackageCompatibilitySchema.Type;

export const ScriptModuleImportSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("builtin"),
    specifier: Schema.Literals(SCRIPT_BUILTIN_MODULE_SPECIFIERS),
  }),
  Schema.Struct({
    kind: Schema.Literal("module"),
    moduleId: Schema.String,
  }),
]);

export type ScriptModuleImport = typeof ScriptModuleImportSchema.Type;

export const ScriptModuleSourceSchema = Schema.Struct({
  id: Schema.String,
  format: Schema.Literals(["commonjs", "unsupported-esm"]),
  imports: Schema.Record(Schema.String, ScriptModuleImportSchema),
  localPath: Schema.String,
  path: Schema.String,
  packageName: Schema.optionalKey(Schema.String),
  revision: Schema.String,
  source: Schema.String,
});

export type ScriptModuleSource = typeof ScriptModuleSourceSchema.Type;

export const ScriptExecutionPackageSchema = Schema.Struct({
  name: Schema.String,
  rootPath: Schema.String,
  mainModuleId: Schema.NullOr(Schema.String),
  compatibility: ScriptPackageCompatibilitySchema,
});

export type ScriptExecutionPackage = typeof ScriptExecutionPackageSchema.Type;

export const ScriptExecutionSnapshotSchema = Schema.Struct({
  entryModuleId: Schema.String,
  modules: Schema.Array(ScriptModuleSourceSchema),
  packages: Schema.Array(ScriptExecutionPackageSchema),
  revision: Schema.String,
});

export type ScriptExecutionSnapshot = typeof ScriptExecutionSnapshotSchema.Type;

export const isRelativeScriptModuleSpecifier = (specifier: string): boolean =>
  specifier === "." ||
  specifier === ".." ||
  specifier.startsWith("./") ||
  specifier.startsWith("../");

export const resolveRelativeScriptModulePath = (
  importerPath: string,
  specifier: string,
): string | null => {
  const base = importerPath.split("/").slice(0, -1);
  for (const segment of specifier.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (base.length === 0) return null;
      base.pop();
      continue;
    }
    base.push(segment);
  }
  return base.join("/");
};

export const scriptModulePathCandidates = (path: string): readonly string[] =>
  path.endsWith(".js") || path.endsWith(".cjs")
    ? [path]
    : [
        path,
        `${path}.js`,
        `${path}.cjs`,
        `${path}/index.js`,
        `${path}/index.cjs`,
      ];

export const ScriptCatalogEntrySchema = Schema.Struct({
  name: Schema.String,
  path: Schema.String,
  relativePath: Schema.String,
  packageName: Schema.optionalKey(Schema.String),
  reference: ScriptReferenceSchema,
});

export type ScriptCatalogEntry = typeof ScriptCatalogEntrySchema.Type;

export const ScriptPackageIntegritySchema = Schema.Literals([
  "modified",
  "unmanaged",
  "verified",
]);

export type ScriptPackageIntegrity = typeof ScriptPackageIntegritySchema.Type;

const ScriptPackageRepositorySourceFields = {
  repositoryUrl: Schema.String,
  requestedRef: Schema.optionalKey(Schema.String),
  credentialId: Schema.optionalKey(Schema.String),
} as const;

export const ScriptPackageSourceSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("repository"),
    ...ScriptPackageRepositorySourceFields,
    resolvedCommit: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("directory"),
    ...ScriptPackageRepositorySourceFields,
    // Local bundled copies have an exact tree without a resolved remote commit.
    resolvedCommit: Schema.optionalKey(Schema.String),
    resolvedTree: Schema.String,
    subdirectory: ScriptPackageRepositorySubdirectorySchema,
  }),
]);

export type ScriptPackageSource = typeof ScriptPackageSourceSchema.Type;

export const ScriptPackageRevisionSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("commit"), sha: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("tree"), sha: Schema.String }),
]);

export type ScriptPackageRevision = typeof ScriptPackageRevisionSchema.Type;

export const ScriptPackageUpdateStateSchema = Schema.Union([
  Schema.Struct({ status: Schema.Literal("unchecked") }),
  Schema.Struct({
    status: Schema.Literal("current"),
    checkedAt: Schema.String,
  }),
  Schema.Struct({
    status: Schema.Literal("available"),
    checkedAt: Schema.String,
    revision: ScriptPackageRevisionSchema,
  }),
  Schema.Struct({
    status: Schema.Literal("unknown"),
    checkedAt: Schema.optionalKey(Schema.String),
    message: Schema.String,
  }),
  Schema.Struct({
    status: Schema.Literal("rate-limited"),
    retryAt: Schema.String,
    message: Schema.String,
  }),
]);

export type ScriptPackageUpdateState =
  typeof ScriptPackageUpdateStateSchema.Type;

export const ScriptPackageDependencyIssueSchema = Schema.Union([
  Schema.Struct({
    reason: Schema.Literal("missing"),
    packageName: Schema.String,
    requiredVersion: Schema.String,
  }),
  Schema.Struct({
    reason: Schema.Literal("version-mismatch"),
    installedVersion: Schema.String,
    packageName: Schema.String,
    requiredVersion: Schema.String,
  }),
  Schema.Struct({
    reason: Schema.Literal("version-unavailable"),
    packageName: Schema.String,
    requiredVersion: Schema.String,
  }),
  Schema.Struct({
    reason: Schema.Literal("unavailable"),
    packageName: Schema.String,
    requiredVersion: Schema.String,
  }),
]);

export type ScriptPackageDependencyIssue =
  typeof ScriptPackageDependencyIssueSchema.Type;

export const ScriptPackageDependencyStatusSchema = Schema.Union([
  Schema.Struct({ status: Schema.Literal("ready") }),
  Schema.Struct({
    status: Schema.Literal("blocked"),
    issues: Schema.Array(ScriptPackageDependencyIssueSchema),
  }),
]);

export type ScriptPackageDependencyStatus =
  typeof ScriptPackageDependencyStatusSchema.Type;

export const ValidScriptPackageSchema = Schema.Struct({
  status: Schema.Literal("valid"),
  compatibility: ScriptPackageCompatibilitySchema,
  dependencyStatus: ScriptPackageDependencyStatusSchema,
  description: Schema.optionalKey(Schema.String),
  integrity: ScriptPackageIntegritySchema,
  name: Schema.String,
  path: Schema.String,
  source: Schema.optionalKey(ScriptPackageSourceSchema),
  update: ScriptPackageUpdateStateSchema,
  version: Schema.optionalKey(Schema.String),
  warning: Schema.optionalKey(Schema.String),
});

export type ValidScriptPackage = typeof ValidScriptPackageSchema.Type;

export const InvalidScriptPackageSchema = Schema.Struct({
  status: Schema.Literal("invalid"),
  diagnostic: Schema.String,
  name: Schema.optionalKey(Schema.String),
  path: Schema.String,
});

export type InvalidScriptPackage = typeof InvalidScriptPackageSchema.Type;

export const ScriptPackageSummarySchema = Schema.Union([
  ValidScriptPackageSchema,
  InvalidScriptPackageSchema,
]);

export type ScriptPackageSummary = typeof ScriptPackageSummarySchema.Type;

export const ScriptCatalogSchema = Schema.Struct({
  packages: Schema.Array(ScriptPackageSummarySchema),
  revision: Schema.String,
  scripts: Schema.Array(ScriptCatalogEntrySchema),
});

export type ScriptCatalog = typeof ScriptCatalogSchema.Type;

export const SCRIPT_CATALOG_PAGE_MAX_ENTRIES = 1024;

export const ScriptCatalogOverviewSchema = Schema.Struct({
  packages: Schema.Array(ScriptPackageSummarySchema),
  revision: Schema.String,
  scriptCount: NonNegativeInt,
});

export type ScriptCatalogOverview = typeof ScriptCatalogOverviewSchema.Type;

export const ScriptCatalogPageRequestSchema = Schema.Struct({
  limit: boundedInt(1, SCRIPT_CATALOG_PAGE_MAX_ENTRIES),
  offset: NonNegativeInt,
  query: Schema.String,
  revision: Schema.String,
});

export type ScriptCatalogPageRequest =
  typeof ScriptCatalogPageRequestSchema.Type;

export const ScriptCatalogPageSchema = Schema.Struct({
  entries: Schema.Array(ScriptCatalogEntrySchema),
  offset: NonNegativeInt,
  revision: Schema.String,
  total: NonNegativeInt,
});

export type ScriptCatalogPage = typeof ScriptCatalogPageSchema.Type;

export const ScriptCatalogChangeSchema = Schema.Struct({
  revision: Schema.String,
});

export type ScriptCatalogChange = typeof ScriptCatalogChangeSchema.Type;

export const GitHubCredentialSummarySchema = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
});

export type GitHubCredentialSummary = typeof GitHubCredentialSummarySchema.Type;

const ScriptPackageNonEmptyStringSchema = Schema.String.check(
  Schema.makeFilter((value) => value.trim() !== "", {
    expected: "a non-empty string",
  }),
);

export const GitHubCredentialWriteSchema = Schema.Struct({
  id: Schema.optionalKey(Schema.String),
  label: ScriptPackageNonEmptyStringSchema,
  token: ScriptPackageNonEmptyStringSchema,
});

export type GitHubCredentialWrite = typeof GitHubCredentialWriteSchema.Type;

export const ScriptPackageInstallRequestSchema = Schema.Struct({
  credentialId: Schema.optionalKey(Schema.String),
  ref: Schema.optionalKey(Schema.String),
  replaceExisting: Schema.optionalKey(Schema.Boolean),
  repositoryUrl: ScriptPackageNonEmptyStringSchema,
  subdirectory: Schema.optionalKey(ScriptPackageRepositorySubdirectorySchema),
});

export type ScriptPackageInstallRequest =
  typeof ScriptPackageInstallRequestSchema.Type;

export const ScriptPackageUpdateRequestSchema = Schema.Struct({
  packageName: ScriptPackageNameSchema,
  replaceModified: Schema.optionalKey(Schema.Boolean),
});

export type ScriptPackageUpdateRequest =
  typeof ScriptPackageUpdateRequestSchema.Type;

export const ScriptPackageRemoveRequestSchema = Schema.Struct({
  confirmModified: Schema.optionalKey(Schema.Boolean),
  packageName: ScriptPackageNameSchema,
});

export type ScriptPackageRemoveRequest =
  typeof ScriptPackageRemoveRequestSchema.Type;

export const ScriptPackageMutationResultSchema = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("completed"),
    catalog: ScriptCatalogOverviewSchema,
    packageName: Schema.String,
  }),
  Schema.Struct({
    status: Schema.Literal("unchanged"),
    catalog: ScriptCatalogOverviewSchema,
    packageName: Schema.String,
  }),
  Schema.Struct({
    status: Schema.Literal("confirmation-required"),
    packageName: Schema.String,
    reason: Schema.Literals(["existing-package", "local-modifications"]),
  }),
]);

export type ScriptPackageMutationResult =
  typeof ScriptPackageMutationResultSchema.Type;

export const ScriptPackageLeftoverCopySchema = Schema.Struct({
  path: Schema.String,
  packageName: Schema.optionalKey(Schema.String),
});

export type ScriptPackageLeftoverCopy =
  typeof ScriptPackageLeftoverCopySchema.Type;
