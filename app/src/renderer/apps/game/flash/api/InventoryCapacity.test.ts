import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { Bridge, makeBridge } from "../bridge/Bridge";
import { Gateway, makeGateway } from "../bridge/Gateway";
import { makeApi } from "./Api";

const equipment = { ItemID: 1, sName: "Sword", sType: "Sword" };
const misc = { ItemID: 2, sName: "Resource", sType: "Resource" };
const classItem = { ItemID: 3, sName: "Class", sType: "Class" };
const potion = {
  ItemID: 4,
  sName: "Potion",
  sType: "Item",
  sMeta: " 400 ",
};
const bankEquipment = { ItemID: 10, sName: "Bank Sword", sType: "Sword" };
const bankMisc = { ItemID: 11, sName: "Bank Resource", sType: "Resource" };

const makeHarness = Effect.fnUntraced(function* (
  items: readonly unknown[],
  bankItems: readonly unknown[] = [bankEquipment, bankMisc],
  bankUsedSlots = 2,
  houseItems: readonly unknown[] = [],
) {
  const target = {} as Window;
  const calls = { deposits: 0, swaps: 0, withdrawals: 0 };
  let loaded = false;
  let opened = false;
  let miscSlots = 2;
  const emit = (dataObj: object) =>
    target.onExtensionResponse?.(JSON.stringify({ dataObj, type: "json" }));
  const emitConnection = (status: string) => target.onConnection?.(status);
  target.swf = {
    "auth.isLoggedIn": () => true,
    "bank.getItems": () => bankItems,
    "bank.getSlots": () => 10,
    "bank.getUsedSlots": () => bankUsedSlots,
    "bank.isLoaded": () => loaded,
    "bank.loadItems": () => {
      loaded = true;
    },
    "bank.isOpen": () => opened,
    "bank.open": () => {
      opened = true;
    },
    "bank.withdraw": (selector: { itemId: number }) => {
      calls.withdrawals++;
      emit({ cmd: "bankToInv", ItemID: selector.itemId, bSuccess: 1 });
      return true;
    },
    "bank.deposit": (selector: { itemId: number }) => {
      calls.deposits++;
      emit({ cmd: "bankFromInv", ItemID: selector.itemId, bSuccess: 1 });
      return true;
    },
    "bank.swap": (
      inventorySelector: { itemId: number },
      bankSelector: { itemId: number },
    ) => {
      calls.swaps++;
      emit({
        cmd: "bankSwapInv",
        invItemID: inventorySelector.itemId,
        bankItemID: bankSelector.itemId,
      });
      return true;
    },
    "inventory.getSlots": () => 1,
    "inventory.getMiscSlots": () => miscSlots,
    "house.getSlots": () => 1,
  } as unknown as Window["swf"];
  const bridge = yield* makeBridge(target);
  const gateway = yield* makeGateway(target).pipe(
    Effect.provideService(Bridge, bridge),
  );
  const api = yield* makeApi.pipe(
    Effect.provideService(Bridge, bridge),
    Effect.provideService(Gateway, gateway),
  );
  const loadedInventory = yield* api.wait.forPacket(
    { command: "loadInventoryBig", direction: "extension", encoding: "json" },
    {
      trigger: Effect.sync(() => {
        emit({ cmd: "loadInventoryBig", items, hitems: houseItems });
        return true;
      }),
    },
  );
  expect(loadedInventory).not.toBeNull();
  return {
    api,
    calls,
    emit,
    emitConnection,
    setMiscSlots: (slots: number) => {
      miscSlots = slots;
    },
  };
});

