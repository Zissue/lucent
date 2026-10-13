import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import type { Event } from "../contract/Event";
import type { Packet } from "../contract/Packet";
import { toItem } from "../contract/payload/Items";
import { makeBridge } from "../bridge/Bridge";
import { makePipeline, type ProjectionTrace } from "../protocol/Pipeline";
import { makeStore } from "../state/Store";
import { auraEvents } from "./Auras";

Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: {},
});

const extension = (command: string, data: unknown): Packet => ({
  command,
  data,
  direction: "extension",
  raw: "",
  encoding: "json",
});

const stringExtension = (command: string, data: readonly string[]): Packet => ({
  command,
  data,
  direction: "extension",
  raw: data.join("%"),
  encoding: "string",
});

const server = (command: string, data: unknown): Packet => ({
  command,
  data,
  direction: "server",
  raw: "",
  encoding: "json",
});

const client = (command: string, params: readonly string[]): Packet => ({
  command,
  direction: "client",
  params,
  raw: params.join("%"),
  encoding: "string",
});

const bridgeTarget = (methods: Record<string, () => unknown>) =>
  ({ swf: methods }) as unknown as Pick<Window, "swf">;

const makeItemProjection = () =>
  Effect.gen(function* () {
    const store = yield* makeStore;
    const diagnostics: string[] = [];
    const events: Event[] = [];
    const traces: ProjectionTrace[] = [];
    const pipeline = makePipeline(store, {
      publishEvent: (event) =>
        Effect.sync(() => {
          events.push(event);
        }),
      reportDiagnostic: (operation) =>
        Effect.sync(() => {
          diagnostics.push(operation);
        }),
      reportProjectionTrace: (_operation, trace) =>
        Effect.sync(() => {
          traces.push(trace);
        }),
    });

    return { store, pipeline, diagnostics, events, traces };
  });

const makeWorldProjection = () =>
  Effect.gen(function* () {
    const store = yield* makeStore;
    let userIdReads = 0;
    let locationReads = 0;
    let worldLoaded = false;
    const bridge = yield* makeBridge(
      bridgeTarget({
        "player.getCell": () => {
          locationReads += 1;
          return "Boss";
        },
        "player.getPad": () => {
          locationReads += 1;
          return "Right";
        },
        "player.getUserId": () => {
          userIdReads += 1;
          return 10;
        },
        "world.isLoaded": () => worldLoaded,
      }),
    );
    const events: Event[] = [];
    const pipeline = makePipeline(
      store,
      {
        publishEvent: (event) =>
          Effect.sync(() => {
            events.push(event);
          }),
      },
      bridge,
    );

    return {
      store,
      pipeline,
      events,
      userIdReads: () => userIdReads,
      locationReads: () => locationReads,
      setWorldLoaded: () => {
        worldLoaded = true;
      },
    };
  });

const enterTestArea = (pipeline: ReturnType<typeof makePipeline>) =>
  Effect.gen(function* () {
    yield* pipeline.packet(
      extension("moveToArea", {
        areaId: 12,
        areaName: "battleon-42",
        monBranch: [
          {
            MonID: 5,
            MonMapID: 1,
            intHP: 100,
            intHPMax: 100,
            strMonName: "Slime",
          },
        ],
        uoBranch: [
          {
            entID: 10,
            intHP: 100,
            intHPMax: 100,
            strUsername: "Hero",
          },
        ],
      }),
    );
  });

