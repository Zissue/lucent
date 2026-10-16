import { describe, expect, it } from "vitest";

import { LiveItem } from "./item";
import {
  formatItemEnhancement,
  matchesAppliedEnhancement,
  matchesEnhancementShopItem,
  resolveEnhancementStrategy,
} from "./enhancement";

const item = (
  equipmentSlot: string,
  enhancement?: {
    readonly level?: number;
    readonly patternId?: number;
    readonly procId?: number;
  },
  category = equipmentSlot === "ar" ? "Class" : equipmentSlot,
) =>
  new LiveItem({
    category,
    coins: false,
    context: "inventory",
    cost: 0,
    description: "",
    ...(enhancement === undefined ? {} : { enhancement }),
    equipped: false,
    equipmentSlot,
    file: "",
    houseItem: false,
    itemId: 1,
    link: "",
    memberOnly: false,
    meta: "",
    name: "Item",
    quantity: 1,
    temporaryItem: false,
  });

describe("enhancement strategy", () => {
  it("resolves a basic lucky enhancement for the class slot", () => {
    expect(resolveEnhancementStrategy(item("ar"), "lucky", 100)).toEqual({
      ok: true,
      strategy: {
        patternId: 9,
        procId: 0,
        shopId: 763,
        slot: "class",
      },
    });
  });

  it("resolves Forge weapon labels to their displayed pattern and proc", () => {
    const elysium = {
      ok: true,
      strategy: {
        map: "forge",
        patternId: 6,
        procId: 12,
        shopId: 2_142,
        slot: "weapon",
      },
    };
    expect(
      resolveEnhancementStrategy(item("Weapon"), "wizard", 100, "elysium"),
    ).toEqual(elysium);
    expect(
      resolveEnhancementStrategy(item("Weapon"), "forge", 100, "elysium"),
    ).toEqual(elysium);
    expect(resolveEnhancementStrategy(item("Weapon"), "elysium", 100)).toEqual(
      elysium,
    );

    const dauntless = {
      ok: true,
      strategy: {
        map: "forge",
        patternId: 2,
        procId: 14,
        shopId: 2_142,
        slot: "weapon",
      },
    };
    expect(
      resolveEnhancementStrategy(item("Weapon"), "fighter", 100, "dauntless"),
    ).toEqual(dauntless);
    expect(
      resolveEnhancementStrategy(item("Weapon"), "forge", 100, "dauntless"),
    ).toEqual(dauntless);

    const acheron = {
      ok: true,
      strategy: {
        map: "forge",
        patternId: 23,
        procId: 11,
        shopId: 2_142,
        slot: "weapon",
      },
    };
    expect(resolveEnhancementStrategy(item("Weapon"), "acheron", 100)).toEqual(
      acheron,
    );
    expect(
      resolveEnhancementStrategy(item("Weapon"), "forge", 100, "acheron"),
    ).toEqual(acheron);
    expect(
      resolveEnhancementStrategy(item("Weapon"), "depths", 100, "acheron"),
    ).toEqual(acheron);
    expect(
      resolveEnhancementStrategy(item("Weapon"), "lucky", 100, "dauntless"),
    ).toEqual({
      ok: false,
      reason: "The enhancement and special do not match their inventory label",
    });
  });

  it("accepts player-facing Forge helm and cape labels", () => {
    const vim = {
      ok: true,
      strategy: {
        map: "forge",
        patternId: 25,
        procId: 0,
        shopId: 2_164,
        slot: "helm",
      },
    };
    expect(resolveEnhancementStrategy(item("he"), "vim", 100)).toEqual(vim);
    expect(resolveEnhancementStrategy(item("he"), "forge", 100, "vim")).toEqual(
      vim,
    );

    const hearty = {
      ok: true,
      strategy: {
        map: "forge",
        patternId: 32,
        procId: 0,
        shopId: 2_164,
        slot: "helm",
      },
    };
    expect(resolveEnhancementStrategy(item("he"), "hearty", 100)).toEqual(
      hearty,
    );
    expect(
      resolveEnhancementStrategy(item("he"), "forge", 100, "hearty"),
    ).toEqual(hearty);
    expect(
      resolveEnhancementStrategy(item("he"), "grimskull", 100, "hearty"),
    ).toEqual(hearty);

    expect(resolveEnhancementStrategy(item("he"), "forge", 100)).toEqual({
      ok: true,
      strategy: {
        map: "forge",
        patternId: 10,
        procId: 0,
        shopId: 2_164,
        slot: "helm",
      },
    });

    expect(resolveEnhancementStrategy(item("ba"), "vainglory", 100)).toEqual({
      ok: true,
      strategy: {
        map: "forge",
        patternId: 24,
        procId: 0,
        shopId: 2_143,
        slot: "cape",
      },
    });
  });

  it("matches the exact inventory pattern and proc", () => {
    const resolution = resolveEnhancementStrategy(
      item("Weapon"),
      "fighter",
      100,
      "dauntless",
    );
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;

    const candidate = item(
      "Weapon",
      {
        level: 100,
        patternId: 2,
        procId: 14,
      },
      "Enhancement",
    );
    const wrongPattern = item(
      "Weapon",
      {
        level: 100,
        patternId: 9,
        procId: 14,
      },
      "Enhancement",
    );
    const wrongProc = item(
      "Weapon",
      { level: 100, patternId: 2, procId: 13 },
      "Enhancement",
    );
    expect(matchesEnhancementShopItem(wrongProc, resolution.strategy)).toBe(
      false,
    );
    expect(matchesAppliedEnhancement(wrongProc, resolution.strategy)).toBe(
      false,
    );
    expect(matchesEnhancementShopItem(candidate, resolution.strategy)).toBe(
      true,
    );
    expect(matchesEnhancementShopItem(wrongPattern, resolution.strategy)).toBe(
      false,
    );
    expect(matchesAppliedEnhancement(candidate, resolution.strategy)).toBe(
      true,
    );
    expect(matchesAppliedEnhancement(wrongPattern, resolution.strategy)).toBe(
      false,
    );
  });
});

