import type { CombatProfile } from "@lucent/core/combatProfiles";
import { EntityState, LiveMonster } from "@lucent/game";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import { Bridge, makeBridge } from "../../flash/bridge/Bridge";
import { Gateway, makeGateway } from "../../flash/bridge/Gateway";
import type { Event, EventType } from "../../flash/contract/Event";
import { makeApi, type ApiService } from "../../flash/api/Api";
import {
  COMBAT_PROFILE_RETRY_DELAY_MS,
  makeCombatProfileRunner,
  selectCombatProfileTarget,
} from "./CombatProfileRunner";

const profile: CombatProfile = {
  cooldownMode: "use-if-ready",
  delayMs: 120,
  id: "runner-test",
  label: "Runner test",
  steps: [
    { conditions: [], skill: 1 },
    { conditions: [], skill: 2 },
  ],
};

const makeMonster = (
  monsterMapId: number,
  name: string,
  overrides: Partial<{
    readonly hp: number;
    readonly state: EntityState;
  }> = {},
) =>
  new LiveMonster({
    aggressive: false,
    cell: "Enter",
    hp: overrides.hp ?? 100,
    level: 1,
    maxHp: 100,
    maxMp: 0,
    monsterId: monsterMapId,
    monsterMapId,
    mp: 0,
    name,
    race: "None",
    state: overrides.state ?? EntityState.Idle,
  });

const first = makeMonster(1, "First");
const priority = makeMonster(2, "Priority");
const triggerProfile = {
  ...profile,
  steps: [],
  messageTriggers: [{ messageIncludes: "enrage", skill: 5, source: "any" }],
} satisfies CombatProfile;

const messageEvent = {
  message: "Boss enrage",
  source: "animation",
  type: "update-message",
} as const;

type EventHandler = (event: Event) => Effect.Effect<void, unknown>;

const makeHarness = (options?: {
  readonly alive?: boolean;
  readonly attack?: (monsterMapId: number) => Effect.Effect<boolean>;
  readonly getAvailableMonsters?: ApiService["monsterLookup"]["getAvailable"];
  readonly getTarget?: ApiService["combat"]["target"]["get"];
  readonly isAttackBlocked?: (monsterMapId: number) => boolean;
  readonly monsters?: readonly LiveMonster[];
  readonly preflightWarning?: string;
  readonly useSkill?: (skill: number) => Effect.Effect<boolean>;
}) => {
  const attacks: number[] = [];
  const casts: number[] = [];
  const preparations: CombatProfile[] = [];
  const castOptions: Parameters<ApiService["combat"]["useSkill"]>[1][] = [];
  const handlers = new Map<EventType, Set<EventHandler>>();

  const emit = (event: Event) =>
    Effect.all(
      [...(handlers.get(event.type) ?? [])].map((handler) => handler(event)),
      { discard: true },
    );

  const api = {
    combat: {
      attack: (monsterMapId: number) => {
        attacks.push(monsterMapId);
        return options?.attack?.(monsterMapId) ?? Effect.succeed(true);
      },
      canUseSkill: () => Effect.succeed(true),
      getConsumableSkillItem: () => Effect.succeed(null),
      isAttackBlocked: (monsterMapId: number) =>
        Effect.succeed(options?.isAttackBlocked?.(monsterMapId) ?? false),
      prepareCombatProfileConsumable: (preparedProfile: CombatProfile) =>
        Effect.sync(() => {
          preparations.push(preparedProfile);
          return options?.preflightWarning === undefined
            ? { release: Effect.void }
            : {
                release: Effect.void,
                warning: options.preflightWarning,
              };
        }),
      target: {
        auras: { get: () => Effect.succeed(null) },
        get: () => options?.getTarget?.() ?? Effect.succeed(null),
      },
      useSkill: (
        skill: number,
        useOptions?: Parameters<ApiService["combat"]["useSkill"]>[1],
      ) => {
        casts.push(skill);
        castOptions.push(useOptions);
        return options?.useSkill?.(skill) ?? Effect.succeed(true);
      },
    },
    events: {
      on: (selector: { readonly type: EventType }, handler: EventHandler) =>
        Effect.sync(() => {
          const registered =
            handlers.get(selector.type) ?? new Set<EventHandler>();
          registered.add(handler);
          handlers.set(selector.type, registered);
          return () => {
            registered.delete(handler);
          };
        }),
    },
    monsterLookup: {
      getAvailable: () =>
        options?.getAvailableMonsters?.() ??
        Effect.succeed(options?.monsters ?? [first, priority]),
    },
    player: {
      auras: { get: () => Effect.succeed(null) },
      getHp: () => Effect.succeed(100),
      getMaxHp: () => Effect.succeed(100),
      getMaxMp: () => Effect.succeed(100),
      getMp: () => Effect.succeed(100),
      isAlive: () => Effect.succeed(options?.alive ?? true),
    },
    players: {
      getAll: () => Effect.succeed([]),
      getMe: () => Effect.succeed(null),
    },
  } as unknown as ApiService;

  return {
    api,
    attacks,
    casts,
    castOptions,
    emit,
    preparations,
    handlerCount: () =>
      [...handlers.values()].reduce(
        (count, current) => count + current.size,
        0,
      ),
  };
};

