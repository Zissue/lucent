import { normalizeItemQuantity, toItemSelector } from "@lucent/game";
import type { ItemQuery, LiveItem, ShopItemQuery } from "@lucent/game";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { BridgeService } from "../bridge/Bridge";
import { PositiveWireInt, WireBoolean, WireInt } from "../contract/Coercion";
import { packetData } from "../contract/Packet";
import { ItemPayloads, toBankItems, toItem } from "../contract/payload/Items";
import type { Store } from "../state/Store";
import type { Inventory } from "./Inventory";
import type { Wait } from "./Wait";

const BuyResponse = Schema.Struct({
  bBank: Schema.optionalKey(WireBoolean),
  bitSuccess: WireBoolean,
  iQty: Schema.optionalKey(WireInt),
});
const ShopIdentity = Schema.Struct({ ShopID: PositiveWireInt });
const ShopLoadResponse = Schema.Union([
  ShopIdentity,
  Schema.Struct({ shopinfo: ShopIdentity }),
]);

const decodeBuyResponse = Schema.decodeUnknownOption(BuyResponse);
const decodeShopLoadResponse = Schema.decodeUnknownOption(ShopLoadResponse);

const isShopId = (shopId: number): boolean =>
  Number.isSafeInteger(shopId) && shopId > 0;

const selectorFor = (item: LiveItem) =>
  item.shopItemId === undefined
    ? { itemId: item.itemId }
    : { shopItemId: item.shopItemId };

