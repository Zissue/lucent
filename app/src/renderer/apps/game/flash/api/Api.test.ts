import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { Bridge, makeBridge } from "../bridge/Bridge";
import { Gateway, makeGateway } from "../bridge/Gateway";
import { makeApi } from "./Api";

const emitExtension = (target: Window, dataObj: object): void => {
  target.onExtensionResponse?.(JSON.stringify({ dataObj, type: "json" }));
};

const makeTarget = () => {
  const calls = {
    actions: [] as string[],
    bankOpens: 0,
    bankLoadForces: [] as boolean[],
    deposits: 0,
    equips: 0,
    hairShopLoads: 0,
    shopLoads: 0,
    skillUses: [] as {
      force: boolean;
      index: string;
      selector: { monsterMapId: number } | { name: string } | null;
    }[],
    swaps: 0,
    wears: 0,
    withdrawals: 0,
  };
  let failBankLoad = false;
  let bankLoaded = false;
  let bankOpen = false;
  let bankItems: readonly unknown[] = [];
  let cachedShopId = 0;
  let openShopId = 0;
  const target = {} as Window;

  target.swf = {
    "auth.isLoggedIn": () => true,
    "bank.deposit": () => {
      calls.deposits += 1;
      emitExtension(target, {
        ItemID: 51,
        bSuccess: 1,
        cmd: "bankFromInv",
      });
      return true;
    },
    "bank.getSlots": () => 2,
    "bank.getUsedSlots": () => 2,
    "bank.getItems": () => bankItems,
    "bank.isLoaded": () => bankLoaded,
    "bank.loadItems": (force = false) => {
      calls.bankLoadForces.push(force);
      if (failBankLoad) throw new Error("load failed");
      bankItems = [
        {
          ItemID: "42",
          bCoins: 1,
          iQty: "2",
          sName: "Indexed Item",
        },
        {
          ItemID: "43",
          bHouse: 1,
          sName: "Banked House Item",
        },
        { ItemID: "44", sName: "Occupied Slot" },
        {
          ItemID: "45",
          iQty: "302500",
          sES: "ar",
          sName: "Banked Class",
          sType: "Class",
        },
      ];
      bankLoaded = true;
    },
    "bank.isOpen": () => bankOpen,
    "bank.open": () => {
      calls.bankOpens += 1;
      bankOpen = true;
    },
    "bank.swap": (
      inventorySelector: { itemId: number },
      bankSelector: { itemId: number },
    ) => {
      calls.swaps += 1;
      emitExtension(target, {
        bankItemID: bankSelector.itemId,
        cmd: "bankSwapInv",
        invItemID: inventorySelector.itemId,
      });
      return true;
    },
    "bank.withdraw": () => {
      calls.withdrawals += 1;
      return false;
    },
    "combat.getSkillCooldownRemaining": () => 0,
    "combat.useSkill": (
      index: string,
      selector: { monsterMapId: number } | { name: string } | null = null,
      force = false,
    ) => {
      calls.skillUses.push({ force, index, selector });
      return true;
    },
    "drops.accept": (itemId: number) => {
      emitExtension(target, {
        ItemID: itemId,
        bBank: 1,
        bSuccess: 1,
        cmd: "getDrop",
        iQty: 1,
      });
      return true;
    },
    "house.getSlots": () => 1,
    "inventory.equip": (selector: { itemId: number }) => {
      calls.equips += 1;
      emitExtension(target, {
        ItemID: selector.itemId,
        cmd: "equipItem",
        strES: "Weapon",
        uid: 1,
      });
      return true;
    },
    "inventory.wear": (selector: { itemId: number }) => {
      calls.wears += 1;
      emitExtension(target, {
        ItemID: selector.itemId,
        cmd: "wearItem",
        sES: "Weapon",
        success: 1,
        uid: 2,
      });
      emitExtension(target, {
        ItemID: selector.itemId,
        cmd: "wearItem",
        sES: "Weapon",
        success: 1,
        uid: 1,
      });
      return true;
    },
    "inventory.getSlots": () => 4,
    "player.getClassRank": () => {
      throw new Error("Class rank must not use the bridge");
    },
    "player.getUserId": () => 1,
    "player.isMember": () => false,
    "shops.isOpen": (shopId = 0) =>
      openShopId !== 0 && (shopId === 0 || shopId === openShopId),
    "shops.canBuyItem": () => true,
    "shops.buy": () => {
      bankItems = [
        { ItemID: 42, bCoins: 1, iQty: 3, sName: "Indexed Item" },
        { ItemID: 43, bHouse: 1, sName: "Banked House Item" },
        { ItemID: 44, sName: "Occupied Slot" },
        { ItemID: 45, sType: "Class", sName: "Banked Class" },
      ];
      emitExtension(target, {
        cmd: "buyItem",
        bitSuccess: 1,
        bBank: 1,
        CharItemID: 420,
        ItemID: 42,
        iQty: 1,
      });
    },
    "shops.load": (shopId: number) => {
      calls.shopLoads += 1;
      openShopId = shopId;
      if (cachedShopId === shopId) return;
      cachedShopId = shopId;
      emitExtension(target, {
        ShopID: shopId,
        cmd: "loadShop",
        items: [],
        sName: "Action-locked Shop",
      });
    },
    "shops.loadHairShop": () => {
      calls.hairShopLoads += 1;
    },
    "world.isActionAvailable": (action: string) => {
      calls.actions.push(action);
      return true;
    },
    "world.getAvailableMonsterMapIds": () => [2],
  } as unknown as Window["swf"];

  return {
    calls,
    closeBankUi: () => {
      bankOpen = false;
    },
    closeShopUi: () => {
      openShopId = 0;
    },
    failNextBankLoad: () => {
      failBankLoad = true;
    },
    resetBankSession: () => {
      bankItems = [];
      bankLoaded = false;
      bankOpen = false;
      failBankLoad = false;
    },
    target,
  };
};

