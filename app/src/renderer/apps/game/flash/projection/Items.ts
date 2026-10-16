import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { LiveItem } from "@lucent/game";

import {
  NonNegativeWireInt,
  PositiveWireInt,
  WireBoolean,
  WireInt,
  WireNumber,
} from "../contract/Coercion";
import type { Event } from "../contract/Event";
import {
  ignoreDiagnostic,
  type DiagnosticReporter,
} from "../contract/Diagnostic";
import type { ClientPacket, ExtensionPacket } from "../contract/Packet";
import { ItemPayload, toItem } from "../contract/payload/Items";
import type { ItemContainer } from "../state/Items";
import type { ProjectionKey } from "../state/Projection";
import type { Store } from "../state/Store";

const InventoryLoad = Schema.Struct({
  bitSuccess: Schema.optionalKey(WireBoolean),
  hitems: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.Unknown))),
  items: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.Unknown))),
});
const ItemMutation = Schema.Struct({
  ItemID: PositiveWireInt,
  bBank: Schema.optionalKey(WireBoolean),
  bHouse: Schema.optionalKey(WireBoolean),
  bSuccess: Schema.optionalKey(WireBoolean),
  iQty: Schema.optionalKey(WireInt),
  iQtyNow: Schema.optionalKey(WireInt),
});
const BankSwap = Schema.Struct({
  bankItemID: PositiveWireInt,
  invItemID: PositiveWireInt,
});
const ItemsRecord = Schema.Struct({
  items: Schema.Record(Schema.String, Schema.Unknown),
});
const CharacterItemMutation = Schema.Struct({
  CharItemID: PositiveWireInt,
  bBank: Schema.optionalKey(WireBoolean),
  bSuccess: Schema.optionalKey(WireBoolean),
  iQty: Schema.optionalKey(WireInt),
  iQtyNow: Schema.optionalKey(WireInt),
});
const EquipmentMutation = Schema.Struct({
  ItemID: PositiveWireInt,
  sES: Schema.optionalKey(Schema.String),
  success: Schema.optionalKey(WireBoolean),
  strES: Schema.optionalKey(Schema.String),
  uid: Schema.optionalKey(PositiveWireInt),
});
const PurchaseResult = Schema.Struct({
  bitSuccess: WireBoolean,
});
const SuccessfulPurchaseMutation = Schema.Struct({
  CharItemID: PositiveWireInt,
  ItemID: PositiveWireInt,
  bBank: WireBoolean,
  iQty: PositiveWireInt,
});
const QuestTurnIn = Schema.Struct({
  sItems: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
const EnhancementMutation = Schema.Struct({
  EnhDPS: Schema.optionalKey(WireNumber),
  EnhID: Schema.optionalKey(NonNegativeWireInt),
  EnhLvl: Schema.optionalKey(NonNegativeWireInt),
  EnhPID: Schema.optionalKey(NonNegativeWireInt),
  EnhRng: Schema.optionalKey(WireNumber),
  EnhRty: Schema.optionalKey(WireNumber),
  ItemIDs: Schema.Array(PositiveWireInt),
  ProcID: Schema.optionalKey(NonNegativeWireInt),
});
const WheelRewards = Schema.Struct({
  CharItemID: Schema.optionalKey(PositiveWireInt),
  Item: Schema.optionalKey(Schema.Unknown),
  charItem1: Schema.optionalKey(PositiveWireInt),
  charItem2: Schema.optionalKey(PositiveWireInt),
  dropItems: Schema.Record(Schema.String, Schema.Unknown),
  dropQty: Schema.optionalKey(NonNegativeWireInt),
});

const decodeInventoryLoad = Schema.decodeUnknownOption(InventoryLoad);
const decodeItemMutation = Schema.decodeUnknownOption(ItemMutation);
const decodeBankSwap = Schema.decodeUnknownOption(BankSwap);
const decodeItemsRecord = Schema.decodeUnknownOption(ItemsRecord);
const decodeCharacterItemMutation = Schema.decodeUnknownOption(
  CharacterItemMutation,
);
const decodeEquipmentMutation = Schema.decodeUnknownOption(EquipmentMutation);
const decodePurchaseResult = Schema.decodeUnknownOption(PurchaseResult);
const decodeSuccessfulPurchaseMutation = Schema.decodeUnknownOption(
  SuccessfulPurchaseMutation,
);
const decodeQuestTurnIn = Schema.decodeUnknownOption(QuestTurnIn);
const decodeEnhancementMutation =
  Schema.decodeUnknownOption(EnhancementMutation);
const decodeWheelRewards = Schema.decodeUnknownOption(WheelRewards);
const decodeItem = Schema.decodeUnknownOption(ItemPayload);
const decodePositiveInt = Schema.decodeUnknownOption(PositiveWireInt);

const WHEEL_TREASURE_POTION_ID = 18_927; // Treasure Potion
const WHEEL_SECONDARY_REWARD_ID = 19_189; // Daily XP Boost! (1 hr)
const ownedItemContainers: readonly ItemContainer[] = [
  "temporary",
  "inventory",
  "house",
  "bank",
];

interface TurnInItem {
  readonly itemId: number;
  readonly quantity: number;
}

const parseTurnInItems = (
  value: string,
): {
  readonly invalid: readonly string[];
  readonly items: readonly TurnInItem[];
} => {
  const invalid: string[] = [];
  const items: TurnInItem[] = [];

  for (const entry of value.split(",")) {
    if (entry.trim() === "") continue;
    const parts = entry.split(":");
    const itemId = Number(parts[0]);
    const quantity = Number(parts[1]);
    if (
      parts.length !== 2 ||
      !Number.isSafeInteger(itemId) ||
      itemId <= 0 ||
      !Number.isSafeInteger(quantity) ||
      quantity <= 0
    ) {
      invalid.push(entry);
      continue;
    }
    items.push({ itemId, quantity });
  }

  return { invalid, items };
};

const decodeContainerItems = (
  values: readonly unknown[],
  context: ItemContainer,
  operation: string,
  diagnose: DiagnosticReporter,
) =>
  Effect.gen(function* () {
    const items: LiveItem[] = [];
    const invalid: unknown[] = [];

    for (const value of values) {
      const decoded = decodeItem(value);
      if (Option.isNone(decoded)) {
        invalid.push(value);
      } else {
        items.push(toItem(decoded.value, { context }));
      }
    }

    if (invalid.length > 0) {
      yield* diagnose(
        operation,
        new Error(`Ignored ${invalid.length} malformed item entries`),
        invalid,
      );
    }

    return { invalid, items };
  });

const projectContainerBaseline = Effect.fn("projectContainerBaseline")(
  function* (
    store: Store,
    values: readonly unknown[] | null,
    context: "house" | "inventory",
    key: ProjectionKey,
    operation: string,
    diagnose: DiagnosticReporter,
  ) {
    const decoded = yield* decodeContainerItems(
      values ?? [],
      context,
      operation,
      diagnose,
    );
    yield* store.items.replace(context, decoded.items);
    if (decoded.invalid.length > 0) {
      yield* store.projection.fail(
        key,
        `${operation} contained ${decoded.invalid.length} malformed item entries`,
      );
      return;
    }

    yield* store.projection.complete(key);
  },
);

const failContainerBaselines = (
  store: Store,
  packet: ExtensionPacket,
  reason: string,
) => {
  const keys: readonly ProjectionKey[] =
    packet.command === "loadInventoryBig"
      ? ["inventory", "houseInventory"]
      : packet.command === "initInventory"
        ? ["inventory"]
        : ["houseInventory"];
  return Effect.forEach(keys, (key) => store.projection.fail(key, reason), {
    discard: true,
  });
};

const equipHouse = Effect.fn("equipHouse")(function* (
  store: Store,
  itemId: number,
) {
  const selected = yield* store.items.get("house", itemId);
  if (selected?.category !== "House") return false;

  const items = yield* store.items.getAll("house");
  for (const item of items) {
    if (item.category === "House") {
      item.update({ equipped: item.itemId === selected.itemId });
    }
  }
  return true;
});

export const projectHouseEquipRequest = Effect.fn("projectHouseEquipRequest")(
  function* (
    store: Store,
    packet: ClientPacket,
    diagnose: DiagnosticReporter = ignoreDiagnostic,
  ) {
    if (packet.command !== "equipItem") return [];

    const itemId = decodePositiveInt(packet.params[4]);
    if (Option.isNone(itemId)) {
      yield* diagnose(
        "items:equipItem",
        new Error("Malformed client equipment payload"),
        [packet.params],
      );
      return [];
    }

    yield* equipHouse(store, itemId.value);
    return [];
  },
);

const projectPurchase = Effect.fn("projectPurchase")(function* (
  store: Store,
  value: unknown,
  diagnose: DiagnosticReporter,
) {
  const result = decodePurchaseResult(value);
  if (Option.isNone(result)) {
    yield* diagnose("items:buyItem", new Error("Malformed purchase payload"), [
      value,
    ]);
    return;
  }
  if (result.value.bitSuccess === false) return;

  const decoded = decodeSuccessfulPurchaseMutation(value);
  if (Option.isNone(decoded)) {
    yield* diagnose(
      "items:buyItem",
      new Error("Malformed successful purchase payload"),
      [value],
    );
    return;
  }
  const purchase = decoded.value;

  const shopItem = yield* store.items.get("shop", {
    itemId: purchase.ItemID,
  });
  if (shopItem === null) return;

  const container: ItemContainer =
    purchase.bBank && shopItem.category !== "Class"
      ? "bank"
      : shopItem.houseItem
        ? "house"
        : "inventory";
  const current = yield* store.items.get(container, purchase.ItemID);
  const autoEquip =
    container === "house" &&
    shopItem.category === "House" &&
    !(yield* store.items.getAll("house")).some(
      (item) => item.category === "House" && item.equipped,
    );
  const item = new LiveItem({
    ...shopItem.snapshot(),
    charItemId: purchase.CharItemID,
    context: container,
    equipped: current?.equipped ?? autoEquip,
    quantity: (current?.quantity ?? 0) + purchase.iQty,
    worn: current?.worn ?? false,
  });
  yield* store.items.upsert(container, item);
});

const deposit = (store: Store, itemId: number) =>
  Effect.gen(function* () {
    const inventory = yield* store.items.remove("inventory", itemId);
    const item = inventory ?? (yield* store.items.remove("house", itemId));
    if (item === null) return;
    item.update({ context: "bank" });
    yield* store.items.upsert("bank", item);
  });

const withdraw = (store: Store, itemId: number) =>
  Effect.gen(function* () {
    const item = yield* store.items.remove("bank", itemId);
    if (item === null) return;
    const target = item.houseItem ? "house" : "inventory";
    item.update({ context: target });
    yield* store.items.upsert(target, item);
  });

const swap = (store: Store, inventoryItemId: number, bankItemId: number) =>
  Effect.gen(function* () {
    const inventoryItem = yield* store.items.get("inventory", inventoryItemId);
    const houseItem = yield* store.items.get("house", inventoryItemId);
    const bankItem = yield* store.items.get("bank", bankItemId);
    const itemToBank = inventoryItem ?? houseItem;
    if (itemToBank === null || bankItem === null) return;

    const source = inventoryItem === null ? "house" : "inventory";
    yield* store.items.remove(source, inventoryItemId);
    yield* store.items.remove("bank", bankItemId);

    itemToBank.update({ context: "bank" });
    yield* store.items.upsert("bank", itemToBank);

    const target = bankItem.houseItem ? "house" : "inventory";
    bankItem.update({ context: target });
    yield* store.items.upsert(target, bankItem);
  });

const consumeTurnInItem = (store: Store, item: TurnInItem) =>
  Effect.gen(function* () {
    const temporary = yield* store.items.get("temporary", item.itemId);
    const inventory =
      temporary === null
        ? yield* store.items.get("inventory", item.itemId)
        : null;
    const current = temporary ?? inventory;
    if (current === null) return;

    const container = temporary === null ? "inventory" : "temporary";
    const quantity = current.quantity - item.quantity;
    if (quantity <= 0) {
      yield* store.items.remove(container, current.itemId);
    } else {
      current.update({ quantity });
    }
  });

const wheelRewardPayload = (
  value: unknown,
  overrides: Readonly<Record<string, unknown>>,
): unknown =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? { ...value, ...overrides }
    : value;

const itemRecordPayload = (key: string, value: unknown): unknown => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return value;
  }

  const record = value as Record<string, unknown>;
  const itemId = Number(key);
  if (
    record["ItemID"] !== undefined ||
    !Number.isSafeInteger(itemId) ||
    itemId <= 0
  ) {
    return value;
  }

  return { ...record, ItemID: itemId };
};