describe("enhancement display", () => {
  it("derives model names from current IDs and includes them in snapshots", () => {
    const weapon = item("Weapon", { level: 100, patternId: 2, procId: 14 });
    expect(weapon.enhancement).toMatchObject({
      name: "Fighter",
      special: "Dauntless",
    });
    const snapshot = weapon.toJSON();
    expect(snapshot.enhancement).toMatchObject({
      name: "Fighter",
      special: "Dauntless",
    });

    weapon.update({ enhancement: { level: 100, patternId: 6, procId: 12 } });
    expect(weapon.enhancement).toMatchObject({
      name: "Wizard",
      special: "Elysium",
    });
    expect(weapon.toJSON().enhancement).toMatchObject({
      name: "Wizard",
      special: "Elysium",
    });
    expect(snapshot.enhancement).toMatchObject({
      name: "Fighter",
      special: "Dauntless",
    });
    for (const [slot, patternId, name, special] of [
      ["he", 25, "Vim", "Ether"],
      ["he", 32, "Grimskull", "Hearty"],
      ["ba", 24, "Forge", "Vainglory"],
    ] as const) {
      const gear = item(slot, { patternId });
      expect(gear.enhancement).toMatchObject({ name, special });
      const resolution = resolveEnhancementStrategy(gear, name, 100, special);
      expect(resolution.ok).toBe(true);
      if (resolution.ok)
        expect(matchesAppliedEnhancement(gear, resolution.strategy)).toBe(true);
    }
    expect(item("ba", { patternId: 999 }).enhancement).toMatchObject({
      name: "Pattern 999",
      special: undefined,
    });
    expect(
      item("Weapon", { patternId: 9, procId: 999 }).enhancement,
    ).toMatchObject({ name: "Lucky", special: "Proc 999" });
    weapon.update({ enhancement: { patternId: 9 } });
    expect(weapon.enhancement).toMatchObject({
      name: "Lucky",
      special: undefined,
    });
    expect(item("Weapon", { level: 100 }).enhancement).toMatchObject({
      name: undefined,
      special: undefined,
    });
    weapon.replaceFrom(item("Weapon"));
    expect(weapon.enhancement).toBeUndefined();
  });

  it("formats basic and weapon-proc enhancements by their player-facing names", () => {
    expect(formatItemEnhancement({ level: 100, patternId: 9, procId: 3 })).toBe(
      "Lucky, Awe Blast, Level 100",
    );
    expect(
      formatItemEnhancement({ level: 100, patternId: 6, procId: 12 }),
    ).toBe("Wizard, Elysium, Level 100");
    expect(
      formatItemEnhancement({ level: 100, patternId: 2, procId: 14 }),
    ).toBe("Fighter, Dauntless, Level 100");
  });

  it("formats Forge cape and helm traits by their inventory labels", () => {
    expect(formatItemEnhancement({ patternId: 24 })).toBe("Forge, Vainglory");
    expect(formatItemEnhancement({ patternId: 25 })).toBe("Vim, Ether");
    expect(formatItemEnhancement({ patternId: 32 })).toBe("Grimskull, Hearty");
  });

  it("preserves unknown identifiers as a diagnostic fallback", () => {
    expect(
      formatItemEnhancement({ level: 80, patternId: 999, procId: 999 }),
    ).toBe("Pattern 999, Proc 999, Level 80");
    expect(formatItemEnhancement(undefined)).toBeUndefined();
  });
});
