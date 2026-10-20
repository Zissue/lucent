import { describe, expect, it } from "@effect/vitest";
import { EntityState, LiveMonster } from "@lucent/game";
import * as Schema from "effect/Schema";

import {
  GrabbedMonsterSchema,
  isLoaderGrabberGrabType,
  isLoaderGrabberLoadType,
  loaderGrabberLoadRequiresId,
  normalizeLoaderGrabberGrabRequest,
  normalizeLoaderGrabberLoadRequest,
} from "./loader-grabber";

describe("loader grabber requests", () => {
  it.each([
    ["hair-shop", true, false],
    ["shop", true, true],
    ["quest", true, true],
    ["armor-customizer", true, false],
    ["inventory", false, true],
    ["temp-inventory", false, true],
    ["bank", false, true],
    ["cell-monsters", false, true],
    ["map-monsters", false, true],
    ["house", false, false],
    [null, false, false],
    [42, false, false],
    [["shop"], false, false],
  ])("recognizes source %j", (value, load, grab) => {
    expect(isLoaderGrabberLoadType(value)).toBe(load);
    expect(isLoaderGrabberGrabType(value)).toBe(grab);
  });

  it("normalizes ID-based loader requests", () => {
    expect(
      normalizeLoaderGrabberLoadRequest({ id: " 42 ", type: "shop" }),
    ).toEqual({ id: 42, type: "shop" });
  });

  it("does not require an ID for the armor customizer", () => {
    expect(loaderGrabberLoadRequiresId("armor-customizer")).toBe(false);
    expect(
      normalizeLoaderGrabberLoadRequest({
        id: "ignored",
        type: "armor-customizer",
      }),
    ).toEqual({ type: "armor-customizer" });
  });

  it.each([
    [42, 42],
    [" 42 ", 42],
    ["0x2a", 42],
    ["4.2e1", 42],
    ["0b101010", 42],
    ["1.0", 1],
    [9007199254740991, 9007199254740991],
  ])("normalizes numeric ID %j", (id, expected) => {
    expect(normalizeLoaderGrabberLoadRequest({ id, type: "quest" })).toEqual({
      id: expected,
      type: "quest",
    });
  });

  it.each([
    "",
    "   ",
    "1.5",
    "Infinity",
    "9007199254740992",
    9007199254740992,
    0,
    -1,
    Number.NaN,
    Infinity,
    true,
    [42],
    null,
    undefined,
  ])("rejects invalid ID %j with the form diagnostic", (id) => {
    expect(() =>
      normalizeLoaderGrabberLoadRequest({ id, type: "quest" }),
    ).toThrow("Enter a positive integer ID.");
  });

  it("accepts arrays and inherited request fields without reading an ignored ID", () => {
    expect(
      normalizeLoaderGrabberLoadRequest(
        Object.assign([], { id: "42", type: "shop" }),
      ),
    ).toEqual({ id: 42, type: "shop" });
    expect(
      normalizeLoaderGrabberGrabRequest(
        Object.assign([], { type: "inventory" }),
      ),
    ).toEqual({ type: "inventory" });
    expect(
      normalizeLoaderGrabberLoadRequest(
        Object.create({ id: 7, type: "quest" }),
      ),
    ).toEqual({ id: 7, type: "quest" });
    expect(
      normalizeLoaderGrabberLoadRequest({
        type: "armor-customizer",
        get id() {
          throw new Error("ID must be ignored");
        },
      }),
    ).toEqual({ type: "armor-customizer" });
  });

  it.each([null, undefined, "shop", {}, { type: "house" }])(
    "preserves source diagnostics for %j",
    (input) => {
      expect(() => normalizeLoaderGrabberLoadRequest(input)).toThrow(
        "Choose a valid loader source.",
      );
      expect(() => normalizeLoaderGrabberGrabRequest(input)).toThrow(
        "Choose a valid grabber source.",
      );
    },
  );

  it("rejects malformed loader IDs and grabber sources", () => {
    expect(() =>
      normalizeLoaderGrabberLoadRequest({ id: "1.5", type: "quest" }),
    ).toThrow("positive integer");
    expect(() => normalizeLoaderGrabberGrabRequest({ type: "house" })).toThrow(
      "valid grabber source",
    );
  });
});

describe("loader grabber aura snapshots", () => {
  it("preserves projected expiry and requires persistence", () => {
    const monster = new LiveMonster({
      aggressive: false,
      cell: "r1",
      hp: 100,
      level: 1,
      maxHp: 100,
      maxMp: 100,
      monsterId: 1,
      monsterMapId: 48,
      mp: 100,
      name: "Monster",
      race: "None",
      state: EntityState.InCombat,
    });
    monster.projectAuras(
      {
        type: "seed",
        entries: [
          {
            name: "Potent Battle Elixir",
            icon: "ice",
            stack: 1,
            persistent: true,
            timer: { type: "timed", remainingSeconds: 854.2, fullSeconds: 900 },
          },
        ],
      },
      1_000_000,
    );
    const decode = Schema.decodeUnknownSync(GrabbedMonsterSchema);
    expect(decode(monster.toJSON()).auras).toEqual([
      {
        name: "Potent Battle Elixir",
        icon: "ice",
        kind: "active",
        stack: 1,
        duration: 900,
        expiresAt: 1_854_200,
        persistent: true,
      },
    ]);
    const missingPersistence = {
      name: "Focus",
      kind: "active",
      stack: 2,
      duration: 8,
    };
    expect(() =>
      decode({ ...monster.toJSON(), auras: [missingPersistence] }),
    ).toThrow("persistent");
  });
});
