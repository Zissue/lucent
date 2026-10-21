import { getItemEnhancementNames } from "@lucent/game";

import type {
  GrabbedData,
  GrabbedDataByType,
  GrabbedItem,
  GrabbedMonster,
  GrabbedQuest,
  LoaderGrabberGrabType,
  LoaderGrabberLoadRequest,
  LoaderGrabberLoadType,
} from "../../../shared/loader-grabber";

export type Source = LoaderGrabberGrabType;
export type OpenTarget = LoaderGrabberLoadType;

interface EmptyCopy {
  readonly title: string;
  readonly description: string;
}

export interface SourceInfo {
  readonly id: Source;
  readonly label: string;
  readonly empty: EmptyCopy;
  readonly missing?: EmptyCopy;
}

export const SOURCES: Readonly<Record<Source, SourceInfo>> = {
  shop: {
    empty: {
      description: "This shop doesn't sell anything right now.",
      title: "No items",
    },
    id: "shop",
    label: "Shop",
    missing: {
      description:
        "Open a shop in the game or load one by ID, and its items appear here.",
      title: "No shop open",
    },
  },
  quest: {
    empty: {
      description:
        "Quests appear here once the game loads them, or load one by ID.",
      title: "No quests loaded",
    },
    id: "quest",
    label: "Quests",
  },
  inventory: {
    empty: {
      description: "Items you carry appear here.",
      title: "Inventory is empty",
    },
    id: "inventory",
    label: "Inventory",
  },
  "temp-inventory": {
    empty: {
      description: "Quest items you pick up appear here.",
      title: "Temp inventory is empty",
    },
    id: "temp-inventory",
    label: "Temp inventory",
  },
  bank: {
    empty: {
      description:
        "Bank items appear after the bank loads. Open your bank in the game, then refresh.",
      title: "Bank is empty",
    },
    id: "bank",
    label: "Bank",
  },
  "cell-monsters": {
    empty: {
      description: "Monsters in your current cell appear here.",
      title: "No monsters in this cell",
    },
    id: "cell-monsters",
    label: "Cell monsters",
  },
  "map-monsters": {
    empty: {
      description: "Monsters anywhere on this map appear here.",
      title: "No monsters on this map",
    },
    id: "map-monsters",
    label: "Map monsters",
  },
};

export const SOURCE_GROUPS: readonly {
  readonly label: string;
  readonly sources: readonly Source[];
}[] = [
  { label: "Loaded", sources: ["shop", "quest"] },
  { label: "Character", sources: ["inventory", "temp-inventory", "bank"] },
  { label: "World", sources: ["cell-monsters", "map-monsters"] },
];

export const SOURCE_ORDER: readonly Source[] = SOURCE_GROUPS.flatMap(
  (group) => group.sources,
);

export type OpenTargetInfo =
  | {
      readonly id: Exclude<OpenTarget, "armor-customizer">;
      readonly kind: "by-id";
      readonly label: string;
      readonly opens: Source | null;
    }
  | {
      readonly id: "armor-customizer";
      readonly kind: "direct";
      readonly label: string;
      readonly opens: null;
    };

const OPEN_TARGET_INFO: Readonly<Record<OpenTarget, OpenTargetInfo>> = {
  shop: {
    id: "shop",
    kind: "by-id",
    label: "Shop",
    opens: "shop",
  },
  quest: {
    id: "quest",
    kind: "by-id",
    label: "Quest",
    opens: "quest",
  },
  "hair-shop": {
    id: "hair-shop",
    kind: "by-id",
    label: "Hair shop",
    opens: null,
  },
  "armor-customizer": {
    id: "armor-customizer",
    kind: "direct",
    label: "Armor customizer",
    opens: null,
  },
};

export const OPEN_TARGETS: readonly OpenTargetInfo[] = [
  OPEN_TARGET_INFO.shop,
  OPEN_TARGET_INFO.quest,
  OPEN_TARGET_INFO["hair-shop"],
  OPEN_TARGET_INFO["armor-customizer"],
];

