import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Logger from "effect/Logger";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as References from "effect/References";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";

import type {
  ArmyLoopTauntCommandPayload,
  ArmyLoopTauntReport,
  ArmyLoopTauntReportPayload,
} from "@lucent/core/army";
import { EntityState, LiveMonster, type PlayerSnapshot } from "@lucent/game";
import type { DesktopArmyBridge } from "../../../../shared/desktopBridge";
import type { ApiService } from "../flash/api/Api";
import type { Event } from "../flash/contract/Event";
import { makeWait } from "../flash/protocol/Wait";
import {
  type ArmyLoopTauntRuntime,
  type ArmyLoopTauntRuntimePlan,
  makeArmyLoopTauntRuntime,
} from "./ArmyLoopTaunt";

const playerSnapshot = (name: string, playerNumber: number): PlayerSnapshot =>
  ({
    alive: true,
    entityId: playerNumber,
    username: name,
  }) as PlayerSnapshot;

const makeMonster = (monsterMapId: number, alive = true) =>
  new LiveMonster({
    aggressive: false,
    cell: "r1",
    hp: alive ? 100 : 0,
    level: 1,
    maxHp: 100,
    maxMp: 100,
    monsterId: 1,
    monsterMapId,
    mp: 100,
    name: "Monster",
    race: "None",
    state: alive ? EntityState.InCombat : EntityState.Dead,
  });

const applyFocus = (monster: LiveMonster, icon: string, stack = 1) =>
  monster.projectAuras(
    {
      type: "apply",
      entries: [
        {
          name: "Focus",
          icon,
          stack,
          timing: { type: "untimed" },
          persistent: false,
          restartDuration: false,
        },
      ],
    },
    0,
  );

interface Harness {
  readonly casts: readonly number[];
  readonly monster: (id: number) => LiveMonster;
  readonly reports: readonly ArmyLoopTauntReport[];
  readonly emitEvent: (event: Event) => Effect.Effect<void>;
  readonly emitTaunt: (assignmentId?: number, monsterMapId?: number) => void;
  readonly nextCommandResult: Effect.Effect<
    Extract<ArmyLoopTauntReport, { readonly type: "command-result" }>
  >;
}

interface RuntimeHarness extends Harness {
  readonly exitMap: Effect.Effect<void>;
  readonly runtime: ArmyLoopTauntRuntime;
}