describe("Projection", () => {
  it.effect(
    "isolates malformed seed slots and applies AS3 scalar conversions",
    () =>
      Effect.gen(function* () {
        const { store, pipeline } = yield* makeWorldProjection();
        yield* TestClock.setTime(1_000_000);
        yield* pipeline.packet(
          extension("moveToArea", {
            areaName: "battleon-42",
            uoBranch: [
              {
                entID: 10,
                strUsername: "Hero",
                au: [
                  ["Curse of Times", "inver2", 6.4, 5, 0, 8],
                  ["Bad", "icon", { toString: null }, 1, 0, 8],
                  [42, null, 5, "garbage", "1"],
                ],
              },
            ],
          }),
        );
        expect(
          (yield* store.world.getMe)?.auras.map((aura) => aura.toJSON()),
        ).toEqual([
          {
            name: "Curse of Times",
            kind: "active",
            icon: "inver2",
            stack: 5,
            duration: 8,
            expiresAt: 1_006_400,
            persistent: false,
          },
          {
            name: "42",
            kind: "active",
            icon: "null",
            stack: 1,
            duration: 5,
            expiresAt: 1_005_000,
            persistent: true,
          },
        ]);
        yield* pipeline.packet(
          extension("cb", {
            a: [
              {
                cmd: "aura+",
                tInf: "p:10",
                auras: [
                  { nam: "Focus", stk: "garbage", persist: "true" },
                  { nam: "Elixir", persist: "1" },
                ],
              },
            ],
          }),
        );
        expect(
          (yield* store.world.getMe)?.getAura("Focus")?.toJSON(),
        ).toMatchObject({ stack: 0, persistent: false });
        expect((yield* store.world.getMe)?.getAura("Elixir")?.persistent).toBe(
          true,
        );
      }),
  );

  it.effect("keeps classes in inventory when item mutations carry bBank", () =>
    Effect.gen(function* () {
      const { store, pipeline } = yield* makeItemProjection();
      yield* pipeline.packet(
        extension("addItems", {
          items: {
            7: {
              CharItemID: 70,
              bBank: 1,
              iQty: 10_000,
              sES: "ar",
              sName: "Owned Class",
              sType: "Class",
            },
          },
        }),
      );
      expect(yield* store.items.get("bank", 7)).toBeNull();
      expect(
        (yield* store.items.get("inventory", 7))?.snapshot(),
      ).toMatchObject({
        context: "inventory",
      });
      expect((yield* store.items.get("inventory", 7))?.classRank).toBe(4);
      yield* pipeline.packet(
        extension("removeItem", { CharItemID: 70, bBank: 1, iQty: 1 }),
      );
      expect(yield* store.items.get("inventory", 7)).toBeNull();
    }),
  );

  it.effect("routes Guild item additions into inventory", () =>
    Effect.gen(function* () {
      const { store, pipeline } = yield* makeItemProjection();
      yield* pipeline.packet(
        extension("addItems", {
          items: { 8: { sName: "Guild Item", sType: "Guild", iQty: 1 } },
        }),
      );
      expect((yield* store.items.get("inventory", 8))?.name).toBe("Guild Item");
      expect(yield* store.items.get("house", 8)).toBeNull();
    }),
  );

  it.effect(
    "indexes valid inventory entries and diagnoses malformed neighbors",
    () =>
      Effect.gen(function* () {
        const { store, pipeline, diagnostics, traces } =
          yield* makeItemProjection();
        yield* pipeline.packet(
          extension("loadInventoryBig", {
            items: [
              {
                CharItemID: "77",
                EnhID: -1,
                ItemID: "7",
                iQty: "3",
                sName: "Health Potion",
              },
              { sName: "Invalid entry" },
            ],
          }),
        );
        expect((yield* store.items.get("inventory", 7))?.quantity).toBe(3);
        expect(
          (yield* store.items.get("inventory", "health potion"))?.itemId,
        ).toBe(7);
        expect(diagnostics).toEqual(["items:loadInventoryBig:entries"]);

        expect(traces).toHaveLength(1);
        expect(traces[0]).toMatchObject({
          before: expect.any(Object),
          diff: expect.any(Object),
          packet: { command: "loadInventoryBig" },
        });
      }),
  );

  it.effect(
    "projects bank swaps, sales, and equipment changes by item identity",
    () =>
      Effect.gen(function* () {
        const { store, pipeline } = yield* makeItemProjection();
        yield* store.items.replace("inventory", [
          toItem(
            { CharItemID: 77, ItemID: 7, iQty: 3, sName: "Health Potion" },
            { context: "inventory" },
          ),
        ]);
        yield* store.items.replace("bank", [
          toItem(
            {
              CharItemID: 88,
              ItemID: 8,
              iQty: 2,
              sName: "Bank Item",
            },
            { context: "bank" },
          ),
        ]);
        yield* pipeline.packet(
          extension("bankSwapInv", { bankItemID: 8, invItemID: 7 }),
        );
        expect((yield* store.items.get("bank", 7))?.name).toBe("Health Potion");
        expect((yield* store.items.get("inventory", 8))?.name).toBe(
          "Bank Item",
        );

        yield* pipeline.packet(
          extension("sellItem", { CharItemID: 88, iQty: 1 }),
        );
        expect((yield* store.items.get("inventory", 8))?.quantity).toBe(1);

        yield* store.world.setSelf("Hero");
        yield* pipeline.packet(
          extension("equipItem", { ItemID: 8, strES: "Weapon" }),
        );
        expect((yield* store.items.get("inventory", 8))?.equipped).toBe(true);
        yield* pipeline.packet(extension("unequipItem", { ItemID: 8 }));
        expect((yield* store.items.get("inventory", 8))?.equipped).toBe(false);
      }),
  );

  it.effect("publishes valid drops alongside malformed entries", () =>
    Effect.gen(function* () {
      const { store, pipeline, events } = yield* makeItemProjection();
      yield* pipeline.packet(
        extension("dropItem", {
          items: {
            bad: { sName: "Invalid drop" },
            valid: { ItemID: 9, iQty: 2, sName: "Dropped Item" },
          },
        }),
      );
      expect((yield* store.items.get("drop", 9))?.quantity).toBe(2);

      expect(events).toEqual([
        {
          item: expect.objectContaining({
            context: "drop",
            itemId: 9,
            name: "Dropped Item",
            quantity: 2,
          }),
          type: "item-drop",
        },
      ]);
    }),
  );

  it.effect(
    "indexes shop entries by item ID while preserving shop item ID",
    () =>
      Effect.gen(function* () {
        const { store, pipeline } = yield* makeItemProjection();
        yield* pipeline.packet(
          extension("loadShop", {
            ShopID: 1,
            items: [
              {
                ItemID: 7,
                ShopItemID: 70,
                iQty: 1,
                iStk: "99",
                sName: "Indexed Shop Item",
                turnin: null,
              },
              {
                ItemID: 7,
                ShopItemID: 71,
                iQty: "5",
                iStk: "99",
                sName: "Indexed Shop Item",
                turnin: [{ ItemID: "8", sName: "Bank Item", iQty: "2" }],
              },
            ],
          }),
        );
        expect(
          (yield* store.items.get("shop", { itemId: 7 }))?.shopItemId,
        ).toBe(70);
        expect(
          (yield* store.items.get("shop", { shopItemId: 70 }))?.requirements,
        ).toEqual([]);
        expect(
          yield* store.items.get("shop", { shopItemId: 71 }),
        ).toMatchObject({
          maxStack: 99,
          quantity: 5,
          requirements: [{ itemId: 8, name: "Bank Item", quantity: 2 }],
        });
      }),
  );

  it.effect(
    "projects house inventory and House-specific equipment changes",
    () =>
      Effect.gen(function* () {
        const store = yield* makeStore;
        const pipeline = makePipeline(store, {
          publishEvent: () => Effect.void,
        });

        yield* pipeline.packet(
          extension("loadInventoryBig", { hitems: [], items: [] }),
        );
        expect(yield* store.items.getAll("house")).toEqual([]);

        yield* pipeline.packet(
          extension("loadInventoryBig", {
            hitems: [
              {
                CharItemID: 1_001,
                ItemID: 101,
                bEquip: 1,
                bHouse: 1,
                sES: "ho",
                sName: "First House",
                sType: "House",
              },
              {
                CharItemID: 1_002,
                ItemID: 102,
                bEquip: 0,
                bHouse: 1,
                sES: "ho",
                sName: "Second House",
                sType: "House",
              },
              {
                CharItemID: 1_003,
                ItemID: 103,
                bEquip: 1,
                bHouse: 1,
                sES: "hi",
                sName: "Placed Chair",
                sType: "Floor Item",
              },
            ],
            items: [],
          }),
        );

        yield* pipeline.packet(
          client("equipItem", ["xt", "zm", "equipItem", "1", "102"]),
        );
        expect((yield* store.items.get("house", 101))?.equipped).toBe(false);
        expect((yield* store.items.get("house", 102))?.equipped).toBe(true);
        expect((yield* store.items.get("house", 103))?.equipped).toBe(true);

        yield* pipeline.packet(
          extension("equipItem", { ItemID: 101, strES: "ho" }),
        );
        expect((yield* store.items.get("house", 101))?.equipped).toBe(true);
        expect((yield* store.items.get("house", 102))?.equipped).toBe(false);

        yield* pipeline.packet(
          client("equipItem", ["xt", "zm", "equipItem", "1", "103"]),
        );
        expect((yield* store.items.get("house", 101))?.equipped).toBe(true);
        expect((yield* store.items.get("house", 103))?.equipped).toBe(true);
      }),
  );

  it.effect("projects successful purchases from current shop metadata", () =>
    Effect.gen(function* () {
      const store = yield* makeStore;
      const diagnostics: string[] = [];
      const pipeline = makePipeline(store, {
        publishEvent: () => Effect.void,
        reportDiagnostic: (operation) =>
          Effect.sync(() => {
            diagnostics.push(operation);
          }),
      });

      yield* store.items.replace(
        "shop",
        [
          {
            ItemID: 201,
            ShopItemID: 2_001,
            bHouse: true,
            sES: "ho",
            sName: "First Purchased House",
            sType: "House",
          },
          {
            ItemID: 202,
            ShopItemID: 2_002,
            bHouse: true,
            sES: "ho",
            sName: "Additional House",
            sType: "House",
          },
          {
            ItemID: 203,
            ShopItemID: 2_003,
            bHouse: true,
            sES: "hi",
            sName: "Purchased Chair",
            sType: "Floor Item",
          },
          {
            ItemID: 204,
            ShopItemID: 2_004,
            bHouse: true,
            sES: "ho",
            sName: "Banked House",
            sType: "House",
          },
        ].map((payload) => toItem(payload, { context: "shop" })),
      );

      yield* pipeline.packet(
        extension("buyItem", {
          CharItemID: 3_001,
          ItemID: 201,
          bBank: 0,
          bitSuccess: 1,
          iQty: 1,
        }),
      );
      expect((yield* store.items.get("house", 201))?.charItemId).toBe(3_001);
      expect((yield* store.items.get("house", 201))?.equipped).toBe(true);

      yield* pipeline.packet(
        extension("buyItem", {
          CharItemID: 3_002,
          ItemID: 202,
          bBank: 0,
          bitSuccess: 1,
          iQty: 1,
        }),
      );
      expect((yield* store.items.get("house", 202))?.equipped).toBe(false);

      yield* pipeline.packet(
        extension("buyItem", {
          CharItemID: 3_003,
          ItemID: 203,
          bBank: 0,
          bitSuccess: 1,
          iQty: 2,
        }),
      );
      expect((yield* store.items.get("house", 203))?.quantity).toBe(2);
      expect((yield* store.items.get("house", 203))?.equipped).toBe(false);

      yield* pipeline.packet(
        extension("buyItem", {
          CharItemID: 3_004,
          ItemID: 204,
          bBank: 1,
          bitSuccess: 1,
          iQty: 1,
        }),
      );
      expect((yield* store.items.get("bank", 204))?.context).toBe("bank");
      expect(yield* store.items.get("house", 204)).toBeNull();

      yield* pipeline.packet(extension("buyItem", { bitSuccess: 0 }));
      expect(yield* store.items.get("house", 205)).toBeNull();
      expect(diagnostics).toEqual([]);

      yield* pipeline.packet(
        extension("buyItem", {
          CharItemID: 3_005,
          bBank: 0,
          bitSuccess: 1,
          iQty: 1,
        }),
      );
      expect(diagnostics).toEqual(["items:buyItem"]);
    }),
  );

  it.effect("projects class-point gains", () =>
    Effect.gen(function* () {
      const store = yield* makeStore;
      const pipeline = makePipeline(store, {
        publishEvent: () => Effect.void,
      });

      yield* pipeline.packet(
        extension("loadInventoryBig", {
          items: [
            {
              CharItemID: 101,
              ItemID: 1,
              bEquip: true,
              iQty: 99_400,
              sES: "ar",
              sName: "Barber",
              sType: "Class",
            },
          ],
        }),
      );

      yield* pipeline.packet(
        extension("addGoldExp", {
          bonusCP: 18,
          bonusGold: 6,
          cmd: "addGoldExp",
          iCP: 36,
          id: 1,
          intExp: 20,
          intGold: 12,
          typ: "m",
        }),
      );
      expect((yield* store.items.get("inventory", "Barber"))?.quantity).toBe(
        99_436,
      );

      yield* pipeline.packet(
        extension("addGoldExp", {
          cmd: "addGoldExp",
          iCP: -36,
          id: 0,
          typ: "q",
        }),
      );
      expect((yield* store.items.get("inventory", "Barber"))?.quantity).toBe(
        99_400,
      );
    }),
  );

  it.effect("consumes temporary requirements on quest turn-in", () =>
    Effect.gen(function* () {
      const store = yield* makeStore;
      const pipeline = makePipeline(store, {
        publishEvent: () => Effect.void,
      });

      yield* pipeline.packet(
        extension("forceAddItem", {
          items: {
            temporary: {
              ItemID: 100,
              bTemp: 1,
              iQty: 3,
              sName: "Quest Drop",
            },
          },
        }),
      );
      expect((yield* store.items.get("temporary", 100))?.quantity).toBe(3);

      yield* pipeline.packet(extension("turnIn", { sItems: "100:2" }));
      expect((yield* store.items.get("temporary", 100))?.quantity).toBe(1);

      yield* pipeline.packet(extension("turnIn", { sItems: "100:1" }));
      expect(yield* store.items.get("temporary", 100)).toBeNull();
    }),
  );

  it.effect("derives omitted item ids from item record keys", () =>
    Effect.gen(function* () {
      const store = yield* makeStore;
      let addItemsChanged: boolean | undefined;
      const pipeline = makePipeline(store, {
        publishEvent: () => Effect.void,
        reportProjectionTrace: (operation, trace) =>
          Effect.sync(() => {
            if (operation === "projection:addItems") {
              addItemsChanged = trace.changed;
            }
          }),
      });

      yield* store.items.replace("inventory", [
        toItem(
          {
            CharItemID: 200,
            EnhID: -1,
            ItemID: 12_917,
            iQty: 200,
            sName: "Scroll of Enrage",
          },
          { context: "inventory" },
        ),
      ]);
      yield* pipeline.packet(
        extension("addItems", {
          items: {
            "12917": {
              CharItemID: 200,
              bBank: 0,
              iQty: 200,
              iQtyNow: 400,
            },
          },
          msg: "",
        }),
      );
      expect((yield* store.items.get("inventory", 12_917))?.quantity).toBe(400);
      expect(addItemsChanged).toBe(true);
      yield* pipeline.packet(
        extension("forceAddItem", {
          items: {
            scroll: {
              ItemID: 12_917,
              iQty: 200,
              iQtyNow: 450,
            },
          },
        }),
      );
      expect((yield* store.items.get("inventory", 12_917))?.quantity).toBe(450);
    }),
  );

  it.effect(
    "updates self health and accepts area changes only from extensions",
    () =>
      Effect.gen(function* () {
        const { store, pipeline } = yield* makeWorldProjection();
        yield* pipeline.packet(
          extension("initUserDatas", {
            a: [
              {
                data: {
                  intHP: "90",
                  intHPMax: "100",
                  strUsername: "Hero",
                },
                uid: "10",
              },
            ],
          }),
        );
        expect((yield* store.world.getMe)?.hp).toBe(90);

        yield* pipeline.packet(
          extension("uotls", { o: { intHP: "80" }, unm: "Hero" }),
        );
        expect((yield* store.world.getMe)?.hp).toBe(80);

        yield* pipeline.packet(
          server("moveToArea", {
            areaId: 99,
            areaName: "duplicate-99",
            monBranch: [],
            uoBranch: [],
          }),
        );
        expect((yield* store.world.getMap).id).toBe(0);

        yield* enterTestArea(pipeline);
        expect((yield* store.world.getMap).roomNumber).toBe(42);
        expect((yield* store.world.getMe)?.username).toBe("Hero");
      }),
  );

  it.effect("projects monster combat ticks only from the server", () =>
    Effect.gen(function* () {
      const { store, pipeline } = yield* makeWorldProjection();
      yield* enterTestArea(pipeline);
      yield* pipeline.packet(extension("ct", { m: { "1": { intHP: 20 } } }));
      expect((yield* store.world.getMonster(1))?.hp).toBe(100);
      yield* pipeline.packet(server("ct", { m: { "1": { intHP: 80 } } }));
      expect((yield* store.world.getMonster(1))?.hp).toBe(80);
    }),
  );

  it.effect("projects which monsters are aggressive", () =>
    Effect.gen(function* () {
      const { store, pipeline } = yield* makeWorldProjection();
      yield* pipeline.packet(
        extension("moveToArea", {
          areaId: 12,
          areaName: "xantown-1",
          monBranch: [
            { MonID: 678, MonMapID: 1, bRed: true },
            { MonID: 863, MonMapID: 14, bRed: false },
          ],
          monmap: [
            { MonMapID: 1, strFrame: "Enter" },
            { MonMapID: 14, strFrame: "r7" },
          ],
          uoBranch: [
            { entID: 10, intHP: 100, intHPMax: 100, strUsername: "Hero" },
          ],
        }),
      );
      expect(
        (yield* store.world.getMonsters).map((monster) => [
          monster.cell,
          monster.aggressive,
        ]),
      ).toEqual([
        ["Enter", true],
        ["r7", false],
      ]);
    }),
  );

  it.effect(
    "tracks movement and refreshes location only after the world loads",
    () =>
      Effect.gen(function* () {
        const { store, pipeline, locationReads, setWorldLoaded } =
          yield* makeWorldProjection();
        yield* enterTestArea(pipeline);
        yield* pipeline.packet(
          client("moveToCell", [
            "xt",
            "zm",
            "moveToCell",
            "12",
            "Battle",
            "Left",
          ]),
        );
        expect((yield* store.world.getMe)?.cell).toBe("Battle");
        expect((yield* store.world.getMe)?.pad).toBe("Left");

        yield* pipeline.packet(
          client("mv", ["xt", "zm", "mv", "12", "320", "240", "8"]),
        );
        expect((yield* store.world.getMe)?.position).toEqual({
          x: 320,
          y: 240,
        });

        yield* pipeline.packet({
          command: "mtcid",
          data: ["mtcid", "4"],
          direction: "extension",
          raw: "",
          encoding: "string",
        });
        expect((yield* store.world.getMe)?.cell).toBe("Battle");
        expect((yield* store.world.getMe)?.pad).toBe("Left");
        expect(locationReads()).toBe(0);

        setWorldLoaded();
        yield* pipeline.packet({
          command: "mtcid",
          data: ["mtcid", "4"],
          direction: "extension",
          raw: "",
          encoding: "string",
        });
        expect((yield* store.world.getMe)?.cell).toBe("Boss");
        expect((yield* store.world.getMe)?.pad).toBe("Right");
        expect(locationReads()).toBe(2);
      }),
  );

  it.effect("uses server stacks and preserves full duration on refresh", () =>
    Effect.gen(function* () {
      const { store, pipeline, events } = yield* makeWorldProjection();
      yield* TestClock.setTime(1_000_000);
      yield* enterTestArea(pipeline);
      events.length = 0;
      yield* pipeline.packet(
        extension("cb", {
          a: [
            {
              cmd: "aura+",
              tInf: "p:10",
              aura: {
                nam: "Empowered",
                stk: 4,
                t: "s",
                dur: 8,
                isNew: true,
              },
            },
          ],
        }),
      );
      const aura = (yield* store.world.getPlayer(10))?.getAura("Empowered");
      expect(aura?.toJSON()).toMatchObject({
        stack: 4,
        duration: 8,
        expiresAt: 1_008_000,
      });
      yield* TestClock.setTime(1_002_000);
      yield* pipeline.packet(
        extension("cb", {
          a: [
            {
              cmd: "aura+",
              tInf: "p:10",
              aura: {
                nam: "Empowered",
                stk: 5,
                t: "s",
                dur: 3,
                isNew: false,
              },
            },
          ],
        }),
      );
      expect((yield* store.world.getPlayer(10))?.getAura("Empowered")).toBe(
        aura,
      );
      expect(aura?.toJSON()).toMatchObject({
        stack: 5,
        duration: 8,
        expiresAt: 1_005_000,
      });
      yield* pipeline.packet(
        extension("cb", {
          a: [{ cmd: "aura++", tInf: "p:10", aura: { nam: "Empowered" } }],
        }),
      );
      expect(aura?.toJSON()).toMatchObject({ stack: 1, duration: 0 });
      expect(
        events.filter((event) => event.type.startsWith("aura-")),
      ).toMatchObject([
        { type: "aura-added", name: "Empowered", stack: 4 },
        { type: "aura-updated", name: "Empowered", stack: 5 },
        { type: "aura-updated", name: "Empowered", stack: 1 },
      ]);
    }),
  );

  it.effect("seeds every room leaf from server aura tuples", () =>
    Effect.gen(function* () {
      const { store, pipeline } = yield* makeWorldProjection();
      yield* TestClock.setTime(1_000_000);
      yield* pipeline.packet(
        extension("moveToArea", {
          areaId: 12,
          areaName: "battleon-42",
          monBranch: [
            {
              MonID: 5,
              MonMapID: 1,
              intState: 0,
              au: [["Curse of Times", "inver2", 6.4, 5, 0, 8]],
            },
          ],
          monmap: [{ MonMapID: 1, strFrame: "OffCell" }],
          uoBranch: [
            {
              entID: 10,
              strUsername: "Hero",
              au: [["Potent Battle Elixir", "ice", 854.2, 1, 1, 900]],
            },
            {
              entID: 11,
              strUsername: "Ally",
              au: [["Curse of Times", "inver2", 6.4, 5, 0, 8]],
            },
          ],
        }),
      );
      for (const entity of [
        yield* store.world.getMonster(1),
        yield* store.world.getPlayer(11),
      ]) {
        expect(entity?.getAura("Curse of Times")?.toJSON()).toMatchObject({
          name: "Curse of Times",
          icon: "inver2",
          stack: 5,
          duration: 8,
          expiresAt: 1_006_400,
          persistent: false,
        });
      }
      expect(
        (yield* store.world.getMe)?.getAura("Potent Battle Elixir")?.toJSON(),
      ).toMatchObject({
        stack: 1,
        duration: 900,
        expiresAt: 1_854_200,
        persistent: true,
      });
    }),
  );

  it.effect.each([
    { state: 0, accepted: false },
    { state: 1, accepted: true },
  ])(
    "clears monster auras on server state $state before aura sync",
    ({ state, accepted }) =>
      Effect.gen(function* () {
        const { store, pipeline, events } = yield* makeWorldProjection();
        yield* TestClock.setTime(1_000_000);
        yield* enterTestArea(pipeline);
        yield* pipeline.packet(
          server("ct", {
            m: { "1": { intState: 2 } },
            a: [
              {
                cmd: "aura+",
                tInf: "m:1",
                cInf: "p:10",
                aura: {
                  nam: "Focus",
                  stk: 5,
                  t: "s",
                  dur: 6,
                },
              },
            ],
          }),
        );
        expect((yield* store.world.getMonster(1))?.hasAura("Focus")).toBe(true);
        events.length = 0;
        yield* pipeline.packet(
          server("ct", {
            m: { "1": { intState: state } },
            a: [
              { cmd: "aura+", tInf: "m:1", aura: { nam: "Inspired", stk: 2 } },
            ],
          }),
        );
        expect((yield* store.world.getMonster(1))?.hasAura("Focus")).toBe(
          false,
        );
        expect((yield* store.world.getMonster(1))?.hasAura("Inspired")).toBe(
          accepted,
        );
        expect(
          events.filter((event) => event.type === "aura-removed"),
        ).toMatchObject([
          {
            type: "aura-removed",
            name: "Focus",
            targetId: 1,
            targetType: "monster",
          },
        ]);
        if (!accepted) {
          yield* pipeline.packet(
            extension("respawnMon", ["respawnMon", "", "1"]),
          );
          yield* pipeline.packet(
            extension("cb", {
              a: [
                { cmd: "aura+", tInf: "m:1", aura: { nam: "Focus", stk: 5 } },
              ],
            }),
          );
          expect((yield* store.world.getMonster(1))?.hasAura("Focus")).toBe(
            false,
          );
          yield* pipeline.packet(server("ct", { m: { "1": { intState: 0 } } }));
          expect(
            events.filter((event) => event.type === "aura-removed"),
          ).toHaveLength(1);
          yield* pipeline.packet(
            server("ct", {
              m: { "1": { intState: 1 } },
              a: [
                { cmd: "aura+", tInf: "m:1", aura: { nam: "Focus", stk: 5 } },
              ],
            }),
          );
          expect(
            (yield* store.world.getMonster(1))?.getAura("Focus")?.stack,
          ).toBe(5);
        }
      }),
  );

  it.effect("decays aura- stacks and refreshes the remaining timer", () =>
    Effect.gen(function* () {
      const { store, pipeline, events } = yield* makeWorldProjection();
      yield* TestClock.setTime(1_000_000);
      yield* enterTestArea(pipeline);
      yield* pipeline.packet(
        extension("cb", {
          a: [
            {
              cmd: "aura+",
              tInf: "p:10",
              aura: {
                nam: "Styx Water",
                stk: 4,
                t: "s",
                dur: 8,
              },
            },
          ],
        }),
      );
      expect((yield* store.world.getMe)?.hasAura("Styx Water")).toBe(true);
      events.length = 0;
      yield* TestClock.setTime(1_003_000);
      yield* pipeline.packet(
        extension("cb", {
          a: [
            {
              cmd: "aura-",
              tInf: "p:10",
              aura: {
                nam: "Styx Water",
                stk: 1,
                dur: 7,
              },
            },
          ],
        }),
      );
      expect(
        (yield* store.world.getMe)?.getAura("Styx Water")?.toJSON(),
      ).toMatchObject({
        stack: 1,
        duration: 8,
        expiresAt: 1_010_000,
      });
      expect(
        events.filter((event) => event.type.startsWith("aura-")),
      ).toMatchObject([{ type: "aura-updated", name: "Styx Water", stack: 1 }]);
    }),
  );

  it.effect(
    "keeps persistent and passive auras when clearing the local player",
    () =>
      Effect.gen(function* () {
        const { store, pipeline, events } = yield* makeWorldProjection();
        yield* TestClock.setTime(1_000_000);
        yield* enterTestArea(pipeline);
        yield* pipeline.packet(
          extension("cb", {
            a: [
              {
                cmd: "aura+",
                tInf: "p:10",
                auras: [
                  {
                    nam: "Potent Battle Elixir",
                    t: "s",
                    dur: 900,
                    persist: true,
                    icon: "ice",
                  },
                  { nam: "Empowered", stk: 4 },
                ],
              },
              { cmd: "aura+p", tInf: "p:10", aura: { nam: "Empowered" } },
              { cmd: "aura+", tInf: "m:1", aura: { nam: "Focus" } },
            ],
          }),
        );
        expect((yield* store.world.getMe)?.auras).toHaveLength(3);
        events.length = 0;
        yield* pipeline.packet(extension("clearAuras", {}));
        expect(
          (yield* store.world.getMe)?.auras.map((aura) => [
            aura.name,
            aura.kind,
          ]),
        ).toEqual([
          ["Potent Battle Elixir", "active"],
          ["Empowered", "passive"],
        ]);
        expect((yield* store.world.getMonster(1))?.hasAura("Focus")).toBe(true);
        expect(
          events.filter((event) => event.type.startsWith("aura-")),
        ).toMatchObject([
          { type: "aura-removed", name: "Empowered", targetId: 10 },
        ]);
        events.length = 0;
        yield* pipeline.packet(extension("clearAuras", {}));
        expect(events).toEqual([]);
      }),
  );

  it.effect("reseeds a known player from auSnap and preserves passives", () =>
    Effect.gen(function* () {
      const { store, pipeline, events } = yield* makeWorldProjection();
      yield* TestClock.setTime(1_000_000);
      yield* enterTestArea(pipeline);
      yield* pipeline.packet(
        extension("cb", {
          a: [
            {
              cmd: "aura+",
              tInf: "p:10",
              aura: { nam: "Empowered", persist: true },
            },
            { cmd: "aura+p", tInf: "p:10", aura: { nam: "Brand of Chaos" } },
          ],
        }),
      );
      expect((yield* store.world.getMe)?.auras).toHaveLength(2);
      events.length = 0;
      yield* pipeline.packet(
        extension("auSnap", {
          unm: "Hero",
          au: [["Inspired", "imr2,iihelm", 8, 1, 0, 12]],
        }),
      );
      expect(
        (yield* store.world.getMe)?.auras.map((aura) => [aura.name, aura.kind]),
      ).toEqual([
        ["Brand of Chaos", "passive"],
        ["Inspired", "active"],
      ]);
      expect(
        (yield* store.world.getMe)?.getAura("Inspired")?.toJSON(),
      ).toMatchObject({
        stack: 1,
        duration: 12,
        expiresAt: 1_008_000,
      });
      expect(
        events.filter((event) => event.type.startsWith("aura-")),
      ).toMatchObject([
        { type: "aura-removed", name: "Empowered" },
        { type: "aura-added", name: "Inspired", stack: 1 },
      ]);
    }),
  );

  it.effect(
    "replaces standalone passive sets while embedded passives merge",
    () =>
      Effect.gen(function* () {
        const { store, pipeline, events } = yield* makeWorldProjection();
        yield* TestClock.setTime(1_000_000);
        yield* enterTestArea(pipeline);
        yield* pipeline.packet(
          extension("cb", {
            a: [
              { cmd: "aura+p", tInf: "p:10", aura: { nam: "Old Class" } },
              { cmd: "aura+", tInf: "p:10", aura: { nam: "Empowered" } },
            ],
          }),
        );
        expect((yield* store.world.getMe)?.auras).toHaveLength(2);
        events.length = 0;
        yield* pipeline.packet(
          extension("aura+p", {
            cmd: "aura+p",
            tInf: "p:10",
            auras: [{ nam: "Brand of Chaos", passive: true }],
          }),
        );
        expect(
          (yield* store.world.getMe)?.auras.map((aura) => aura.name),
        ).toEqual(["Empowered", "Brand of Chaos"]);
        expect(
          events.filter((event) => event.type.startsWith("aura-")),
        ).toMatchObject([
          { type: "aura-removed", name: "Old Class" },
          { type: "aura-added", name: "Brand of Chaos", stack: 1 },
        ]);
        yield* pipeline.packet(
          extension("cb", {
            a: [
              { cmd: "aura+p", tInf: "p:10", aura: { nam: "Merged Passive" } },
            ],
          }),
        );
        expect(
          (yield* store.world.getMe)?.auras.map((aura) => aura.name),
        ).toEqual(["Empowered", "Brand of Chaos", "Merged Passive"]);
        yield* pipeline.packet(
          extension("aura+p", { cmd: "aura+p", tInf: "p:10", auras: [] }),
        );
        expect(
          (yield* store.world.getMe)?.auras.map((aura) => aura.name),
        ).toEqual(["Empowered"]);
      }),
  );

  it.effect(
    "publishes active and passive kinds for same-named aura events",
    () =>
      Effect.gen(function* () {
        const { store, pipeline, events } = yield* makeWorldProjection();
        yield* enterTestArea(pipeline);
        events.length = 0;
        yield* pipeline.packet(
          extension("aura+p", {
            cmd: "aura+p",
            tInf: "p:10",
            auras: [{ nam: "Arcane Flux", cat: "passive", icon: "imr1" }],
          }),
        );
        yield* pipeline.packet(
          extension("aura+", {
            cmd: "aura+",
            tInf: "p:10",
            aura: { nam: "Arcane Flux", icon: "imr2", t: "s", dur: 6 },
          }),
        );
        expect(events).toEqual([
          {
            type: "aura-added",
            kind: "passive",
            name: "Arcane Flux",
            duration: 0,
            icon: "imr1",
            stack: 1,
            targetId: 10,
            targetType: "player",
          },
          {
            type: "aura-added",
            kind: "active",
            name: "Arcane Flux",
            duration: 6,
            icon: "imr2",
            stack: 1,
            targetId: 10,
            targetType: "player",
          },
        ]);
        events.length = 0;
        yield* pipeline.packet(
          extension("aura-", {
            cmd: "aura-",
            tInf: "p:10",
            aura: { nam: "Arcane Flux" },
          }),
        );
        expect(events).toEqual([
          {
            type: "aura-removed",
            kind: "active",
            name: "Arcane Flux",
            duration: 6,
            icon: "imr2",
            targetId: 10,
            targetType: "player",
          },
        ]);
        expect(
          (yield* store.world.getMe)?.auras.map((aura) => aura.toJSON()),
        ).toEqual([
          {
            name: "Arcane Flux",
            kind: "passive",
            category: "passive",
            icon: "imr1",
            duration: 0,
            stack: 1,
            persistent: false,
          },
        ]);
      }),
  );

  it.effect.each(["aura-", "aura--"])(
    "keeps a same-named passive when %s removes the active aura",
    (command) =>
      Effect.gen(function* () {
        const { store, pipeline, events } = yield* makeWorldProjection();
        yield* enterTestArea(pipeline);
        yield* pipeline.packet(
          extension("aura+p", {
            cmd: "aura+p",
            tInf: "p:10",
            auras: [{ nam: "Arcane Flux", cat: "passive", icon: "imr1" }],
          }),
        );
        yield* pipeline.packet(
          extension("aura+", {
            cmd: "aura+",
            tInf: "p:10",
            aura: { nam: "Arcane Flux", icon: "imr2", t: "s", dur: 6 },
          }),
        );
        expect(
          (yield* store.world.getMe)?.auras.map((aura) => [
            aura.name,
            aura.kind,
          ]),
        ).toEqual([
          ["Arcane Flux", "passive"],
          ["Arcane Flux", "active"],
        ]);
        events.length = 0;
        yield* pipeline.packet(
          extension(command, {
            cmd: command,
            tInf: "p:10",
            aura: { nam: "Arcane Flux" },
          }),
        );
        expect(
          (yield* store.world.getMe)?.auras.map((aura) => [
            aura.name,
            aura.kind,
          ]),
        ).toEqual([["Arcane Flux", "passive"]]);
        expect(events.filter((event) => event.type === "aura-removed")).toEqual(
          [
            {
              type: "aura-removed",
              kind: "active",
              name: "Arcane Flux",
              duration: 6,
              icon: "imr2",
              targetId: 10,
              targetType: "player",
            },
          ],
        );
      }),
  );

  it.effect(
    "keeps login passives when moveToArea rebuilds the local player",
    () =>
      Effect.gen(function* () {
        const { store, pipeline } = yield* makeWorldProjection();
        yield* store.auth.setCredentials("Hero", "");
        yield* pipeline.packet(
          extension("initUserData", {
            uid: 10,
            data: { strUsername: "Hero", intHP: 100, intHPMax: 100 },
          }),
        );
        yield* pipeline.packet(
          extension("aura+p", {
            cmd: "aura+p",
            tInf: "p:10",
            auras: [
              {
                nam: "Arcane Flux",
                cat: "passive",
                icon: "imr1",
                val: 25,
                dur: 3,
              },
              { nam: "Arcane Power", cat: "buff", icon: "imr2", val: "mana" },
            ],
          }),
        );
        yield* pipeline.packet(
          extension("aura+", {
            cmd: "aura+",
            tInf: "p:10",
            aura: { nam: "Old Active", persist: true },
          }),
        );
        expect(
          (yield* store.world.getMe)?.auras.map((aura) => aura.name),
        ).toEqual(["Arcane Flux", "Arcane Power", "Old Active"]);
        yield* pipeline.packet(
          extension("uotls", {
            unm: "Companion",
            o: { entID: 11, intHP: 100 },
          }),
        );
        yield* pipeline.packet(
          extension("aura+p", {
            cmd: "aura+p",
            tInf: "p:11",
            auras: [{ nam: "Other Passive" }],
          }),
        );
        expect(
          (yield* store.world.getPlayer(11))?.auras.map((aura) => aura.name),
        ).toEqual(["Other Passive"]);
        yield* pipeline.packet(
          extension("moveToArea", {
            areaId: 13,
            areaName: "yulgar-1",
            uoBranch: [
              {
                entID: 11,
                uoName: "Companion",
                au: [["Inspired", "ice", 0, 1, 0]],
              },
              {
                entID: 20,
                uoName: "hErO",
                au: [["New Active", "imr3", 0, 2, 0]],
              },
            ],
          }),
        );
        const self = yield* store.world.getMe;
        expect(self?.entityId).toBe(20);
        expect(
          self?.auras
            .filter((aura) => aura.kind === "passive")
            .map((aura) => aura.toJSON()),
        ).toEqual([
          {
            name: "Arcane Flux",
            kind: "passive",
            category: "passive",
            icon: "imr1",
            value: 25,
            duration: 3,
            stack: 1,
            persistent: false,
          },
          {
            name: "Arcane Power",
            kind: "passive",
            category: "buff",
            icon: "imr2",
            value: "mana",
            duration: 0,
            stack: 1,
            persistent: false,
          },
        ]);
        expect(
          self?.auras
            .filter((aura) => aura.kind === "active")
            .map((aura) => [aura.name, aura.stack]),
        ).toEqual([["New Active", 2]]);
        expect(
          (yield* store.world.getPlayer(11))?.auras.map((aura) => [
            aura.name,
            aura.kind,
          ]),
        ).toEqual([["Inspired", "active"]]);
      }),
  );

  it.effect.each(["aura+", "aura++", "aura-", "aura--", "aura+p", "auSnap"])(
    "projects standalone %s only from its extension copy",
    (command) =>
      Effect.gen(function* () {
        const { store, pipeline, events } = yield* makeWorldProjection();
        yield* TestClock.setTime(1_000_000);
        yield* enterTestArea(pipeline);
        yield* pipeline.packet(
          extension("cb", {
            a: [{ cmd: "aura+", tInf: "p:10", aura: { nam: "Focus" } }],
          }),
        );
        events.length = 0;
        const data =
          command === "auSnap"
            ? {
                cmd: command,
                unm: "Hero",
                au: [["Inspired", "imr2,iihelm", 8, 1, 0, 12]],
              }
            : { cmd: command, tInf: "p:10", aura: { nam: "Focus", stk: 5 } };
        yield* pipeline.packet(server(command, data));
        expect((yield* store.world.getMe)?.getAura("Focus")?.stack).toBe(1);
        expect(events).toEqual([]);
        yield* pipeline.packet(extension(command, data));
        if (command === "auSnap") {
          expect((yield* store.world.getMe)?.getAura("Inspired")?.stack).toBe(
            1,
          );
          expect((yield* store.world.getMe)?.hasAura("Focus")).toBe(false);
        } else if (command === "aura+p") {
          expect(
            (yield* store.world.getMe)?.getAura("Focus", { kind: "passive" })
              ?.stack,
          ).toBe(1);
        } else {
          expect((yield* store.world.getMe)?.getAura("Focus")?.stack).toBe(5);
        }
        expect(
          events.filter((event) => event.type.startsWith("aura-")),
        ).toHaveLength(command === "auSnap" ? 2 : 1);
        events.length = 0;
        yield* pipeline.packet(extension(command, data));
        expect(events).toEqual([]);
        yield* pipeline.packet(server("aura*", { cmd: "aura*", tInf: "m:1" }));
        yield* pipeline.packet(
          extension("aura*", { cmd: "aura*", tInf: "m:1" }),
        );
        expect(events).toEqual([]);
      }),
  );

  it.effect(
    "publishes aura metadata and clears it on death before respawn",
    () =>
      Effect.gen(function* () {
        const { store, pipeline, events } = yield* makeWorldProjection();
        yield* TestClock.setTime(1_000_000);
        yield* enterTestArea(pipeline);
        yield* pipeline.packet(
          extension("cb", {
            m: { "1": { intState: 2 } },
            a: [
              {
                cmd: "aura+",
                tInf: "m:1",
                cInf: "p:10",
                auras: [
                  {
                    nam: "Focus",
                    t: "s",
                    dur: "6",
                    stk: 5,
                    icon: "scroll-enrage",
                  },
                ],
              },
            ],
          }),
        );
        expect(
          (yield* store.world.getMonster(1))?.getAura("Focus")?.stack,
        ).toBe(5);
        expect(events.find((event) => event.type === "aura-added")).toEqual({
          type: "aura-added",
          kind: "active",
          duration: 6,
          icon: "scroll-enrage",
          name: "Focus",
          stack: 5,
          sourceId: 10,
          sourceType: "player",
          targetId: 1,
          targetType: "monster",
        });
        events.length = 0;
        yield* pipeline.packet(
          extension("cb", {
            m: { "1": { intHP: 0, intState: 0 } },
            a: [{ cmd: "aura+", tInf: "m:1", aura: { nam: "Focus", stk: 5 } }],
          }),
        );
        expect(events).toContainEqual({
          type: "monster-death",
          monsterMapId: 1,
        });
        expect(
          events.filter((event) => event.type.startsWith("aura-")),
        ).toEqual([
          {
            type: "aura-removed",
            kind: "active",
            duration: 6,
            icon: "scroll-enrage",
            name: "Focus",
            targetId: 1,
            targetType: "monster",
          },
        ]);
        expect((yield* store.world.getMonster(1))?.auras).toEqual([]);
        events.length = 0;
        yield* pipeline.packet(
          extension("cb", { m: { "1": { intState: 0 } } }),
        );
        yield* pipeline.packet(
          extension("respawnMon", ["respawnMon", "", "1"]),
        );
        yield* pipeline.packet(
          extension("cb", {
            a: [{ cmd: "aura+", tInf: "m:1", aura: { nam: "Focus" } }],
          }),
        );
        expect(events).toEqual([{ type: "monster-respawn", monsterMapId: 1 }]);
        expect((yield* store.world.getMonster(1))?.auras).toEqual([]);
      }),
  );

  it.effect(
    "uses explicit stacks and publishes self-only removal messages",
    () =>
      Effect.gen(function* () {
        const { store, pipeline, events } = yield* makeWorldProjection();
        yield* enterTestArea(pipeline);
        yield* pipeline.packet(
          extension("cb", {
            a: [
              { cmd: "unsupported-aura", tInf: "p:10" },
              {
                auras: [
                  { nam: "Empowered", t: "s", dur: "10", stk: 4, isNew: true },
                ],
                cmd: "aura+",
                tInf: "p:10",
              },
            ],
          }),
        );
        expect((yield* store.world.getPlayer(10))?.auras[0]?.name).toBe(
          "Empowered",
        );

        yield* pipeline.packet(
          extension("cb", {
            a: [
              {
                auras: [{ nam: "Empowered", dur: 10 }],
                cmd: "aura++",
                tInf: "p:10",
              },
            ],
          }),
        );
        expect((yield* store.world.getPlayer(10))?.auras[0]?.stack).toBe(1);

        yield* pipeline.packet(
          extension("cb", {
            a: [
              {
                aura: { nam: "Empowered" },
                cmd: "aura--",
                tInf: "p:10",
              },
            ],
          }),
        );
        expect((yield* store.world.getPlayer(10))?.hasAura("Empowered")).toBe(
          false,
        );

        yield* pipeline.packet(
          extension("cb", {
            a: [
              {
                aura: {
                  isNew: true,
                  nam: "Skill Locked",
                  val: "Ravenous",
                },
                cmd: "aura+",
                tInf: "p:10",
              },
            ],
          }),
        );
        expect(
          (yield* store.world.getPlayer(10))?.getAura("Skill Locked")?.value,
        ).toBe("Ravenous");

        yield* pipeline.packet(
          extension("cb", {
            a: [
              {
                aura: {
                  msgOff: "@Ravenous can now be used again!",
                  nam: "Skill Locked",
                  val: "Ravenous",
                },
                cmd: "aura-",
                tInf: "p:10",
              },
            ],
          }),
        );
        expect(events.slice(-2)).toEqual([
          {
            type: "aura-removed",
            kind: "active",
            duration: 0,
            name: "Skill Locked",
            targetId: 10,
            targetType: "player",
          },
          {
            type: "update-message",
            message: "Ravenous can now be used again!",
            source: "aura",
          },
        ]);
        expect(
          (yield* store.world.getPlayer(10))?.getAura("Skill Locked"),
        ).toBeNull();
      }),
  );

  it.effect.each([
    { command: "cb", packet: extension },
    { command: "ct", packet: server },
  ])(
    "synchronizes existing aura stacks through $command",
    ({ command, packet }) =>
      Effect.gen(function* () {
        const { store, pipeline, events } = yield* makeWorldProjection();
        yield* TestClock.setTime(1_000_000);
        yield* enterTestArea(pipeline);
        yield* pipeline.packet(
          packet(command, {
            a: [
              ...["p:10", "m:1"].map((tInf) => ({
                cmd: "aura+",
                tInf,
                aura: {
                  nam: "Counter Attack",
                  dur: 10,
                  t: "s",
                  icon: "scroll-enrage",
                  cat: "buff",
                  val: 5,
                  isNew: true,
                },
              })),
              {
                cmd: "aura+p",
                tInf: "p:10",
                aura: { nam: "Counter Attack", dur: 0 },
              },
            ],
          }),
        );
        const player = yield* store.world.getPlayer(10);
        const monster = yield* store.world.getMonster(1);
        const playerAura = player?.getAura("Counter Attack", {
          kind: "active",
        });
        const monsterAura = monster?.getAura("Counter Attack");
        events.length = 0;

        for (let repeat = 0; repeat < 2; repeat += 1) {
          yield* pipeline.packet(
            packet(command, {
              a: ["p:10", "m:1"].map((tInf) => ({
                cmd: "aura=",
                tInf,
                auras: [
                  {
                    nam: "Counter Attack",
                    stk: "4",
                    dur: 99,
                    val: 99,
                    isNew: true,
                    msgOn: "Should not be published",
                    msgOff: "Should not be published",
                  },
                  { nam: "Unknown Aura", stk: 3 },
                ],
              })),
            }),
          );
          expect(playerAura?.toJSON()).toMatchObject({
            name: "Counter Attack",
            kind: "active",
            duration: 10,
            expiresAt: 1_010_000,
            icon: "scroll-enrage",
            category: "buff",
            value: 5,
            stack: 4,
          });
          expect(monsterAura?.stack).toBe(4);
          expect(
            player?.getAura("Counter Attack", { kind: "passive" })?.stack,
          ).toBe(1);
          expect(player?.getAura("Unknown Aura")).toBeNull();
          expect(monster?.getAura("Unknown Aura")).toBeNull();
          expect(events).toMatchObject(
            repeat === 0
              ? [
                  {
                    type: "aura-updated",
                    name: "Counter Attack",
                    stack: 4,
                    targetId: 10,
                  },
                  {
                    type: "aura-updated",
                    name: "Counter Attack",
                    stack: 4,
                    targetId: 1,
                  },
                ]
              : [],
          );
          events.length = 0;
        }

        yield* pipeline.packet(
          packet(command, {
            a: ["p:10", "m:1"].map((tInf) => ({
              cmd: "aura=",
              tInf,
              aura: { nam: "Counter Attack" },
            })),
          }),
        );
        expect(playerAura?.stack).toBe(4);
        expect(monsterAura?.stack).toBe(4);

        for (const { stk, expected } of [
          { stk: 2, expected: 2 },
          { stk: 0, expected: 1 },
          { stk: -2, expected: 1 },
          { stk: "2.9", expected: 2 },
        ]) {
          yield* pipeline.packet(
            packet(command, {
              a: ["p:10", "m:1"].map((tInf) => ({
                cmd: "aura=",
                tInf,
                aura: { nam: "Counter Attack", stk },
              })),
            }),
          );
          expect(playerAura?.stack).toBe(expected);
          expect(monsterAura?.stack).toBe(expected);
        }
        expect(events.map((event) => event.type)).toEqual([
          "aura-updated",
          "aura-updated",
          "aura-updated",
          "aura-updated",
          "aura-updated",
          "aura-updated",
        ]);
      }),
  );

  it.effect("skips malformed seed rows without discarding valid siblings", () =>
    Effect.gen(function* () {
      const { store, pipeline } = yield* makeWorldProjection();
      yield* TestClock.setTime(1_000_000);
      yield* pipeline.packet(
        extension("moveToArea", {
          areaId: 12,
          areaName: "battleon-42",
          monBranch: [],
          uoBranch: [
            {
              entID: 10,
              strUsername: "Hero",
              au: [
                null,
                ["Short", "icon"],
                [null, "icon", 8, 1, 0],
                ["Inspired", "old", 8, 1, 0],
                ["Inspired", "imr2,iihelm", 6.4, 5, 0],
                ["Untimed", null, 0, -2, 1, 900],
                ["Expired", "ice", -1, 0, 0, 900],
              ],
            },
          ],
        }),
      );
      expect(
        (yield* store.world.getMe)?.auras.map((aura) => aura.toJSON()),
      ).toMatchObject([
        {
          name: "Inspired",
          icon: "imr2,iihelm",
          stack: 5,
          duration: 6.4,
          expiresAt: 1_006_400,
        },
        {
          name: "Untimed",
          icon: "null",
          stack: 1,
          duration: 0,
          persistent: true,
        },
        { name: "Expired", stack: 1, duration: 0, persistent: false },
      ]);
      expect(
        (yield* store.world.getMe)?.getAura("Untimed")?.expiresAt,
      ).toBeUndefined();
      expect(
        (yield* store.world.getMe)?.getAura("Expired")?.expiresAt,
      ).toBeUndefined();
    }),
  );

  it.effect.each([
    {
      name: "ct",
      packet: (patch: Record<string, number>) =>
        server("ct", { m: { "1": patch } }),
    },
    {
      name: "cb",
      packet: (patch: Record<string, number>) =>
        extension("cb", { m: { "1": patch } }),
    },
    {
      name: "JSON mtls",
      packet: (patch: Record<string, number>) =>
        extension("mtls", { id: 1, o: patch }),
    },
    {
      name: "string mtls",
      packet: (patch: Record<string, number>) =>
        stringExtension("mtls", [
          "mtls",
          "",
          "1",
          Object.entries(patch)
            .map(([key, value]) => `${key}:${value}`)
            .join(","),
        ]),
    },
  ])("applies server aura lifecycle through $name", ({ packet }) =>
    Effect.gen(function* () {
      const { store, pipeline, events } = yield* makeWorldProjection();
      yield* enterTestArea(pipeline);
      yield* pipeline.packet(
        extension("cb", {
          a: [
            {
              cmd: "aura+",
              tInf: "m:1",
              aura: { nam: "Focus", stk: 5, persist: true },
            },
            { cmd: "aura+p", tInf: "m:1", aura: { nam: "Brand of Chaos" } },
          ],
        }),
      );
      expect((yield* store.world.getMonster(1))?.getAura("Focus")?.stack).toBe(
        5,
      );
      yield* pipeline.packet(packet({ intHP: 0 }));
      expect((yield* store.world.getMonster(1))?.hasAura("Focus")).toBe(true);
      yield* pipeline.packet(packet({ intState: 2 }));
      expect((yield* store.world.getMonster(1))?.hasAura("Focus")).toBe(true);
      events.length = 0;
      yield* pipeline.packet(packet({ intState: 1 }));
      expect(
        (yield* store.world.getMonster(1))?.auras.map((aura) => aura.name),
      ).toEqual(["Brand of Chaos"]);
      expect(
        events.filter((event) => event.type === "aura-removed"),
      ).toMatchObject([{ name: "Focus" }]);
      yield* pipeline.packet(
        extension("cb", {
          a: [{ cmd: "aura+", tInf: "m:1", aura: { nam: "Focus", stk: 4 } }],
        }),
      );
      expect((yield* store.world.getMonster(1))?.getAura("Focus")?.stack).toBe(
        4,
      );
      yield* pipeline.packet(packet({ intState: 1 }));
      expect((yield* store.world.getMonster(1))?.hasAura("Focus")).toBe(false);
      yield* pipeline.packet(packet({ intState: 0 }));
      yield* pipeline.packet(
        extension("cb", {
          a: [{ cmd: "aura+", tInf: "m:1", aura: { nam: "Focus", stk: 5 } }],
        }),
      );
      expect(
        (yield* store.world.getMonster(1))?.auras.map((aura) => aura.name),
      ).toEqual(["Brand of Chaos"]);
    }),
  );

  it.effect(
    "keeps synthetic monster metadata writes separate from the server gate",
    () =>
      Effect.gen(function* () {
        const { store, pipeline, events } = yield* makeWorldProjection();
        yield* TestClock.setTime(1_000_000);
        yield* pipeline.packet(
          extension("moveToArea", {
            areaId: 12,
            areaName: "battleon-42",
            uoBranch: [],
            monBranch: [
              {
                MonID: 5,
                MonMapID: 1,
                intState: 1,
                intHPMax: 100,
                au: [["Curse of Times", "inver2", 6.4, 5, 0, 8]],
              },
            ],
          }),
        );
        const monster = yield* store.world.getMonster(1);
        const aura = monster?.getAura("Curse of Times");
        expect(aura?.stack).toBe(5);
        events.length = 0;
        yield* pipeline.packet(
          extension("respawnMon", ["respawnMon", "", "1"]),
        );
        expect(monster?.hp).toBe(100);
        expect(monster?.getAura("Curse of Times")).toBe(aura);
        yield* pipeline.packet(extension("addGoldExp", { id: 1, typ: "m" }));
        expect(monster?.hp).toBe(0);
        expect(monster?.getAura("Curse of Times")).toBe(aura);
        yield* pipeline.packet(
          extension("cb", {
            a: [{ cmd: "aura+", tInf: "m:1", aura: { nam: "Focus", stk: 4 } }],
          }),
        );
        expect(monster?.getAura("Focus")?.stack).toBe(4);
        expect(events.filter((event) => event.type === "aura-removed")).toEqual(
          [],
        );
      }),
  );

  it.effect(
    "ignores unknown or invalid snapshots and clears an empty snapshot",
    () =>
      Effect.gen(function* () {
        const { store, pipeline, events } = yield* makeWorldProjection();
        yield* enterTestArea(pipeline);
        yield* pipeline.packet(
          extension("cb", {
            a: [
              {
                cmd: "aura+",
                tInf: "p:10",
                aura: { nam: "Focus", stk: 5, val: 7, cat: "buff" },
              },
            ],
          }),
        );
        const aura = (yield* store.world.getMe)?.getAura("Focus");
        expect(aura?.stack).toBe(5);
        events.length = 0;
        for (const data of [
          { unm: "Unknown", au: [["Inspired", "imr2,iihelm", 8, 1, 0, 12]] },
          { unm: "Hero" },
          { unm: "Hero", au: null },
          { unm: "Hero", au: {} },
        ]) {
          yield* pipeline.packet(extension("auSnap", data));
          expect((yield* store.world.getMe)?.getAura("Focus")).toBe(aura);
        }
        expect(yield* store.world.getPlayer("Unknown")).toBeNull();
        expect(events).toEqual([]);
        yield* pipeline.packet(
          extension("auSnap", {
            unm: "Hero",
            au: [["Focus", "inver2", 6.4, 4, 0, 8]],
          }),
        );
        expect((yield* store.world.getMe)?.getAura("Focus")).toBe(aura);
        expect(aura?.toJSON()).toMatchObject({
          stack: 4,
          value: 7,
          category: "buff",
        });
        events.length = 0;
        yield* pipeline.packet(extension("auSnap", { unm: "Hero", au: [] }));
        expect((yield* store.world.getMe)?.auras).toEqual([]);
        expect(events).toMatchObject([{ type: "aura-removed", name: "Focus" }]);
      }),
  );

  it.effect(
    "isolates malformed aura rows and rejects compound HUD targets",
    () =>
      Effect.gen(function* () {
        const { store, pipeline, events, diagnostics } =
          yield* makeItemProjection();
        yield* enterTestArea(pipeline);
        events.length = 0;
        yield* pipeline.packet(
          extension("cb", {
            a: [
              {
                cmd: "unsupported-aura",
                tInf: "p:10",
                aura: { nam: "Ignored" },
              },
              {
                cmd: "aura+",
                tInf: "p:10",
                auras: [null, { dur: 4 }, { nam: "Focus", stk: 5 }],
              },
              {
                cmd: "aura+",
                tInf: "p:10",
                auras: [],
                aura: { nam: "Suppressed" },
              },
              {
                cmd: "aura+",
                tInf: "m:1",
                auras: null,
                aura: { nam: "Inspired", stk: 4 },
              },
              {
                cmd: "aura+",
                tInf: "p:10,m:1",
                aura: { nam: "Counter Attack", msgOn: "Compound" },
              },
              {
                cmd: "aura+",
                tInf: "p:10>m:1",
                aura: { nam: "Counter Attack", msgOn: "Directed" },
              },
              { cmd: "aura+", tInf: "m:99", aura: { nam: "Unknown" } },
              { cmd: "aura-p", tInf: "p:10", aura: { nam: "Focus" } },
            ],
          }),
        );
        expect(
          (yield* store.world.getPlayer(10))?.auras.map((aura) => [
            aura.name,
            aura.stack,
          ]),
        ).toEqual([["Focus", 5]]);
        expect(
          (yield* store.world.getMonster(1))?.auras.map((aura) => [
            aura.name,
            aura.stack,
          ]),
        ).toEqual([["Inspired", 4]]);
        expect(yield* store.world.getMonster(99)).toBeNull();
        expect(events).toEqual([
          {
            type: "aura-added",
            kind: "active",
            duration: 0,
            name: "Focus",
            stack: 5,
            targetId: 10,
            targetType: "player",
          },
          {
            type: "aura-added",
            kind: "active",
            duration: 0,
            name: "Inspired",
            stack: 4,
            targetId: 1,
            targetType: "monster",
          },
        ]);
        expect(diagnostics).toEqual([
          "combat:malformed-aura-change",
          "combat:malformed-aura-payload",
          "combat:malformed-aura-payload",
          "combat:malformed-aura-change",
        ]);
      }),
  );

  it.effect(
    "derives counter notices from applied and removed aura deltas",
    () =>
      Effect.gen(function* () {
        const { store, pipeline, events } = yield* makeWorldProjection();
        yield* TestClock.setTime(1_000_000);
        yield* enterTestArea(pipeline);
        events.length = 0;
        yield* pipeline.packet(
          extension("cb", {
            a: [
              {
                cmd: "aura+",
                tInf: "m:1",
                aura: {
                  nam: "Counter Attack",
                  stk: 5,
                  t: "s",
                  dur: 6,
                  msgOn: "Counter ready",
                },
              },
            ],
          }),
        );
        expect(events).toEqual([
          {
            type: "counter-attack-start",
            monsterMapId: 1,
            source: "aura",
            triggerId: "anti-counter",
            triggerText: "Counter Attack",
            durationMs: 6000,
          },
          {
            type: "aura-added",
            kind: "active",
            duration: 6,
            name: "Counter Attack",
            stack: 5,
            targetId: 1,
            targetType: "monster",
          },
          {
            type: "update-message",
            source: "aura",
            message: "Counter ready",
            monsterMapId: 1,
          },
        ]);
        events.length = 0;
        yield* TestClock.setTime(1_002_000);
        yield* pipeline.packet(
          extension("cb", {
            a: [
              {
                cmd: "aura++",
                tInf: "m:1",
                aura: { nam: "Counter Attack", stk: 5, t: "s", dur: 6 },
              },
            ],
          }),
        );
        expect(events).toEqual([
          {
            type: "counter-attack-start",
            monsterMapId: 1,
            source: "aura",
            triggerId: "anti-counter",
            triggerText: "Counter Attack",
            durationMs: 6000,
          },
          {
            type: "aura-updated",
            kind: "active",
            duration: 6,
            name: "Counter Attack",
            stack: 5,
            targetId: 1,
            targetType: "monster",
          },
        ]);
        events.length = 0;
        yield* pipeline.packet(
          extension("cb", {
            a: [
              {
                cmd: "aura-",
                tInf: "m:1",
                aura: {
                  nam: "Counter Attack",
                  stk: 1,
                  msgOff: "Counter ended",
                },
              },
            ],
          }),
        );
        expect(
          (yield* store.world.getMonster(1))?.getAura("Counter Attack")?.stack,
        ).toBe(1);
        expect(events).toEqual([
          {
            type: "aura-updated",
            kind: "active",
            duration: 6,
            name: "Counter Attack",
            stack: 1,
            targetId: 1,
            targetType: "monster",
          },
          {
            type: "update-message",
            source: "aura",
            message: "Counter ended",
            monsterMapId: 1,
          },
        ]);
        events.length = 0;
        yield* pipeline.packet(
          extension("cb", { m: { "1": { intState: 0, intHP: 0 } } }),
        );
        expect(events).toEqual([
          { type: "monster-death", monsterMapId: 1 },
          {
            type: "counter-attack-end",
            monsterMapId: 1,
            source: "aura",
            triggerId: "anti-counter",
            triggerText: "Counter Attack",
          },
          {
            type: "aura-removed",
            kind: "active",
            duration: 6,
            name: "Counter Attack",
            targetId: 1,
            targetType: "monster",
          },
        ]);
        events.length = 0;
        for (const tInf of ["m:1", "m:99"]) {
          yield* pipeline.packet(
            extension("cb", {
              a: [
                {
                  cmd: "aura+",
                  tInf,
                  aura: { nam: "Counter Attack", t: "s", dur: 6 },
                },
                { cmd: "aura-", tInf, aura: { nam: "Counter Attack" } },
              ],
            }),
          );
        }
        expect(events).toEqual([]);
        expect((yield* store.world.getMonster(1))?.auras).toEqual([]);
        expect(yield* store.world.getMonster(99)).toBeNull();
        yield* pipeline.packet(
          extension("mtls", { id: 1, o: { intState: 2, intHP: 100 } }),
        );
        yield* pipeline.packet(
          extension("aura+", {
            cmd: "aura+",
            tInf: "m:1",
            aura: { nam: "Counter Attack", t: "s", dur: 6 },
          }),
        );
        expect(
          (yield* store.world.getMonster(1))?.hasAura("Counter Attack"),
        ).toBe(true);
        events.length = 0;
        yield* pipeline.packet(
          extension("mtls", { id: 1, o: { intState: 1 } }),
        );
        expect(events).toEqual([
          {
            type: "counter-attack-end",
            monsterMapId: 1,
            source: "aura",
            triggerId: "anti-counter",
            triggerText: "Counter Attack",
          },
          {
            type: "aura-removed",
            kind: "active",
            duration: 6,
            name: "Counter Attack",
            targetId: 1,
            targetType: "monster",
          },
        ]);
      }),
  );

  it.effect(
    "uses applied counter duration and keeps no-op aura messages command-based",
    () =>
      Effect.gen(function* () {
        const { store, pipeline, events } = yield* makeWorldProjection();
        yield* TestClock.setTime(1_000_000);
        yield* enterTestArea(pipeline);
        yield* pipeline.packet(
          extension("aura+", {
            cmd: "aura+",
            tInf: "m:1",
            aura: { nam: "Counter Attack", t: "s", dur: 12 },
          }),
        );
        events.length = 0;
        yield* TestClock.setTime(1_002_000);
        const refresh = {
          cmd: "aura+",
          tInf: "m:1",
          aura: {
            nam: "Counter Attack",
            t: "s",
            dur: 6,
            msgOn: "Counter ready",
          },
        };
        yield* pipeline.packet(extension("aura+", refresh));
        expect(events).toEqual([
          {
            type: "counter-attack-start",
            monsterMapId: 1,
            source: "aura",
            triggerId: "anti-counter",
            triggerText: "Counter Attack",
            durationMs: 6000,
          },
          {
            type: "aura-updated",
            kind: "active",
            duration: 12,
            name: "Counter Attack",
            stack: 1,
            targetId: 1,
            targetType: "monster",
          },
          {
            type: "update-message",
            source: "aura",
            message: "Counter ready",
            monsterMapId: 1,
          },
        ]);
        events.length = 0;
        yield* pipeline.packet(extension("aura+", refresh));
        expect(events).toEqual([
          {
            type: "update-message",
            source: "aura",
            message: "Counter ready",
            monsterMapId: 1,
          },
        ]);
        events.length = 0;
        yield* pipeline.packet(
          extension("aura-", {
            cmd: "aura-",
            tInf: "m:1",
            aura: { nam: "Counter Attack" },
          }),
        );
        expect(events).toEqual([
          {
            type: "counter-attack-end",
            monsterMapId: 1,
            source: "aura",
            triggerId: "anti-counter",
            triggerText: "Counter Attack",
          },
          {
            type: "aura-removed",
            kind: "active",
            duration: 12,
            name: "Counter Attack",
            targetId: 1,
            targetType: "monster",
          },
        ]);
        events.length = 0;
        yield* pipeline.packet(
          extension("aura+", {
            cmd: "aura+",
            tInf: "m:1",
            aura: { nam: "Counter Attack", dur: 6 },
          }),
        );
        expect(events).toEqual([
          {
            type: "counter-attack-start",
            monsterMapId: 1,
            source: "aura",
            triggerId: "anti-counter",
            triggerText: "Counter Attack",
          },
          {
            type: "aura-added",
            kind: "active",
            duration: 0,
            name: "Counter Attack",
            stack: 1,
            targetId: 1,
            targetType: "monster",
          },
        ]);
        expect(
          (yield* store.world.getMonster(1))?.getAura("Counter Attack")
            ?.expiresAt,
        ).toBeUndefined();
      }),
  );

  it.effect(
    "ends counter notices on seed removal and ignores passive deltas",
    () =>
      Effect.gen(function* () {
        const { store, pipeline } = yield* makeWorldProjection();
        yield* TestClock.setTime(1_000_000);
        yield* enterTestArea(pipeline);
        const target = { type: "monster", id: 1 } as const;
        const seed = yield* store.world.projectAuras(
          target,
          {
            type: "seed",
            entries: [
              {
                name: "Counter Attack",
                icon: "scroll-enrage",
                stack: 5,
                persistent: false,
                timer: { type: "timed", remainingSeconds: 6, fullSeconds: 8 },
              },
            ],
          },
          1_000_000,
        );
        expect(auraEvents(target, seed)).toEqual([
          {
            type: "aura-added",
            kind: "active",
            duration: 8,
            icon: "scroll-enrage",
            name: "Counter Attack",
            stack: 5,
            targetId: 1,
            targetType: "monster",
          },
        ]);
        const removed = yield* store.world.projectAuras(
          target,
          { type: "seed", entries: [] },
          1_002_000,
        );
        expect(auraEvents(target, removed)).toEqual([
          {
            type: "counter-attack-end",
            monsterMapId: 1,
            source: "aura",
            triggerId: "anti-counter",
            triggerText: "Counter Attack",
          },
          {
            type: "aura-removed",
            kind: "active",
            duration: 8,
            icon: "scroll-enrage",
            name: "Counter Attack",
            targetId: 1,
            targetType: "monster",
          },
        ]);
        const passive = yield* store.world.projectAuras(
          target,
          {
            type: "passives",
            mode: "replace",
            entries: [{ name: "Counter Attack", duration: 0 }],
          },
          1_002_000,
        );
        expect(auraEvents(target, passive)).toEqual([
          {
            type: "aura-added",
            kind: "passive",
            duration: 0,
            name: "Counter Attack",
            stack: 1,
            targetId: 1,
            targetType: "monster",
          },
        ]);
        const passiveRemoved = yield* store.world.projectAuras(
          target,
          { type: "passives", mode: "replace", entries: [] },
          1_002_000,
        );
        expect(auraEvents(target, passiveRemoved)).toEqual([
          {
            type: "aura-removed",
            kind: "passive",
            duration: 0,
            name: "Counter Attack",
            targetId: 1,
            targetType: "monster",
          },
        ]);
      }),
  );

  it.effect.each(["clearAuras", "auSnap"])(
    "removes player counter auras without counter notices through %s",
    (command) =>
      Effect.gen(function* () {
        const { pipeline, events } = yield* makeWorldProjection();
        yield* enterTestArea(pipeline);
        events.length = 0;
        yield* pipeline.packet(
          extension("aura+", {
            cmd: "aura+",
            tInf: "p:10",
            aura: { nam: "Counter Attack", t: "s", dur: 6 },
          }),
        );
        expect(events).toEqual([
          {
            type: "aura-added",
            kind: "active",
            duration: 6,
            name: "Counter Attack",
            stack: 1,
            targetId: 10,
            targetType: "player",
          },
        ]);
        events.length = 0;
        yield* pipeline.packet(
          extension(
            command,
            command === "auSnap" ? { unm: "Hero", au: [] } : {},
          ),
        );
        expect(events).toEqual([
          {
            type: "aura-removed",
            kind: "active",
            duration: 6,
            name: "Counter Attack",
            targetId: 10,
            targetType: "player",
          },
        ]);
      }),
  );

  it.effect(
    "keeps auras after the display expiry until a server mutation",
    () =>
      Effect.gen(function* () {
        const { store, pipeline, events } = yield* makeWorldProjection();
        yield* TestClock.setTime(1_000_000);
        yield* enterTestArea(pipeline);
        yield* pipeline.packet(
          extension("cb", {
            a: [
              {
                cmd: "aura+",
                tInf: "p:10",
                aura: { nam: "Focus", t: "s", dur: 6, stk: 5 },
              },
            ],
          }),
        );
        const aura = (yield* store.world.getMe)?.getAura("Focus");
        expect(aura?.toJSON()).toMatchObject({
          stack: 5,
          expiresAt: 1_006_000,
        });
        events.length = 0;
        yield* TestClock.setTime(2_000_000);
        expect((yield* store.world.getMe)?.getAura("Focus")).toBe(aura);
        expect(events).toEqual([]);
      }),
  );

  it.effect("clears players and monsters when entering another area", () =>
    Effect.gen(function* () {
      const { store, pipeline, userIdReads } = yield* makeWorldProjection();
      yield* enterTestArea(pipeline);
      expect((yield* store.world.getMonsters).length).toBe(1);
      expect(yield* store.world.getPlayer(10)).not.toBeNull();
      yield* pipeline.packet(
        extension("moveToArea", {
          areaId: 13,
          areaName: "yulgar-1",
          monBranch: [],
          uoBranch: [],
        }),
      );
      expect(yield* store.world.getMonsters).toEqual([]);
      expect(yield* store.world.getPlayer(10)).toBeNull();
      expect(userIdReads()).toBe(1);
    }),
  );

  it.effect("exposes player position and destination movement semantics", () =>
    Effect.gen(function* () {
      const store = yield* makeStore;
      const events: Event[] = [];
      const pipeline = makePipeline(store, {
        publishEvent: (event) =>
          Effect.sync(() => {
            events.push(event);
          }),
      });

      yield* pipeline.packet(
        extension("moveToArea", {
          areaId: 12,
          areaName: "battleon-42",
          monBranch: [],
          uoBranch: [
            {
              entID: 11,
              strFrame: "Enter",
              strPad: "Spawn",
              strUsername: "Leader",
              tx: 120,
              ty: 140,
            },
          ],
        }),
      );
      events.length = 0;

      yield* pipeline.packet(
        extension("uotls", {
          o: { px: 120, py: 140, tx: 300, ty: 240 },
          unm: "Leader",
        }),
      );
      expect(events).toEqual([
        {
          cell: "Enter",
          destination: { x: 300, y: 240 },
          entityId: 11,
          kind: "walk",
          pad: "Spawn",
          position: { x: 120, y: 140 },
          type: "player-location",
          username: "Leader",
        },
      ]);
      expect((yield* store.world.getPlayer("Leader"))?.position).toEqual({
        x: 120,
        y: 140,
      });
      events.length = 0;

      yield* pipeline.packet(
        extension("uotls", {
          o: {
            px: 40,
            py: 50,
            strFrame: "Battle",
            strPad: "Left",
            tx: 0,
            ty: 0,
          },
          unm: "Leader",
        }),
      );
      expect(events).toEqual([
        {
          cell: "Battle",
          entityId: 11,
          kind: "cell",
          pad: "Left",
          position: { x: 40, y: 50 },
          type: "player-location",
          username: "Leader",
        },
      ]);
      events.length = 0;

      yield* pipeline.packet(
        extension("uotls", {
          o: { px: 80, py: 90 },
          unm: "Leader",
        }),
      );
      expect(events).toEqual([
        {
          cell: "Battle",
          entityId: 11,
          kind: "position",
          pad: "Left",
          position: { x: 80, y: 90 },
          type: "player-location",
          username: "Leader",
        },
      ]);
      events.length = 0;

      yield* pipeline.packet(
        extension("uotls", {
          o: { strFrame: "Boss", strPad: "Right" },
          unm: "Leader",
        }),
      );
      expect(events).toEqual([
        {
          cell: "Boss",
          entityId: 11,
          kind: "cell",
          pad: "Right",
          position: { x: 80, y: 90 },
          type: "player-location",
          username: "Leader",
        },
      ]);
    }),
  );

  it.effect("emits AFK state events for local and remote players", () =>
    Effect.gen(function* () {
      const store = yield* makeStore;
      const events: Event[] = [];
      const pipeline = makePipeline(store, {
        publishEvent: (event) =>
          Effect.sync(() => {
            events.push(event);
          }),
      });

      yield* pipeline.packet(
        extension("moveToArea", {
          areaId: 12,
          areaName: "battleon-1",
          monBranch: [],
          uoBranch: [
            { entID: 10, strUsername: "Hero" },
            { entID: 11, strUsername: "Visitor" },
          ],
        }),
      );
      events.length = 0;

      yield* pipeline.packet(
        stringExtension("uotls", ["uotls", "12", "Hero", "afk:true"]),
      );
      yield* pipeline.packet(
        stringExtension("uotls", ["uotls", "12", "Visitor", "afk:true"]),
      );
      yield* pipeline.packet(
        extension("uotls", { o: { afk: false }, unm: "Visitor" }),
      );

      expect(events).toEqual([
        { afk: true, entityId: 10, type: "player-afk", username: "Hero" },
        {
          afk: true,
          entityId: 11,
          type: "player-afk",
          username: "Visitor",
        },
        {
          afk: false,
          entityId: 11,
          type: "player-afk",
          username: "Visitor",
        },
      ]);
      expect((yield* store.world.getPlayer("Hero"))?.afk).toBe(true);
      expect((yield* store.world.getPlayer("Visitor"))?.afk).toBe(false);
    }),
  );
});
