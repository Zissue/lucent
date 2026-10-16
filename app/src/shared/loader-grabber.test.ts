import { describe, expect, it } from "@effect/vitest";
import { EntityState, LiveMonster } from "@lucent/game";
import * as Schema from "effect/Schema";

import {
  GrabbedMonsterSchema,
  loaderGrabberLoadRequiresId,
  normalizeLoaderGrabberGrabRequest,
  normalizeLoaderGrabberLoadRequest,
} from "./loader-grabber";

describe("loader grabber requests", () => {
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
