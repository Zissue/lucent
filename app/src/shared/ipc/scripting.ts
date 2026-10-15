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
  ScriptPackageLeftoverCopySchema,
  ScriptPackageMutationResultSchema,
  ScriptPackageRemoveRequestSchema,
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
    name: "scripting.getCatalog",
    payload: Schema.Void,
    result: ScriptCatalogOverviewSchema,
  }),
  getCatalogPage: defineInvoke({
    channel: `${namespace}:get-catalog-page`,
    name: "scripting.getCatalogPage",
    payload: ScriptCatalogPageRequestSchema,
    result: ScriptCatalogPageSchema,
  }),
  refreshCatalog: defineInvoke({
    channel: `${namespace}:refresh-catalog`,
    name: "scripting.refreshCatalog",
    payload: Schema.Void,
    result: ScriptCatalogOverviewSchema,
  }),
  listPackageLeftovers: defineInvoke({
    channel: `${namespace}:list-package-leftovers`,
    name: "scripting.listPackageLeftovers",
    payload: Schema.Void,
    result: Schema.Array(ScriptPackageLeftoverCopySchema),
  }),
  listCredentials: defineInvoke({
    channel: `${namespace}:list-github-credentials`,
    name: "scripting.listCredentials",
    payload: Schema.Void,
    result: Schema.Array(GitHubCredentialSummarySchema),
  }),
  saveCredential: defineInvoke({
    channel: `${namespace}:save-github-credential`,
    name: "scripting.saveCredential",
    payload: GitHubCredentialWriteSchema,
    result: GitHubCredentialSummarySchema,
  }),
  deleteCredential: defineInvoke({
    channel: `${namespace}:delete-github-credential`,
    name: "scripting.deleteCredential",
    payload: Schema.Struct({ id: Schema.String }),
    result: Schema.Void,
  }),
  installPackage: defineInvoke({
    channel: `${namespace}:install-package`,
    name: "scripting.installPackage",
    payload: ScriptPackageInstallRequestSchema,
    result: ScriptPackageMutationResultSchema,
  }),
  updatePackage: defineInvoke({
    channel: `${namespace}:update-package`,
    name: "scripting.updatePackage",
    payload: ScriptPackageUpdateRequestSchema,
    result: ScriptPackageMutationResultSchema,
  }),
  removePackage: defineInvoke({
    channel: `${namespace}:remove-package`,
    name: "scripting.removePackage",
    payload: ScriptPackageRemoveRequestSchema,
    result: ScriptPackageMutationResultSchema,
  }),
  checkPackageUpdate: defineInvoke({
    channel: `${namespace}:check-package-update`,
    name: "scripting.checkPackageUpdate",
    payload: Schema.Struct({ packageName: Schema.String }),
    result: ScriptCatalogOverviewSchema,
  }),
  openRepository: defineInvoke({
    channel: `${namespace}:open-repository`,
    name: "scripting.openRepository",
    payload: Schema.Struct({ repositoryUrl: Schema.String }),
    result: Schema.Boolean,
  }),
  openFile: defineInvoke({
    channel: `${namespace}:open-file`,
    name: "scripting.openFile",
    payload: Schema.Void,
    result: ScriptOpenFileResultSchema,
  }),
  loadReference: defineInvoke({
    channel: `${namespace}:load-reference`,
    name: "scripting.loadReference",
    payload: ScriptReferenceSchema,
    result: ScriptFileSchema,
  }),
  readFile: defineInvoke({
    channel: `${namespace}:read-file`,
    name: "scripting.readFile",
    payload: Schema.Struct({
      path: Schema.String,
    }),
    result: ScriptFileSchema,
  }),
  readReference: defineInvoke({
    channel: `${namespace}:read-reference`,
    name: "scripting.readReference",
    payload: ScriptReferenceSchema,
    result: ScriptFileSchema,
  }),
  resolveFile: defineInvoke({
    channel: `${namespace}:resolve-file`,
    name: "scripting.resolveFile",
    payload: Schema.Struct({
      path: Schema.String,
    }),
    result: ScriptFileResolutionSchema,
  }),
  resolveReference: defineInvoke({
    channel: `${namespace}:resolve-reference`,
    name: "scripting.resolveReference",
    payload: ScriptReferenceSchema,
    result: ScriptFileResolutionSchema,
  }),
  selectFile: defineInvoke({
    channel: `${namespace}:select-file`,
    name: "scripting.selectFile",
    payload: Schema.Void,
    result: ScriptSelectFileResultSchema,
  }),
  openPath: defineInvoke({
    channel: `${namespace}:open-path`,
    name: "scripting.openPath",
    payload: Schema.Struct({
      path: Schema.String,
    }),
    result: Schema.Boolean,
  }),
  getInputValues: defineInvoke({
    channel: `${namespace}:get-input-values`,
    name: "scripting.getInputValues",
    payload: ScriptInputsDefinitionSchema,
    result: ScriptInputValuesSchema,
  }),
  saveInputValues: defineInvoke({
    channel: `${namespace}:save-input-values`,
    name: "scripting.saveInputValues",
    payload: Schema.Struct({
      definition: ScriptInputsDefinitionSchema,
      values: ScriptInputValuesSchema,
    }),
    result: ScriptInputValuesSchema,
  }),
  catalogChanged: defineEvent({
    channel: `${namespace}:catalog-changed`,
    name: "scripting.catalogChanged",
    payload: ScriptCatalogChangeSchema,
  }),
} as const;
