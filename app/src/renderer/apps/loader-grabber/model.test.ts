import { resolveEnhancementStrategy } from "@lucent/game";
import { describe, expect, it } from "vitest";

import type {
  GrabbedItem,
  GrabbedMonster,
  GrabbedQuest,
  GrabbedShop,
} from "../../../shared/loader-grabber";
import {
  NO_FILTERS,
  buildSnapshot,
  filterEntries,
  filterGroups,
  parseIdInput,
  type Entry,
  type FilterGroup,
} from "./model";

const item = (overrides: Partial<GrabbedItem>): GrabbedItem => ({
  armor: false,
  banked: false,
  cape: false,
  category: "Sword",
  classItem: false,
  coins: false,
  context: "inventory",
  cost: 0,
  description: "",
  equipmentSlot: "Weapon",
  equipped: false,
  file: "",
  helm: false,
  houseItem: false,
  itemId: 1,
  link: "",
  memberOnly: false,
  meta: "",
  name: "Item",
  pet: false,
  quantity: 1,
  temporaryItem: false,
  wearable: true,
  weapon: true,
  worn: false,
  ...overrides,
});

const quest = (overrides: Partial<GrabbedQuest>): GrabbedQuest => ({
  cadence: "none",
  id: 1,
  name: "Quest",
  once: false,
  requirements: [],
  rewards: [],
  ...overrides,
});

const drop = (
  overrides: Partial<GrabbedMonster["drops"][number]>,
): GrabbedMonster["drops"][number] => ({
  eventDrop: false,
  icon: "",
  item: item({ itemId: 5, name: "Bone Dust" }),
  questGated: false,
  questObjectives: [],
  rarity: 10,
  rarityName: "Common",
  rateBoostPercent: null,
  ratePercent: 100,
  requiredQuestIds: [],
  requiredQuests: [],
  stackSize: 1,
  variableQuantity: false,
  ...overrides,
});

const monster = (overrides: Partial<GrabbedMonster>): GrabbedMonster => ({
  alive: true,
  auras: [],
  cell: "r2",
  dead: false,
  drops: [],
  hp: 100,
  hpPercent: 100,
  idle: true,
  inCombat: false,
  level: 10,
  maxHp: 100,
  maxMp: 10,
  monsterId: 7,
  monsterMapId: 1,
  mp: 10,
  mpPercent: 100,
  name: "Skeleton",
  race: "Undead",
  state: 0,
  ...overrides,
});

const aura = (
  overrides: Partial<GrabbedMonster["auras"][number]>,
): GrabbedMonster["auras"][number] => ({
  duration: 10,
  kind: "active",
  name: "Bleed",
  persistent: false,
  stack: 1,
  ...overrides,
});

const blade = (shopItemId: number, cost: number): GrabbedItem =>
  item({ cost, itemId: 100, name: "Blade", shopItemId });

const smith = (items: readonly GrabbedItem[]): GrabbedShop => ({
  house: false,
  id: 1,
  items,
  limited: false,
  merge: false,
  name: "Smith",
});

const priceOf = (
  snapshot: ReturnType<typeof buildSnapshot>,
  key: string,
): string | undefined =>
  snapshot?.entries.find((entry) => entry.key === key)?.cells[1];

describe("parseIdInput", () => {
  it("reads an ID typed or pasted with padding, zeros, or full-width digits", () => {
    expect(parseIdInput(" 1550 ")).toBe(1550);
    expect(parseIdInput("00042")).toBe(42);
    expect(parseIdInput("１２３")).toBe(123);
  });

  it("rejects text that isn't a whole ID instead of rewriting it", () => {
    expect(parseIdInput("12.5")).toBeNull();
    expect(parseIdInput("1e5")).toBeNull();
    expect(parseIdInput("-5")).toBeNull();
    expect(parseIdInput("123456789012")).toBeNull();
    expect(parseIdInput("000")).toBeNull();
  });
});