export const openTargetInfo = (id: OpenTarget): OpenTargetInfo =>
  OPEN_TARGET_INFO[id];

export const describeOpenRequest = (
  request: LoaderGrabberLoadRequest,
): string =>
  request.type === "armor-customizer"
    ? "Armor customizer"
    : `${openTargetInfo(request.type).label} ${request.id}`;

const ID_INPUT = /^\d{1,9}$/u;

export const parseIdInput = (value: string): number | null => {
  const text = value.normalize("NFKC").trim();
  const id = ID_INPUT.test(text) ? Number(text) : 0;
  return id > 0 ? id : null;
};

export type FactRole = "id" | "property" | "note";

export interface Fact {
  readonly label: string;
  readonly value: string;
  readonly role: FactRole;
  readonly expiresAt?: number;
}

export type EntryJson =
  | GrabbedItem
  | NonNullable<GrabbedItem["requirements"]>[number]
  | GrabbedQuest
  | GrabbedQuest["requirements"][number]
  | GrabbedQuest["rewards"][number]
  | GrabbedMonster
  | GrabbedMonster["auras"][number]
  | GrabbedMonster["drops"][number];

export type ColumnKind = "id" | "number" | "text";

export interface Column {
  readonly label: string;
  readonly kind: ColumnKind;
}

const FACETS = [
  { id: "price", label: "Price" },
  { id: "category", label: "Category" },
] as const;

export type Facet = (typeof FACETS)[number]["id"];

const FLAGS = [
  { id: "equipped", label: "Equipped" },
  { id: "member", label: "Member" },
  { id: "ac", label: "AC tagged" },
  { id: "enhanced", label: "Enhanced" },
  { id: "requirements", label: "Has requirements" },
] as const;

export type Flag = (typeof FLAGS)[number]["id"];

export interface Entry {
  readonly key: string;
  readonly title: string;
  readonly primary: Fact;
  readonly cells: readonly string[];
  readonly badges: readonly string[];
  readonly facts: readonly Fact[];
  readonly sections: readonly Section[];
  readonly facets: Readonly<Partial<Record<Facet, string>>>;
  readonly flags: readonly Flag[];
  readonly searchText: string;
  readonly json: EntryJson;
}

export interface Section {
  readonly title: string;
  readonly columns: readonly Column[];
  readonly entries: readonly Entry[];
}

export interface Snapshot {
  readonly source: Source;
  readonly heading: string | null;
  readonly headingFacts: readonly Fact[];
  readonly headingBadges: readonly string[];
  readonly columns: readonly Column[];
  readonly entries: readonly Entry[];
  readonly data: GrabbedData;
  readonly grabbedAt: number;
}

type EntryInput = Omit<
  Entry,
  "facets" | "flags" | "key" | "searchText" | "sections"
> &
  Partial<Pick<Entry, "facets" | "flags" | "sections">> & {
    readonly identity?: number;
  };

const numberFormat = new Intl.NumberFormat();

export const formatNumber = (value: number): string =>
  numberFormat.format(value);

const percentFormat = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 2,
});

const formatPercent = (value: number): string =>
  `${percentFormat.format(value)}%`;

const dayFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "short" });

const timeFormat = new Intl.DateTimeFormat(undefined, { timeStyle: "medium" });

const dateTimeFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "medium",
});

const formatMoment = (at: number, now: number): string =>
  dayFormat.format(at) === dayFormat.format(now)
    ? timeFormat.format(at)
    : dateTimeFormat.format(at);

const idFact = (label: string, value: number | undefined): Fact | undefined =>
  value === undefined ? undefined : { label, role: "id", value: String(value) };

const prop = (label: string, value: string): Fact => ({
  label,
  role: "property",
  value,
});

const textFact = (
  label: string,
  value: string | undefined,
  role: FactRole = "property",
): Fact | undefined => {
  const text = value?.trim() ?? "";
  return text === "" ? undefined : { label, role, value: text };
};

const present = <Value>(values: readonly (Value | undefined)[]): Value[] =>
  values.filter((value): value is Value => value !== undefined);

