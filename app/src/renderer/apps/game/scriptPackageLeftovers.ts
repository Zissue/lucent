import type { ScriptPackageLeftoverCopy } from "@lucent/core/scriptPackages";

interface ScriptPackageLeftoverActions {
  readonly list: () => Promise<readonly ScriptPackageLeftoverCopy[]>;
  readonly isCurrent: () => boolean;
  readonly setCopies: (copies: readonly ScriptPackageLeftoverCopy[]) => void;
  readonly setError: (message: string) => void;
}

export const refreshScriptPackageLeftovers = async (
  actions: ScriptPackageLeftoverActions,
): Promise<void> => {
  try {
    const copies = await actions.list();
    if (actions.isCurrent()) {
      actions.setCopies(copies);
      actions.setError("");
    }
  } catch {
    if (actions.isCurrent()) {
      actions.setError("Couldn't check for leftover package folders.");
    }
  }
};
