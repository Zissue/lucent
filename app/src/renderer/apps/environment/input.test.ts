import { describe, expect, it } from "@effect/vitest";

import {
  parseEnvironmentQuestBulkInput,
  splitEnvironmentBulkInput,
} from "./input";

describe("Environment bulk input", () => {
  it("splits semicolon-separated entries without treating commas specially", () => {
    expect(
      splitEnvironmentBulkInput(
        " Vok, the Tundra Blade; ; Cape of 1,000 Bones ",
      ),
    ).toEqual(["Vok, the Tundra Blade", "Cape of 1,000 Bones"]);
  });

  it("parses quest IDs with optional reward item IDs", () => {
    expect(parseEnvironmentQuestBulkInput("12; 34:56; ; 78:")).toEqual([
      { questId: 12 },
      { questId: 34, rewardItemId: 56 },
      { questId: 78 },
    ]);
  });

  it("rejects the whole input when any quest entry is malformed", () => {
    expect(parseEnvironmentQuestBulkInput("12; abc")).toBeNull();
    expect(parseEnvironmentQuestBulkInput("12; 34:abc")).toBeNull();
    expect(parseEnvironmentQuestBulkInput("12:34:56")).toBeNull();
    expect(parseEnvironmentQuestBulkInput("0")).toBeNull();
  });
});