const findOwnedItem = Effect.fn("findOwnedItem")(function* (
  store: Store,
  itemId: number,
) {
  for (const container of ownedItemContainers) {
    const item = yield* store.items.get(container, itemId);
    if (item !== null) return item;
  }
  return null;
});

const upsertWheelReward = (
  store: Store,
  value: unknown,
  overrides: Readonly<Record<string, unknown>>,
) =>
  Effect.gen(function* () {
    const decoded = decodeItem(wheelRewardPayload(value, overrides));
    if (Option.isNone(decoded)) return false;

    const reward = toItem(decoded.value, { context: "inventory" });
    const container: ItemContainer = reward.banked
      ? "bank"
      : reward.houseItem
        ? "house"
        : reward.temporaryItem
          ? "temporary"
          : "inventory";
    const current = yield* store.items.get(container, reward.itemId);
    const quantity = (current?.quantity ?? 0) + reward.quantity;
    yield* store.items.upsert(
      container,
      new LiveItem({ ...reward.snapshot(), context: container, quantity }),
    );
    return true;
  });

export const projectExtensionItems = (
  store: Store,
  packet: ExtensionPacket,
  diagnose: DiagnosticReporter = ignoreDiagnostic,
): Effect.Effect<readonly Event[]> =>
  Effect.gen(function* () {
    const data = packet.data;
    switch (packet.command) {
      case "loadInventoryBig":
      case "initInventory":
      case "loadHouseInventory": {
        const decoded = decodeInventoryLoad(data);
        if (Option.isNone(decoded)) {
          const reason = `${packet.command} has a malformed container payload`;
          yield* diagnose(
            `items:${packet.command}`,
            new Error("Malformed container payload"),
            [data],
          );
          yield* failContainerBaselines(store, packet, reason);
          return [];
        }
        if (decoded.value.bitSuccess === false) {
          yield* failContainerBaselines(
            store,
            packet,
            `${packet.command} reported an unsuccessful baseline load`,
          );
          return [];
        }

        if (packet.command === "loadInventoryBig") {
          if (decoded.value.items === undefined) {
            yield* store.projection.fail(
              "inventory",
              "loadInventoryBig omitted items",
            );
          } else {
            yield* projectContainerBaseline(
              store,
              decoded.value.items,
              "inventory",
              "inventory",
              "items:loadInventoryBig:entries",
              diagnose,
            );
          }

          if (decoded.value.hitems === undefined) {
            yield* store.projection.fail(
              "houseInventory",
              "loadInventoryBig omitted hitems",
            );
          } else {
            yield* projectContainerBaseline(
              store,
              decoded.value.hitems,
              "house",
              "houseInventory",
              "items:loadInventoryBig:house-entries",
              diagnose,
            );
          }
          return [];
        }

        if (decoded.value.items === undefined) {
          const key =
            packet.command === "initInventory" ? "inventory" : "houseInventory";
          yield* store.projection.fail(key, `${packet.command} omitted items`);
          return [];
        }

        if (packet.command === "initInventory") {
          yield* projectContainerBaseline(
            store,
            decoded.value.items,
            "inventory",
            "inventory",
            "items:initInventory:entries",
            diagnose,
          );
        } else {
          yield* projectContainerBaseline(
            store,
            decoded.value.items,
            "house",
            "houseInventory",
            "items:loadHouseInventory:entries",
            diagnose,
          );
        }
        return [];
      }
      case "bankFromInv":
      case "bankToInv": {
        const decoded = decodeItemMutation(data);
        if (Option.isNone(decoded)) {
          yield* diagnose(
            `items:${packet.command}`,
            new Error("Malformed transfer payload"),
            [data],
          );
          return [];
        }
        if (decoded.value.bSuccess === false) return [];
        yield* packet.command === "bankFromInv"
          ? deposit(store, decoded.value.ItemID)
          : withdraw(store, decoded.value.ItemID);
        return [];
      }
      case "bankSwapInv": {
        const decoded = decodeBankSwap(data);
        if (Option.isNone(decoded)) {
          yield* diagnose(
            "items:bankSwapInv",
            new Error("Malformed bank swap payload"),
            [data],
          );
          return [];
        }
        yield* swap(store, decoded.value.invItemID, decoded.value.bankItemID);
        return [];
      }
      case "dropItem": {
        const decoded = decodeItemsRecord(data);
        if (Option.isNone(decoded)) {
          yield* diagnose(
            "items:dropItem",
            new Error("Malformed drop payload"),
            [data],
          );
          return [];
        }

        const values = Object.values(decoded.value.items);
        const decodedDrops = yield* decodeContainerItems(
          values,
          "drop",
          "items:dropItem:entries",
          diagnose,
        );
        const events: Event[] = [];
        for (const drop of decodedDrops.items) {
          yield* store.items.upsert("drop", drop);
          events.push({
            item: drop.toJSON(),
            type: "item-drop",
          });
        }
        return events;
      }
      case "buyItem": {
        yield* projectPurchase(store, data, diagnose);
        return [];
      }
      case "equipItem":
      case "wearItem":
      case "unequipItem":
      case "unwearItem": {
        const decoded = decodeEquipmentMutation(data);
        if (Option.isNone(decoded)) {
          yield* diagnose(
            `items:${packet.command}`,
            new Error("Malformed equipment payload"),
            [data],
          );
          return [];
        }
        const self = yield* store.world.getMe;
        if (
          decoded.value.success === false ||
          (decoded.value.uid !== undefined &&
            self?.entityId !== decoded.value.uid)
        ) {
          return [];
        }

        const isWearMutation =
          packet.command === "wearItem" || packet.command === "unwearItem";
        const activating =
          packet.command === "equipItem" || packet.command === "wearItem";
        const equipmentSlot = decoded.value.sES ?? decoded.value.strES;
        const containers = isWearMutation
          ? (["inventory"] as const)
          : (["inventory", "temporary", "house"] as const);
        for (const container of containers) {
          const item = yield* store.items.get(container, decoded.value.ItemID);
          if (item === null) continue;

          if (activating && equipmentSlot !== undefined) {
            const items = yield* store.items.getAll(container);
            for (const current of items) {
              if (current.equipmentSlot === equipmentSlot) {
                if (isWearMutation) current.update({ worn: false });
                else current.update({ equipped: false });
              }
            }
          }
          if (isWearMutation) item.update({ worn: activating });
          else item.update({ equipped: activating });
          break;
        }
        return [];
      }
      case "enhanceItemShop": {
        const decoded = decodeEnhancementMutation(data);
        if (Option.isNone(decoded)) {
          yield* diagnose(
            "items:enhanceItemShop",
            new Error("Malformed enhancement response"),
            [data],
          );
          return [];
        }
        for (const itemId of decoded.value.ItemIDs) {
          const item = yield* store.items.get("inventory", itemId);
          if (item === null) continue;
          item.update({
            enhancement: {
              ...(decoded.value.EnhDPS === undefined
                ? {}
                : { dps: decoded.value.EnhDPS }),
              ...(decoded.value.EnhID === undefined
                ? {}
                : { id: decoded.value.EnhID }),
              ...(decoded.value.EnhLvl === undefined
                ? {}
                : { level: decoded.value.EnhLvl }),
              ...(decoded.value.EnhPID === undefined
                ? {}
                : { patternId: decoded.value.EnhPID }),
              ...(decoded.value.ProcID === undefined
                ? {}
                : { procId: decoded.value.ProcID }),
              ...(decoded.value.EnhRng === undefined
                ? {}
                : { range: decoded.value.EnhRng }),
              ...(decoded.value.EnhRty === undefined
                ? {}
                : { rarity: decoded.value.EnhRty }),
            },
          });
        }
        return [];
      }
      case "Wheel": {
        const decoded = decodeWheelRewards(data);
        if (Option.isNone(decoded)) {
          yield* diagnose(
            "items:Wheel",
            new Error("Malformed Wheel reward response"),
            [data],
          );
          return [];
        }

        const rewards = decoded.value;
        const treasurePotion =
          rewards.dropItems[String(WHEEL_TREASURE_POTION_ID)];
        const secondaryReward =
          rewards.dropItems[String(WHEEL_SECONDARY_REWARD_ID)];
        if (treasurePotion !== undefined) {
          yield* upsertWheelReward(store, treasurePotion, {
            ...(rewards.charItem1 === undefined
              ? {}
              : { CharItemID: rewards.charItem1 }),
            iQty: rewards.dropQty ?? 1,
          });
        }
        if (secondaryReward !== undefined) {
          yield* upsertWheelReward(store, secondaryReward, {
            ...(rewards.charItem2 === undefined
              ? {}
              : { CharItemID: rewards.charItem2 }),
            iQty: 1,
          });
        }
        if (rewards.Item !== undefined) {
          yield* upsertWheelReward(store, rewards.Item, {
            bBank: false,
            ...(rewards.CharItemID === undefined
              ? {}
              : { CharItemID: rewards.CharItemID }),
            iQty: 1,
          });
        }
        return [];
      }
      case "getDrop": {
        const decoded = decodeItemMutation(data);
        if (Option.isNone(decoded)) {
          yield* diagnose(
            "items:getDrop",
            new Error("Malformed drop response"),
            [data],
          );
          return [];
        }
        if (decoded.value.bSuccess !== true) return [];
        const drop = yield* store.items.remove("drop", decoded.value.ItemID);
        if (drop === null) return [];
        const context =
          decoded.value.bBank && drop.category !== "Class"
            ? "bank"
            : decoded.value.bHouse || drop.houseItem
              ? "house"
              : "inventory";
        const current = yield* store.items.get(context, {
          itemId: decoded.value.ItemID,
        });
        const quantity =
          decoded.value.iQtyNow ??
          (current?.quantity ?? 0) + (decoded.value.iQty ?? drop.quantity);
        const accepted = new LiveItem({
          ...drop.snapshot(),
          context,
          quantity,
        });
        yield* store.items.upsert(context, accepted);
        return [];
      }
      case "addItems":
      case "forceAddItem": {
        const decoded = decodeItemsRecord(data);
        if (Option.isNone(decoded)) return [];
        for (const [key, value] of Object.entries(decoded.value.items)) {
          const payload = decodeItem(itemRecordPayload(key, value));
          if (Option.isNone(payload)) continue;
          // Sparse addItems increments after the first full item payload.
          // Reuse existing metadata so omitted bTemp/bHouse fields preserve the container.
          const existing = yield* findOwnedItem(store, payload.value.ItemID);
          const item = toItem(payload.value, existing?.snapshot());
          const container: ItemContainer = item.banked
            ? "bank"
            : item.houseItem
              ? "house"
              : item.temporaryItem
                ? "temporary"
                : "inventory";
          const current =
            existing?.context === container
              ? existing
              : yield* store.items.get(container, item.itemId);
          if (current === null) {
            yield* store.items.upsert(container, item);
          } else {
            current.update({
              quantity:
                payload.value.iQtyNow ?? current.quantity + item.quantity,
            });
          }
        }
        return [];
      }
      case "turnIn": {
        const decoded = decodeQuestTurnIn(data);
        if (Option.isNone(decoded)) {
          yield* diagnose(
            "items:turnIn",
            new Error("Malformed quest turn-in payload"),
            [data],
          );
          return [];
        }
        if (decoded.value.sItems == null) return [];

        const { invalid, items } = parseTurnInItems(decoded.value.sItems);
        if (invalid.length > 0) {
          yield* diagnose(
            "items:turnIn:entries",
            new Error(`Ignored ${invalid.length} malformed turn-in entries`),
            invalid,
          );
        }
        for (const item of items) yield* consumeTurnInItem(store, item);
        return [];
      }
      case "removeItem":
      case "sellItem": {
        const decoded = decodeCharacterItemMutation(data);
        if (Option.isNone(decoded) || decoded.value.bSuccess === false)
          return [];
        const inventoryItem = decoded.value.bBank
          ? yield* store.items.getByCharItemId(
              "inventory",
              decoded.value.CharItemID,
            )
          : null;
        const containers =
          decoded.value.bBank && inventoryItem?.category !== "Class"
            ? (["bank"] as const)
            : (["inventory", "house"] as const);
        let container: (typeof containers)[number] | undefined;
        let current: LiveItem | null = null;
        for (const candidate of containers) {
          current = yield* store.items.getByCharItemId(
            candidate,
            decoded.value.CharItemID,
          );
          if (current !== null) {
            container = candidate;
            break;
          }
        }
        if (container === undefined || current === null) return [];
        const quantity =
          decoded.value.iQtyNow ?? current.quantity - (decoded.value.iQty ?? 1);
        if (current.category === "Class" || quantity <= 0) {
          yield* store.items.remove(container, current.itemId);
        } else {
          current.update({ quantity });
        }
        return [];
      }
      case "removeTempItem": {
        const decoded = decodeItemMutation(data);
        if (Option.isNone(decoded)) return [];
        const current = yield* store.items.get("temporary", {
          itemId: decoded.value.ItemID,
        });
        if (current === null) return [];
        const quantity =
          decoded.value.iQtyNow ?? current.quantity - (decoded.value.iQty ?? 1);
        if (quantity <= 0)
          yield* store.items.remove("temporary", current.itemId);
        else current.update({ quantity });
        return [];
      }
      default:
        return [];
    }
  });
