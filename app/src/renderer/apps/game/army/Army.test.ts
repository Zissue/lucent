import { afterEach, describe, expect, it, vi } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import type { ArmySessionPayload } from "@lucent/core/army";
import type { DesktopArmyBridge } from "../../../../shared/desktopBridge";
import { Api, type ApiService } from "../flash/api/Api";
import {
  ArmyApi,
  ArmyError,
  type ArmyApiRuntimeShape,
  layer as armyLayer,
} from "./Army";

afterEach(() => vi.unstubAllGlobals());

const makeSession = (
  sets: ArmySessionPayload["sets"] = {},
): ArmySessionPayload => ({
  configName: "test",
  items: {},
  playerName: "Alice",
  playerNumber: 1,
  players: ["Alice"],
  raw: { players: ["Alice"], room: "1234", sets },
  role: "leader",
  room: "1234",
  sessionId: "session-1",
  sets,
});

const makeBridge = (overrides: Partial<DesktopArmyBridge> = {}) => {
  let endedListener:
    | ((payload: {
        readonly reason: string;
        readonly sessionId: string;
      }) => void)
    | undefined;
  const bridge: DesktopArmyBridge = {
    fail: async () => undefined,
    leave: async () => undefined,
    loadConfig: async () => makeSession(),
    loopTauntAwait: async () => ({ status: "completed" }),
    loopTauntLeave: async () => undefined,
    loopTauntRegister: async () => ({ runId: "loop-1" }),
    loopTauntReport: async () => undefined,
    loopTauntReady: async () => undefined,
    onEnded: (listener) => {
      endedListener = listener;
      return () => {
        endedListener = undefined;
      };
    },
    onLoopTauntCommand: () => () => undefined,
    progress: async () => ({
      complete: true,
      completedPlayers: ["Alice"],
      pendingPlayers: [],
    }),
    start: async () => makeSession(),
    sync: async () => undefined,
    ...overrides,
  };
  return {
    bridge,
    end: (reason = "ended") =>
      endedListener?.({ reason, sessionId: "session-1" }),
  };
};

const makeApi = (overrides: Record<string, unknown> = {}): ApiService =>
  ({
    auth: { getUsername: () => Effect.succeed("Alice") },
    combat: {
      getConsumableSkillItem: () => Effect.succeed({ itemId: 1, ready: true }),
      kill: () => Effect.void,
      useSkill: () => Effect.succeed(true),
    },
    drops: {
      accept: () => Effect.void,
      contains: () => Effect.succeed(false),
    },
    inventory: {
      contains: () => Effect.succeed(true),
      equip: () => Effect.succeed(true),
      get: () => Effect.succeed({ itemId: 1, link: "potion", quantity: 1 }),
      use: () => Effect.succeed(true),
    },
    map: {
      getName: () => Effect.succeed("ultra"),
      getRoomNumber: () => Effect.succeed(1234),
    },
    player: {
      joinMap: () => Effect.succeed(true),
    },
    players: {
      getAll: () => Effect.succeed([{ username: "Alice" }]),
    },
    tempInventory: { contains: () => Effect.succeed(true) },
    wait: { until: <A>(effect: Effect.Effect<A>) => effect },
    ...overrides,
  }) as unknown as ApiService;

const withArmy = <A, E, R>(
  api: ApiService,
  bridge: DesktopArmyBridge,
  use: (army: ArmyApiRuntimeShape) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    vi.stubGlobal("window", { desktop: { army: bridge, view: "game" } });
    return yield* Effect.gen(function* () {
      const army = yield* ArmyApi;
      return yield* use(army);
    }).pipe(
      Effect.provide(armyLayer.pipe(Layer.provide(Layer.succeed(Api, api)))),
    );
  });

