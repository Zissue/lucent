import { DEFAULT_COMBAT_PROFILE_LIBRARY } from "@lucent/core/combatProfiles";
import { EntityState, LiveMonster } from "@lucent/game";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FiberMap from "effect/FiberMap";
import * as Ref from "effect/Ref";
import { TestClock } from "effect/testing";

import type { ApiService } from "../flash/api/Api";
import type { Event, EventSelector } from "../flash/contract/Event";
import { makeAutoAttack } from "./AutoAttack";

const monster = new LiveMonster({
  aggressive: false,
  cell: "Enter",
  hp: 100,
  level: 1,
  maxHp: 100,
  maxMp: 0,
  monsterId: 1,
  monsterMapId: 7,
  mp: 0,
  name: "Target",
  race: "None",
  state: EntityState.Idle,
});

const apiWith = (
  combat: Partial<ApiService["combat"]>,
  on: ApiService["events"]["on"],
): ApiService =>
  ({
    combat: {
      canUseSkill: () => Effect.succeed(true),
      getConsumableSkillItem: () => Effect.succeed(null),
      isAttackBlocked: () => Effect.succeed(false),
      target: {
        auras: { get: () => Effect.succeed(null) },
        get: () => Effect.succeed(null),
      },
      ...combat,
    },
    events: { on },
    monsterLookup: { getAvailable: () => Effect.succeed([monster]) },
    player: {
      auras: { get: () => Effect.succeed(null) },
      getHp: () => Effect.succeed(100),
      getMaxHp: () => Effect.succeed(100),
      getMaxMp: () => Effect.succeed(100),
      getMp: () => Effect.succeed(100),
      isAlive: () => Effect.succeed(true),
    },
    players: {
      getAll: () => Effect.succeed([]),
      getMe: () => Effect.succeed(null),
    },
  }) as unknown as ApiService;

