import { describe, expect, it } from "vitest";

import { splitTextMatches } from "./text";

describe("splitTextMatches", () => {
  it("marks every match regardless of case", () => {
    expect(splitTextMatches("Dragon dragon", "DRAGON")).toEqual([
      { match: true, text: "Dragon" },
      { match: false, text: " " },
      { match: true, text: "dragon" },
    ]);
  });

  it("marks the matched letters after a character that lowercases to two", () => {
    expect(splitTextMatches("İrd of War", "rd of")).toEqual([
      { match: false, text: "İ" },
      { match: true, text: "rd of" },
      { match: false, text: " War" },
    ]);
  });

  it("matches regex characters literally", () => {
    expect(splitTextMatches("a.b axb", "a.b")).toEqual([
      { match: true, text: "a.b" },
      { match: false, text: " axb" },
    ]);
  });
});
