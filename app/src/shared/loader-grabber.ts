import { PositiveInt } from "@lucent/core";
import * as Schema from "effect/Schema";

export const LoaderGrabberLoadTypes = [
  "hair-shop",
  "shop",
  "quest",
  "armor-customizer",
] as const;

export const LoaderGrabberGrabTypes = [
  "shop",
  "quest",
  "inventory",
  "temp-inventory",
  "bank",
  "cell-monsters",
  "map-monsters",
] as const;

export const LoaderGrabberLoadTypeSchema = Schema.Literals(
  LoaderGrabberLoadTypes,
);
export const LoaderGrabberGrabTypeSchema = Schema.Literals(
  LoaderGrabberGrabTypes,
);

export type LoaderGrabberLoadType = typeof LoaderGrabberLoadTypeSchema.Type;
export type LoaderGrabberGrabType = typeof LoaderGrabberGrabTypeSchema.Type;

export const LoaderGrabberLoadRequestSchema = Schema.Union([
  Schema.Struct({
    id: PositiveInt,
    type: Schema.Literals(["hair-shop", "quest", "shop"]),
  }),
  Schema.Struct({
    type: Schema.Literal("armor-customizer"),
  }),
]);
export type LoaderGrabberLoadRequest =
  typeof LoaderGrabberLoadRequestSchema.Type;

export const LoaderGrabberGrabRequestSchema = Schema.Struct({
  type: LoaderGrabberGrabTypeSchema,
});
export type LoaderGrabberGrabRequest =
  typeof LoaderGrabberGrabRequestSchema.Type;

const EnhancementSchema = Schema.Struct({
  dps: Schema.optionalKey(Schema.Number),
  id: Schema.optionalKey(Schema.Number),
  level: Schema.optionalKey(Schema.Number),
  patternId: Schema.optionalKey(Schema.Number),
  procId: Schema.optionalKey(Schema.Number),
  range: Schema.optionalKey(Schema.Number),
  rarity: Schema.optionalKey(Schema.Number),
});

export const GrabbedItemSchema = Schema.Struct({
  armor: Schema.Boolean,
  banked: Schema.Boolean,
  cape: Schema.Boolean,
  category: Schema.String,
  charItemId: Schema.optionalKey(Schema.Number),
  classItem: Schema.Boolean,
  coins: Schema.Boolean,
  context: Schema.Literals([
    "bank",
    "drop",
    "house",
    "inventory",
    "monster-drop",
    "shop",
    "temporary",
  ]),
  cost: Schema.Number,
  description: Schema.String,
  enhancement: Schema.optionalKey(EnhancementSchema),
  equipped: Schema.Boolean,
  equipmentSlot: Schema.String,
  file: Schema.String,
  helm: Schema.Boolean,
  houseItem: Schema.Boolean,
  itemId: Schema.Number,
  link: Schema.String,
  memberOnly: Schema.Boolean,
  meta: Schema.String,
  name: Schema.String,
  pet: Schema.Boolean,
  quantity: Schema.Number,
  shopItemId: Schema.optionalKey(Schema.Number),
  temporaryItem: Schema.Boolean,
  wearable: Schema.Boolean,
  weapon: Schema.Boolean,
  worn: Schema.Boolean,
});
export type GrabbedItem = typeof GrabbedItemSchema.Type;

const MonsterDropSchema = Schema.Struct({
  eventDrop: Schema.Boolean,
  icon: Schema.String,
  item: GrabbedItemSchema,
  questGated: Schema.Boolean,
  questObjectives: Schema.Array(Schema.String),
  rarity: Schema.Number,
  rarityName: Schema.String,
  rateBoostPercent: Schema.NullOr(Schema.Number),
  ratePercent: Schema.NullOr(Schema.Number),
  requiredQuestIds: Schema.Array(Schema.Number),
  requiredQuests: Schema.Array(Schema.String),
  stackSize: Schema.Number,
  variableQuantity: Schema.Boolean,
});

const QuestItemSchema = Schema.Struct({
  itemId: Schema.Number,
  name: Schema.String,
  quantity: Schema.Number,
  temporaryItem: Schema.optionalKey(Schema.Boolean),
});

const QuestRewardSchema = Schema.Struct({
  ...QuestItemSchema.fields,
  dropChance: Schema.optionalKey(Schema.Number),
});