describe("AutoAttack", () => {
  it.effect("replaces its fiber and cancels combat when disabled", () =>
    Effect.gen(function* () {
      const casts = yield* Ref.make<number[]>([]);
      const oldCastStarted = yield* Deferred.make<void>();
      const releaseOldCast = yield* Deferred.make<void>();
      const cancellations = yield* Ref.make(0);
      const fibers = yield* FiberMap.make<string>();
      const api = apiWith(
        {
          attack: () => Effect.succeed(true),
          cancelAutoAttack: () =>
            Ref.update(cancellations, (count) => count + 1),
          cancelTarget: () => Ref.update(cancellations, (count) => count + 1),
          prepareCombatProfileConsumable: () =>
            Effect.succeed({
              release: Effect.void,
              warning: "Skill 5 will use whichever consumable is available.",
            }),
          useSkill: (skill: number) =>
            Effect.gen(function* () {
              if (skill === 1) {
                yield* Deferred.succeed(oldCastStarted, undefined);
                yield* Deferred.await(releaseOldCast);
              }
              yield* Ref.update(casts, (values) => [...values, skill]);
              return true;
            }),
        },
        () => Effect.succeed(() => undefined),
      );

      const autoAttack = yield* makeAutoAttack(api, fibers);
      const profile = DEFAULT_COMBAT_PROFILE_LIBRARY.profiles[0]!;
      const first = {
        ...profile,
        id: "first",
        steps: [{ skill: 1 as const, conditions: [] }],
      };
      const second = {
        ...profile,
        id: "second",
        steps: [{ skill: 2 as const, conditions: [] }],
      };
      const library = {
        ...DEFAULT_COMBAT_PROFILE_LIBRARY,
        profiles: [first, second],
      };
      yield* autoAttack.enable({ library, profileId: first.id });
      yield* Deferred.await(oldCastStarted);
      expect(yield* autoAttack.getState()).toMatchObject({
        enabled: true,
        warning: "Skill 5 will use whichever consumable is available.",
      });
      yield* autoAttack.enable({ library, profileId: second.id });
      yield* Deferred.succeed(releaseOldCast, undefined);
      yield* TestClock.adjust("1 second");
      const replacementCasts = yield* Ref.get(casts);
      expect(replacementCasts.length).toBeGreaterThan(0);
      expect(replacementCasts.every((skill) => skill === 2)).toBe(true);
      yield* autoAttack.disable();
      const disabledCasts = yield* Ref.get(casts);
      yield* TestClock.adjust("1 second");
      expect(yield* Ref.get(casts)).toEqual(disabledCasts);
      expect(yield* Ref.get(cancellations)).toBeGreaterThanOrEqual(2);
      expect((yield* autoAttack.getState()).running).toBe(false);
    }),
  );

  it.effect("disables auto attack after a combat failure", () =>
    Effect.gen(function* () {
      const attackStarted = yield* Deferred.make<void>();
      const cancellations = yield* Ref.make(0);
      const fibers = yield* FiberMap.make<string>();
      const api = apiWith(
        {
          attack: () =>
            Deferred.succeed(attackStarted, undefined).pipe(
              Effect.andThen(Effect.die("attack exploded")),
            ),
          cancelAutoAttack: () =>
            Ref.update(cancellations, (count) => count + 1),
          cancelTarget: () => Ref.update(cancellations, (count) => count + 1),
          prepareCombatProfileConsumable: () =>
            Effect.succeed({ release: Effect.void }),
          useSkill: () => Effect.succeed(true),
        },
        () => Effect.succeed(() => undefined),
      );
      const autoAttack = yield* makeAutoAttack(api, fibers);
      const profile = DEFAULT_COMBAT_PROFILE_LIBRARY.profiles[0]!;

      yield* autoAttack.enable({
        library: DEFAULT_COMBAT_PROFILE_LIBRARY,
        profileId: profile.id,
      });
      yield* Deferred.await(attackStarted);
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;

      expect(yield* autoAttack.getState()).toMatchObject({
        enabled: false,
        lastError: "attack exploded",
      });
      expect(yield* Ref.get(cancellations)).toBeGreaterThanOrEqual(2);
    }),
  );

  it.effect(
    "ignores an in-flight message-trigger failure from a replaced run",
    () =>
      Effect.gen(function* () {
        const cycleStarted = yield* Deferred.make<void>();
        const failureStarted = yield* Deferred.make<void>();
        const releaseFailure = yield* Deferred.make<void>();
        let onMessage:
          | ((event: Event) => Effect.Effect<void, unknown>)
          | undefined;
        const cancellations = yield* Ref.make(0);
        const fibers = yield* FiberMap.make<string>();
        const api = apiWith(
          {
            attack: () => Effect.succeed(true),
            cancelAutoAttack: () =>
              Ref.update(cancellations, (count) => count + 1),
            cancelTarget: () => Ref.update(cancellations, (count) => count + 1),
            prepareCombatProfileConsumable: () =>
              Effect.succeed({ release: Effect.void }),
            useSkill: (skill: number) =>
              skill === 1
                ? Deferred.succeed(cycleStarted, undefined).pipe(
                    Effect.as(true),
                  )
                : Deferred.succeed(failureStarted, undefined).pipe(
                    Effect.andThen(Deferred.await(releaseFailure)),
                    Effect.andThen(Effect.die("late cast failure")),
                  ),
          },
          (
            selector: EventSelector | undefined,
            handler: (event: Event) => Effect.Effect<void, unknown>,
          ) =>
            Effect.sync(() => {
              if (selector?.type === "update-message") onMessage = handler;
              return () => undefined;
            }),
        );
        const autoAttack = yield* makeAutoAttack(api, fibers);
        const profile = DEFAULT_COMBAT_PROFILE_LIBRARY.profiles[0]!;
        const first = {
          ...profile,
          id: "first",
          steps: [{ skill: 1 as const, conditions: [] }],
          messageTriggers: [
            {
              messageIncludes: "enrage",
              skill: 2 as const,
              source: "any" as const,
              cooldownMs: 0,
            },
          ],
        };
        const second = {
          ...profile,
          id: "second",
          steps: [{ skill: 1 as const, conditions: [] }],
        };
        const library = {
          ...DEFAULT_COMBAT_PROFILE_LIBRARY,
          profiles: [first, second],
        };
        yield* autoAttack.enable({ library, profileId: first.id });
        yield* Deferred.await(cycleStarted);
        const pendingFailure = yield* onMessage!({
          type: "update-message",
          message: "enrage",
          source: "animation",
        }).pipe(Effect.forkScoped);
        yield* Deferred.await(failureStarted);
        yield* autoAttack.enable({ library, profileId: second.id });
        yield* Deferred.succeed(releaseFailure, undefined);
        yield* Fiber.join(pendingFailure);
        expect(yield* autoAttack.getState()).toMatchObject({
          enabled: true,
          running: true,
          profileId: "second",
        });
        expect((yield* autoAttack.getState()).lastError).toBeUndefined();
      }),
  );
});