const makeApiHarness = () =>
  Effect.gen(function* () {
    const {
      calls,
      closeBankUi,
      closeShopUi,
      failNextBankLoad,
      resetBankSession,
      target,
    } = makeTarget();
    const bridge = yield* makeBridge(target);
    const gateway = yield* makeGateway(target).pipe(
      Effect.provideService(Bridge, bridge),
    );
    const api = yield* makeApi.pipe(
      Effect.provideService(Bridge, bridge),
      Effect.provideService(Gateway, gateway),
    );

    return {
      api,
      calls,
      closeBankUi,
      closeShopUi,
      failNextBankLoad,
      resetBankSession,
      target,
    };
  });

const loadTestInventory = (
  api: Effect.Success<typeof makeApi>,
  target: Window,
) =>
  Effect.gen(function* () {
    const inventoryLoad = yield* api.wait.forPacket(
      {
        command: "loadInventoryBig",
        direction: "extension",
        encoding: "json",
      },
      {
        timeout: "1 second",
        trigger: Effect.sync(() => {
          emitExtension(target, {
            cmd: "loadInventoryBig",
            hitems: [{ ItemID: 60, sName: "Placed House Item" }],
            items: [
              { ItemID: 50, sName: "Normal Item" },
              { ItemID: 51, bCoins: 1, sName: "Coin Item" },
              {
                ItemID: 52,
                bWear: 0,
                sES: "Weapon",
                sName: "Wearable Item",
              },
              {
                ItemID: 53,
                bUpg: 1,
                bWear: 0,
                sES: "ba",
                sName: "Member Item",
              },
              {
                ItemID: 54,
                bWear: 0,
                sES: "Weapon",
                sName: "Cosmetic Item",
              },
            ],
          });
          return true;
        }),
      },
    );
    expect(inventoryLoad).not.toBeNull();
  });

