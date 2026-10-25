import { describe, expect, it } from "@effect/vitest";

import { parseArmyConfigCore } from "./army";

const parseRoom = (room: unknown) =>
  parseArmyConfigCore({ players: ["Alice"], room }).room;

describe("army config", () => {
  it("parses room as a number", () => {
    expect(parseRoom(1234)).toBe(1234);
    expect(parseRoom(" 1234 ")).toBe(1234);
    expect(parseRoom("99999")).toBe(99999);
  });

  it("rejects rooms that are not whole numbers in range", () => {
    for (const room of ["abc", "12a", "-5", "0", "100000", 12.5, "1e3"]) {
      expect(() => parseRoom(room)).toThrow(
        "Army config room must be a whole number from 1 to 99999",
      );
    }
  });

  it("requires a room", () => {
    expect(() => parseRoom(undefined)).toThrow("Army config must define room");
    expect(() => parseRoom(" ")).toThrow("Army config must define room");
  });
});
