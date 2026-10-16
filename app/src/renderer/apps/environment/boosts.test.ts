import { describe, expect, it } from "@effect/vitest";

import {
  environmentBoostWithdrawalSummary,
  prepareEnvironmentBankBoosts,
} from "./boosts";

describe("prepareEnvironmentBankBoosts", () => {
  it("deduplicates and sorts bank boosts by name", () => {
    expect(
      prepareEnvironmentBankBoosts([
        { itemId: 2, name: " XP Boost ", quantity: 4 },
        { itemId: 3, name: "Gold Boost", quantity: 2 },
        { itemId: 4, name: "xp boost", quantity: 8 },
      ]),
    ).toEqual([
      { itemId: 3, name: "Gold Boost", quantity: 2 },
      { itemId: 2, name: "XP Boost", quantity: 4 },
    ]);
  });
});

describe("environmentBoostWithdrawalSummary", () => {
  it("is silent on full success and reports withdrawal and failure counts", () => {
    expect(environmentBoostWithdrawalSummary(3, 3)).toBe("");
    expect(environmentBoostWithdrawalSummary(4, 3)).toBe(
      "Withdrew 3 boosts. Couldn't withdraw 1.",
    );
    expect(environmentBoostWithdrawalSummary(2, 1)).toBe(
      "Withdrew 1 boost. Couldn't withdraw 1.",
    );
    expect(environmentBoostWithdrawalSummary(2, 0)).toBe(
      "Couldn't withdraw 2 boosts. Try again.",
    );
    expect(environmentBoostWithdrawalSummary(1, 0)).toBe(
      "Couldn't withdraw 1 boost. Try again.",
    );
  });
});
