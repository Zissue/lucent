import { afterEach, describe, expect, it } from "@effect/vitest";
import { vi } from "vitest";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";

import type {
  ArmyConfigPayload,
  ArmySessionEndedPayload,
} from "@lucent/core/army";
import {
  makeArmyCoordinator,
  type ArmyCoordinatorShape,
} from "../../../../main/game/army/ArmyCoordinator";
import type { DesktopArmyBridge } from "../../../../shared/desktopBridge";
import { Api, type ApiService } from "../flash/api/Api";
import { ArmyApi, layer as armyLayer, type ArmyApiRuntimeShape } from "./Army";

vi.mock("effect/Deferred", async (importOriginal) => ({
  ...(await importOriginal<typeof Deferred>()),
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const config: ArmyConfigPayload = {
  configName: "sim",
  items: {},
  players: ["Alice", "Bob"],
  raw: {},
  room: "1",
  sets: {},
};

const flush = Effect.promise(
  () => new Promise<void>((resolve) => setImmediate(resolve)),
).pipe(Effect.repeat({ times: 5 }));

const advance = (ms: number) =>
  Effect.gen(function* () {
    for (let elapsed = 0; elapsed < ms; elapsed += 50) {
      yield* TestClock.adjust("50 millis");
      yield* flush;
    }
  });

const makeClientBridge = (
  coordinator: ArmyCoordinatorShape,
  participantId: number,
  run: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>,
  endedListeners: Map<number, (payload: ArmySessionEndedPayload) => void>,
): DesktopArmyBridge =>
  ({
    fail: (payload) =>
      run(coordinator.fail(payload.sessionId, participantId, payload.reason)),
    leave: () => run(coordinator.leave(participantId)),
    loadConfig: async () => config,
    loopTauntAwait: async () => ({ status: "completed" }),
    loopTauntLeave: async () => undefined,
    loopTauntRegister: async () => ({ runId: "unused" }),
    loopTauntReady: async () => undefined,
    loopTauntReport: async () => undefined,
    onEnded: (listener) => {
      endedListeners.set(participantId, listener);
      return () => endedListeners.delete(participantId);
    },
    onLoopTauntCommand: () => () => undefined,
    progress: (payload) =>
      run(coordinator.progress(payload.sessionId, participantId, payload)),
    start: (payload) =>
      run(
        coordinator.join(config, payload.playerName, {
          rendererId: participantId,
          isCurrent: () => true,
        }),
      ),
    sync: (payload) =>
      run(coordinator.sync(payload.sessionId, participantId, payload)),
  }) as DesktopArmyBridge;

interface Boss {
  readonly attackers: Set<string>;
  life: number;
  death: Deferred.Deferred<void>;
  readonly drops: Map<string, number>;
  readonly dropsByLife: ReadonlyMap<number, readonly string[]>;
  readonly requiredAttackers: number;
  readonly sees: (player: string, life: number, attempt: number) => boolean;
  readonly attempts: Map<string, number>;
}

const makeBoss = (args: {
  readonly dropsByLife: ReadonlyMap<number, readonly string[]>;
  readonly requiredAttackers: number;
  readonly sees: Boss["sees"];
}) =>
  Effect.gen(function* () {
    const boss: Boss = {
      ...args,
      attackers: new Set(),
      attempts: new Map(),
      death: yield* Deferred.make<void>(),
      drops: new Map(),
      life: 1,
    };
    return boss;
  });

const killBoss = (boss: Boss, player: string) =>
  Effect.gen(function* () {
    const attempt = (boss.attempts.get(player) ?? 0) + 1;
    boss.attempts.set(player, attempt);
    if (!boss.sees(player, boss.life, attempt)) return false;
    const death = boss.death;
    boss.attackers.add(player);
    if (boss.attackers.size >= boss.requiredAttackers) {
      for (const looter of boss.dropsByLife.get(boss.life) ?? []) {
        if (boss.attackers.has(looter)) {
          boss.drops.set(looter, (boss.drops.get(looter) ?? 0) + 1);
        }
      }
      boss.attackers.clear();
      boss.life += 1;
      boss.death = yield* Deferred.make<void>();
      yield* Deferred.succeed(death, undefined);
    }
    yield* Deferred.await(death).pipe(
      Effect.onInterrupt(() =>
        Effect.sync(() => boss.attackers.delete(player)),
      ),
    );
    return true;
  });

const makeClientApi = (
  player: string,
  combatKill: () => Effect.Effect<unknown>,
  boss: Boss | undefined,
): ApiService =>
  ({
    auth: { getUsername: () => Effect.succeed(player) },
    combat: { kill: () => combatKill() },
    drops: {
      accept: () => Effect.void,
      contains: () => Effect.succeed(false),
    },
    inventory: {
      contains: () => Effect.sync(() => (boss?.drops.get(player) ?? 0) >= 1),
    },
    map: {
      getName: () => Effect.succeed("boss"),
      getRoomNumber: () => Effect.succeed(1),
    },
    players: {
      getAll: () =>
        Effect.succeed([{ username: "Alice" }, { username: "Bob" }]),
    },
    tempInventory: { contains: () => Effect.succeed(false) },
    wait: { until: <A>(effect: Effect.Effect<A>) => effect },
  }) as unknown as ApiService;

const makeArmy = (
  coordinator: ArmyCoordinatorShape,
  participantId: number,
  api: ApiService,
  endedListeners: Map<number, (payload: ArmySessionEndedPayload) => void>,
  scope: Scope.Scope,
  wrapBridge: (
    bridge: DesktopArmyBridge,
    participantId: number,
  ) => DesktopArmyBridge,
) =>
  Effect.gen(function* () {
    const services = yield* Effect.context<never>();
    const run = <A, E>(effect: Effect.Effect<A, E>) =>
      Effect.runPromiseWith(services)(effect);
    vi.stubGlobal("window", {
      desktop: {
        army: wrapBridge(
          makeClientBridge(coordinator, participantId, run, endedListeners),
          participantId,
        ),
        view: "game",
      },
    });
    const context = yield* Layer.buildWithScope(
      armyLayer.pipe(Layer.provide(Layer.succeed(Api, api))),
      scope,
    );
    return context.mapUnsafe.get(ArmyApi.key) as ArmyApiRuntimeShape;
  });

const makeArmies = (apis: {
  readonly alice: ApiService;
  readonly bob: ApiService;
  readonly wrapBridge?: (
    bridge: DesktopArmyBridge,
    participantId: number,
  ) => DesktopArmyBridge;
}) =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const coordinator = yield* makeArmyCoordinator();
    const endedListeners = new Map<
      number,
      (payload: ArmySessionEndedPayload) => void
    >();
    const ended: Array<{
      readonly participantIds: readonly number[];
      readonly reason: string;
    }> = [];
    yield* coordinator.onSessionEnded((event) =>
      Effect.sync(() => {
        ended.push(event);
        for (const id of event.participantIds) {
          endedListeners.get(id)?.({
            reason: event.reason,
            sessionId: event.sessionId,
          });
        }
      }),
    );
    const alice = yield* makeArmy(
      coordinator,
      1,
      apis.alice,
      endedListeners,
      scope,
      apis.wrapBridge ?? ((bridge) => bridge),
    );
    const bob = yield* makeArmy(
      coordinator,
      2,
      apis.bob,
      endedListeners,
      scope,
      apis.wrapBridge ?? ((bridge) => bridge),
    );
    return { alice, bob, coordinator, ended };
  });

const makeArmyPair = (apis: {
  readonly alice: ApiService;
  readonly bob: ApiService;
  readonly wrapBridge?: (
    bridge: DesktopArmyBridge,
    participantId: number,
  ) => DesktopArmyBridge;
}) =>
  Effect.gen(function* () {
    const { alice, bob, coordinator, ended } = yield* makeArmies(apis);
    const aliceStart = yield* Effect.forkChild(alice.start("sim"));
    const bobStart = yield* Effect.forkChild(bob.start("sim"));
    yield* advance(100);
    yield* Fiber.join(aliceStart);
    yield* Fiber.join(bobStart);
    return { alice, bob, coordinator, ended };
  });

describe("army simulation", () => {
  it.effect(
    "keeps helping a peer whose kill outlives the local kill (cooperative boss)",
    () =>
      Effect.gen(function* () {
        const boss = yield* makeBoss({
          dropsByLife: new Map([
            [1, ["Alice"]],
            [2, ["Alice", "Bob"]],
          ]),
          requiredAttackers: 2,
          sees: (player, life, attempt) =>
            !(player === "Alice" && life === 2 && attempt === 2),
        });
        const { alice, bob, ended } = yield* makeArmyPair({
          alice: makeClientApi("Alice", () => killBoss(boss, "Alice"), boss),
          bob: makeClientApi("Bob", () => killBoss(boss, "Bob"), boss),
        });
        const target = { item: "Trophy", quantity: 1 };
        const aliceFarm = yield* Effect.forkChild(
          alice.killForItem("Boss", target),
        );
        const bobFarm = yield* Effect.forkChild(
          bob.killForItem("Boss", target),
        );
        yield* advance(60_000);

        const aliceExit = aliceFarm.pollUnsafe();
        const bobExit = bobFarm.pollUnsafe();
        expect(boss.drops.get("Bob") ?? 0, "Bob farmed the trophy").toBe(1);
        expect(aliceExit !== undefined && Exit.isSuccess(aliceExit)).toBe(true);
        expect(bobExit !== undefined && Exit.isSuccess(bobExit)).toBe(true);
        expect(ended).toEqual([]);
      }),
  );

  it.effect(
    "releases a peer stuck in its own action when a checkpoint times out",
    () =>
      Effect.gen(function* () {
        const pair = yield* makeArmyPair({
          alice: makeClientApi("Alice", () => Effect.void, undefined),
          bob: makeClientApi("Bob", () => Effect.void, undefined),
        });
        const { alice, bob, ended } = pair;
        const aliceSync = yield* Effect.forkChild(
          alice.sync("x", { timeout: "5 seconds" }),
        );
        const bobStep = yield* Effect.forkChild(
          bob.runStep("x", Effect.never, { timeout: "5 seconds" }),
        );
        yield* advance(10_000);

        expect(yield* pair.coordinator.getSessions()).toEqual([]);
        const aliceExit = aliceSync.pollUnsafe();
        const bobExit = bobStep.pollUnsafe();
        expect(aliceExit !== undefined && Exit.isFailure(aliceExit)).toBe(true);
        expect(ended.length, "session-ended broadcast").toBe(1);
        expect(
          bobExit !== undefined && Exit.isFailure(bobExit),
          "Bob released",
        ).toBe(true);
        expect(yield* bob.isStarted()).toBe(false);
      }),
  );

  it.effect("does not attack when every account already has the item", () =>
    Effect.gen(function* () {
      const boss = yield* makeBoss({
        dropsByLife: new Map(),
        requiredAttackers: 2,
        sees: () => true,
      });
      boss.drops.set("Alice", 1).set("Bob", 1);
      let kills = 0;
      const countKill = () => Effect.sync(() => (kills += 1));
      const { alice, bob, ended } = yield* makeArmyPair({
        alice: makeClientApi("Alice", countKill, boss),
        bob: makeClientApi("Bob", countKill, boss),
      });
      const target = { item: "Trophy", quantity: 1 };
      const aliceFarm = yield* Effect.forkChild(
        alice.killForItem("Boss", target),
      );
      const bobFarm = yield* Effect.forkChild(bob.killForItem("Boss", target));
      yield* advance(1_000);

      const aliceExit = aliceFarm.pollUnsafe();
      const bobExit = bobFarm.pollUnsafe();
      expect(aliceExit !== undefined && Exit.isSuccess(aliceExit)).toBe(true);
      expect(bobExit !== undefined && Exit.isSuccess(bobExit)).toBe(true);
      expect(kills).toBe(0);
      expect(ended).toEqual([]);
    }),
  );

  it.effect("fails every account when one account's step fails", () =>
    Effect.gen(function* () {
      const { alice, bob, ended } = yield* makeArmyPair({
        alice: makeClientApi("Alice", () => Effect.void, undefined),
        bob: makeClientApi("Bob", () => Effect.void, undefined),
      });
      const bobSync = yield* Effect.forkChild(Effect.flip(bob.sync("loot")));
      yield* advance(100);
      const aliceStep = yield* Effect.forkChild(
        Effect.flip(alice.runStep("loot", Effect.fail(new Error("Bag full")))),
      );
      yield* advance(100);

      expect((yield* Fiber.join(aliceStep)).message).toBe("Bag full");
      expect((yield* Fiber.join(bobSync)).message).toBe(
        "Army failed for Alice: Bag full",
      );
      expect(ended).toEqual([
        expect.objectContaining({
          participantIds: [1, 2],
          reason: "Army failed for Alice: Bag full",
        }),
      ]);
      expect([yield* alice.isStarted(), yield* bob.isStarted()]).toEqual([
        false,
        false,
      ]);
    }),
  );

  it.effect(
    "releases a peer stuck in its own action when an account leaves",
    () =>
      Effect.gen(function* () {
        const { alice, bob } = yield* makeArmyPair({
          alice: makeClientApi("Alice", () => Effect.void, undefined),
          bob: makeClientApi("Bob", () => Effect.void, undefined),
        });
        const bobStep = yield* Effect.forkChild(
          Effect.flip(bob.runStep("x", Effect.never)),
        );
        yield* advance(100);
        yield* alice.leave();
        yield* advance(100);

        expect((yield* Fiber.join(bobStep)).message).toBe(
          "Army player left: Alice",
        );
        expect(yield* bob.isStarted()).toBe(false);
      }),
  );

  it.effect("releases every account when a peer's renderer goes away", () =>
    Effect.gen(function* () {
      const { alice, bob, coordinator } = yield* makeArmyPair({
        alice: makeClientApi("Alice", () => Effect.void, undefined),
        bob: makeClientApi("Bob", () => Effect.void, undefined),
      });
      const aliceSync = yield* Effect.forkChild(Effect.flip(alice.sync("x")));
      yield* advance(100);
      yield* coordinator.abortParticipant(2, {
        kind: "participant-unavailable",
        reason: "Army window closed",
      });
      yield* advance(100);

      expect((yield* Fiber.join(aliceSync)).message).toBe("Army window closed");
      expect([yield* alice.isStarted(), yield* bob.isStarted()]).toEqual([
        false,
        false,
      ]);
    }),
  );

  it.effect("leaves the roster when a start is stopped while collecting", () =>
    Effect.gen(function* () {
      const { alice, coordinator, ended } = yield* makeArmies({
        alice: makeClientApi("Alice", () => Effect.void, undefined),
        bob: makeClientApi("Bob", () => Effect.void, undefined),
      });
      const aliceStart = yield* Effect.forkChild(alice.start("sim"));
      yield* advance(100);
      yield* Fiber.interrupt(aliceStart);
      yield* advance(100);

      expect(yield* coordinator.getSessions()).toEqual([]);
      expect(ended).toEqual([
        expect.objectContaining({
          participantIds: [1],
          reason: "Army player left: Alice",
        }),
      ]);
    }),
  );

  it.effect("fails a start whose roster never arrives", () =>
    Effect.gen(function* () {
      const { alice } = yield* makeArmies({
        alice: makeClientApi("Alice", () => Effect.void, undefined),
        bob: makeClientApi("Bob", () => Effect.void, undefined),
      });
      const aliceStart = yield* Effect.forkChild(
        Effect.flip(alice.start("sim")),
      );
      yield* advance(100);
      yield* TestClock.adjust("120 seconds");
      yield* flush;

      expect((yield* Fiber.join(aliceStart)).message).toBe(
        "Timed out waiting for army players; missing: Bob",
      );
      expect(yield* alice.isStarted()).toBe(false);
    }),
  );
});

const plain = (player: string) =>
  makeClientApi(player, () => Effect.void, undefined);

describe("army session lifecycle", () => {
  it.effect(
    "start timeout ends the session once and fails the waiting player",
    () =>
      Effect.gen(function* () {
        const coordinator = yield* makeArmyCoordinator();
        const ended: Array<unknown> = [];
        yield* coordinator.onSessionEnded((event) =>
          Effect.sync(() => ended.push(event)),
        );
        const alice = yield* Effect.forkChild(
          coordinator.join(config, "Alice", {
            rendererId: 1,
            isCurrent: () => true,
          }),
        );
        yield* advance(121_000);
        const exit = alice.pollUnsafe();
        expect(exit !== undefined && Exit.isFailure(exit)).toBe(true);
        expect(ended.length).toBe(1);
        expect(yield* coordinator.getSessions()).toEqual([]);
      }),
  );

  it.effect(
    "label mismatch fails both players with a message naming the step",
    () =>
      Effect.gen(function* () {
        const { alice, bob, ended } = yield* makeArmyPair({
          alice: plain("Alice"),
          bob: plain("Bob"),
        });
        const a = yield* Effect.forkChild(Effect.flip(alice.sync("first")));
        const b = yield* Effect.forkChild(Effect.flip(bob.sync("second")));
        yield* advance(1_000);
        const aliceError = a.pollUnsafe();
        const bobError = b.pollUnsafe();
        expect(aliceError !== undefined && Exit.isSuccess(aliceError)).toBe(
          true,
        );
        expect(bobError !== undefined && Exit.isSuccess(bobError)).toBe(true);
        const messages = [aliceError, bobError].map((exit) =>
          exit !== undefined && Exit.isSuccess(exit)
            ? String((exit.value as Error).message) +
              String(
                ((exit.value as Error).cause as Error | undefined)?.message ??
                  "",
              )
            : "",
        );
        expect(messages.some((message) => /first|second/.test(message))).toBe(
          true,
        );
        expect(ended.length).toBe(1);
        expect(yield* alice.isStarted()).toBe(false);
        expect(yield* bob.isStarted()).toBe(false);
      }),
  );

  it.effect(
    "a peer leaving mid-farm releases the farming player promptly",
    () =>
      Effect.gen(function* () {
        const { alice, bob, ended } = yield* makeArmyPair({
          alice: makeClientApi("Alice", () => Effect.never, undefined),
          bob: plain("Bob"),
        });
        const farm = yield* Effect.forkChild(
          alice.killForItem("Boss", { item: "Trophy", quantity: 1 }),
        );
        yield* advance(1_000);
        yield* bob.leave();
        yield* advance(1_000);
        const exit = farm.pollUnsafe();
        expect(exit !== undefined && Exit.isFailure(exit)).toBe(true);
        expect(ended.length).toBe(1);
        expect(yield* alice.isStarted()).toBe(false);
      }),
  );

  it.effect(
    "losing a renderer releases the other player stuck in an action",
    () =>
      Effect.gen(function* () {
        const { alice, coordinator, ended } = yield* makeArmyPair({
          alice: makeClientApi("Alice", () => Effect.never, undefined),
          bob: plain("Bob"),
        });
        const farm = yield* Effect.forkChild(
          alice.killForItem("Boss", { item: "Trophy", quantity: 1 }),
        );
        yield* advance(1_000);
        yield* coordinator.abortParticipant(2, {
          kind: "participant-unavailable",
          reason: "Army window closed",
        });
        yield* advance(1_000);
        const exit = farm.pollUnsafe();
        expect(exit !== undefined && Exit.isFailure(exit)).toBe(true);
        expect(ended.length).toBe(1);
      }),
  );

  it.effect(
    "farming players who already hold the item return without killing",
    () =>
      Effect.gen(function* () {
        let kills = 0;
        const owned = (player: string) =>
          ({
            ...(plain(player) as unknown as Record<string, unknown>),
            combat: {
              kill: () =>
                Effect.sync(() => {
                  kills += 1;
                }),
            },
            inventory: { contains: () => Effect.succeed(true) },
          }) as unknown as ApiService;
        const { alice, bob, ended } = yield* makeArmyPair({
          alice: owned("Alice"),
          bob: owned("Bob"),
        });
        const a = yield* Effect.forkChild(
          alice.killForItem("Boss", { item: "Trophy", quantity: 1 }),
        );
        const b = yield* Effect.forkChild(
          bob.killForItem("Boss", { item: "Trophy", quantity: 1 }),
        );
        yield* advance(2_000);
        const aliceExit = a.pollUnsafe();
        const bobExit = b.pollUnsafe();
        expect(aliceExit !== undefined && Exit.isSuccess(aliceExit)).toBe(true);
        expect(bobExit !== undefined && Exit.isSuccess(bobExit)).toBe(true);
        expect(kills).toBe(0);
        expect(ended).toEqual([]);
      }),
  );

  it.effect(
    "the first player to finish keeps killing until the last one finishes",
    () =>
      Effect.gen(function* () {
        const kills = new Map<string, number>();
        const have = new Map<string, boolean>([
          ["Alice", true],
          ["Bob", false],
        ]);
        const farmer = (player: string) =>
          ({
            ...(plain(player) as unknown as Record<string, unknown>),
            combat: {
              kill: () =>
                Effect.sleep("1 second").pipe(
                  Effect.andThen(
                    Effect.sync(() => {
                      const count = (kills.get(player) ?? 0) + 1;
                      kills.set(player, count);
                      if (player === "Bob" && count >= 5) have.set("Bob", true);
                    }),
                  ),
                ),
            },
            inventory: {
              contains: () => Effect.sync(() => have.get(player) === true),
            },
          }) as unknown as ApiService;
        const { alice, bob, ended } = yield* makeArmyPair({
          alice: farmer("Alice"),
          bob: farmer("Bob"),
        });
        const a = yield* Effect.forkChild(
          alice.killForItem("Boss", { item: "Trophy", quantity: 1 }),
        );
        const b = yield* Effect.forkChild(
          bob.killForItem("Boss", { item: "Trophy", quantity: 1 }),
        );
        yield* advance(15_000);
        const aliceExit = a.pollUnsafe();
        const bobExit = b.pollUnsafe();
        expect(aliceExit !== undefined && Exit.isSuccess(aliceExit)).toBe(true);
        expect(bobExit !== undefined && Exit.isSuccess(bobExit)).toBe(true);
        expect(kills.get("Alice") ?? 0).toBeGreaterThanOrEqual(4);
        expect(ended).toEqual([]);
      }),
  );

  it.effect(
    "a session that timed out can be restarted from step zero in the same windows",
    () =>
      Effect.gen(function* () {
        const { alice, bob, ended } = yield* makeArmyPair({
          alice: plain("Alice"),
          bob: plain("Bob"),
        });
        const stuck = yield* Effect.forkChild(
          Effect.exit(alice.sync("x", { timeout: "1 second" })),
        );
        yield* advance(3_000);
        expect(stuck.pollUnsafe()).toBeDefined();
        expect(ended.length).toBe(1);
        const a = yield* Effect.forkChild(alice.start("sim"));
        const b = yield* Effect.forkChild(bob.start("sim"));
        yield* advance(500);
        yield* Fiber.join(a);
        yield* Fiber.join(b);
        const s1 = yield* Effect.forkChild(alice.sync("again"));
        const s2 = yield* Effect.forkChild(bob.sync("again"));
        yield* advance(500);
        const e1 = s1.pollUnsafe();
        const e2 = s2.pollUnsafe();
        expect(e1 !== undefined && Exit.isSuccess(e1)).toBe(true);
        expect(e2 !== undefined && Exit.isSuccess(e2)).toBe(true);
      }),
  );

  it.effect("overlapping coordinated operations are still rejected", () =>
    Effect.gen(function* () {
      const { alice } = yield* makeArmyPair({
        alice: plain("Alice"),
        bob: plain("Bob"),
      });
      yield* Effect.forkChild(alice.sync("held"));
      yield* advance(100);
      const error = yield* Effect.flip(alice.sync("other"));
      expect(error.message).toContain(
        "Another coordinated army operation is already running",
      );
    }),
  );
});

describe("army kill-for duration", () => {
  it.effect(
    "a farm where one account finishes 15 minutes after the other still completes",
    () =>
      Effect.gen(function* () {
        const have = new Map<string, boolean>([
          ["Alice", true],
          ["Bob", false],
        ]);
        let bobKills = 0;
        const farmer = (player: string) =>
          ({
            ...(plain(player) as unknown as Record<string, unknown>),
            combat: {
              kill: () =>
                Effect.sleep("10 seconds").pipe(
                  Effect.andThen(
                    Effect.sync(() => {
                      if (player !== "Bob") return;
                      bobKills += 1;
                      if (bobKills >= 90) have.set("Bob", true);
                    }),
                  ),
                ),
            },
            inventory: {
              contains: () => Effect.sync(() => have.get(player) === true),
            },
          }) as unknown as ApiService;
        const { alice, bob, ended } = yield* makeArmyPair({
          alice: farmer("Alice"),
          bob: farmer("Bob"),
        });
        const a = yield* Effect.forkChild(
          alice.killForItem("Boss", { item: "Trophy", quantity: 1 }),
        );
        const b = yield* Effect.forkChild(
          bob.killForItem("Boss", { item: "Trophy", quantity: 1 }),
        );
        for (
          let i = 0;
          i < 20 &&
          (a.pollUnsafe() === undefined || b.pollUnsafe() === undefined);
          i++
        ) {
          yield* TestClock.adjust("60 seconds");
          yield* advance(500);
        }
        const aliceExit = a.pollUnsafe();
        const bobExit = b.pollUnsafe();
        expect(aliceExit !== undefined && Exit.isSuccess(aliceExit)).toBe(true);
        expect(bobExit !== undefined && Exit.isSuccess(bobExit)).toBe(true);
        expect(ended).toEqual([]);
      }),
  );
});

describe("army joinMap", () => {
  const viewer = (player: string, seesAllAfterMs: number) => {
    let start: number | undefined;
    return {
      ...(makeClientApi(
        player,
        () => Effect.void,
        undefined,
      ) as unknown as Record<string, unknown>),
      player: { joinMap: () => Effect.succeed(true) },
      players: {
        getAll: () =>
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis;
            start ??= now;
            return now - start >= seesAllAfterMs
              ? [{ username: "Alice" }, { username: "Bob" }]
              : [{ username: player }];
          }),
      },
    } as unknown as ApiService;
  };

  it.effect(
    "joinMap completes when one account sees the roster two seconds late",
    () =>
      Effect.gen(function* () {
        const { alice, bob, ended } = yield* makeArmyPair({
          alice: viewer("Alice", 0),
          bob: viewer("Bob", 2_000),
        });
        const a = yield* Effect.forkChild(alice.joinMap("boss"));
        const b = yield* Effect.forkChild(bob.joinMap("boss"));
        yield* advance(5_000);
        const aliceExit = a.pollUnsafe();
        const bobExit = b.pollUnsafe();
        expect(aliceExit !== undefined && Exit.isSuccess(aliceExit)).toBe(true);
        expect(bobExit !== undefined && Exit.isSuccess(bobExit)).toBe(true);
        expect(ended).toEqual([]);
      }),
  );

  it.effect(
    "joinMap fails everyone within about 30 seconds when one account never sees the roster",
    () =>
      Effect.gen(function* () {
        const { alice, bob, ended } = yield* makeArmyPair({
          alice: viewer("Alice", 0),
          bob: viewer("Bob", 10_000_000),
        });
        const a = yield* Effect.forkChild(Effect.flip(alice.joinMap("boss")));
        const b = yield* Effect.forkChild(Effect.flip(bob.joinMap("boss")));
        yield* advance(35_000);
        const aliceExit = a.pollUnsafe();
        const bobExit = b.pollUnsafe();
        expect(aliceExit !== undefined && Exit.isSuccess(aliceExit)).toBe(true);
        expect(bobExit !== undefined && Exit.isSuccess(bobExit)).toBe(true);
        expect(ended.length).toBe(1);
      }),
  );
});