describe("Api", () => {
  it.effect("resolves named skill targets from available monsters", () =>
    Effect.gen(function* () {
      const { calls, target } = makeTarget();
      const bridge = yield* makeBridge(target);
      const gateway = yield* makeGateway(target).pipe(
        Effect.provideService(Bridge, bridge),
      );
      const api = yield* makeApi.pipe(
        Effect.provideService(Bridge, bridge),
        Effect.provideService(Gateway, gateway),
      );

      const loaded = yield* api.wait.forPacket(
        {
          command: "moveToArea",
          direction: "extension",
          encoding: "json",
        },
        {
          timeout: "1 second",
          trigger: Effect.sync(() => {
            emitExtension(target, {
              areaId: 1,
              areaName: "test-1",
              cmd: "moveToArea",
              monBranch: [
                {
                  MonID: 1,
                  MonMapID: 1,
                  intHP: 0,
                  intHPMax: 100,
                  intState: 0,
                  strMonName: "Slime",
                },
                {
                  MonID: 1,
                  MonMapID: 2,
                  intHP: 100,
                  intHPMax: 100,
                  intState: 1,
                  strMonName: "Slime",
                },
              ],
              uoBranch: [
                {
                  entID: 1,
                  intHP: 100,
                  intHPMax: 100,
                  intState: 1,
                  strUsername: "Hero",
                },
              ],
            });
            return true;
          }),
        },
      );
      expect(loaded).not.toBeNull();

      expect(
        yield* api.combat.useSkill(1, {
          force: true,
          target: "Slime",
        }),
      ).toBe(true);
      expect(calls.skillUses).toEqual([
        { force: true, index: "1", selector: { monsterMapId: 2 } },
      ]);
    }),
  );

  it.effect("reads class ranks from projections without bridge calls", () =>
    Effect.gen(function* () {
      const { calls, target } = makeTarget();
      const bridge = yield* makeBridge(target);
      const gateway = yield* makeGateway(target).pipe(
        Effect.provideService(Bridge, bridge),
      );
      const api = yield* makeApi.pipe(
        Effect.provideService(Bridge, bridge),
        Effect.provideService(Gateway, gateway),
      );

      expect(yield* api.player.getClassRank()).toBeNull();
      expect(yield* api.player.getClassRank(45)).toBeNull();
      expect(calls.bankLoadForces).toEqual([]);

      expect(yield* api.bank.open()).toBe(true);
      expect(yield* api.bank.get(45)).toBeNull();
      expect(yield* api.player.getClassRank(45)).toBeNull();

      const inventoryLoad = yield* api.wait.forPacket(
        {
          command: "loadInventoryBig",
          direction: "extension",
          encoding: "json",
        },
        {
          timeout: "1 second",
          trigger: Effect.sync(() => {
            emitExtension(target, {
              cmd: "loadInventoryBig",
              items: [
                {
                  ItemID: 45,
                  iQty: 302_500,
                  sES: "ar",
                  sName: "Owned Class",
                  sType: "Class",
                },
                {
                  ItemID: 46,
                  bEquip: 1,
                  iQty: 10_000,
                  sES: "ar",
                  sName: "Equipped Class",
                  sType: "Class",
                },
              ],
            });
            return true;
          }),
        },
      );
      expect(inventoryLoad).not.toBeNull();
      expect(yield* api.player.getClassRank()).toBe(4);
      expect(yield* api.player.getClassRank(46)).toBe(4);
      expect(yield* api.player.getClassRank(45)).toBe(10);
    }),
  );

  it.effect("reuses the shared bank for house withdrawals", () =>
    Effect.gen(function* () {
      const { calls, target } = makeTarget();
      const bridge = yield* makeBridge(target);
      const gateway = yield* makeGateway(target).pipe(
        Effect.provideService(Bridge, bridge),
      );
      const api = yield* makeApi.pipe(
        Effect.provideService(Bridge, bridge),
        Effect.provideService(Gateway, gateway),
      );

      expect(yield* api.bank.isOpen()).toBe(false);
      expect(yield* api.bank.open()).toBe(true);
      expect(yield* api.bank.isOpen()).toBe(true);
      expect(calls.bankOpens).toBe(1);

      expect(yield* api.bank.open()).toBe(true);
      expect(calls.bankOpens).toBe(1);

      expect(yield* api.bank.open({ force: true })).toBe(true);
      expect(calls.bankLoadForces).toEqual([true, true]);
      expect(calls.bankOpens).toBe(1);

      expect(yield* api.bank.withdraw(43)).toBe(false);
      expect(calls.withdrawals).toBe(1);
      expect(calls.bankOpens).toBe(1);
      expect((yield* api.bank.get(43))?.context).toBe("bank");
      expect(yield* api.house.get(43)).toBeNull();
    }),
  );

  it.effect(
    "caches bank loads until disconnect and retains items after a failed reload",
    () =>
      Effect.gen(function* () {
        const { api, calls, resetBankSession, target, failNextBankLoad } =
          yield* makeApiHarness();
        expect(yield* api.bank.getAll()).toEqual([]);
        expect(yield* api.bank.open()).toBe(true);
        expect(calls.bankLoadForces).toEqual([true]);
        expect((yield* api.bank.getAll())[0]?.quantity).toBe(2);
        expect(calls.bankOpens).toBe(1);

        expect(yield* api.bank.open()).toBe(true);
        expect(calls.bankLoadForces).toEqual([true]);
        expect(calls.bankOpens).toBe(1);

        const disconnected = yield* api.wait.forEvent(
          { type: "connection" },
          {
            trigger: Effect.sync(() => {
              resetBankSession();
              target.onConnection?.("OnConnectionLost");
              return true;
            }),
          },
        );
        expect(disconnected).not.toBeNull();
        expect(yield* api.bank.getAll()).toEqual([]);

        expect(yield* api.bank.open()).toBe(true);
        expect(calls.bankLoadForces).toEqual([true, true]);
        expect(calls.bankOpens).toBe(2);
        expect((yield* api.bank.getAll())[0]?.itemId).toBe(42);

        failNextBankLoad();
        expect(yield* api.bank.load(true)).toBe(false);
        expect(calls.bankLoadForces).toEqual([true, true, true]);
        const retained = yield* api.bank.getAll();
        expect(retained[0]?.itemId).toBe(42);
      }),
  );

  it.effect(
    "keeps classes out of bank snapshots after a purchase refresh",
    () =>
      Effect.gen(function* () {
        const { api, target } = yield* makeApiHarness();
        expect(yield* api.bank.load()).toBe(true);
        const loaded = yield* api.wait.forPacket(
          { command: "loadShop", direction: "extension", encoding: "json" },
          {
            trigger: Effect.sync(() => {
              emitExtension(target, {
                cmd: "loadShop",
                ShopID: 1,
                items: [{ ItemID: 42, sName: "Indexed Item" }],
              });
              return true;
            }),
          },
        );
        expect(loaded).not.toBeNull();
        expect(yield* api.shops.buy(42)).toBe(true);
        expect((yield* api.bank.get(42))?.quantity).toBe(3);
        expect(yield* api.bank.get(45)).toBeNull();
      }),
  );

  it.effect("accepts classes into inventory despite a bank response flag", () =>
    Effect.gen(function* () {
      const { api, target } = yield* makeApiHarness();
      const packet = yield* api.wait.forPacket(
        { command: "dropItem", direction: "extension", encoding: "json" },
        {
          timeout: "1 second",
          trigger: Effect.sync(() => {
            emitExtension(target, {
              cmd: "dropItem",
              items: {
                70: { ItemID: 70, sName: "Dropped Class", sType: "Class" },
              },
            });
            return true;
          }),
        },
      );
      expect(packet).not.toBeNull();
      expect(yield* api.drops.accept(70)).toBe(true);
      expect(yield* api.drops.contains(70)).toBe(false);
      expect((yield* api.inventory.get(70))?.context).toBe("inventory");
      expect(yield* api.bank.get(70)).toBeNull();
    }),
  );

  it.effect("guards full containers and projects deposits and swaps", () =>
    Effect.gen(function* () {
      const { api, calls, closeBankUi, target } = yield* makeApiHarness();
      yield* api.bank.open();
      yield* loadTestInventory(api, target);
      expect(yield* api.house.contains(60)).toBe(true);
      expect(yield* api.house.contains(60, 2)).toBe(false);
      expect(yield* api.bank.getAvailableSlots()).toBe(0);
      expect(yield* api.bank.deposit(50)).toBe(false);
      expect(yield* api.bank.withdraw(42)).toBe(false);
      expect(yield* api.bank.withdraw(43)).toBe(false);
      expect(calls.deposits).toBe(0);
      expect(calls.withdrawals).toBe(0);

      const opensBeforeDeposit = calls.bankOpens;
      closeBankUi();
      expect(yield* api.bank.deposit(51)).toBe(true);
      expect(calls.deposits).toBe(1);
      expect(calls.bankOpens).toBe(opensBeforeDeposit + 1);
      expect(calls.bankLoadForces).toEqual([true]);
      expect(yield* api.bank.contains(51)).toBe(true);
      expect(yield* api.inventory.contains(51)).toBe(false);

      expect(yield* api.bank.swap(50, 42)).toBe(false);
      expect(calls.swaps).toBe(0);
      expect(yield* api.bank.swap(50, 44)).toBe(true);
      expect(calls.swaps).toBe(1);
      expect(yield* api.bank.contains(50)).toBe(true);
      expect(yield* api.inventory.contains(44)).toBe(true);
    }),
  );

  it.effect(
    "keeps cosmetic wear distinct from equipment and rejects member-only items",
    () =>
      Effect.gen(function* () {
        const { api, calls, target } = yield* makeApiHarness();
        yield* loadTestInventory(api, target);
        const playerLoad = yield* api.wait.forPacket(
          {
            command: "initUserDatas",
            direction: "extension",
            encoding: "json",
          },
          {
            timeout: "1 second",
            trigger: Effect.sync(() => {
              emitExtension(target, {
                a: [
                  {
                    data: { strUsername: "Hero" },
                    uid: 1,
                  },
                ],
                cmd: "initUserDatas",
              });
              return true;
            }),
          },
        );
        expect(playerLoad).not.toBeNull();
        expect(yield* api.inventory.wear(54)).toBe(true);
        expect(calls.wears).toBe(1);
        const cosmetic = yield* api.inventory.get(54);
        expect(cosmetic).not.toBeNull();
        expect(cosmetic?.worn).toBe(true);
        expect(cosmetic?.equipped).toBe(false);

        expect(yield* api.inventory.equip(52, { wear: false })).toBe(true);
        expect(calls.equips).toBe(1);
        expect(calls.wears).toBe(1);
        expect((yield* api.inventory.get(52))?.equipped).toBe(true);
        expect((yield* api.inventory.get(52))?.worn).toBe(false);
        expect((yield* api.inventory.get(54))?.worn).toBe(true);

        expect(yield* api.inventory.equip(52)).toBe(true);
        expect(calls.equips).toBe(1);
        expect(calls.wears).toBe(2);
        expect((yield* api.inventory.get(52))?.worn).toBe(true);
        expect((yield* api.inventory.get(54))?.worn).toBe(false);

        expect(yield* api.inventory.wear(52)).toBe(true);
        expect(yield* api.inventory.wear(50)).toBe(false);
        expect(yield* api.inventory.wear(53)).toBe(false);
        expect(calls.wears).toBe(2);

        expect(yield* api.inventory.equip(53)).toBe(false);
        expect(calls.equips).toBe(1);

        expect(calls.actions).toContain("wearItem");
      }),
  );

  it.effect("reopens cached shops and dispatches hair-shop actions", () =>
    Effect.gen(function* () {
      const { api, calls, closeShopUi } = yield* makeApiHarness();
      expect(yield* api.shops.load(101)).toBe(true);
      closeShopUi();
      expect(yield* api.shops.isOpen(101)).toBe(false);
      expect(yield* api.shops.load(101)).toBe(true);
      expect(calls.shopLoads).toBe(2);
      yield* api.shops.openHairShop(202);
      expect(calls.actions).toContain("loadShop");
      expect(calls.actions).toContain("loadHairShop");
      expect(calls.hairShopLoads).toBe(1);
    }),
  );
});