const makeRuntime = Effect.fn("ArmyLoopTaunt.test.makeRuntime")(function* (
  initialAlive: Readonly<Record<number, boolean>> = {},
  bridgeOverrides: Partial<DesktopArmyBridge> = {},
  subscribeEvents?: Effect.Effect<
    PubSub.Subscription<Event>,
    never,
    Scope.Scope
  >,
): Effect.fn.Return<RuntimeHarness, never, Scope.Scope> {
  const players = ["Alice", "Bob"];
  const casts: number[] = [];
  const reports: ArmyLoopTauntReport[] = [];
  const monsters = new Map<number, LiveMonster>();
  const monster = (id: number) => {
    let current = monsters.get(id);
    if (current === undefined) {
      current = makeMonster(id, initialAlive[id] ?? true);
      monsters.set(id, current);
    }
    return current;
  };
  const commandResults =
    yield* Queue.unbounded<
      Extract<ArmyLoopTauntReport, { readonly type: "command-result" }>
    >();
  const runFork = Effect.runForkWith(yield* Effect.context<never>());
  const events = yield* PubSub.unbounded<Event>();
  const wait = makeWait({
    subscribeEvents: subscribeEvents ?? PubSub.subscribe(events),
    subscribePackets: Effect.die("Loop Taunt does not wait for packets"),
  });
  let commandListener:
    | ((payload: ArmyLoopTauntCommandPayload) => void)
    | undefined;
  let eventListener: ((event: Event) => Effect.Effect<void>) | undefined;

  const bridge = {
    loopTauntAwait: () => new Promise<never>(() => undefined),
    loopTauntLeave: () => Promise.resolve(),
    loopTauntReady: () => Promise.resolve(),
    loopTauntRegister: () => Promise.resolve({ runId: "run-1" }),
    loopTauntReport: (payload: ArmyLoopTauntReportPayload) => {
      reports.push(payload.report);
      if (payload.report.type === "command-result") {
        runFork(Queue.offer(commandResults, payload.report));
      }
      return Promise.resolve();
    },
    onLoopTauntCommand: (
      listener: (payload: ArmyLoopTauntCommandPayload) => void,
    ) => {
      commandListener = listener;
      return () => {
        commandListener = undefined;
      };
    },
    ...bridgeOverrides,
  } as unknown as DesktopArmyBridge;

  const api = {
    combat: {
      castConsumableOnMonster: (monsterMapId: number) =>
        Effect.sync(() => {
          casts.push(monsterMapId);
          return { monsterMapId, success: true };
        }),
      getConsumableSkillItem: () =>
        Effect.succeed({ itemId: 12_917, ready: true }),
      getSkillCooldownRemainingMs: () => Effect.succeed(0),
      target: {
        get: () => Effect.succeed(null),
      },
    },
    events: {
      on: (
        _selector: unknown,
        listener: (event: Event) => Effect.Effect<void>,
      ) =>
        Effect.sync(() => {
          eventListener = listener;
          return () => {
            eventListener = undefined;
          };
        }),
      once: wait.forEvent,
    },
    map: {
      getId: () => Effect.succeed(100),
      getName: () => Effect.succeed("ultra"),
      getRoomNumber: () => Effect.succeed(1_234),
    },
    monsterLookup: {
      get: (query: number) => Effect.sync(() => monster(query)),
    },
    monsters: {
      get: (query: number) => Effect.sync(() => monster(query)),
    },
    player: {
      isAlive: () => Effect.succeed(true),
    },
    players: {
      get: (name: string) => {
        const playerNumber = players.indexOf(name) + 1;
        return Effect.succeed(
          playerNumber === 0
            ? null
            : { toJSON: () => playerSnapshot(name, playerNumber) },
        );
      },
    },
  } as unknown as ApiService;

  const runtime = yield* makeArmyLoopTauntRuntime(api, bridge, () =>
    Effect.succeed({
      playerNumber: 1,
      players,
      sessionId: "session-1",
    }),
  );
  return {
    casts,
    exitMap: PubSub.publish(events, {
      map: { id: 101, name: "battleon", roomNumber: 1 },
      type: "join-map",
    }).pipe(Effect.asVoid),
    monster,
    reports,
    runtime,
    emitEvent: (event) =>
      eventListener === undefined
        ? Effect.die("Loop Taunt event listener was not registered")
        : eventListener(event).pipe(Effect.asVoid),
    emitTaunt: (assignmentId = 0, monsterMapId = 42) => {
      if (commandListener === undefined) {
        throw new Error("Loop Taunt command listener was not registered");
      }
      commandListener({
        command: {
          assignmentId,
          expiresAt: Number.MAX_SAFE_INTEGER,
          lifeRevision: 0,
          monsterMapId,
          type: "taunt",
        },
        commandId: 1,
        runId: "run-1",
        sessionId: "session-1",
      });
    },
    nextCommandResult: Queue.take(commandResults),
  };
});

const makeHarness = Effect.fn("ArmyLoopTaunt.test.makeHarness")(function* (
  plan: ArmyLoopTauntRuntimePlan,
  initialAlive: Readonly<Record<number, boolean>> = {},
): Effect.fn.Return<Harness, unknown, Scope.Scope> {
  const { runtime, ...harness } = yield* makeRuntime(initialAlive);
  const handle = yield* runtime.loopTaunt(plan, () => Effect.void);
  yield* Effect.addFinalizer(() => handle.stop());
  return harness;
});

const startLoopTaunt = (
  runtime: ArmyLoopTauntRuntime,
  onFailure: (cause: Cause.Cause<unknown>) => Effect.Effect<void> = () =>
    Effect.void,
) =>
  runtime
    .loopTaunt(
      [
        {
          assignments: [
            { players: [1, 2], strategy: { type: "focus" }, target: 42 },
          ],
        },
      ],
      onFailure,
    )
    .pipe(
      Effect.tap((handle) => Effect.addFinalizer(() => handle.stop())),
      Effect.result,
      Effect.forkChild,
    );