describe("latest army readiness", () => {
  for (const operation of [
    "joinMap",
    "killForItem",
    "killForTempItem",
  ] as const) {
    it.effect(
      `${operation} retracts readiness until both accounts are ready together`,
      () =>
        Effect.gen(function* () {
          const ready = new Map([
            ["Alice", true],
            ["Bob", false],
          ]);
          const reports: Array<{ participantId: number; complete: boolean }> =
            [];
          const client = (name: string) =>
            ({
              ...plain(name),
              player: { joinMap: () => Effect.succeed(true) },
              players: {
                getAll: () =>
                  Effect.sync(() =>
                    (ready.get(name) ? ["Alice", "Bob"] : [name]).map(
                      (username) => ({ username }),
                    ),
                  ),
              },
              inventory: {
                contains: () => Effect.sync(() => ready.get(name) === true),
              },
              tempInventory: {
                contains: () => Effect.sync(() => ready.get(name) === true),
              },
            }) as unknown as ApiService;
          const { alice, bob, ended } = yield* makeArmyPair({
            alice: client("Alice"),
            bob: client("Bob"),
            wrapBridge: (bridge, participantId) => ({
              ...bridge,
              progress: (payload) => {
                reports.push({ participantId, complete: payload.complete });
                return bridge.progress(payload);
              },
            }),
          });
          const run = (army: ArmyApiRuntimeShape) =>
            operation === "joinMap"
              ? army.joinMap("boss")
              : army[operation]("Boss", { item: "Trophy", quantity: 1 });
          const a = yield* Effect.forkChild(run(alice));
          const b = yield* Effect.forkChild(run(bob));
          yield* advance(500);
          ready.set("Alice", false);
          yield* advance(500);
          ready.set("Bob", true);
          yield* advance(500);
          expect([a.pollUnsafe(), b.pollUnsafe()]).toEqual([
            undefined,
            undefined,
          ]);
          const stableReports = reports.length;
          yield* advance(1_000);
          expect(reports.length).toBe(stableReports);
          ready.set("Alice", true);
          yield* advance(500);
          expect(a.pollUnsafe()).toMatchObject({ _tag: "Success" });
          expect(b.pollUnsafe()).toMatchObject({ _tag: "Success" });
          expect(
            reports
              .filter((report) => report.participantId === 1)
              .map((report) => report.complete),
          ).toEqual([true, true, false, true]);
          expect(ended).toEqual([]);
        }),
    );
  }

  for (const changed of ["map", "room"] as const) {
    it.effect(`reports a changed ${changed} identity during a map wait`, () =>
      Effect.gen(function* () {
        let mapName = "boss";
        let roomNumber = 1;
        const aliceApi = {
          ...plain("Alice"),
          player: { joinMap: () => Effect.succeed(true) },
          map: {
            getName: () => Effect.sync(() => mapName),
            getRoomNumber: () => Effect.sync(() => roomNumber),
          },
        } as unknown as ApiService;
        const bobApi = {
          ...plain("Bob"),
          player: { joinMap: () => Effect.succeed(true) },
          players: { getAll: () => Effect.succeed([{ username: "Bob" }]) },
        } as unknown as ApiService;
        const { alice, bob, ended } = yield* makeArmyPair({
          alice: aliceApi,
          bob: bobApi,
        });
        const a = yield* Effect.forkChild(Effect.flip(alice.joinMap("boss")));
        const b = yield* Effect.forkChild(Effect.flip(bob.joinMap("boss")));
        yield* advance(500);
        if (changed === "map") mapName = "other";
        else roomNumber = 2;
        yield* advance(500);
        expect(a.pollUnsafe()).toMatchObject({
          _tag: "Success",
          value: {
            message: expect.stringContaining("Army step mismatch for step 1"),
          },
        });
        expect(b.pollUnsafe()).toMatchObject({
          _tag: "Success",
          value: {
            message: expect.stringContaining("Army step mismatch for step 1"),
          },
        });
        expect(ended).toHaveLength(1);
      }),
    );
  }
});

