import { describe, expect, it } from "@effect/vitest";

import {
  formatFollowerAttackTarget,
  parseFollowerAttackPriority,
} from "./follower";

describe("parseFollowerAttackPriority", () => {
  it("reads id tokens as monster map IDs and merges their spellings", () => {
    expect(
      parseFollowerAttackPriority("id:17, ID.17, id-17, id'17, Defense Drone"),
    ).toEqual([17, "Defense Drone"]);
  });

  it("keeps bare numbers as monster names", () => {
    expect(parseFollowerAttackPriority(["17", 17, "0", "id:0"])).toEqual([
      "17",
      17,
      "0",
      "id:0",
    ]);
  });
});

describe("formatFollowerAttackTarget", () => {
  it("writes map IDs so they parse back to the same targets", () => {
    const targets = [17, "Defense Drone"];
    expect(
      parseFollowerAttackPriority(
        targets.map(formatFollowerAttackTarget).join(", "),
      ),
    ).toEqual(targets);
  });
});