const searchTextOf = (entry: EntryInput): string =>
  [
    entry.title,
    ...entry.cells,
    ...entry.badges,
    ...entry.facts.map((fact) => fact.value),
    ...(entry.sections ?? []).flatMap((section) =>
      section.entries.map((child) => child.searchText),
    ),
  ]
    .join("\n")
    .toLocaleLowerCase();

const keyed = (inputs: readonly EntryInput[]): readonly Entry[] => {
  const used = new Set<string>();
  return inputs.map(({ identity, ...input }) => {
    const base = String(identity ?? input.primary.value);
    let key = base;
    for (let count = 1; used.has(key); count += 1) {
      key = `${base}~${count}`;
    }
    used.add(key);
    return {
      ...input,
      key,
      facets: input.facets ?? {},
      flags: input.flags ?? [],
      searchText: searchTextOf(input),
      sections: input.sections ?? [],
    };
  });
};

const nameOr = (name: string, fallback: string): string =>
  name.trim() === "" ? fallback : name;

const priceKind = (item: GrabbedItem): "AC" | "Free" | "Gold" | "Merge" => {
  if (item.cost === 0) {
    return (item.requirements ?? []).length > 0 ? "Merge" : "Free";
  }
  return item.coins ? "AC" : "Gold";
};

const priceText = (item: GrabbedItem): string => {
  const kind = priceKind(item);
  return item.cost === 0 ? kind : `${formatNumber(item.cost)} ${kind}`;
};

const categoryFacet = (item: GrabbedItem): Entry["facets"] => {
  const category = item.category.trim();
  return category === "" ? {} : { category };
};

const isEnhanced = (item: GrabbedItem): boolean =>
  item.enhancement !== undefined &&
  getItemEnhancementNames(item.enhancement).name !== undefined;

const itemBadges = (item: GrabbedItem): string[] =>
  present([
    item.equipped ? "Equipped" : undefined,
    item.memberOnly ? "Member" : undefined,
    item.coins ? "AC" : undefined,
  ]);

const itemFacts = (
  item: GrabbedItem,
  options: { readonly shop: boolean },
): Fact[] => {
  const enhancement =
    item.enhancement === undefined
      ? undefined
      : getItemEnhancementNames(item.enhancement);
  return present([
    idFact("Item ID", item.itemId),
    options.shop
      ? idFact("Shop item ID", item.shopItemId)
      : idFact("Char item ID", item.charItemId),
    prop("Quantity", formatNumber(item.quantity)),
    prop("Price", priceText(item)),
    textFact("Category", item.category),
    textFact("Enhancement", enhancement?.name),
    textFact("Special", enhancement?.special),
    textFact("Description", item.description, "note"),
  ]);
};

const ITEM_COLUMNS: readonly Column[] = [
  { kind: "id", label: "Item ID" },
  { kind: "text", label: "Category" },
  { kind: "number", label: "Qty" },
];

const itemEntry = (item: GrabbedItem): EntryInput => ({
  ...(item.charItemId === undefined ? {} : { identity: item.charItemId }),
  badges: itemBadges(item),
  cells: [String(item.itemId), item.category, formatNumber(item.quantity)],
  facets: categoryFacet(item),
  facts: itemFacts(item, { shop: false }),
  flags: present<Flag>([
    item.equipped ? "equipped" : undefined,
    item.memberOnly ? "member" : undefined,
    item.coins ? "ac" : undefined,
    isEnhanced(item) ? "enhanced" : undefined,
  ]),
  json: item,
  primary: { label: "Item ID", role: "id", value: String(item.itemId) },
  title: nameOr(item.name, "Unnamed item"),
});

const tempItemEntry = (item: GrabbedItem): EntryInput => ({
  badges: [],
  cells: [String(item.itemId), formatNumber(item.quantity)],
  facts: present([
    idFact("Item ID", item.itemId),
    prop("Quantity", formatNumber(item.quantity)),
  ]),
  json: item,
  primary: { label: "Item ID", role: "id", value: String(item.itemId) },
  title: nameOr(item.name, "Unnamed item"),
});