describe("army local end interruption", () => {
  it.effect(
    "releases actions when ending is interrupted after clearing local state",
    () =>
      Effect.gen(function* () {
        const { alice, bob, coordinator, ended } = yield* makeArmyPair({
          alice: plain("Alice"),
          bob: plain("Bob"),
        });
        const a = yield* Effect.forkChild(alice.runStep("held", Effect.never));
        const b = yield* Effect.forkChild(bob.runStep("held", Effect.never));
        yield* flush;
        let interruptions = 0;
        const fail = Deferred.fail;
        vi.spyOn(Deferred, "fail").mockImplementation(((
          waiter: Deferred.Deferred<unknown, unknown>,
          error: unknown,
        ) =>
          Effect.withFiber((fiber) => {
            if (
              error instanceof Error &&
              error.name === "ArmyError" &&
              error.message === "Window closed"
            ) {
              interruptions += 1;
              fiber.interruptUnsafe();
            }
            return fail(waiter, error);
          })) as typeof Deferred.fail);
        yield* coordinator.abortParticipant(1, {
          kind: "participant-unavailable",
          reason: "Window closed",
        });
        yield* flush;
        expect(interruptions).toBe(2);
        expect([yield* alice.isStarted(), yield* bob.isStarted()]).toEqual([
          false,
          false,
        ]);
        expect(a.pollUnsafe()).toMatchObject({ _tag: "Failure" });
        expect(b.pollUnsafe()).toMatchObject({ _tag: "Failure" });
        expect(ended).toEqual([
          expect.objectContaining({ reason: "Window closed" }),
        ]);
      }),
  );
});

