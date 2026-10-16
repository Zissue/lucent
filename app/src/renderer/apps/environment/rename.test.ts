import { describe, expect, it } from "vitest";

import {
  addEnvironmentItems,
  createEmptyEnvironmentState,
  removeEnvironmentItem,
  type EnvironmentState,
} from "@lucent/core/environment";
import { renameEntry } from "./rename";

const renameItem = async (
  names: readonly string[],
  from: string,
  to: string,
) => {
  let state: EnvironmentState = addEnvironmentItems(
    createEmptyEnvironmentState(),
    names,
  );
  const update = (request: () => Promise<EnvironmentState>) =>
    request().then((next) => {
      state = next;
      return next;
    });
  await renameEntry(update, from, to, {
    add: () => Promise.resolve(addEnvironmentItems(state, [to])),
    remove: () => Promise.resolve(removeEnvironmentItem(state, from)),
  });
  return state.itemNames;
};

describe("renameEntry", () => {
  it("replaces the old name with the new one", async () => {
    expect(
      await renameItem(["Relic of Chaos", "test"], "test", "Darkon's Receipt"),
    ).toEqual(["Darkon's Receipt", "Relic of Chaos"]);
  });

  it("keeps the item when only the letter case changes", async () => {
    expect(await renameItem(["test"], "test", "Test")).toEqual(["Test"]);
  });

  it("stops when a step fails", async () => {
    const calls: string[] = [];
    const renamed = await renameEntry(
      () => Promise.resolve(null),
      "test",
      "other",
      {
        add: () => {
          calls.push("add");
          return Promise.resolve(createEmptyEnvironmentState());
        },
        remove: () => {
          calls.push("remove");
          return Promise.resolve(createEmptyEnvironmentState());
        },
      },
    );
    expect(renamed).toBe(false);
    expect(calls).toEqual([]);
  });
});
