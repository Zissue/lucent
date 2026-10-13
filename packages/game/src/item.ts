import { getItemEnhancementNames } from "./enhancement";
import { LiveModel, normalizeGameText } from "./model";

export type ItemContext =
  | "bank"
  | "drop"
  | "house"
  | "inventory"
  | "monster-drop"
  | "shop"
  | "temporary";

/**
 * `"bag"` counts equipment and equippable consumables such as potions.
 * `"misc"` counts resources, quest items, notes, and other non-consumable items
 * of type Item.
 * Classes, house items, and Guild items count against neither. A misc item
 * already in the inventory never takes a new misc slot.
 */
export type InventoryPool = "bag" | "misc";

/**
 * The pool an item counts against in the inventory. `"class"` has no limit,
 * and `"house"` uses house slots.
 */
export type ItemPool = InventoryPool | "class" | "house";

const miscCategories = new Set(["Item", "Note", "Quest Item", "Resource"]);

const itemRarityNames: Readonly<Record<number, string>> = {
  0: "Unknown",
  1: "Enhancement +0",
  2: "Enhancement +1",
  3: "Enhancement +2",
  4: "Enhancement +3",
  5: "Enhancement +4",
  6: "Enhancement +5",
  7: "Enhancement +6",
  8: "Enhancement +100",
  9: "Enhancement +200",
  10: "Unknown",
  11: "Common",
  12: "Weird",
  13: "Awesome",
  14: "1% Drop",
  15: "5% Drop",
  16: "Boss Drop",
  17: "Hidden Secret",
  18: "Junk",
  19: "Impossible",
  20: "Artifact",
  21: "Limited Time Drop",
  23: "Crazy",
  24: "Expensive",
  25: "Placeholder",
  30: "Rare",
  35: "Epic",
  36: "Champion",
  40: "Verification Shop",
  50: "Seasonal",
  55: "Seasonal Rare",
  60: "Event",
  65: "Event Rare",
  67: "Infinity",
  68: "New Collection Chest",
  70: "Limited Rare",
  75: "Collector",
  80: "Promo",
  81: "Founder",
  88: "Benevolent",
  90: "Ultra Rare",
  91: "Achievement Tracker",
  92: "Upgrade Pack",
  93: "Limited Quantity",
  94: "Frostval Gifting",
  95: "Super Ultra Rare",
  96: "Kickstarter Backer",
  99: "Custom Item",
  100: "Legendary",
};

export const getItemRarityName = (rarity: number): string =>
  itemRarityNames[rarity] ?? "Unknown";

const classRankPointThresholds = [
  900, 3_600, 10_000, 22_500, 44_100, 78_400, 129_600, 202_500, 302_500,
] as const;

/** Returns the class rank for a cumulative class-point total. */
export const getClassRankFromPoints = (classPoints: number): number => {
  if (!Number.isFinite(classPoints)) return 1;

  const points = Math.max(0, Math.trunc(classPoints));
  let rank = 1;
  for (const threshold of classRankPointThresholds) {
    if (points < threshold) break;
    rank += 1;
  }
  return rank;
};

export interface Enhancement {
  readonly dps?: number;
  readonly id?: number;
  readonly level?: number;
  /** Enhancement label, such as `Fighter` or `Vim`. */
  readonly name?: string | undefined;
  readonly patternId?: number;
  readonly procId?: number;
  readonly range?: number;
  readonly rarity?: number;
  /** Special label, such as `Dauntless` or `Ether`. */
  readonly special?: string | undefined;
}

export interface ItemSelectorById {
  readonly itemId: number;
  readonly name?: never;
}

export interface ItemSelectorByName {
  readonly itemId?: never;
  readonly name: string;
}

export type ItemSelector = ItemSelectorById | ItemSelectorByName;

export interface ShopItemSelectorById {
  readonly itemId?: never;
  readonly name?: never;
  readonly shopItemId: number;
}

export type ShopItemSelector = ItemSelector | ShopItemSelectorById;
export type ItemQuery = ItemSelector | number | string;
export type ShopItemQuery = ShopItemSelector | number | string;

export const toItemSelector = (query: ItemQuery): ItemSelector => {
  if (typeof query === "number") return { itemId: query };
  if (typeof query === "string") return { name: query.trim() };
  return "name" in query ? { name: query.name.trim() } : query;
};

export const normalizeItemQuantity = (value: number | undefined): number =>
  value === undefined || !Number.isFinite(value)
    ? 1
    : Math.max(1, Math.trunc(value));

export interface ItemRequirement {
  readonly itemId: number;
  readonly name: string;
  readonly quantity: number;
}

export interface Item {
  readonly armor: boolean;
  readonly banked: boolean;
  readonly cape: boolean;
  readonly category: string;
  readonly charItemId: number | undefined;
  readonly classItem: boolean;
  /** Rank derived from class points, or `null` for a non-class item. */
  readonly classRank: number | null;
  readonly coins: boolean;
  readonly context: ItemContext;
  readonly cost: number;
  readonly description: string;
  readonly enhancement: Enhancement | undefined;
  readonly equipped: boolean;
  readonly equipmentSlot: string;
  readonly file: string;
  readonly helm: boolean;
  readonly houseItem: boolean;
  readonly itemId: number;
  readonly link: string;
  readonly maxStack: number | undefined;
  readonly memberOnly: boolean;
  readonly meta: string;
  readonly name: string;
  readonly pet: boolean;
  readonly pool: ItemPool;
  readonly quantity: number;
  /** Items consumed per merge for this shop offer. */
  readonly requirements: readonly ItemRequirement[];
  readonly shopItemId: number | undefined;
  readonly temporaryItem: boolean;
  readonly wearable: boolean;
  readonly weapon: boolean;
  readonly worn: boolean;
  matches(selector: ItemQuery | ShopItemQuery): boolean;
  toJSON(): ItemSnapshot;
}