const REQUIRED_ITEM_COLUMNS: readonly Column[] = [
  { kind: "id", label: "Item ID" },
  { kind: "number", label: "Qty" },
];

const requiredItemEntry = (
  item: NonNullable<GrabbedItem["requirements"]>[number] &
    GrabbedQuest["requirements"][number],
): EntryInput => ({
  badges: item.temporaryItem === true ? ["Temp"] : [],
  cells: [String(item.itemId), formatNumber(item.quantity)],
  facts: present([
    idFact("Item ID", item.itemId),
    prop("Quantity", formatNumber(item.quantity)),
  ]),
  json: item,
  primary: { label: "Item ID", role: "id", value: String(item.itemId) },
  title: nameOr(item.name, "Unnamed item"),
});

const shopItemEntry = (item: GrabbedItem): EntryInput => {
  const requirements = keyed((item.requirements ?? []).map(requiredItemEntry));
  return {
    ...(item.shopItemId === undefined ? {} : { identity: item.shopItemId }),
    badges: present([
      item.memberOnly ? "Member" : undefined,
      item.coins && priceKind(item) !== "AC" ? "AC" : undefined,
    ]),
    cells: [String(item.itemId), priceText(item), formatNumber(item.quantity)],
    facets: { ...categoryFacet(item), price: priceKind(item) },
    facts: itemFacts(item, { shop: true }),
    flags: present<Flag>([
      item.memberOnly ? "member" : undefined,
      item.coins ? "ac" : undefined,
      isEnhanced(item) ? "enhanced" : undefined,
      requirements.length > 0 ? "requirements" : undefined,
    ]),
    json: item,
    primary: { label: "Item ID", role: "id", value: String(item.itemId) },
    sections:
      requirements.length === 0
        ? []
        : [
            {
              columns: REQUIRED_ITEM_COLUMNS,
              entries: requirements,
              title: "Requirements",
            },
          ],
    title: nameOr(item.name, "Unnamed item"),
  };
};

const QUEST_REPEAT: Record<GrabbedQuest["cadence"], string> = {
  daily: "Daily",
  monthly: "Monthly",
  none: "Unlimited",
  weekly: "Weekly",
};

const questRepeat = (quest: GrabbedQuest): string =>
  quest.once ? "Once" : QUEST_REPEAT[quest.cadence];

const questEntry = (quest: GrabbedQuest): EntryInput => {
  const requirements = keyed(quest.requirements.map(requiredItemEntry));
  const rewards = keyed(
    quest.rewards.map((item) => {
      const chance =
        item.dropChance === undefined ? "—" : formatPercent(item.dropChance);
      return {
        badges: [],
        cells: [String(item.itemId), formatNumber(item.quantity), chance],
        facts: present([
          idFact("Item ID", item.itemId),
          prop("Quantity", formatNumber(item.quantity)),
          item.dropChance === undefined
            ? undefined
            : prop("Drop chance", chance),
        ]),
        json: item,
        primary: { label: "Item ID", role: "id", value: String(item.itemId) },
        title: nameOr(item.name, "Unnamed item"),
      };
    }),
  );

  return {
    badges: [],
    cells: [String(quest.id), questRepeat(quest)],
    facts: [
      { label: "Quest ID", role: "id", value: String(quest.id) },
      prop("Repeat", questRepeat(quest)),
    ],
    json: quest,
    primary: { label: "Quest ID", role: "id", value: String(quest.id) },
    sections: [
      ...(requirements.length === 0
        ? []
        : [
            {
              columns: REQUIRED_ITEM_COLUMNS,
              entries: requirements,
              title: "Requirements",
            },
          ]),
      ...(rewards.length === 0
        ? []
        : [
            {
              columns: [
                { kind: "id", label: "Item ID" },
                { kind: "number", label: "Qty" },
                { kind: "number", label: "Chance" },
              ] satisfies Column[],
              entries: rewards,
              title: "Rewards",
            },
          ]),
    ],
    title: nameOr(quest.name, `Quest ${quest.id}`),
  };
};

