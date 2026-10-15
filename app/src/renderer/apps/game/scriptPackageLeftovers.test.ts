import { describe, expect, it } from "@effect/vitest";
import type { ScriptPackageLeftoverCopy } from "@lucent/core/scriptPackages";
import { refreshScriptPackageLeftovers } from "./scriptPackageLeftovers";

const copy: ScriptPackageLeftoverCopy = {
  path: "/workspace/.lucent-package-remove-kept",
  packageName: "example",
};

const scenario = (
  list: () => Promise<readonly ScriptPackageLeftoverCopy[]>,
) => {
  const state = {
    copies: [] as readonly ScriptPackageLeftoverCopy[],
    error: "",
    current: true,
  };
  return {
    state,
    actions: {
      list,
      isCurrent: () => state.current,
      setCopies: (copies: readonly ScriptPackageLeftoverCopy[]) => {
        state.copies = copies;
      },
      setError: (error: string) => {
        state.error = error;
      },
    },
  };
};

describe("script package leftover notices", () => {
  it("reports a listing failure in the leftover notice", async () => {
    const test = scenario(() => Promise.reject(new Error("Disk unavailable")));
    await refreshScriptPackageLeftovers(test.actions);
    expect(test.state.error).toBe(
      "Couldn't check for leftover package folders.",
    );
  });

  it.each([
    { label: "a copy", copies: [copy] },
    { label: "no copies", copies: [] },
  ])(
    "clears a listing error when the latest listing returns $label",
    async ({ copies }) => {
      const test = scenario(async () => copies);
      test.state.error = "Previous listing failed";
      await refreshScriptPackageLeftovers(test.actions);
      expect(test.state.error).toBe("");
      expect(test.state.copies).toEqual(copies);
    },
  );

  it("ignores an older listing that finishes after the current one", async () => {
    const older = Promise.withResolvers<readonly ScriptPackageLeftoverCopy[]>();
    const test = scenario(() => older.promise);
    const pending = refreshScriptPackageLeftovers(test.actions);
    test.state.current = false;
    const latest = scenario(async () => [copy]);
    await refreshScriptPackageLeftovers({
      ...latest.actions,
      setCopies: test.actions.setCopies,
      setError: test.actions.setError,
    });
    older.reject(new Error("Old request failed"));
    await pending;
    expect(test.state.error).toBe("");
    expect(test.state.copies).toEqual([copy]);
  });
});
