import { describe, expect, it } from "@effect/vitest";

import { combatExitCells } from "./CombatExit";

describe("combatExitCells", () => {
  it("orders the current cell, then empty cells, then passive cells", () => {
    expect(
      combatExitCells(
        ["Enter", "Blank", "r1", "r2", "R3", "r4", "Wait", ""],
        [
          { aggressive: false, cell: "enter" },
          { aggressive: true, cell: "r1" },
          { aggressive: false, cell: "r2" },
          { aggressive: true, cell: "r3" },
        ],
        "enter",
      ),
    ).toEqual(["Enter", "r4", "r2"]);
  });

  it("excludes the current cell when it has aggressive monsters", () => {
    expect(
      combatExitCells(
        ["Enter", "r1"],
        [{ aggressive: true, cell: "Enter" }],
        "Enter",
      ),
    ).toEqual(["r1"]);
  });
});
