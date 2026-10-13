import { describe, expect, it } from "@effect/vitest";

import {
  EntityState,
  getClassRankFromPoints,
  getItemRarityName,
  LiveItem,
  LiveMonster,
  LivePlayer,
  LiveServer,
  orderMonstersByPriority,
  toItemSelector,
  toMonsterSelector,
  toPlayerSelector,
} from "./index";

describe("game domain models", () => {
  it("derives entity state and silently reflects updates", () => {
    const player = new LivePlayer({
      afk: false,
      cell: "Enter",
      entityId: 1,
      entityType: "player",
      hp: 50,
      level: 10,
      maxHp: 100,
      maxMp: 40,
      mp: 10,
      pad: "Spawn",
      position: { x: 1, y: 2 },
      state: EntityState.InCombat,
      username: "Hero",
    });

    expect(player.alive).toBe(true);
    expect(player.hpPercent).toBe(50);
    expect(player.mpPercent).toBe(25);
    expect(player.inCombat).toBe(true);
    expect(player.isInCell(" enter ")).toBe(true);

    player.update({ hp: 0, state: EntityState.Dead });
    expect(player.dead).toBe(true);
    expect(player.toJSON()).toMatchObject({ alive: false, hp: 0 });
    expect(toPlayerSelector(" Hero ")).toEqual({ username: "Hero" });
    expect(toPlayerSelector({ username: " Hero " })).toEqual({
      username: "Hero",
    });
  });

  it("interprets item context, equipment type, and selectors", () => {
    const item = new LiveItem({
      category: "Weapon",
      charItemId: 10,
      coins: true,
      context: "inventory",
      cost: 100,
      description: "",
      equipped: true,
      equipmentSlot: "Weapon",
      file: "sword.swf",
      houseItem: false,
      itemId: 7,
      link: "Sword",
      memberOnly: false,
      meta: "",
      name: "Test Sword",
      quantity: 1,
      temporaryItem: false,
    });

    expect(item.weapon).toBe(true);
    expect(item.classRank).toBeNull();
    expect(item.matches("test sword")).toBe(true);
    expect(item.matches("7")).toBe(false);
    expect(item.matches(7)).toBe(true);
    expect(item.matches({ name: "Test Sword" })).toBe(true);
    expect(item.matches({ itemId: 7 })).toBe(true);
    expect(toItemSelector(7)).toEqual({ itemId: 7 });
    expect(toItemSelector(" Test Sword ")).toEqual({ name: "Test Sword" });
    item.update({ context: "bank", equipped: false, shopItemId: 12 });
    expect(item.matches({ shopItemId: 12 })).toBe(true);
    expect(item.toJSON()).toMatchObject({ context: "bank", weapon: true });
  });

  it("classifies items into inventory pools", () => {
    const items = [
      { category: "Weapon", houseItem: false, meta: "" },
      { category: "Resource", houseItem: false, meta: "" },
      { category: "Class", houseItem: false, meta: "" },
      { category: "Item", houseItem: false, meta: " 400 " },
      { category: "Note", houseItem: false, meta: "" },
      { category: "Quest Item", houseItem: false, meta: "" },
      { category: "Item", houseItem: false, meta: "" },
      { category: "Guild", houseItem: false, meta: "" },
      { category: "Floor Item", houseItem: true, meta: "" },
    ].map(
      (data, index) =>
        new LiveItem({
          ...data,
          coins: false,
          context: "inventory",
          cost: 0,
          description: "",
          equipped: false,
          equipmentSlot: "",
          file: "",
          itemId: index + 1,
          link: "",
          memberOnly: false,
          name: "Test Item",
          quantity: 1,
          temporaryItem: false,
        }),
    );

    expect(items.map((item) => item.pool)).toEqual([
      "bag",
      "misc",
      "class",
      "bag",
      "misc",
      "misc",
      "misc",
      "house",
      "house",
    ]);
    expect(items[1]?.toJSON().pool).toBe("misc");
  });

  it("derives class rank from cumulative class points", () => {
    const thresholds = [
      900, 3_600, 10_000, 22_500, 44_100, 78_400, 129_600, 202_500, 302_500,
    ];
    expect(getClassRankFromPoints(0)).toBe(1);
    for (const [index, threshold] of thresholds.entries()) {
      expect(getClassRankFromPoints(threshold - 1)).toBe(index + 1);
      expect(getClassRankFromPoints(threshold)).toBe(index + 2);
    }

    const classItem = new LiveItem({
      category: "Class",
      coins: false,
      context: "inventory",
      cost: 0,
      description: "",
      equipped: true,
      equipmentSlot: "ar",
      file: "",
      houseItem: false,
      itemId: 8,
      link: "",
      memberOnly: false,
      meta: "",
      name: "Test Class",
      quantity: 302_500,
      temporaryItem: false,
    });
    expect(classItem.classRank).toBe(10);
    expect(classItem.toJSON()).toMatchObject({ classRank: 10 });
  });

  it("matches monster selectors and distinguishes IDs from numeric names", () => {
    const monster = new LiveMonster({
      aggressive: false,
      cell: "r1",
      hp: 100,
      level: 5,
      maxHp: 100,
      maxMp: 0,
      monsterId: 8,
      monsterMapId: 9,
      mp: 0,
      name: "Undead Warrior",
      race: "Undead",
      state: EntityState.Idle,
    });

    expect(monster.matches("undead warrior")).toBe(true);
    expect(monster.matches("id:9")).toBe(true);
    for (const query of ["id:9", "id.9", "id-9", "id'9"]) {
      expect(toMonsterSelector(query)).toEqual({ monsterMapId: 9 });
    }
    for (const query of ["9", "id9"]) {
      expect(toMonsterSelector(query)).toEqual({ name: query });
    }
  });

  it("retains drop metadata when a monster snapshot is replaced", () => {
    const monster = new LiveMonster({
      aggressive: false,
      cell: "r1",
      hp: 100,
      level: 5,
      maxHp: 100,
      maxMp: 0,
      monsterId: 8,
      monsterMapId: 9,
      mp: 0,
      name: "Undead Warrior",
      race: "Undead",
      state: EntityState.Idle,
    });

    monster.replaceDrops([
      {
        eventDrop: true,
        icon: "iibag",
        item: new LiveItem({
          category: "Item",
          coins: false,
          context: "monster-drop",
          cost: 0,
          description: "A test drop",
          equipped: false,
          equipmentSlot: "",
          file: "",
          houseItem: false,
          itemId: 10,
          link: "None",
          memberOnly: false,
          meta: "",
          name: "Bone",
          quantity: 1,
          temporaryItem: false,
        }).toJSON(),
        questGated: false,
        questObjectives: [],
        rarity: 1,
        rarityName: "Enhancement +0",
        rateBoostPercent: null,
        ratePercent: 25,
        requiredQuestIds: [2972],
        requiredQuests: [],
        stackSize: 100,
        variableQuantity: false,
      },
    ]);
    monster.replaceFrom(
      new LiveMonster({
        ...monster.snapshot(),
        hp: 50,
      }),
    );
    expect(monster.drops[0]?.item.name).toBe("Bone");
    expect(monster.toJSON().drops[0]?.ratePercent).toBe(25);
    expect(monster.toJSON().drops[0]?.requiredQuestIds).toEqual([2972]);
  });

  it.each([
    [16, "Boss Drop"],
    [22, "Unknown"],
  ])("labels rarity %i as %s", (rarity, expected) => {
    expect(getItemRarityName(rarity)).toBe(expected);
  });

  it("treats a server at its player limit as full", () => {
    const server = new LiveServer({
      chat: 2,
      count: 100,
      language: "en",
      max: 100,
      memberOnly: false,
      name: "Artix",
      online: true,
    });

    expect(server.full).toBe(true);
  });

  it("orders monsters by typed priority without duplicates", () => {
    const monsters = [
      new LiveMonster({
        aggressive: false,
        cell: "r1",
        hp: 100,
        level: 5,
        maxHp: 100,
        maxMp: 0,
        monsterId: 1,
        monsterMapId: 10,
        mp: 0,
        name: "Guard",
        race: "Human",
        state: EntityState.Idle,
      }),
      new LiveMonster({
        aggressive: false,
        cell: "r1",
        hp: 100,
        level: 5,
        maxHp: 100,
        maxMp: 0,
        monsterId: 2,
        monsterMapId: 11,
        mp: 0,
        name: "Elite Guard",
        race: "Human",
        state: EntityState.Idle,
      }),
    ];

    expect(orderMonstersByPriority(monsters, [11, "guard"])).toEqual([
      monsters[1],
      monsters[0],
    ]);
  });
});