export interface ItemData {
  category: string;
  charItemId?: number;
  coins: boolean;
  context: ItemContext;
  cost: number;
  description: string;
  enhancement?: Enhancement;
  equipped: boolean;
  equipmentSlot: string;
  file: string;
  houseItem: boolean;
  itemId: number;
  link: string;
  maxStack?: number;
  memberOnly: boolean;
  meta: string;
  name: string;
  quantity: number;
  requirements?: readonly ItemRequirement[];
  shopItemId?: number;
  temporaryItem: boolean;
  wearable?: boolean;
  worn?: boolean;
}

export type ItemSnapshot = Readonly<ItemData> & {
  readonly armor: boolean;
  readonly banked: boolean;
  readonly cape: boolean;
  readonly classItem: boolean;
  readonly classRank: number | null;
  readonly helm: boolean;
  readonly pet: boolean;
  readonly pool: ItemPool;
  readonly weapon: boolean;
  readonly wearable: boolean;
  readonly worn: boolean;
};

export class LiveItem extends LiveModel<ItemData> implements Item {
  get armor(): boolean {
    return this.equipmentSlot === "co";
  }
  get banked(): boolean {
    return this.context === "bank";
  }
  get cape(): boolean {
    return this.equipmentSlot === "ba";
  }
  get category(): string {
    return this.modelData.category;
  }
  get charItemId(): number | undefined {
    return this.modelData.charItemId;
  }
  get classItem(): boolean {
    return this.category === "Class";
  }
  get classRank(): number | null {
    return this.classItem ? getClassRankFromPoints(this.quantity) : null;
  }
  get coins(): boolean {
    return this.modelData.coins;
  }
  get context(): ItemContext {
    return this.modelData.context;
  }
  get cost(): number {
    return this.modelData.cost;
  }
  get description(): string {
    return this.modelData.description;
  }
  get enhancement(): Enhancement | undefined {
    const enhancement = this.modelData.enhancement;
    if (enhancement === undefined) return undefined;
    return { ...enhancement, ...getItemEnhancementNames(enhancement) };
  }
  get equipped(): boolean {
    return this.modelData.equipped;
  }
  get equipmentSlot(): string {
    return this.modelData.equipmentSlot;
  }
  get file(): string {
    return this.modelData.file;
  }
  get helm(): boolean {
    return this.equipmentSlot === "he";
  }
  get houseItem(): boolean {
    return this.modelData.houseItem;
  }
  get itemId(): number {
    return this.modelData.itemId;
  }
  get link(): string {
    return this.modelData.link;
  }
  get maxStack(): number | undefined {
    return this.modelData.maxStack;
  }
  get memberOnly(): boolean {
    return this.modelData.memberOnly;
  }
  get meta(): string {
    return this.modelData.meta;
  }
  get name(): string {
    return this.modelData.name;
  }
  get pet(): boolean {
    return this.equipmentSlot === "pe";
  }
  get pool(): ItemPool {
    if (this.classItem) return "class";
    if (this.houseItem || this.category === "Guild") return "house";
    return miscCategories.has(this.category) &&
      !(this.category === "Item" && /^\s*\d+\s*$/.test(this.meta))
      ? "misc"
      : "bag";
  }
  get quantity(): number {
    return this.modelData.quantity;
  }
  get requirements(): readonly ItemRequirement[] {
    return this.modelData.requirements ?? [];
  }
  get shopItemId(): number | undefined {
    return this.modelData.shopItemId;
  }
  get temporaryItem(): boolean {
    return this.modelData.temporaryItem;
  }
  get weapon(): boolean {
    return this.equipmentSlot === "Weapon";
  }
  get wearable(): boolean {
    return this.modelData.wearable ?? false;
  }
  get worn(): boolean {
    return this.modelData.worn ?? false;
  }

  matches(selector: ItemQuery | ShopItemQuery): boolean {
    if (typeof selector === "number") return this.itemId === selector;
    if (typeof selector === "string") {
      return normalizeGameText(this.name) === normalizeGameText(selector);
    }
    if ("itemId" in selector) return this.itemId === selector.itemId;
    if ("name" in selector)
      return normalizeGameText(this.name) === normalizeGameText(selector.name);
    if ("shopItemId" in selector)
      return this.shopItemId === selector.shopItemId;
    return false;
  }

  toJSON(): ItemSnapshot {
    const enhancement = this.enhancement;
    return {
      ...this.modelData,
      armor: this.armor,
      banked: this.banked,
      cape: this.cape,
      classItem: this.classItem,
      classRank: this.classRank,
      ...(enhancement === undefined ? {} : { enhancement }),
      helm: this.helm,
      pet: this.pet,
      pool: this.pool,
      ...(this.modelData.requirements === undefined
        ? {}
        : {
            requirements: this.requirements.map((requirement) => ({
              ...requirement,
            })),
          }),
      wearable: this.wearable,
      weapon: this.weapon,
      worn: this.worn,
    };
  }
}