describe("army startup ordering", () => {
  it.effect(
    "rejects an ended session before a delayed start reply can resurrect it",
    () =>
      Effect.gen(function* () {
        let releaseReply: (() => void) | undefined;
        const delayed = new Promise<void>((resolve) => {
          releaseReply = resolve;
        });
        const { alice, bob, coordinator, ended } = yield* makeArmies({
          alice: plain("Alice"),
          bob: plain("Bob"),
          wrapBridge: (bridge, id) =>
            id === 1
              ? {
                  ...bridge,
                  start: async (payload) => {
                    const session = await bridge.start(payload);
                    await delayed;
                    return session;
                  },
                }
              : bridge,
        });
        const a = yield* Effect.forkChild(Effect.exit(alice.start("sim")));
        const b = yield* Effect.forkChild(bob.start("sim"));
        yield* advance(100);
        yield* Fiber.join(b);
        yield* coordinator.abortParticipant(2, {
          kind: "participant-unavailable",
          reason: "Bob disconnected",
        });
        yield* flush;
        releaseReply!();
        yield* flush;
        const action = yield* Effect.forkChild(
          Effect.flip(alice.runStep("held", Effect.never)),
        );
        yield* flush;
        expect(action.pollUnsafe()).toMatchObject({
          _tag: "Success",
          value: { message: "Army has not been started" },
        });
        const startExit = yield* Fiber.join(a);
        expect(startExit).toMatchObject({ _tag: "Failure" });
        if (Exit.isFailure(startExit))
          expect(Cause.squash(startExit.cause)).toMatchObject({
            message: "Bob disconnected",
          });
        expect([yield* alice.isStarted(), yield* bob.isStarted()]).toEqual([
          false,
          false,
        ]);
        expect(ended).toHaveLength(1);
        const restartA = yield* Effect.forkChild(alice.start("sim"));
        const restartB = yield* Effect.forkChild(bob.start("sim"));
        yield* advance(100);
        expect((yield* Fiber.join(restartA)).sessionId).toBe(
          (yield* Fiber.join(restartB)).sessionId,
        );
        expect([yield* alice.isStarted(), yield* bob.isStarted()]).toEqual([
          true,
          true,
        ]);
      }),
  );
});