export const makeShops = (
  bridge: BridgeService,
  store: Store,
  inventory: Inventory,
  wait: Wait,
) => {
  const refreshPurchasedContainer = (
    container: "bank" | "house" | "inventory",
  ) => {
    const method =
      container === "bank"
        ? "bank.getItems"
        : container === "house"
          ? "house.getItems"
          : "inventory.getItems";
    return bridge.invoke(method, undefined, ItemPayloads).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.void,
          onSome: (payloads) => {
            const items =
              container === "bank"
                ? toBankItems(payloads)
                : payloads.map((payload) =>
                    toItem(payload, { context: container }),
                  );
            return store.items.replace(container, items);
          },
        }),
      ),
    );
  };

  const get = (selector: ShopItemQuery) => {
    return store.items.get("shop", selector);
  };

  const isOpen = (shopId?: number) => {
    if (shopId !== undefined && !isShopId(shopId)) {
      return Effect.succeed(false);
    }
    return bridge
      .invoke(
        "shops.isOpen",
        shopId === undefined ? undefined : [shopId],
        Schema.Boolean,
      )
      .pipe(
        Effect.flatMap(
          Option.match({
            onNone: () =>
              store.shops.get.pipe(
                Effect.map((shop) =>
                  shopId !== undefined ? shop?.id === shopId : shop !== null,
                ),
              ),
            onSome: (open) => Effect.succeed(open),
          }),
        ),
      );
  };

  function close(shopId?: number) {
    if (shopId !== undefined && !isShopId(shopId)) {
      return Effect.succeed(false);
    }
    return Effect.gen(function* () {
      if (!(yield* isOpen(shopId))) return false;
      const closed = yield* bridge
        .invoke(
          "shops.close",
          shopId === undefined ? undefined : [shopId],
          Schema.Boolean,
        )
        .pipe(Effect.map(Option.getOrElse(() => false)));
      if (!closed) return false;
      const settled = yield* wait.until(
        isOpen(shopId).pipe(Effect.map((open) => !open)),
        { timeout: "3 seconds" },
      );
      if (settled) {
        yield* store.shops.set(null);
        yield* store.items.replace("shop", []);
      }
      return settled;
    });
  }

  const load = (shopId: number) => {
    if (!isShopId(shopId)) return Effect.succeed(false);
    return Effect.gen(function* () {
      if (yield* isOpen(shopId)) return true;
      const current = yield* store.shops.get;
      // The client reopens cached non-limited shops without emitting a loadShop packet.
      const reopensCachedShop =
        current?.id === shopId && current.limited === false;
      if (
        current !== null &&
        current.id !== shopId &&
        (yield* isOpen(current.id))
      ) {
        yield* close(current.id);
      }
      if (!(yield* wait.forGameAction("loadShop", { timeout: "5 seconds" }))) {
        return false;
      }

      if (reopensCachedShop) {
        if (
          Option.isNone(
            yield* bridge.invoke("shops.load", [shopId], Schema.Void),
          )
        ) {
          return false;
        }
        return yield* wait.until(isOpen(shopId), { timeout: "5 seconds" });
      }

      const packet = yield* wait.forPacket(
        {
          command: "loadShop",
          direction: "extension",
          predicate: (candidate) => {
            const decoded = decodeShopLoadResponse(packetData(candidate));
            if (Option.isNone(decoded)) return false;
            const identity =
              "shopinfo" in decoded.value
                ? decoded.value.shopinfo
                : decoded.value;
            return identity.ShopID === shopId;
          },
          encoding: "json",
        },
        {
          timeout: "5 seconds",
          trigger: bridge
            .invoke("shops.load", [shopId], Schema.Void)
            .pipe(Effect.map(Option.isSome)),
        },
      );
      if (packet === null) return false;

      const [shop, open] = yield* Effect.all([store.shops.get, isOpen(shopId)]);
      return shop?.id === shopId && open;
    });
  };

  const canBuy = (selector: ShopItemQuery, options?: { quantity?: number }) =>
    get(selector).pipe(
      Effect.flatMap((item) =>
        item === null
          ? Effect.succeed(false)
          : bridge
              .invoke(
                "shops.canBuyItem",
                [selectorFor(item), normalizeItemQuantity(options?.quantity)],
                Schema.Boolean,
              )
              .pipe(Effect.map(Option.getOrElse(() => false))),
      ),
    );

  const buy = (selector: ShopItemQuery, options?: { quantity?: number }) =>
    get(selector).pipe(
      Effect.flatMap((item) => {
        if (item === null) return Effect.succeed(false);
        const requested = normalizeItemQuantity(options?.quantity);
        return Effect.gen(function* () {
          if (!(yield* wait.forGameAction("buyItem"))) return false;
          if (!(yield* canBuy(selectorFor(item), { quantity: requested }))) {
            return false;
          }
          const startingQuantities = yield* Effect.all({
            bank: store.items.quantity("bank", item.itemId),
            house: store.items.quantity("house", item.itemId),
            inventory: store.items.quantity("inventory", item.itemId),
          });
          let response: typeof BuyResponse.Type | undefined;
          const packet = yield* wait.forPacket(
            {
              command: "buyItem",
              direction: "extension",
              predicate: (candidate) => {
                const decoded = decodeBuyResponse(packetData(candidate));
                if (Option.isNone(decoded)) return false;
                response = decoded.value;
                return true;
              },
              encoding: "json",
            },
            {
              timeout: "5 seconds",
              trigger: bridge
                .invoke(
                  "shops.buy",
                  [selectorFor(item), requested],
                  Schema.Void,
                )
                .pipe(Effect.map(Option.isSome)),
            },
          );
          if (packet === null || response?.bitSuccess !== true) return false;

          const container =
            response.bBank && item.category !== "Class"
              ? "bank"
              : item.houseItem
                ? "house"
                : "inventory";
          yield* refreshPurchasedContainer(container);
          const owned = yield* store.items.quantity(container, item.itemId);
          return owned >= startingQuantities[container] + requested;
        });
      }),
    );

  const sell = (selector: ItemQuery, options?: { quantity?: number }) => {
    return inventory.get(selector).pipe(
      Effect.flatMap((item) => {
        if (item === null) return Effect.succeed(false);
        const requested = normalizeItemQuantity(options?.quantity);
        if (item.quantity < requested) return Effect.succeed(false);
        return Effect.gen(function* () {
          if (!(yield* wait.forGameAction("sellItem"))) return false;
          const sold = yield* bridge
            .invoke(
              "shops.sell",
              [toItemSelector(selector), requested],
              Schema.Boolean,
            )
            .pipe(Effect.map(Option.getOrElse(() => false)));
          if (!sold) return false;
          return yield* wait.until(
            inventory
              .get(item.itemId)
              .pipe(
                Effect.map(
                  (current) =>
                    current === null ||
                    current.quantity <= item.quantity - requested,
                ),
              ),
            { timeout: "5 seconds" },
          );
        });
      }),
    );
  };

  const getAll = () => store.items.getAll("shop");
  const getCurrent = () => store.shops.get;

  const getMaxBuyQuantity = (selector: ShopItemQuery) =>
    get(selector).pipe(
      Effect.flatMap((item) =>
        item === null
          ? Effect.succeed(0)
          : bridge
              .invoke("shops.getMaxBuyQuantity", [selectorFor(item)], WireInt)
              .pipe(Effect.map(Option.getOrElse(() => 0))),
      ),
    );

  const isMergeShop = () =>
    bridge.invoke("shops.isMergeShop", undefined, Schema.Boolean).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () =>
            store.shops.get.pipe(Effect.map((shop) => shop?.merge ?? false)),
          onSome: (merge) => Effect.succeed(merge),
        }),
      ),
    );

  const openArmorCustomize = () =>
    bridge
      .invoke("shops.loadArmorCustomize", undefined, Schema.Void)
      .pipe(Effect.asVoid);

  const openHairShop = (shopId: number) => {
    if (!isShopId(shopId)) return Effect.void;
    return wait.forGameAction("loadHairShop", { timeout: "5 seconds" }).pipe(
      Effect.flatMap((ready) =>
        ready
          ? bridge.invoke("shops.loadHairShop", [shopId], Schema.Void)
          : Effect.succeed(Option.none()),
      ),
      Effect.asVoid,
    );
  };

  return {
    buy,
    canBuy,
    close,
    get,
    getAll,
    getCurrent,
    getMaxBuyQuantity,
    isMergeShop,
    isOpen,
    load,
    openArmorCustomize,
    openHairShop,
    sell,
  };
};

export type Shops = ReturnType<typeof makeShops>;