describe("buildSnapshot", () => {
  it("summarizes a shop and prices its items", () => {
    const shop: GrabbedShop = {
      house: false,
      id: 1550,
      items: [
        item({ coins: true, cost: 500, itemId: 10, name: "Blade" }),
        item({ cost: 0, itemId: 11, name: "Hat", quantity: 3 }),
      ],
      limited: false,
      merge: true,
      name: "Yulgar's Inn",
    };

    const snapshot = buildSnapshot("shop", shop, 0);

    expect(snapshot?.heading).toBe("Yulgar's Inn");
    expect(snapshot?.headingFacts).toEqual([
      { label: "Shop ID", role: "id", value: "1550" },
    ]);
    expect(snapshot?.headingBadges).toEqual(["Merge"]);
    expect(
      snapshot?.entries.map((entry) => [entry.title, entry.cells]),
    ).toEqual([
      ["Blade", ["10", "500 AC", "1"]],
      ["Hat", ["11", "Free", "3"]],
    ]);
  });

  it("names an item's enhancement the way scripts accept it", () => {
    const sword = item({
      enhancement: { level: 100, patternId: 10, procId: 7 },
      itemId: 12,
      name: "Sword",
      weapon: true,
    });

    const facts = buildSnapshot("inventory", [sword], 0)?.entries[0]?.facts;
    const value = (label: string) =>
      facts?.find((fact) => fact.label === label)?.value;

    expect([value("Enhancement"), value("Special")]).toEqual([
      "Forge",
      "Lacerate",
    ]);
    const resolved = resolveEnhancementStrategy(
      sword,
      value("Enhancement") ?? "",
      100,
      value("Special"),
    );
    expect(
      resolved.ok && [resolved.strategy.patternId, resolved.strategy.procId],
    ).toEqual([10, 7]);
  });

  it("lists a monster's auras before its drops", () => {
    const skeleton = monster({
      auras: [aura({ expiresAt: 1_000_000, stack: 3 })],
      drops: [drop({})],
    });

    const entry = buildSnapshot("cell-monsters", [skeleton], 0)?.entries[0];
    const bleed = entry?.sections[0]?.entries[0];

    expect(entry?.sections.map((section) => section.title)).toEqual([
      "Auras",
      "Drops",
    ]);
    expect([bleed?.title, bleed?.cells]).toEqual(["Bleed", ["3"]]);
    expect(
      bleed?.facts.find((fact) => fact.label === "Expires")?.expiresAt,
    ).toBe(1_000_000);
  });

  it("lists the items a merge shop item requires", () => {
    const shop: GrabbedShop = {
      house: false,
      id: 1348,
      items: [
        item({
          itemId: 20,
          name: "Infernal Guardian",
          requirements: [
            { itemId: 30, name: "Tainted Gem", quantity: 50 },
            { itemId: 31, name: "Dark Crystal Shard", quantity: 25 },
          ],
        }),
      ],
      limited: false,
      merge: true,
      name: "Featured Gear Shop",
    };

    const section = buildSnapshot("shop", shop, 0)?.entries[0]?.sections[0];

    expect(section?.title).toBe("Requirements");
    expect(section?.entries.map((entry) => [entry.title, entry.cells])).toEqual(
      [
        ["Tainted Gem", ["30", "50"]],
        ["Dark Crystal Shard", ["31", "25"]],
      ],
    );
  });

  it("prices a zero-cost item that needs turn-ins as Merge, not Free", () => {
    const snapshot = buildSnapshot(
      "shop",
      smith([
        item({
          itemId: 20,
          name: "Infernal Guardian",
          requirements: [{ itemId: 30, name: "Tainted Gem", quantity: 50 }],
        }),
        item({ itemId: 21, name: "Hat" }),
      ]),
      0,
    );

    expect(
      snapshot?.entries.map((entry) => [
        entry.title,
        entry.cells[1],
        entry.facets.price,
      ]),
    ).toEqual([
      ["Infernal Guardian", "Merge", "Merge"],
      ["Hat", "Free", "Free"],
    ]);
  });

  it("tags AC shop items even when they cost nothing", () => {
    const snapshot = buildSnapshot(
      "shop",
      smith([
        item({ coins: true, cost: 0, itemId: 1, name: "Free AC Blade" }),
        item({ coins: true, cost: 500, itemId: 2, name: "AC Blade" }),
        item({ cost: 0, itemId: 3, name: "Free Blade" }),
      ]),
      0,
    );

    expect(
      snapshot?.entries.map((entry) => [
        entry.title,
        entry.cells[1],
        entry.badges,
        entry.flags,
      ]),
    ).toEqual([
      ["Free AC Blade", "Free", ["AC"], ["ac"]],
      ["AC Blade", "500 AC", [], ["ac"]],
      ["Free Blade", "Free", [], []],
    ]);
  });

  it("reports a missing shop", () => {
    expect(buildSnapshot("shop", null, 0)).toBeNull();
  });

  it("keys quests by ID and lists requirements and rewards", () => {
    const snapshot = buildSnapshot(
      "quest",
      [
        quest({
          cadence: "daily",
          id: 8372,
          name: "The First Observatory",
          requirements: [{ itemId: 5, name: "Notes", quantity: 12 }],
          rewards: [
            { dropChance: 2, itemId: 6, name: "Astral Mantle", quantity: 1 },
          ],
        }),
      ],
      0,
    );

    const entry = snapshot?.entries[0];
    expect(entry?.key).toBe("8372");
    expect(entry?.cells).toEqual(["8372", "Daily"]);
    expect(
      entry?.sections.map((section) => [
        section.title,
        section.entries.map((child) => [child.title, child.cells]),
      ]),
    ).toEqual([
      ["Requirements", [["Notes", ["5", "12"]]]],
      ["Rewards", [["Astral Mantle", ["6", "1", "2%"]]]],
    ]);
  });

  it("rounds drop rates that the game divides by stack size", () => {
    const entry = buildSnapshot(
      "cell-monsters",
      [
        monster({
          drops: [drop({ rateBoostPercent: 20 / 3, ratePercent: 10 / 3 })],
        }),
      ],
      0,
    )?.entries[0];
    const bones = entry?.sections[0]?.entries[0];

    expect(bones?.cells).toEqual(["5", "3.33%"]);
    expect(
      bones?.facts.find((fact) => fact.label === "Rate boost")?.value,
    ).toBe("+6.67%");
  });

  it("dates an aura expiry that isn't on the day it was read", () => {
    const readAt = Date.UTC(2026, 0, 1, 12);
    const expiries = buildSnapshot(
      "cell-monsters",
      [
        monster({
          auras: [
            aura({ expiresAt: readAt + 30_000, name: "Soon" }),
            aura({ expiresAt: readAt + 2 * 86_400_000, name: "Later" }),
          ],
        }),
      ],
      readAt,
    )?.entries[0]?.sections[0]?.entries.map(
      (entry) => entry.facts.find((fact) => fact.label === "Expires")?.value,
    );

    expect(expiries?.map((value) => value?.includes("2026"))).toEqual([
      false,
      true,
    ]);
  });

  it("keeps keys unique when a name already looks like a numbered key", () => {
    const keys = buildSnapshot(
      "cell-monsters",
      [
        monster({
          auras: [
            aura({ name: "Burn" }),
            aura({ name: "Burn~1" }),
            aura({ name: "Burn" }),
          ],
        }),
      ],
      0,
    )?.entries[0]?.sections[0]?.entries.map((entry) => entry.key);

    expect(keys).toEqual(["Burn", "Burn~1", "Burn~2"]);
  });

  it("keys shop items by their shop slot so a reorder keeps each key on its item", () => {
    const before = buildSnapshot(
      "shop",
      smith([blade(1, 100), blade(2, 200)]),
      0,
    );
    const after = buildSnapshot(
      "shop",
      smith([blade(2, 200), blade(1, 100)]),
      0,
    );

    expect([priceOf(before, "1"), priceOf(after, "1")]).toEqual([
      "100 Gold",
      "100 Gold",
    ]);
  });

  it("gives repeated item IDs distinct keys", () => {
    const snapshot = buildSnapshot(
      "inventory",
      [item({ itemId: 100 }), item({ itemId: 100 }), item({ itemId: 200 })],
      0,
    );

    expect(snapshot?.entries.map((entry) => entry.key)).toEqual([
      "100",
      "100~1",
      "200",
    ]);
  });
});