describe("army leave during startup", () => {
  it.effect("leaves main membership while start is still collecting", () =>
    Effect.gen(function* () {
      const { alice, coordinator, ended } = yield* makeArmies({
        alice: plain("Alice"),
        bob: plain("Bob"),
      });
      const start = yield* Effect.forkChild(Effect.flip(alice.start("sim")));
      yield* advance(100);
      expect(
        (yield* coordinator.getSessions()).map((session) => [
          ...session.participants.values(),
        ]),
      ).toEqual([[1]]);
      yield* alice.leave();
      yield* flush;
      expect(yield* coordinator.getSessions()).toEqual([]);
      expect(start.pollUnsafe()).toMatchObject({
        _tag: "Success",
        value: { message: "Army player left: Alice" },
      });
      expect(ended).toEqual([
        expect.objectContaining({
          participantIds: [1],
          reason: "Army player left: Alice",
        }),
      ]);
      yield* alice.leave();
      expect(ended).toHaveLength(1);
    }),
  );
});

describe("army failure IPC", () => {
  it.effect(
    "returns the action failure without waiting for fail IPC and sends fail before leave",
    () =>
      Effect.gen(function* () {
        const sent: string[] = [];
        const { alice, bob, ended } = yield* makeArmyPair({
          alice: plain("Alice"),
          bob: plain("Bob"),
          wrapBridge: (bridge, id) =>
            id === 1
              ? {
                  ...bridge,
                  fail: async (payload) => {
                    sent.push("fail");
                    await bridge.fail(payload);
                    await new Promise<void>(() => {});
                  },
                  leave: () => {
                    sent.push("leave");
                    return bridge.leave();
                  },
                }
              : bridge,
        });
        const peer = yield* Effect.forkChild(
          Effect.flip(bob.runStep("held", Effect.never)),
        );
        const failing = yield* Effect.forkChild(
          Effect.flip(
            alice.runStep("held", Effect.fail(new Error("Bag full"))),
          ),
        );
        yield* flush;
        expect(failing.pollUnsafe()).toMatchObject({
          _tag: "Success",
          value: { message: "Bag full" },
        });
        expect(peer.pollUnsafe()).toMatchObject({
          _tag: "Success",
          value: { message: "Army failed for Alice: Bag full" },
        });
        expect([yield* alice.isStarted(), yield* bob.isStarted()]).toEqual([
          false,
          false,
        ]);
        yield* alice.leave();
        expect(sent).toEqual(["fail", "leave"]);
        expect(ended).toHaveLength(1);
      }),
  );
});

