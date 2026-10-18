import * as Schema from "effect/Schema";

import {
  ScriptFileResolutionSchema,
  ScriptFileSchema,
  ScriptInputsDefinitionSchema,
  ScriptInputValuesSchema,
  ScriptOpenFileResultSchema,
  ScriptSelectFileResultSchema,
} from "@lucent/core/scriptInputs";
import {
  GitHubCredentialSummarySchema,
  GitHubCredentialWriteSchema,
  ScriptCatalogChangeSchema,
  ScriptCatalogOverviewSchema,
  ScriptCatalogPageRequestSchema,
  ScriptCatalogPageSchema,
  ScriptPackageInstallRequestSchema,
  ScriptPackageMutationResultSchema,
  ScriptPackageRemoveRequestSchema,
  ScriptPackageRestoreRequestSchema,
  ScriptPackageUpdateRequestSchema,
  ScriptReferenceSchema,
} from "@lucent/core/scriptPackages";
import { defineEvent, defineInvoke } from "./core";

export type {
  ScriptFile,
  ScriptFileResolution,
  ScriptOpenFileResult,
  ScriptSelectFileResult,
} from "@lucent/core/scriptInputs";

const namespace = "desktop:scripting";

export const ScriptingIpc = {
  getCatalog: defineInvoke({
    channel: `${namespace}:get-catalog`,
    payload: Schema.Void,
    result: ScriptCatalogOverviewSchema,
  }),
  getCatalogPage: defineInvoke({
    channel: `${namespace}:get-catalog-page`,
    payload: ScriptCatalogPageRequestSchema,
    result: ScriptCatalogPageSchema,
  }),
  refreshCatalog: defineInvoke({
    channel: `${namespace}:refresh-catalog`,
    payload: Schema.Void,
    result: ScriptCatalogOverviewSchema,
  }),
  listCredentials: defineInvoke({
    channel: `${namespace}:list-github-credentials`,
    payload: Schema.Void,
    result: Schema.Array(GitHubCredentialSummarySchema),
  }),
  saveCredential: defineInvoke({
    channel: `${namespace}:save-github-credential`,
    payload: GitHubCredentialWriteSchema,
    result: GitHubCredentialSummarySchema,
  }),
  deleteCredential: defineInvoke({
    channel: `${namespace}:delete-github-credential`,
    payload: Schema.Struct({ id: Schema.String }),
    result: Schema.Void,
  }),
  installPackage: defineInvoke({
    channel: `${namespace}:install-package`,
    payload: ScriptPackageInstallRequestSchema,
    result: ScriptPackageMutationResultSchema,
  }),
  updatePackage: defineInvoke({
    channel: `${namespace}:update-package`,
    payload: ScriptPackageUpdateRequestSchema,
    result: ScriptPackageMutationResultSchema,
  }),
  restorePackage: defineInvoke({
    channel: `${namespace}:restore-package`,
    payload: ScriptPackageRestoreRequestSchema,
    result: ScriptPackageMutationResultSchema,
  }),
  removePackage: defineInvoke({
    channel: `${namespace}:remove-package`,
    payload: ScriptPackageRemoveRequestSchema,
    result: ScriptPackageMutationResultSchema,
  }),
  checkPackageUpdate: defineInvoke({
    channel: `${namespace}:check-package-update`,
    payload: Schema.Struct({ packageName: Schema.String }),
    result: ScriptCatalogOverviewSchema,
  }),
  openRepository: defineInvoke({
    channel: `${namespace}:open-repository`,
    payload: Schema.Struct({ repositoryUrl: Schema.String }),
    result: Schema.Boolean,
  }),
  openFile: defineInvoke({
    channel: `${namespace}:open-file`,
    payload: Schema.Void,
    result: ScriptOpenFileResultSchema,
  }),
  loadReference: defineInvoke({
    channel: `${namespace}:load-reference`,
    payload: ScriptReferenceSchema,
    result: ScriptFileSchema,
  }),
  readFile: defineInvoke({
    channel: `${namespace}:read-file`,
    payload: Schema.Struct({
      path: Schema.String,
    }),
    result: ScriptFileSchema,
  }),
  readReference: defineInvoke({
    channel: `${namespace}:read-reference`,
    payload: ScriptReferenceSchema,
    result: ScriptFileSchema,
  }),
  resolveFile: defineInvoke({
    channel: `${namespace}:resolve-file`,
    payload: Schema.Struct({
      path: Schema.String,
    }),
    result: ScriptFileResolutionSchema,
  }),
  resolveReference: defineInvoke({
    channel: `${namespace}:resolve-reference`,
    payload: ScriptReferenceSchema,
    result: ScriptFileResolutionSchema,
  }),
  selectFile: defineInvoke({
    channel: `${namespace}:select-file`,
    payload: Schema.Void,
    result: ScriptSelectFileResultSchema,
  }),
  openPath: defineInvoke({
    channel: `${namespace}:open-path`,
    payload: Schema.Struct({
      path: Schema.String,
    }),
    result: Schema.Boolean,
  }),
  getInputValues: defineInvoke({
    channel: `${namespace}:get-input-values`,
    payload: ScriptInputsDefinitionSchema,
    result: ScriptInputValuesSchema,
  }),
  saveInputValues: defineInvoke({
    channel: `${namespace}:save-input-values`,
    payload: Schema.Struct({
      definition: ScriptInputsDefinitionSchema,
      values: ScriptInputValuesSchema,
    }),
    result: ScriptInputValuesSchema,
  }),
  catalogChanged: defineEvent({
    channel: `${namespace}:catalog-changed`,
    payload: ScriptCatalogChangeSchema,
  }),
} as const;
