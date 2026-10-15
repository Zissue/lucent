import type {
  ScriptPackageIntegrity,
  ScriptPackageMutationResult,
  ScriptPackageRemoveRequest,
} from "@lucent/core/scriptPackages";

export interface ScriptPackageRemovalConfirmation {
  readonly confirmLabel: string;
  readonly description: string;
  readonly destructive: boolean;
  readonly onConfirm: () => Promise<void>;
  readonly title: string;
}

interface ScriptPackageRemovalActions {
  readonly askForConfirmation: (
    value: ScriptPackageRemovalConfirmation,
  ) => void;
  readonly removePackage: (
    request: ScriptPackageRemoveRequest,
  ) => Promise<ScriptPackageMutationResult>;
  readonly applyMutation: (result: ScriptPackageMutationResult) => void;
}

export const confirmScriptPackageRemoval = (
  entry: { readonly name: string; readonly integrity: ScriptPackageIntegrity },
  actions: ScriptPackageRemovalActions,
): void => {
  actions.askForConfirmation({
    confirmLabel: "Remove package",
    description:
      entry.integrity === "modified"
        ? `${entry.name} has local changes. Removing it will permanently delete the entire package folder, including your changes.`
        : `Remove ${entry.name} and delete its entire package folder?`,
    destructive: true,
    onConfirm: async () => {
      const result = await actions.removePackage({
        packageName: entry.name,
        confirmModified: true,
      });
      actions.applyMutation(result);
    },
    title: "Remove this package?",
  });
};