const joined = (values: readonly (number | string)[]): string | undefined =>
  values.length === 0 ? undefined : values.join(", ");

const monsterDropEntry = (
  drop: GrabbedMonster["drops"][number],
): EntryInput => {
  const rate =
    drop.ratePercent === null ? "—" : formatPercent(drop.ratePercent);
  return {
    badges: present([
      drop.eventDrop ? "Event" : undefined,
      drop.questGated ? "Quest gated" : undefined,
      drop.item.memberOnly ? "Member" : undefined,
    ]),
    cells: [String(drop.item.itemId), rate],
    facts: present([
      idFact("Item ID", drop.item.itemId),
      drop.ratePercent === null ? undefined : prop("Drop rate", rate),
      drop.rateBoostPercent === null
        ? undefined
        : prop("Rate boost", `+${formatPercent(drop.rateBoostPercent)}`),
      textFact("Rarity", drop.rarityName),
      prop(
        "Stack size",
        drop.variableQuantity
          ? `${formatNumber(drop.stackSize)} (varies)`
          : formatNumber(drop.stackSize),
      ),
      textFact("Category", drop.item.category),
      textFact("Required quest IDs", joined(drop.requiredQuestIds)),
      textFact("Required quests", joined(drop.requiredQuests), "note"),
      textFact("Quest objectives", joined(drop.questObjectives), "note"),
    ]),
    json: drop,
    primary: { label: "Item ID", role: "id", value: String(drop.item.itemId) },
    title: nameOr(drop.item.name, "Unnamed item"),
  };
};

const auraEntry = (
  aura: GrabbedMonster["auras"][number],
  now: number,
): EntryInput => ({
  badges: present([
    aura.kind === "passive" ? "Passive" : undefined,
    aura.persistent ? "Persistent" : undefined,
  ]),
  cells: [formatNumber(aura.stack)],
  facts: present([
    prop("Stack", formatNumber(aura.stack)),
    aura.value === undefined ? undefined : prop("Value", String(aura.value)),
    textFact("Category", aura.category),
    aura.duration > 0
      ? prop("Duration", `${formatNumber(aura.duration)}s`)
      : undefined,
    aura.expiresAt === undefined
      ? undefined
      : {
          expiresAt: aura.expiresAt,
          label: "Expires",
          role: "property",
          value: formatMoment(aura.expiresAt, now),
        },
  ]),
  json: aura,
  primary: { label: "Name", role: "property", value: aura.name },
  title: nameOr(aura.name, "Unnamed aura"),
});

const monsterEntry = (
  monster: GrabbedMonster,
  options: { readonly inCell: boolean; readonly now: number },
): EntryInput => {
  const auras = keyed(
    monster.auras.map((aura) => auraEntry(aura, options.now)),
  );
  const drops = keyed(monster.drops.map(monsterDropEntry));
  const health = `${formatNumber(monster.hp)} / ${formatNumber(monster.maxHp)}`;
  const healthPercent =
    monster.maxHp > 0 ? Math.round((monster.hp / monster.maxHp) * 100) : 0;
  return {
    badges: present([
      options.inCell && monster.inCombat ? "In combat" : undefined,
    ]),
    cells: [
      String(monster.monsterMapId),
      String(monster.level),
      options.inCell ? `${healthPercent}%` : monster.cell,
    ],
    facts: present([
      idFact("MonMapID", monster.monsterMapId),
      idFact("Monster ID", monster.monsterId),
      textFact("Race", monster.race),
      prop("Level", String(monster.level)),
      options.inCell ? prop("Health", health) : undefined,
      textFact("Cell", monster.cell),
    ]),
    json: monster,
    primary: {
      label: "MonMapID",
      role: "id",
      value: String(monster.monsterMapId),
    },
    sections: [
      ...(auras.length === 0
        ? []
        : [
            {
              columns: [{ kind: "number", label: "Stack" }] satisfies Column[],
              entries: auras,
              title: "Auras",
            },
          ]),
      ...(drops.length === 0
        ? []
        : [
            {
              columns: [
                { kind: "id", label: "Item ID" },
                { kind: "number", label: "Rate" },
              ] satisfies Column[],
              entries: drops,
              title: "Drops",
            },
          ]),
    ],
    title: nameOr(monster.name, "Unnamed monster"),
  };
};

