import { describe, expect, it } from "@effect/vitest";

import { isArtixHost } from "./GameRequestHeaders";

describe("isArtixHost", () => {
  it("accepts Artix domains and their subdomains in any case", () => {
    expect(
      ["aq.com", "game.aq.com", "AQWorlds.com", "cdn.artix.com"].map(
        isArtixHost,
      ),
    ).toEqual([true, true, true, true]);
  });

  it("rejects look-alike hosts", () => {
    expect(
      ["evilaq.com", "aq.com.example.net", "artix.co", "example.com"].map(
        isArtixHost,
      ),
    ).toEqual([false, false, false, false]);
  });
});