describe("army readiness before the first snapshot", () => {
  for (const changed of ["readiness", "map"] as const) {
    it.effect(
      `reports changed ${changed} while a peer has not reported yet`,
      () =>
        Effect.gen(function* () {
          const bobJoined = yield* Deferred.make<void>();
          let seesEveryone = true;
          let mapName = "boss";
          const { alice, bob } = yield* makeArmyPair({
            alice: {
              ...plain("Alice"),
              player: { joinMap: () => Effect.succeed(true) },
              map: {
                getName: () => Effect.sync(() => mapName),
                getRoomNumber: () => Effect.succeed(1),
              },
              players: {
                getAll: () =>
                  Effect.sync(() =>
                    (seesEveryone ? ["Alice", "Bob"] : ["Alice"]).map(
                      (username) => ({ username }),
                    ),
                  ),
              },
            } as unknown as ApiService,
            bob: {
              ...plain("Bob"),
              player: {
                joinMap: () => Deferred.await(bobJoined).pipe(Effect.as(true)),
              },
            } as unknown as ApiService,
          });
          const a = yield* Effect.forkChild(alice.joinMap("boss"));
          const b = yield* Effect.forkChild(bob.joinMap("boss"));
          yield* advance(500);
          if (changed === "readiness") seesEveryone = false;
          else mapName = "other";
          yield* advance(500);
          yield* Deferred.succeed(bobJoined, undefined);
          yield* advance(500);
          if (changed === "readiness") {
            expect([a.pollUnsafe(), b.pollUnsafe()]).toEqual([
              undefined,
              undefined,
            ]);
            seesEveryone = true;
            yield* advance(500);
            expect(a.pollUnsafe()).toMatchObject({ _tag: "Success" });
            expect(b.pollUnsafe()).toMatchObject({ _tag: "Success" });
          } else {
            expect(a.pollUnsafe()).toMatchObject({ _tag: "Failure" });
            expect(b.pollUnsafe()).toMatchObject({ _tag: "Failure" });
            expect([yield* alice.isStarted(), yield* bob.isStarted()]).toEqual([
              false,
              false,
            ]);
          }
        }),
    );
  }
});