const MONSTER_COLUMNS = (inCell: boolean): readonly Column[] => [
  { kind: "id", label: "MonMapID" },
  { kind: "number", label: "Level" },
  inCell
    ? { kind: "number", label: "Health" }
    : { kind: "text", label: "Cell" },
];

interface SnapshotContent {
  readonly heading: string | null;
  readonly headingFacts: readonly Fact[];
  readonly headingBadges: readonly string[];
  readonly columns: readonly Column[];
  readonly entries: readonly Entry[];
}

const list = (
  columns: readonly Column[],
  entries: readonly EntryInput[],
): SnapshotContent => ({
  columns,
  entries: keyed(entries),
  heading: null,
  headingBadges: [],
  headingFacts: [],
});

const isShop = (data: GrabbedData): data is GrabbedDataByType["shop"] =>
  !Array.isArray(data) && "items" in data;

const contentFor = (
  source: Source,
  data: GrabbedData,
  now: number,
): SnapshotContent | null => {
  if (source === "shop") {
    if (!isShop(data)) {
      return null;
    }
    return {
      columns: [
        { kind: "id", label: "Item ID" },
        { kind: "number", label: "Price" },
        { kind: "number", label: "Qty" },
      ],
      entries: keyed(data.items.map(shopItemEntry)),
      heading: nameOr(data.name, `Shop ${data.id}`),
      headingBadges: present([
        data.merge ? "Merge" : undefined,
        data.limited ? "Limited" : undefined,
        data.house ? "House" : undefined,
      ]),
      headingFacts: [{ label: "Shop ID", role: "id", value: String(data.id) }],
    };
  }
  if (!Array.isArray(data)) {
    return null;
  }
  switch (source) {
    case "quest":
      return list(
        [
          { kind: "id", label: "Quest ID" },
          { kind: "text", label: "Repeat" },
        ],
        (data as readonly GrabbedQuest[]).map(questEntry),
      );
    case "inventory":
    case "bank":
      return list(
        ITEM_COLUMNS,
        (data as readonly GrabbedItem[]).map(itemEntry),
      );
    case "temp-inventory":
      return list(
        [
          { kind: "id", label: "Item ID" },
          { kind: "number", label: "Qty" },
        ],
        (data as readonly GrabbedItem[]).map(tempItemEntry),
      );
    case "cell-monsters":
      return list(
        MONSTER_COLUMNS(true),
        (data as readonly GrabbedMonster[]).map((monster) =>
          monsterEntry(monster, { inCell: true, now }),
        ),
      );
    case "map-monsters":
      return list(
        MONSTER_COLUMNS(false),
        (data as readonly GrabbedMonster[]).map((monster) =>
          monsterEntry(monster, { inCell: false, now }),
        ),
      );
  }
};

export const buildSnapshot = (
  source: Source,
  data: GrabbedData | null,
  grabbedAt: number,
): Snapshot | null => {
  const content = data === null ? null : contentFor(source, data, grabbedAt);
  return content === null || data === null
    ? null
    : { ...content, data, grabbedAt, source };
};

export interface Filters {
  readonly facets: Readonly<Partial<Record<Facet, readonly string[]>>>;
  readonly flags: readonly Flag[];
}

export const NO_FILTERS: Filters = { facets: {}, flags: [] };

export interface Criteria {
  readonly query: string;
  readonly filters: Filters;
}

export interface FilterOption {
  readonly key: string;
  readonly label: string;
  readonly count: number;
  readonly selected: boolean;
  readonly toggle: (filters: Filters) => Filters;
}

export interface FilterGroup {
  readonly key: string;
  readonly label: string;
  readonly options: readonly FilterOption[];
}