describe("filterEntries", () => {
  it("matches names and IDs inside nested sections", () => {
    const entries =
      buildSnapshot(
        "quest",
        [
          quest({ id: 1, name: "Gather" }),
          quest({
            id: 2,
            name: "Hunt",
            rewards: [{ itemId: 999, name: "Dragon Scale", quantity: 1 }],
          }),
        ],
        0,
      )?.entries ?? [];

    const titles = (query: string) =>
      filterEntries(entries, { filters: NO_FILTERS, query }).map(
        (entry) => entry.title,
      );

    expect(titles("dragon")).toEqual(["Hunt"]);
    expect(titles("999")).toEqual(["Hunt"]);
    expect(titles("  ")).toEqual(["Gather", "Hunt"]);
  });

  it("keeps items in any chosen category that have every chosen flag", () => {
    const entries = inventory([
      item({ category: "Sword", memberOnly: true, name: "Member Sword" }),
      item({ category: "Sword", name: "Free Sword" }),
      item({ category: "Armor", memberOnly: true, name: "Member Armor" }),
      item({ category: "Helm", name: "Helm" }),
    ]);
    const titles = (
      categories: readonly string[],
      flags: readonly ("member" | "equipped")[],
    ) =>
      filterEntries(entries, {
        filters: { facets: { category: categories }, flags },
        query: "",
      }).map((entry) => entry.title);

    expect(titles(["Sword"], [])).toEqual(["Member Sword", "Free Sword"]);
    expect(titles(["Sword", "Armor"], ["member"])).toEqual([
      "Member Sword",
      "Member Armor",
    ]);
    expect(titles([], ["equipped"])).toEqual([]);
  });

  it("filters shop items by whether they cost gold, AC, or nothing", () => {
    const entries =
      buildSnapshot(
        "shop",
        {
          house: false,
          id: 1,
          items: [
            item({ coins: true, cost: 500, name: "AC Blade" }),
            item({ cost: 1_000, name: "Gold Blade" }),
            item({ coins: true, cost: 0, name: "Free Blade" }),
          ],
          limited: false,
          merge: false,
          name: "Shop",
        },
        0,
      )?.entries ?? [];

    expect(
      filterEntries(entries, {
        filters: { facets: { price: ["Free", "AC"] }, flags: [] },
        query: "",
      }).map((entry) => entry.title),
    ).toEqual(["AC Blade", "Free Blade"]);
  });
});