export const GrabbedQuestSchema = Schema.Struct({
  cadence: Schema.Literals(["daily", "monthly", "none", "weekly"]),
  id: Schema.Number,
  name: Schema.String,
  once: Schema.Boolean,
  requirements: Schema.Array(QuestItemSchema),
  rewards: Schema.Array(QuestRewardSchema),
});
export type GrabbedQuest = typeof GrabbedQuestSchema.Type;

export const GrabbedShopSchema = Schema.Struct({
  house: Schema.Boolean,
  id: Schema.Number,
  items: Schema.Array(GrabbedItemSchema),
  limited: Schema.Boolean,
  merge: Schema.Boolean,
  name: Schema.String,
});
export type GrabbedShop = typeof GrabbedShopSchema.Type;

const AuraSchema = Schema.Struct({
  category: Schema.optionalKey(Schema.String),
  duration: Schema.Number,
  expiresAt: Schema.optionalKey(Schema.Number),
  icon: Schema.optionalKey(Schema.String),
  kind: Schema.Literals(["active", "passive"]),
  name: Schema.String,
  persistent: Schema.Boolean,
  stack: Schema.Number,
  value: Schema.optionalKey(Schema.Union([Schema.Number, Schema.String])),
});

export const GrabbedMonsterSchema = Schema.Struct({
  alive: Schema.Boolean,
  auras: Schema.Array(AuraSchema),
  cell: Schema.String,
  dead: Schema.Boolean,
  drops: Schema.Array(MonsterDropSchema),
  hp: Schema.Number,
  hpPercent: Schema.Number,
  idle: Schema.Boolean,
  inCombat: Schema.Boolean,
  level: Schema.Number,
  maxHp: Schema.Number,
  maxMp: Schema.Number,
  monsterId: Schema.Number,
  monsterMapId: Schema.Number,
  mp: Schema.Number,
  mpPercent: Schema.Number,
  name: Schema.String,
  race: Schema.String,
  state: Schema.Literals([0, 1, 2]),
});
export type GrabbedMonster = typeof GrabbedMonsterSchema.Type;

export interface GrabbedDataByType {
  readonly bank: readonly GrabbedItem[];
  readonly "cell-monsters": readonly GrabbedMonster[];
  readonly inventory: readonly GrabbedItem[];
  readonly "map-monsters": readonly GrabbedMonster[];
  readonly quest: readonly GrabbedQuest[];
  readonly shop: GrabbedShop;
  readonly "temp-inventory": readonly GrabbedItem[];
}

export type GrabbedData = GrabbedDataByType[LoaderGrabberGrabType];

export const GrabbedDataSchema = Schema.Union([
  GrabbedShopSchema,
  Schema.Array(GrabbedQuestSchema),
  Schema.Array(GrabbedItemSchema),
  Schema.Array(GrabbedMonsterSchema),
]);

const loadTypeSet = new Set<string>(LoaderGrabberLoadTypes);
const grabTypeSet = new Set<string>(LoaderGrabberGrabTypes);

export const isLoaderGrabberLoadType = (
  value: unknown,
): value is LoaderGrabberLoadType =>
  typeof value === "string" && loadTypeSet.has(value);

export const isLoaderGrabberGrabType = (
  value: unknown,
): value is LoaderGrabberGrabType =>
  typeof value === "string" && grabTypeSet.has(value);

export const loaderGrabberLoadRequiresId = (
  type: LoaderGrabberLoadType | null | undefined,
): boolean =>
  type !== null && type !== undefined && type !== "armor-customizer";

const recordFrom = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};

const positiveIntegerFrom = (value: unknown): number | null => {
  const number =
    typeof value === "string" && value.trim() !== ""
      ? Number(value)
      : typeof value === "number"
        ? value
        : Number.NaN;
  return Number.isSafeInteger(number) && number > 0 ? number : null;
};

export const normalizeLoaderGrabberLoadRequest = (
  value: unknown,
): LoaderGrabberLoadRequest => {
  const input = recordFrom(value);
  if (!isLoaderGrabberLoadType(input["type"])) {
    throw new Error("Choose a valid loader source.");
  }

  const type = input["type"];
  if (type === "armor-customizer") {
    return { type };
  }

  const id = positiveIntegerFrom(input["id"]);
  if (id === null) {
    throw new Error("Enter a positive integer ID.");
  }
  return { id, type };
};

export const normalizeLoaderGrabberGrabRequest = (
  value: unknown,
): LoaderGrabberGrabRequest => {
  const type = recordFrom(value)["type"];
  if (!isLoaderGrabberGrabType(type)) {
    throw new Error("Choose a valid grabber source.");
  }
  return { type };
};