describe("Army API", () => {
  it.effect("rejects repeated starts and resets after a remote end event", () =>
    Effect.gen(function* () {
      const testBridge = makeBridge();
      yield* withArmy(makeApi(), testBridge.bridge, (army) =>
        Effect.gen(function* () {
          yield* army.start("test");
          const error = yield* Effect.flip(army.start("test"));
          expect(error.message).toContain("already been started");
          testBridge.end();
          yield* Effect.yieldNow;
          expect(yield* army.isStarted()).toBe(false);
        }),
      );
    }),
  );

  it.effect("rejects overlapping coordinated operations", () =>
    withArmy(makeApi(), makeBridge().bridge, (army) =>
      Effect.gen(function* () {
        yield* army.start("test");
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const first = yield* army
          .runStep(
            "first",
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
            ),
          )
          .pipe(Effect.forkScoped);
        yield* Deferred.await(started);
        const error = yield* Effect.flip(army.sync("second"));
        expect(error.message).toContain("already running");
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(first);
      }),
    ),
  );

  it.effect("interrupts coordinated work when the army session ends", () =>
    Effect.gen(function* () {
      const actionStarted = yield* Deferred.make<void>();
      const actionStopped = yield* Deferred.make<void>();
      let reports = 0;
      const testBridge = makeBridge({
        progress: () => {
          reports += 1;
          return reports === 1
            ? Promise.resolve({
                complete: false,
                completedPlayers: [],
                pendingPlayers: ["Alice", "Bob"],
              })
            : new Promise(() => undefined);
        },
      });
      const reason = "Timed out waiting for army progress 25; missing: Bob";

      yield* withArmy(
        makeApi({
          combat: {
            getConsumableSkillItem: () =>
              Effect.succeed({ itemId: 1, ready: true }),
            kill: () =>
              Deferred.succeed(actionStarted, undefined).pipe(
                Effect.andThen(Effect.never),
                Effect.ensuring(
                  Deferred.succeed(actionStopped, undefined).pipe(
                    Effect.asVoid,
                  ),
                ),
              ),
            useSkill: () => Effect.succeed(true),
          },
          tempInventory: { contains: () => Effect.succeed(false) },
        }),
        testBridge.bridge,
        (army) =>
          Effect.gen(function* () {
            yield* army.start("test");
            const work = yield* army
              .killForTempItem("Boss", {
                item: "Defeated",
                quantity: 1,
              })
              .pipe(Effect.forkScoped);
            yield* Deferred.await(actionStarted);

            testBridge.end(reason);
            yield* Deferred.await(actionStopped);

            const error = yield* Fiber.join(work).pipe(Effect.flip);
            expect(error).toBeInstanceOf(ArmyError);
            expect(error.message).toBe(reason);
            expect(yield* army.isStarted()).toBe(false);
          }),
      );
    }),
  );

  it.effect("keeps helping after the local item guard passes", () =>
    Effect.gen(function* () {
      const kills = yield* Ref.make(0);
      let progressRound = 0;
      const testBridge = makeBridge({
        progress: async () => {
          progressRound += 1;
          return progressRound === 1
            ? {
                complete: false,
                completedPlayers: ["Alice"],
                pendingPlayers: ["Bob"],
              }
            : {
                complete: true,
                completedPlayers: ["Alice", "Bob"],
                pendingPlayers: [],
              };
        },
      });
      yield* withArmy(
        makeApi({
          combat: {
            getConsumableSkillItem: () =>
              Effect.succeed({ itemId: 1, ready: true }),
            kill: () => Ref.update(kills, (count) => count + 1),
            useSkill: () => Effect.succeed(true),
          },
        }),
        testBridge.bridge,
        (army) =>
          Effect.gen(function* () {
            yield* army.start("test");
            const fiber = yield* army
              .killForItem("Boss", { item: "Drop", quantity: 1 })
              .pipe(Effect.forkScoped);
            yield* TestClock.adjust("200 millis");
            yield* Fiber.join(fiber);
          }),
      );
      expect(yield* Ref.get(kills)).toBe(1);
      expect(progressRound).toBe(2);
    }),
  );

  it.effect("reports map identity and full-roster visibility", () =>
    Effect.gen(function* () {
      let reported:
        | { readonly complete: boolean; readonly label?: string }
        | undefined;
      const bridge = makeBridge({
        progress: async (payload) => {
          reported = payload;
          return {
            complete: true,
            completedPlayers: ["Alice"],
            pendingPlayers: [],
          };
        },
      }).bridge;
      yield* withArmy(makeApi(), bridge, (army) =>
        Effect.gen(function* () {
          yield* army.start("test");
          yield* army.waitForAllInMap();
        }),
      );
      expect(reported).toMatchObject({
        complete: true,
        label: "map:ultra-1234",
      });
    }),
  );

  it.effect("preserves the pot-lock-safe equipment order", () =>
    Effect.gen(function* () {
      const equipped = yield* Ref.make<readonly string[]>([]);
      const skillUses = yield* Ref.make(0);
      let quantity = 3;
      const session = makeSession({
        boss: {
          default: {
            armor: "armor",
            cape: "cape",
            class: "class",
            helm: "helm",
            pet: "pet",
            pots: ["pot-one", "pot-two"],
            safeClass: "safe-class",
            safePot: "safe-pot",
            scroll: "scroll",
            weapon: "weapon",
          },
          players: {},
        },
      });
      const bridge = makeBridge({ start: async () => session }).bridge;
      yield* withArmy(
        makeApi({
          combat: {
            getConsumableSkillItem: () =>
              Effect.succeed({ itemId: 1, ready: true }),
            kill: () => Effect.void,
            useSkill: () =>
              Ref.update(skillUses, (count) => count + 1).pipe(
                Effect.tap(() =>
                  Effect.sync(() => {
                    quantity -= 1;
                  }),
                ),
                Effect.as(true),
              ),
          },
          inventory: {
            contains: () => Effect.succeed(true),
            equip: (item: string) =>
              Ref.update(equipped, (items) => [...items, item]).pipe(
                Effect.as(true),
              ),
            get: () =>
              Effect.sync(() => ({
                itemId: 1,
                link: "potion",
                quantity,
              })),
          },
        }),
        bridge,
        (army) =>
          Effect.gen(function* () {
            yield* army.start("test");
            const fiber = yield* army.equipSet("boss").pipe(Effect.forkScoped);
            yield* TestClock.adjust("20 seconds");
            yield* Fiber.join(fiber);
          }),
      );
      expect(yield* Ref.get(equipped)).toEqual([
        "safe-class",
        "safe-pot",
        "class",
        "safe-pot",
        "weapon",
        "cape",
        "helm",
        "armor",
        "pet",
        "pot-one",
        "pot-two",
        "scroll",
      ]);
      expect(yield* Ref.get(skillUses)).toBe(2);
      expect(quantity).toBe(1);
    }),
  );

  it.effect("uses tonics directly from inventory", () =>
    Effect.gen(function* () {
      const equipped = yield* Ref.make<readonly string[]>([]);
      const directUses = yield* Ref.make<readonly number[]>([]);
      const skillUses = yield* Ref.make(0);
      const session = makeSession({
        boss: {
          default: { pots: ["Fate Tonic"] },
          players: {},
        },
      });
      const bridge = makeBridge({ start: async () => session }).bridge;
      yield* withArmy(
        makeApi({
          combat: {
            getConsumableSkillItem: () => Effect.succeed(null),
            kill: () => Effect.void,
            useSkill: () => Ref.update(skillUses, (count) => count + 1),
          },
          inventory: {
            contains: () => Effect.succeed(true),
            equip: (item: string) =>
              Ref.update(equipped, (items) => [...items, item]).pipe(
                Effect.as(true),
              ),
            get: () =>
              Effect.succeed({
                itemId: 42,
                link: "Tonic",
                quantity: 2,
              }),
            use: (itemId: number) =>
              Ref.update(directUses, (items) => [...items, itemId]).pipe(
                Effect.as(true),
              ),
          },
        }),
        bridge,
        (army) =>
          Effect.gen(function* () {
            yield* army.start("test");
            const fiber = yield* army.equipSet("boss").pipe(Effect.forkScoped);
            yield* TestClock.adjust("2 seconds");
            yield* Fiber.join(fiber);
          }),
      );
      expect(yield* Ref.get(equipped)).toEqual([]);
      expect(yield* Ref.get(directUses)).toEqual([42]);
      expect(yield* Ref.get(skillUses)).toBe(0);
    }),
  );
});