describe("inventory capacity after the AQW inventory update", () => {
  it.effect(
    "counts equipment slots separately from misc items and classes",
    () =>
      Effect.gen(function* () {
        const { api } = yield* makeHarness([
          misc,
          classItem,
          { ItemID: 5, sName: "Note", sType: "Note" },
          { ItemID: 6, sName: "Quest Item", sType: "Quest Item" },
          { ItemID: 7, sName: "Misc Item", sType: "Item", sMeta: "" },
          { ItemID: 8, sName: "Guild Item", sType: "Guild" },
        ]);
        expect(yield* api.inventory.getUsedSlots()).toBe(0);
        expect(yield* api.inventory.getAvailableSlots()).toBe(1);
        expect(yield* api.bank.withdraw(10)).toBe(true);
        expect(yield* api.inventory.contains(10)).toBe(true);
        expect(yield* api.bank.contains(10)).toBe(false);
        expect(yield* api.inventory.getAvailableSlots()).toBe(0);
      }),
  );

  it.effect("counts action-slot consumables as equipment", () =>
    Effect.gen(function* () {
      const { api, calls } = yield* makeHarness([potion]);
      expect(yield* api.inventory.getUsedSlots()).toBe(1);
      expect(yield* api.bank.withdraw(10)).toBe(false);
      expect(calls.withdrawals).toBe(0);
    }),
  );

  it.effect(
    "withdraws misc items into their own pool when equipment is full",
    () =>
      Effect.gen(function* () {
        const { api } = yield* makeHarness([equipment, misc]);
        expect(yield* api.bank.withdraw(11)).toBe(true);
        expect(yield* api.inventory.contains(11)).toBe(true);
        expect(yield* api.inventory.getUsedSlots()).toBe(1);
      }),
  );

  it.effect("rejects misc withdrawals when the misc pool is full", () =>
    Effect.gen(function* () {
      const { api, calls } = yield* makeHarness([
        misc,
        { ItemID: 5, sName: "Quest Item", sType: "Quest Item" },
      ]);
      expect(yield* api.bank.withdraw(11)).toBe(false);
      expect(calls.withdrawals).toBe(0);
      expect(yield* api.bank.contains(11)).toBe(true);
    }),
  );

  it.effect(
    "allows a misc swap to free a misc slot but not an equipment slot",
    () =>
      Effect.gen(function* () {
        const { api, calls } = yield* makeHarness([
          equipment,
          misc,
          { ItemID: 5, sName: "Quest Item", sType: "Quest Item" },
        ]);
        expect(yield* api.bank.swap(1, 11)).toBe(false);
        expect(calls.swaps).toBe(0);
        expect(yield* api.bank.swap(2, 11)).toBe(true);
        expect(yield* api.inventory.contains(11)).toBe(true);
        expect(yield* api.bank.contains(2)).toBe(true);
      }),
  );

  it.effect(
    "allows swaps only when they leave room in the destination pool",
    () =>
      Effect.gen(function* () {
        const { api, calls } = yield* makeHarness([equipment, misc]);
        expect(yield* api.bank.swap(2, 10)).toBe(false);
        expect(calls.swaps).toBe(0);
        expect(yield* api.bank.swap(1, 10)).toBe(true);
        expect(calls.swaps).toBe(1);
        expect(yield* api.inventory.contains(10)).toBe(true);
        expect(yield* api.bank.contains(1)).toBe(true);
      }),
  );

  it.effect("allows swaps within an already overfilled pool", () =>
    Effect.gen(function* () {
      const { api } = yield* makeHarness([
        misc,
        { ItemID: 5, sName: "Quest Item", sType: "Quest Item" },
        { ItemID: 6, sName: "Note", sType: "Note" },
      ]);
      expect(yield* api.bank.withdraw(11)).toBe(false);
      expect(yield* api.bank.swap(2, 11)).toBe(true);
      expect(yield* api.inventory.contains(11)).toBe(true);
      expect(yield* api.bank.contains(2)).toBe(true);
    }),
  );

  it.effect("rejects banking classes and equipped items", () =>
    Effect.gen(function* () {
      const { api, calls } = yield* makeHarness([
        classItem,
        { ...equipment, bEquip: 1 },
      ]);
      expect(yield* api.bank.deposit(3)).toBe(false);
      expect(yield* api.bank.deposit(1)).toBe(false);
      expect(yield* api.bank.swap(3, 10)).toBe(false);
      expect(yield* api.bank.swap(1, 10)).toBe(false);
      expect(calls).toEqual({ deposits: 0, swaps: 0, withdrawals: 0 });
    }),
  );

  it.effect("uses the client's bank count to reject a full bank", () =>
    Effect.gen(function* () {
      const full = yield* makeHarness(
        [equipment],
        [bankEquipment, bankMisc],
        10,
      );
      expect(yield* full.api.bank.deposit(1)).toBe(false);
      expect(full.calls.deposits).toBe(0);
      expect(yield* full.api.inventory.contains(1)).toBe(true);

      const available = yield* makeHarness([equipment]);
      expect(yield* available.api.bank.deposit(1)).toBe(true);
      expect(yield* available.api.bank.contains(1)).toBe(true);
      expect(yield* available.api.inventory.contains(1)).toBe(false);
    }),
  );

  it.effect(
    "withdraws Guild items into inventory without using a bag slot",
    () =>
      Effect.gen(function* () {
        const { api } = yield* makeHarness(
          [equipment],
          [{ ItemID: 12, sName: "Guild Item", sType: "Guild" }],
        );
        expect(yield* api.bank.withdraw(12)).toBe(true);
        expect(yield* api.inventory.contains(12)).toBe(true);
        expect(yield* api.house.contains(12)).toBe(false);
        expect(yield* api.inventory.getUsedSlots()).toBe(1);
      }),
  );

  it.effect(
    "allows native house and Guild swaps when house storage is full",
    () =>
      Effect.gen(function* () {
        for (const bankItem of [
          { ItemID: 12, sName: "Guild Item", sType: "Guild" },
          { ItemID: 12, sName: "House Item", sType: "Floor Item", bHouse: 1 },
        ]) {
          const { api, calls } = yield* makeHarness(
            [equipment],
            [bankItem],
            1,
            [{ ItemID: 20, sName: "Owned House Item", bHouse: 1 }],
          );
          expect(yield* api.bank.withdraw(12)).toBe(false);
          expect(calls.withdrawals).toBe(0);
          expect(yield* api.bank.swap(1, 12)).toBe(true);
          expect(calls.swaps).toBe(1);
          expect(yield* api.bank.contains(1)).toBe(true);
          const destination = bankItem.bHouse ? api.house : api.inventory;
          expect(yield* destination.contains(12)).toBe(true);
        }
      }),
  );

  it.effect("excludes classes from bank snapshots", () =>
    Effect.gen(function* () {
      const { api } = yield* makeHarness([], [bankEquipment, classItem], 1);
      expect(yield* api.bank.load()).toBe(true);
      expect((yield* api.bank.getAll()).map((item) => item.itemId)).toEqual([
        10,
      ]);
      expect(yield* api.bank.contains(3)).toBe(false);
    }),
  );

  it.effect("reports bag and misc capacity independently", () =>
    Effect.gen(function* () {
      const { api } = yield* makeHarness([
        equipment,
        misc,
        classItem,
        { ItemID: 8, sName: "Guild Item", sType: "Guild" },
        potion,
      ]);
      expect(yield* api.inventory.getSlots()).toBe(1);
      expect(yield* api.inventory.getSlots("bag")).toBe(1);
      expect(yield* api.inventory.getUsedSlots()).toBe(2);
      expect(yield* api.inventory.getAvailableSlots()).toBe(0);
      expect(yield* api.inventory.getSlots("misc")).toBe(2);
      expect(yield* api.inventory.getUsedSlots("misc")).toBe(1);
      expect(yield* api.inventory.getAvailableSlots("misc")).toBe(1);
    }),
  );

  it.effect(
    "rejects a new misc withdrawal when availability reaches zero",
    () =>
      Effect.gen(function* () {
        const { api, calls } = yield* makeHarness(
          [misc],
          [
            bankMisc,
            { ItemID: 12, sName: "Another Resource", sType: "Resource" },
          ],
        );
        expect(yield* api.bank.withdraw(11)).toBe(true);
        expect(yield* api.inventory.getUsedSlots("misc")).toBe(2);
        expect(yield* api.inventory.getAvailableSlots("misc")).toBe(0);
        expect(yield* api.inventory.contains(11)).toBe(true);
        expect(yield* api.bank.contains(11)).toBe(false);
        expect(calls.withdrawals).toBe(1);
        expect(yield* api.bank.withdraw(12)).toBe(false);
        expect(calls.withdrawals).toBe(1);
        expect(yield* api.inventory.contains(12)).toBe(false);
        expect(yield* api.bank.contains(12)).toBe(true);
      }),
  );

  it.effect("uses the current misc limit for reads and withdrawals", () =>
    Effect.gen(function* () {
      const { api, setMiscSlots } = yield* makeHarness([
        misc,
        { ItemID: 5, sName: "Quest Item", sType: "Quest Item" },
      ]);
      expect(yield* api.inventory.getSlots("misc")).toBe(2);
      expect(yield* api.inventory.getAvailableSlots("misc")).toBe(0);
      setMiscSlots(3);
      expect(yield* api.inventory.getSlots("misc")).toBe(3);
      expect(yield* api.inventory.getAvailableSlots("misc")).toBe(1);
      expect(yield* api.bank.withdraw(11)).toBe(true);
      expect(yield* api.inventory.getUsedSlots("misc")).toBe(3);
      expect(yield* api.inventory.getAvailableSlots("misc")).toBe(0);
    }),
  );

  it.effect(
    "resets capacity until inventory reloads after connection events",
    () =>
      Effect.gen(function* () {
        const items = [equipment, misc];
        const { api, emit, emitConnection } = yield* makeHarness(items);
        expect(yield* api.inventory.getSlots("misc")).toBe(2);
        expect(yield* api.inventory.getAvailableSlots("misc")).toBe(1);
        expect(yield* api.inventory.getSlots()).toBe(1);

        for (const status of [
          "OnConnection",
          "OnConnectionLost",
          "OnConnectionFailed",
        ]) {
          const reset = yield* api.wait.forEvent(
            { type: "connection", status },
            {
              trigger: Effect.sync(() => {
                emitConnection(status);
                return true;
              }),
            },
          );
          expect(reset).toEqual({ type: "connection", status });
          expect(yield* api.inventory.getSlots("misc")).toBe(0);
          expect(yield* api.inventory.getAvailableSlots("misc")).toBe(0);
          expect(yield* api.inventory.getSlots()).toBe(0);

          const reloadedInventory = yield* api.wait.forPacket(
            {
              command: "loadInventoryBig",
              direction: "extension",
              encoding: "json",
            },
            {
              trigger: Effect.sync(() => {
                emit({ cmd: "loadInventoryBig", items, hitems: [] });
                return true;
              }),
            },
          );
          expect(reloadedInventory?.command).toBe("loadInventoryBig");
          expect(yield* api.inventory.getSlots("misc")).toBe(2);
          expect(yield* api.inventory.getUsedSlots("misc")).toBe(1);
          expect(yield* api.inventory.getAvailableSlots("misc")).toBe(1);
          expect(yield* api.inventory.getSlots()).toBe(1);
          expect(yield* api.inventory.getUsedSlots()).toBe(1);
          expect(yield* api.inventory.getAvailableSlots()).toBe(0);
        }
      }),
  );
});