describe("Army Loop Taunt renderer", () => {
  it.effect("logs a readiness failure once until polling recovers", () => {
    const records: {
      readonly cause: Cause.Cause<unknown>;
      readonly level: string;
      readonly message: unknown;
      readonly annotations: Readonly<Record<string, unknown>>;
    }[] = [];
    const logger = Logger.make((options) => {
      records.push({
        cause: options.cause,
        level: options.logLevel,
        message: options.message,
        annotations: options.fiber.getRef(References.CurrentLogAnnotations),
      });
    });

    return Effect.gen(function* () {
      const cycles = yield* Queue.unbounded<number>();
      const runFork = Effect.runForkWith(yield* Effect.context());
      const failure = new Error("bridge unavailable");
      let attempts = 0;
      const harness = yield* makeRuntime(
        {},
        {
          loopTauntReport: ({ report }) => {
            if (report.type !== "participant-state") {
              return Promise.resolve();
            }
            attempts++;
            runFork(Queue.offer(cycles, attempts));
            return attempts <= 3 ? Promise.reject(failure) : Promise.resolve();
          },
        },
      );
      const startup = yield* startLoopTaunt(harness.runtime);
      yield* Fiber.join(startup);
      expect(yield* Queue.take(cycles)).toBe(1);
      for (const attempt of [2, 3, 4, 5]) {
        yield* TestClock.adjust("250 millis");
        expect(yield* Queue.take(cycles)).toBe(attempt);
      }
      yield* TestClock.adjust("0 millis");

      expect(
        records.map(({ level, message, annotations }) => ({
          level,
          message,
          annotations,
        })),
      ).toEqual([
        {
          level: "Warn",
          message: ["Loop Taunt readiness report failed"],
          annotations: {
            component: "army",
            data: {
              key: "readiness-report",
              runId: "run-1",
              sessionId: "session-1",
            },
          },
        },
        {
          level: "Info",
          message: ["Loop Taunt readiness report recovered"],
          annotations: {
            component: "army",
            data: {
              key: "readiness-report",
              runId: "run-1",
              sessionId: "session-1",
            },
          },
        },
      ]);
      expect(Cause.squash(records[0]!.cause)).toMatchObject({
        cause: failure,
        message: "Failed to report Loop Taunt state",
      });
    }).pipe(Effect.provideService(Logger.CurrentLoggers, new Set([logger])));
  });

  it.effect(
    "evaluates skipWhen for the selected member with participant snapshots",
    () =>
      Effect.gen(function* () {
        const contexts: unknown[] = [];
        const harness = yield* makeHarness([
          {
            assignments: [
              {
                players: [1, 2],
                skipWhen: (context) =>
                  Effect.sync(() => {
                    contexts.push(context);
                    return true;
                  }),
                strategy: { type: "focus" },
                target: 42,
              },
            ],
          },
        ]);

        expect(contexts).toHaveLength(0);
        harness.emitTaunt();
        expect(yield* harness.nextCommandResult).toEqual({
          commandId: 1,
          outcome: "skipped",
          type: "command-result",
        });
        expect(harness.casts).toHaveLength(0);
        expect(contexts).toHaveLength(1);
        const context = contexts[0] as {
          readonly participants: readonly { readonly playerNumber: number }[];
          readonly self: { readonly playerNumber: number };
        };
        expect(context.self.playerNumber).toBe(1);
        expect(
          context.participants.map(({ playerNumber }) => playerNumber),
        ).toEqual([1, 2]);
      }),
  );

  it.effect("revalidates the target after skipWhen before dispatching", () =>
    Effect.gen(function* () {
      let beforeCast: Effect.Effect<boolean> = Effect.succeed(false);
      const harness = yield* makeHarness([
        {
          assignments: [
            {
              players: [1, 2],
              skipWhen: () => beforeCast,
              strategy: { type: "focus" },
              target: 42,
            },
          ],
        },
      ]);
      beforeCast = Effect.gen(function* () {
        applyFocus(harness.monster(42), "iwd1,ied1");
        yield* harness.emitEvent({
          icon: "iwd1,ied1",
          kind: "active",
          name: "focus",
          stack: 1,
          targetId: 42,
          targetType: "monster",
          type: "aura-added",
        });
        return false;
      });

      harness.emitTaunt();

      expect(yield* harness.nextCommandResult).toEqual({
        commandId: 1,
        outcome: "target-unavailable",
        type: "command-result",
      });
      expect(harness.casts).toHaveLength(0);
    }),
  );

  it.effect("rereads Focus for icon changes, decay, and replacement", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([
        {
          assignments: [
            {
              players: [1, 2],
              strategy: { type: "focus" },
              target: 42,
            },
          ],
        },
      ]);
      const monster = harness.monster(42);
      const reportStates = () =>
        harness.reports
          .filter((report) => report.type === "focus-state")
          .map((report) => report.active);
      const event = {
        kind: "active",
        name: "Focus",
        targetId: 42,
        targetType: "monster",
      } as const;

      applyFocus(monster, "other", 5);
      yield* harness.emitEvent({
        ...event,
        type: "aura-added",
        stack: 5,
        icon: "other",
      });
      applyFocus(monster, "iwd1,ied1", 5);
      yield* harness.emitEvent({ ...event, type: "aura-updated", stack: 5 });
      expect(reportStates()).toEqual([true]);

      monster.projectAuras(
        {
          type: "withdraw",
          entries: [{ type: "decay", name: "Focus", stack: 2 }],
        },
        0,
      );
      yield* harness.emitEvent({ ...event, type: "aura-updated", stack: 2 });
      expect(reportStates()).toEqual([true]);

      monster.projectAuras(
        { type: "withdraw", entries: [{ type: "remove", name: "Focus" }] },
        0,
      );
      applyFocus(monster, "iwd1,ied1");
      yield* harness.emitEvent({ ...event, type: "aura-removed" });
      yield* harness.emitEvent({ ...event, type: "aura-added", stack: 1 });
      expect(reportStates()).toEqual([true]);

      applyFocus(monster, "other");
      yield* harness.emitEvent({ ...event, type: "aura-updated", stack: 1 });
      expect(reportStates()).toEqual([true, false]);
      applyFocus(monster, "iwd1,ied1");
      yield* harness.emitEvent({ ...event, type: "aura-added", stack: 1 });
      monster.projectAuras(
        { type: "withdraw", entries: [{ type: "remove", name: "Focus" }] },
        0,
      );
      yield* harness.emitEvent({ ...event, type: "aura-removed" });
      expect(reportStates()).toEqual([true, false, true, false]);
    }),
  );

  it.effect(
    "rejects a lower-priority command after an earlier target respawns",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness(
          [
            {
              assignments: [
                {
                  players: [1],
                  strategy: { type: "focus" },
                  target: 41,
                },
              ],
            },
            {
              assignments: [
                {
                  players: [1],
                  strategy: { type: "focus" },
                  target: 42,
                },
              ],
            },
          ],
          { 41: false },
        );

        yield* harness.emitEvent({
          monsterMapId: 41,
          type: "monster-respawn",
        });
        harness.emitTaunt(1, 42);

        expect(yield* harness.nextCommandResult).toEqual({
          commandId: 1,
          outcome: "target-unavailable",
          type: "command-result",
        });
        expect(harness.casts).toHaveLength(0);
      }),
  );

  it.effect(
    "sends leave last when the map changes as Loop Taunt startup completes",
    () =>
      Effect.gen(function* () {
        const calls: string[] = [];
        const leaveResponded = yield* Deferred.make<void>();
        const context = yield* Effect.context();
        const runFork = Effect.runForkWith(context);
        const runPromise = Effect.runPromiseWith(context);
        let exitMap: Effect.Effect<void> = Effect.void;
        const harness = yield* makeRuntime(
          {},
          {
            loopTauntAwait: () => {
              calls.push("await");
              return runPromise(Effect.never);
            },
            loopTauntLeave: () => {
              calls.push("leave");
              return runPromise(Deferred.await(leaveResponded));
            },
            loopTauntReady: () => {
              calls.push("ready");
              runFork(exitMap);
              return Promise.resolve();
            },
            loopTauntRegister: () => {
              calls.push("register");
              return Promise.resolve({ runId: "run-1" });
            },
          },
        );
        exitMap = harness.exitMap;

        const startup = yield* startLoopTaunt(harness.runtime);
        for (let turn = 0; turn < 100 && !calls.includes("await"); turn++) {
          yield* Effect.yieldNow;
        }
        yield* Deferred.succeed(leaveResponded, undefined);

        const result = yield* Fiber.join(startup);
        expect(calls).toEqual(["register", "ready", "leave"]);
        expect(result).toMatchObject({
          _tag: "Failure",
          failure: { message: "The map changed while Loop Taunt was starting" },
        });
      }),
  );

  for (const { calls, closeOn, failure, outcome, subscribe } of [
    {
      calls: [],
      closeOn: undefined,
      failure: {
        cause: { message: "Event subscription failed" },
        message: "Failed to start Loop Taunt",
      },
      outcome: "fails before it arms",
      subscribe: () => Effect.die(new Error("Event subscription failed")),
    },
    {
      calls: [],
      closeOn: undefined,
      failure: { message: "Failed to start Loop Taunt" },
      outcome: "is interrupted before it arms",
      subscribe: () => Effect.interrupt,
    },
    {
      calls: ["register", "ready", "leave"],
      closeOn: undefined,
      failure: { message: "Failed to start Loop Taunt" },
      outcome: "is already closed",
      subscribe: (events: PubSub.PubSub<Event>) =>
        PubSub.shutdown(events).pipe(Effect.andThen(PubSub.subscribe(events))),
    },
    {
      calls: ["register", "ready", "leave"],
      closeOn: "ready",
      failure: { message: "Failed to start Loop Taunt" },
      outcome: "closes while startup waits for the roster",
      subscribe: (events: PubSub.PubSub<Event>) => PubSub.subscribe(events),
    },
    {
      calls: ["register", "ready", "leave"],
      closeOn: "report",
      failure: { message: "Failed to start Loop Taunt" },
      outcome: "closes after setup returns",
      subscribe: (events: PubSub.PubSub<Event>) => PubSub.subscribe(events),
    },
  ] as const) {
    it.effect(`fails startup when the map-exit subscription ${outcome}`, () =>
      Effect.gen(function* () {
        const recorded: string[] = [];
        const events = yield* PubSub.unbounded<Event>();
        const context = yield* Effect.context();
        const runFork = Effect.runForkWith(context);
        const runPromise = Effect.runPromiseWith(context);
        const record =
          <A>(call: string, response: A) =>
          () => {
            recorded.push(call);
            return Promise.resolve(response);
          };
        const harness = yield* makeRuntime(
          {},
          {
            loopTauntAwait: () => {
              recorded.push("await");
              return runPromise(Effect.never);
            },
            loopTauntLeave: record("leave", undefined),
            loopTauntReady: () => {
              recorded.push("ready");
              if (closeOn !== "ready") return Promise.resolve();
              runFork(PubSub.shutdown(events));
              return runPromise(Effect.never);
            },
            loopTauntRegister: record("register", { runId: "run-1" }),
            loopTauntReport: () => {
              if (closeOn === "report") runFork(PubSub.shutdown(events));
              return Promise.resolve();
            },
          },
          subscribe(events),
        );

        const startup = yield* startLoopTaunt(harness.runtime);
        for (
          let turn = 0;
          turn < 100 && startup.pollUnsafe() === undefined;
          turn++
        ) {
          yield* Effect.yieldNow;
        }
        const settled = startup.pollUnsafe();
        if (settled === undefined) yield* Fiber.interrupt(startup);

        expect(
          settled !== undefined && Exit.isSuccess(settled)
            ? settled.value
            : settled,
        ).toMatchObject({ _tag: "Failure", failure });
        expect(recorded).toEqual(calls);
      }),
    );
  }

  it.effect(
    "keeps running when the map-exit subscription closes after startup",
    () =>
      Effect.gen(function* () {
        const failures: unknown[] = [];
        const events = yield* PubSub.unbounded<Event>();
        const harness = yield* makeRuntime({}, {}, PubSub.subscribe(events));
        const startup = yield* startLoopTaunt(harness.runtime, (cause) =>
          Effect.sync(() => {
            failures.push(cause);
          }),
        );
        expect(yield* Fiber.join(startup)).toMatchObject({ _tag: "Success" });

        yield* PubSub.shutdown(events);
        for (let turn = 0; turn < 20; turn++) yield* Effect.yieldNow;
        harness.emitTaunt();

        expect(yield* harness.nextCommandResult).toEqual({
          commandId: 1,
          cooldownMs: 0,
          outcome: "confirmed",
          type: "command-result",
        });
        expect(failures).toEqual([]);
      }),
  );
});