const inventory = (items: readonly GrabbedItem[]): readonly Entry[] =>
  buildSnapshot("inventory", items, 0)?.entries ?? [];

const summary = (groups: readonly FilterGroup[]) =>
  groups.map((group) => [
    group.label,
    group.options.map((option) => [
      option.label,
      option.count,
      option.selected,
    ]),
  ]);

describe("filterGroups", () => {
  const entries = inventory([
    item({ category: "Sword", memberOnly: true, name: "Member Sword" }),
    item({ category: "Sword", name: "Free Sword" }),
    item({ category: "Armor", memberOnly: true, name: "Member Armor" }),
    item({ category: "Helm", name: "Helm" }),
  ]);

  it("counts the rows each option would show alongside the other filters", () => {
    const groups = filterGroups(entries, {
      filters: { facets: { category: ["Sword"] }, flags: [] },
      query: "",
    });

    expect(summary(groups)).toEqual([
      ["Show only", [["Member", 1, false]]],
      [
        "Category",
        [
          ["Armor", 1, false],
          ["Helm", 1, false],
          ["Sword", 2, true],
        ],
      ],
    ]);
  });

  it("counts only rows that match the search", () => {
    const groups = filterGroups(entries, {
      filters: NO_FILTERS,
      query: "member",
    });

    expect(summary(groups)).toEqual([
      ["Show only", [["Member", 2, false]]],
      [
        "Category",
        [
          ["Armor", 1, false],
          ["Helm", 0, false],
          ["Sword", 1, false],
        ],
      ],
    ]);
  });

  it("toggles an option on and off", () => {
    const member = filterGroups(entries, {
      filters: NO_FILTERS,
      query: "",
    })[0]?.options[0];
    const on = member?.toggle(NO_FILTERS) ?? NO_FILTERS;

    expect(
      filterEntries(entries, { filters: on, query: "" }).map(
        (entry) => entry.title,
      ),
    ).toEqual(["Member Sword", "Member Armor"]);
    expect(member?.toggle(on)).toEqual(NO_FILTERS);
  });

  it("hides filters that would not narrow the list", () => {
    const groups = filterGroups(
      inventory([
        item({ category: "Sword", memberOnly: true, name: "A" }),
        item({ category: "Sword", memberOnly: true, name: "B" }),
      ]),
      { filters: NO_FILTERS, query: "" },
    );

    expect(groups).toEqual([]);
  });

  it("keeps a chosen option visible after a refresh removes its rows", () => {
    const groups = filterGroups(
      inventory([item({ category: "Sword", name: "A" })]),
      {
        filters: { facets: { category: ["Axe"] }, flags: ["member"] },
        query: "",
      },
    );

    expect(summary(groups)).toEqual([
      ["Show only", [["Member", 0, true]]],
      [
        "Category",
        [
          ["Axe", 0, true],
          ["Sword", 0, false],
        ],
      ],
    ]);
  });
});
