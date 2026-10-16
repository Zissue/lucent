import type { ItemQuery } from "@lucent/game";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import type { BridgeService } from "../bridge/Bridge";
import { PositiveWireInt, WireBoolean, WireInt } from "../contract/Coercion";
import { packetData } from "../contract/Packet";
import type { Store } from "../state/Store";
import type { Auth } from "./Auth";
import type { Wait } from "./Wait";

const AcceptResponse = Schema.Struct({
  ItemID: PositiveWireInt,
  bBank: Schema.optionalKey(WireBoolean),
  bHouse: Schema.optionalKey(WireBoolean),
  bSuccess: WireBoolean,
  iQty: Schema.optionalKey(WireInt),
  iQtyNow: Schema.optionalKey(WireInt),
});
const decodeAcceptResponse = Schema.decodeUnknownOption(AcceptResponse);

export const makeDrops = Effect.fnUntraced(function* (
  bridge: BridgeService,
  store: Store,
  auth: Auth,
  wait: Wait,
) {
  const accepts = yield* Semaphore.make(1);

  const accept = (selector: ItemQuery) => {
    return accepts.withPermits(1)(
      Effect.gen(function* () {
        if (!(yield* auth.isLoggedIn())) return false;
        const drop = yield* store.items.get("drop", selector);
        if (drop === null) return false;

        const before = yield* Effect.all({
          bank: store.items.quantity("bank", drop.itemId),
          house: store.items.quantity("house", drop.itemId),
          inventory: store.items.quantity("inventory", drop.itemId),
        });
        let response: typeof AcceptResponse.Type | undefined;
        const packet = yield* wait.forPacket(
          {
            command: "getDrop",
            direction: "extension",
            predicate: (candidate) => {
              const decoded = decodeAcceptResponse(packetData(candidate));
              if (
                Option.isNone(decoded) ||
                decoded.value.ItemID !== drop.itemId
              ) {
                return false;
              }
              response = decoded.value;
              return true;
            },
            encoding: "json",
          },
          {
            timeout: "10 seconds",
            trigger: bridge
              .invoke("drops.accept", [drop.itemId], Schema.Boolean)
              .pipe(Effect.map(Option.getOrElse(() => false))),
          },
        );
        if (packet === null || response?.bSuccess !== true) return false;

        const container =
          response.bBank && drop.category !== "Class"
            ? "bank"
            : response.bHouse || drop.houseItem
              ? "house"
              : "inventory";
        const expected =
          response.iQtyNow ??
          before[container] + (response.iQty ?? drop.quantity);
        const owned = yield* store.items.get(container, drop.itemId);
        return owned !== null && owned.quantity >= expected;
      }),
    );
  };

  const contains = (selector: ItemQuery) => {
    return store.items
      .get("drop", selector)
      .pipe(Effect.map((drop) => drop !== null));
  };

  const get = (selector: ItemQuery) => store.items.get("drop", selector);

  const getAll = () => store.items.getAll("drop");

  const isCustomUiEnabled = () =>
    bridge
      .invoke("drops.isUsingCustomDrops", undefined, Schema.Boolean)
      .pipe(Effect.map(Option.getOrElse(() => false)));

  const reject = (selector: ItemQuery) => {
    return Effect.gen(function* () {
      if (!(yield* auth.isLoggedIn())) return false;
      const drop = yield* store.items.get("drop", selector);
      if (drop === null) return false;
      const rejected = yield* bridge.invoke(
        "drops.reject",
        [drop.itemId],
        Schema.Boolean,
      );
      if (Option.isNone(rejected) || !rejected.value) {
        return false;
      }
      yield* store.items.remove("drop", drop.itemId);
      return true;
    });
  };

  const toggleUi = () =>
    bridge.invoke("drops.toggleUi", undefined, Schema.Void).pipe(Effect.asVoid);

  return {
    accept,
    contains,
    get,
    getAll,
    isCustomUiEnabled,
    reject,
    toggleUi,
  };
});

export type Drops = Effect.Success<ReturnType<typeof makeDrops>>;