export const activeFilterCount = (filters: Filters): number =>
  FACETS.reduce(
    (count, facet) => count + (filters.facets[facet.id]?.length ?? 0),
    filters.flags.length,
  );

const toggled = <Value>(
  values: readonly Value[],
  value: Value,
): readonly Value[] =>
  values.includes(value)
    ? values.filter((current) => current !== value)
    : [...values, value];

const matcher = ({ filters, query }: Criteria): ((entry: Entry) => boolean) => {
  const needle = query.trim().toLocaleLowerCase();
  return (entry) =>
    entry.searchText.includes(needle) &&
    filters.flags.every((flag) => entry.flags.includes(flag)) &&
    FACETS.every(({ id }) => {
      const chosen = filters.facets[id] ?? [];
      const value = entry.facets[id];
      return (
        chosen.length === 0 || (value !== undefined && chosen.includes(value))
      );
    });
};

export const filterEntries = (
  entries: readonly Entry[],
  criteria: Criteria,
): readonly Entry[] =>
  criteria.query.trim() === "" && activeFilterCount(criteria.filters) === 0
    ? entries
    : entries.filter(matcher(criteria));

const flagOptions = (
  entries: readonly Entry[],
  criteria: Criteria,
): FilterOption[] =>
  FLAGS.flatMap(({ id, label }) => {
    const { filters } = criteria;
    const selected = filters.flags.includes(id);
    const total = entries.filter((entry) => entry.flags.includes(id)).length;
    if (!selected && (total === 0 || total === entries.length)) {
      return [];
    }
    const others = entries.filter(
      matcher({
        ...criteria,
        filters: {
          ...filters,
          flags: filters.flags.filter((flag) => flag !== id),
        },
      }),
    );
    return [
      {
        count: others.filter((entry) => entry.flags.includes(id)).length,
        key: id,
        label,
        selected,
        toggle: (current: Filters): Filters => ({
          ...current,
          flags: toggled(current.flags, id),
        }),
      },
    ];
  });

const facetGroups = (
  entries: readonly Entry[],
  criteria: Criteria,
): FilterGroup[] =>
  FACETS.flatMap(({ id, label }) => {
    const { filters } = criteria;
    const chosen = filters.facets[id] ?? [];
    const values = new Set(chosen);
    for (const entry of entries) {
      const value = entry.facets[id];
      if (value !== undefined) {
        values.add(value);
      }
    }
    if (chosen.length === 0 && values.size < 2) {
      return [];
    }
    const counts = new Map<string, number>();
    const others = entries.filter(
      matcher({
        ...criteria,
        filters: { ...filters, facets: { ...filters.facets, [id]: [] } },
      }),
    );
    for (const entry of others) {
      const value = entry.facets[id];
      if (value !== undefined) {
        counts.set(value, (counts.get(value) ?? 0) + 1);
      }
    }
    return [
      {
        key: id,
        label,
        options: [...values]
          .toSorted((left, right) => left.localeCompare(right))
          .map((value) => ({
            count: counts.get(value) ?? 0,
            key: value,
            label: value,
            selected: chosen.includes(value),
            toggle: (current: Filters): Filters => ({
              ...current,
              facets: {
                ...current.facets,
                [id]: toggled(current.facets[id] ?? [], value),
              },
            }),
          })),
      },
    ];
  });

export const filterGroups = (
  entries: readonly Entry[],
  criteria: Criteria,
): readonly FilterGroup[] => {
  const flags = flagOptions(entries, criteria);
  return [
    ...(flags.length === 0
      ? []
      : [{ key: "flags", label: "Show only", options: flags }]),
    ...facetGroups(entries, criteria),
  ];
};

export const exportFileName = (snapshot: Snapshot): string => {
  const shopId = snapshot.headingFacts.find(
    (fact) => fact.label === "Shop ID",
  )?.value;
  return shopId === undefined
    ? `${snapshot.source}.json`
    : `${snapshot.source}-${shopId}.json`;
};