describe("CombatProfileRunner", () => {
  it.effect.each([false, true])(
    "keeps empty rotations idle with triggers enabled: %s",
    (hasTriggers) =>
      Effect.gen(function* () {
        const harness = makeHarness();
        const runner = yield* makeCombatProfileRunner(harness.api, {
          profile: {
            ...triggerProfile,
            consumable: "Potion",
            messageTriggers: hasTriggers ? triggerProfile.messageTriggers : [],
          },
          targetPriority: [],
        });

        yield* harness.emit(messageEvent);
        yield* harness.emit({
          ...messageEvent,
          monsterMapId: first.monsterMapId,
        });
        expect(yield* runner.runCycle()).toMatchObject({ kind: "idle" });
        expect(harness.attacks).toEqual([]);
        expect(harness.preparations).toHaveLength(hasTriggers ? 1 : 0);
        expect(harness.casts).toEqual(hasTriggers ? [5, 5] : []);
        expect(harness.castOptions).toEqual(
          hasTriggers
            ? [
                { force: true, waitUntilReady: true },
                {
                  force: true,
                  target: first.monsterMapId,
                  waitUntilReady: true,
                },
              ]
            : [],
        );
      }),
  );

  it.effect("drops a trigger if its owned target dies during validation", () =>
    Effect.gen(function* () {
      const validationStarted = yield* Deferred.make<void>();
      const finishValidation = yield* Deferred.make<void>();
      let validating = false;
      const harness = makeHarness({
        getAvailableMonsters: () =>
          Effect.gen(function* () {
            if (validating) {
              yield* Deferred.succeed(validationStarted, undefined);
              yield* Deferred.await(finishValidation);
            }
            return [first, priority];
          }),
      });
      const runner = yield* makeCombatProfileRunner(harness.api, {
        profile: { ...triggerProfile, steps: profile.steps },
        targetPriority: [],
      });
      yield* runner.runCycle();
      validating = true;
      const pending = yield* Effect.forkChild(
        harness.emit({
          ...messageEvent,
          monsterMapId: first.monsterMapId,
        }),
      );
      yield* Deferred.await(validationStarted);
      yield* harness.emit({
        type: "monster-death",
        monsterMapId: first.monsterMapId,
      });
      yield* Deferred.succeed(finishValidation, undefined);
      yield* Fiber.join(pending);
      expect(harness.casts).toEqual([1]);
    }),
  );

  it("selects by priority while retaining an equal-rank target", () => {
    const dead = makeMonster(3, "Dead", {
      hp: 0,
      state: EntityState.Dead,
    });
    expect(
      selectCombatProfileTarget([dead, first, priority], ["Priority"]),
    ).toBe(priority);
    expect(selectCombatProfileTarget([dead, first, priority], [])).toBe(first);
    expect(
      selectCombatProfileTarget([first, priority], [], {
        currentMonsterMapId: priority.monsterMapId,
      }),
    ).toBe(priority);
    expect(
      selectCombatProfileTarget([first, priority], ["Priority"], {
        currentMonsterMapId: first.monsterMapId,
      }),
    ).toBe(priority);
  });

  it.effect(
    "does not abandon an equal-rank target when another monster respawns",
    () =>
      Effect.gen(function* () {
        const harnessOptions: { monsters: readonly LiveMonster[] } = {
          monsters: [first, priority],
        };
        const harness = makeHarness(harnessOptions);
        const runner = yield* makeCombatProfileRunner(harness.api, {
          profile,
          targetPriority: [],
        });

        yield* runner.runCycle();
        yield* harness.emit({
          monsterMapId: first.monsterMapId,
          type: "monster-death",
        });
        harnessOptions.monsters = [priority];
        yield* runner.runCycle();
        harnessOptions.monsters = [first, priority];
        yield* runner.runCycle();

        expect(harness.attacks).toEqual([
          first.monsterMapId,
          priority.monsterMapId,
          priority.monsterMapId,
        ]);
      }),
  );

  it.effect(
    "skips Anti-Counter targets without switching back at equal rank",
    () =>
      Effect.gen(function* () {
        const blocked = new Set<number>();
        const harness = makeHarness({
          isAttackBlocked: (monsterMapId) => blocked.has(monsterMapId),
        });
        const runner = yield* makeCombatProfileRunner(harness.api, {
          profile,
          targetPriority: [],
        });

        yield* runner.runCycle();
        blocked.add(first.monsterMapId);
        yield* runner.runCycle();
        blocked.delete(first.monsterMapId);
        yield* runner.runCycle();
        blocked.add(first.monsterMapId);
        blocked.add(priority.monsterMapId);

        expect(yield* runner.runCycle()).toMatchObject({ kind: "no-target" });
        expect(harness.attacks).toEqual([
          first.monsterMapId,
          priority.monsterMapId,
          priority.monsterMapId,
        ]);
      }),
  );

  it.effect("gates dead players and returns the shared cycle delays", () =>
    Effect.gen(function* () {
      const dead = makeHarness({ alive: false });
      const deadRunner = yield* makeCombatProfileRunner(dead.api, {
        profile,
        targetPriority: [],
      });
      expect(yield* deadRunner.runCycle()).toEqual({
        delayMs: COMBAT_PROFILE_RETRY_DELAY_MS,
        kind: "player-dead",
      });
      expect(dead.attacks).toEqual([]);

      const rejected = makeHarness({
        attack: () => Effect.succeed(false),
      });
      const rejectedRunner = yield* makeCombatProfileRunner(rejected.api, {
        profile,
        targetPriority: ["Priority"],
      });
      expect(yield* rejectedRunner.runCycle()).toEqual({
        delayMs: COMBAT_PROFILE_RETRY_DELAY_MS,
        kind: "attack-rejected",
      });
      expect(rejected.attacks).toEqual([priority.monsterMapId]);

      const successful = makeHarness();
      const successfulRunner = yield* makeCombatProfileRunner(successful.api, {
        profile,
        targetPriority: [],
      });
      expect(yield* successfulRunner.runCycle()).toEqual({
        cast: true,
        delayMs: profile.delayMs,
        kind: "attacked",
      });
    }),
  );

  it.effect("labels target, attack, and profile failures", () =>
    Effect.gen(function* () {
      const targetFailure = makeHarness();
      const targetRunner = yield* makeCombatProfileRunner(
        {
          ...targetFailure.api,
          monsterLookup: {
            getAvailable: () => Effect.die("target failed"),
          },
        } as unknown as ApiService,
        { profile, targetPriority: [] },
      );
      expect((yield* Effect.flip(targetRunner.runCycle())).stage).toBe(
        "target-selection",
      );

      const attackFailure = makeHarness({
        attack: () => Effect.die("attack failed"),
      });
      const attackRunner = yield* makeCombatProfileRunner(attackFailure.api, {
        profile,
        targetPriority: [],
      });
      expect((yield* Effect.flip(attackRunner.runCycle())).stage).toBe(
        "attack",
      );

      const profileFailure = makeHarness({
        useSkill: () => Effect.die("profile failed"),
      });
      const profileRunner = yield* makeCombatProfileRunner(profileFailure.api, {
        profile,
        targetPriority: [],
      });
      expect((yield* Effect.flip(profileRunner.runCycle())).stage).toBe(
        "profile-cast",
      );
    }),
  );

  it.effect(
    "continues after a preflight warning without guarding skill 5",
    () =>
      Effect.gen(function* () {
        const harness = makeHarness({
          preflightWarning:
            "Skill 5 will use whichever consumable is available.",
        });
        const runner = yield* makeCombatProfileRunner(harness.api, {
          profile: {
            ...profile,
            steps: [{ conditions: [], skill: 5 }],
          },
          targetPriority: [],
        });

        expect(runner.warning).toBe(
          "Skill 5 will use whichever consumable is available.",
        );
        expect(yield* runner.runCycle()).toEqual({
          cast: true,
          delayMs: profile.delayMs,
          kind: "attacked",
        });
        expect(harness.attacks).toEqual([first.monsterMapId]);
        expect(harness.casts).toEqual([5]);
      }),
  );

  it.effect("guards triggers and resets only on active-target death", () =>
    Effect.gen(function* () {
      const blocked = new Set<number>();
      let selected: LiveMonster | undefined;
      const harness = makeHarness({
        isAttackBlocked: (monsterMapId) => blocked.has(monsterMapId),
        getTarget: () =>
          Effect.succeed(
            selected === undefined
              ? null
              : { ...selected.toJSON(), type: "monster" as const },
          ),
      });
      const eventProfile: CombatProfile = {
        ...profile,
        messageTriggers: [
          {
            messageIncludes: "enrage",
            skill: 5,
            source: "any",
          },
        ],
        resetSkillIndexOnTargetDeath: true,
      };

      yield* Effect.scoped(
        Effect.gen(function* () {
          const runner = yield* makeCombatProfileRunner(harness.api, {
            profile: eventProfile,
            targetPriority: [],
          });
          expect(harness.handlerCount()).toBe(2);

          yield* runner.runCycle();
          yield* harness.emit({ monsterMapId: 2, type: "monster-death" });
          yield* runner.runCycle();
          selected = priority;
          yield* harness.emit({
            ...messageEvent,
            monsterMapId: first.monsterMapId,
          });
          selected = undefined;
          yield* harness.emit({
            message: "Boss enrage",
            monsterMapId: priority.monsterMapId,
            source: "animation",
            type: "update-message",
          });
          blocked.add(first.monsterMapId);
          yield* harness.emit({
            message: "Boss enrage",
            source: "animation",
            type: "update-message",
          });
          blocked.clear();
          yield* harness.emit({ monsterMapId: 1, type: "monster-death" });
          yield* runner.runCycle();
          yield* harness.emit({
            message: "Boss enrage",
            source: "animation",
            type: "update-message",
          });

          expect(harness.casts).toEqual([1, 2, 1, 5]);
        }),
      );

      expect(harness.handlerCount()).toBe(0);
    }),
  );

  it.effect("reports asynchronous trigger failures by stage", () =>
    Effect.gen(function* () {
      const failures: string[] = [];
      const harness = makeHarness({
        useSkill: (skill) =>
          skill === 5 ? Effect.die("trigger failed") : Effect.succeed(true),
      });
      const eventProfile: CombatProfile = {
        ...profile,
        messageTriggers: [
          {
            messageIncludes: "enrage",
            skill: 5,
            source: "any",
          },
        ],
      };
      const runner = yield* makeCombatProfileRunner(harness.api, {
        onAsyncFailure: (failure) =>
          Effect.sync(() => {
            failures.push(failure.stage);
          }),
        profile: eventProfile,
        targetPriority: [],
      });
      yield* runner.runCycle();

      yield* harness.emit({
        message: "Boss enrage",
        source: "animation",
        type: "update-message",
      });

      expect(failures).toEqual(["message-trigger"]);
    }),
  );

  it.effect("keeps runner cursors independent", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const left = yield* makeCombatProfileRunner(harness.api, {
        profile,
        targetPriority: [],
      });
      const right = yield* makeCombatProfileRunner(harness.api, {
        profile,
        targetPriority: [],
      });

      yield* left.runCycle();
      yield* right.runCycle();
      yield* left.runCycle();

      expect(harness.casts).toEqual([1, 1, 2]);
    }),
  );

  it.effect("attacks without waiting for monster drop responses", () =>
    Effect.gen(function* () {
      const target = {} as Window;
      target.swf = {
        "combat.attackMonster": () => true,
        "combat.getSkillCooldownRemaining": () => 0,
        "combat.useSkill": () => true,
        "player.getUserId": () => 1,
        "world.getAvailableMonsterMapIds": () => [2],
        "world.requestMonsterDrops": () => true,
      } as unknown as Window["swf"];
      const bridge = yield* makeBridge(target);
      const gateway = yield* makeGateway(target).pipe(
        Effect.provideService(Bridge, bridge),
      );
      const api = yield* makeApi.pipe(
        Effect.provideService(Bridge, bridge),
        Effect.provideService(Gateway, gateway),
      );
      yield* api.wait.forPacket(
        { command: "moveToArea", direction: "extension", encoding: "json" },
        {
          timeout: "1 second",
          trigger: Effect.sync(() => {
            target.onExtensionResponse?.(
              JSON.stringify({
                dataObj: {
                  areaId: 1,
                  areaName: "test-1",
                  cmd: "moveToArea",
                  monBranch: [
                    {
                      MonID: 1,
                      MonMapID: 2,
                      intHP: 100,
                      intHPMax: 100,
                      intState: 1,
                      strMonName: "Slime",
                    },
                  ],
                  monmap: [{ MonMapID: 2, strFrame: "Enter" }],
                  uoBranch: [
                    {
                      entID: 1,
                      intHP: 100,
                      intHPMax: 100,
                      intState: 1,
                      strFrame: "Enter",
                      strUsername: "Hero",
                    },
                  ],
                },
                type: "json",
              }),
            );
            return true;
          }),
        },
      );

      const runner = yield* makeCombatProfileRunner(api, {
        profile,
        targetPriority: [],
      });
      const cycle = yield* runner
        .runCycle()
        .pipe(Effect.timeoutOption("1 second"), Effect.forkChild);
      yield* TestClock.adjust("1 second");

      expect(yield* Fiber.join(cycle)).toEqual(
        Option.some({ cast: true, delayMs: 120, kind: "attacked" }),
      );
    }),
  );
});
