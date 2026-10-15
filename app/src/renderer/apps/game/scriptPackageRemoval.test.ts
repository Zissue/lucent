import { describe, expect, it } from "@effect/vitest";
import type {
  ScriptPackageMutationResult,
  ScriptPackageRemoveRequest,
} from "@lucent/core/scriptPackages";
import {
  confirmScriptPackageRemoval,
  type ScriptPackageRemovalConfirmation,
} from "./scriptPackageRemoval";

const completed: ScriptPackageMutationResult = {
  status: "completed",
  packageName: "example",
  catalog: { packages: [], revision: "removed", scriptCount: 0 },
};

const scenario = (results: ScriptPackageMutationResult[]) => {
  const prompts: ScriptPackageRemovalConfirmation[] = [];
  const requests: ScriptPackageRemoveRequest[] = [];
  const applied: ScriptPackageMutationResult[] = [];
  return {
    prompts,
    requests,
    applied,
    actions: {
      askForConfirmation: (value: ScriptPackageRemovalConfirmation) => {
        prompts.push(value);
      },
      removePackage: async (request: ScriptPackageRemoveRequest) => {
        requests.push(request);
        const result = results.shift();
        if (result === undefined) throw new Error("Unexpected removal request");
        return result;
      },
      applyMutation: (result: ScriptPackageMutationResult) => {
        applied.push(result);
      },
    },
  };
};

describe("script package removal", () => {
  it("a verified row sends no confirmModified", async () => {
    const test = scenario([completed]);
    confirmScriptPackageRemoval(
      { name: "example", integrity: "verified" },
      test.actions,
    );
    expect(test.requests).toEqual([]);
    await test.prompts[0]?.onConfirm();
    expect(test.requests).toEqual([{ packageName: "example" }]);
    expect(test.applied).toEqual([completed]);
  });

  it("confirmation-required asks again with the local-changes warning", async () => {
    const test = scenario([
      {
        status: "confirmation-required",
        packageName: "example",
        reason: "local-modifications",
      },
      completed,
    ]);
    confirmScriptPackageRemoval(
      { name: "example", integrity: "verified" },
      test.actions,
    );
    await test.prompts[0]?.onConfirm();
    expect(test.prompts).toHaveLength(2);
    expect(test.prompts[1]?.description).toBe(
      "example has local changes. Removing it will permanently delete the entire package folder, including your changes.",
    );
    expect(test.applied).toEqual([]);
    await test.prompts[1]?.onConfirm();
    expect(test.requests).toEqual([
      { packageName: "example" },
      { packageName: "example", confirmModified: true },
    ]);
    expect(test.applied).toEqual([completed]);
  });

  it.each(["modified", "unmanaged"] as const)(
    "warns before deleting a %s row",
    async (integrity) => {
      const test = scenario([completed]);
      confirmScriptPackageRemoval({ name: "example", integrity }, test.actions);
      expect(test.prompts[0]?.description).toBe(
        "example has local changes. Removing it will permanently delete the entire package folder, including your changes.",
      );
      await test.prompts[0]?.onConfirm();
      expect(test.requests).toEqual([
        { packageName: "example", confirmModified: true },
      ]);
      expect(test.applied).toEqual([completed]);
    },
  );
});
