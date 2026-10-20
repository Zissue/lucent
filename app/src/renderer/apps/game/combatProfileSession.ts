import type { CombatProfile } from "@lucent/core/combatProfiles";
import { EntityState, type Monster, type MonsterQuery } from "@lucent/game";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";

import {
  castCombatProfileMessageTriggers,
  castNextCombatProfileStep,
  makeCombatProfileCursor,
  makeCombatProfileMessageTriggerState,
  matchesCombatProfileMessageTrigger,
  resetCombatProfileCursor,
  type CombatProfileMessageTriggerEvent,
  type CombatProfileRuntimeDeps,
} from "./combatProfiles";

export const COMBAT_PROFILE_RETRY_DELAY_MS = 250;
export const COMBAT_PROFILE_TARGET_ABSENCE_GRACE_MS = 500;

const idleCycle = {
  delayMs: COMBAT_PROFILE_RETRY_DELAY_MS,
  kind: "idle",
} as const;

export type CombatProfileRunFailureStage =
  | "attack"
  | "message-trigger"
  | "profile-cast"
  | "target-selection";

const failureMessage = (
  stage: CombatProfileRunFailureStage,
  cause: Cause.Cause<never>,
): string => {
  const squashed = Cause.squash(cause);
  if (squashed instanceof Error && squashed.message !== "") {
    return squashed.message;
  }
  if (typeof squashed === "string" && squashed !== "") {
    return squashed;
  }

  const pretty = Cause.pretty(cause).split("\n")[0];
  return pretty === undefined || pretty === ""
    ? `Combat profile ${stage} failed`
    : pretty;
};

export class CombatProfileRunError extends Error {
  readonly _tag = "CombatProfileRunError";

  constructor(
    readonly stage: CombatProfileRunFailureStage,
    readonly failureCause: Cause.Cause<never>,
  ) {
    super(failureMessage(stage, failureCause));
    this.name = "CombatProfileRunError";
  }
}

export type CombatProfileCycleResult =
  | {
      readonly delayMs: typeof COMBAT_PROFILE_RETRY_DELAY_MS;
      readonly kind: "attack-rejected" | "idle" | "no-target" | "player-dead";
    }
  | {
      readonly cast: boolean;
      readonly delayMs: number;
      readonly kind: "attacked";
    };

export interface CombatProfileSessionCycleOptions {
  readonly beforeAttack?: (target: Monster) => Effect.Effect<void>;
}

export interface CombatProfileSessionPreparation {
  readonly dependencies: CombatProfileRuntimeDeps;
  readonly release: Effect.Effect<void>;
  readonly warnings: Effect.Effect<readonly string[]>;
}

export interface CombatProfileSessionDependencies {
  readonly attack: (monsterMapId: number) => Effect.Effect<boolean>;
  readonly getAvailableMonsters: () => Effect.Effect<readonly Monster[]>;
  readonly isAttackBlocked: (monsterMapId: number) => Effect.Effect<boolean>;
  readonly isPlayerAlive: () => Effect.Effect<boolean>;
  readonly onMessage: (
    handler: (event: CombatProfileMessageTriggerEvent) => Effect.Effect<void>,
  ) => Effect.Effect<() => void>;
  readonly onMonsterDeath: (
    handler: (monsterMapId: number) => Effect.Effect<void>,
  ) => Effect.Effect<() => void>;
  readonly prepare: (
    profile: CombatProfile,
  ) => Effect.Effect<CombatProfileSessionPreparation>;
}

export interface CombatProfileSessionOptions {
  readonly allowTargetFallback?: boolean;
  readonly onAsyncFailure?: (
    failure: CombatProfileRunError,
  ) => Effect.Effect<void>;
  readonly profile: CombatProfile;
  readonly targetPriority: readonly MonsterQuery[];
}

export interface CombatProfileTargetSelectionOptions {
  readonly allowFallback?: boolean;
  readonly blockedMonsterMapIds?: ReadonlySet<number>;
  readonly currentMonsterMapId?: number;
}

interface ActiveTarget {
  readonly confirmed: boolean;
  readonly missingSinceMs: number | undefined;
  readonly monsterMapId: number;
}

interface SessionState {
  /** Invalidates in-flight actions whenever target ownership changes. */
  readonly generation: number;
  readonly resetPending: boolean;
  readonly target: ActiveTarget | undefined;
}

interface TargetLease {
  readonly generation: number;
  readonly monster: Monster;
}

interface DeathAction {
  readonly generation: number;
  readonly reset: boolean;
}

const withFailureStage = <A, R>(
  stage: CombatProfileRunFailureStage,
  effect: Effect.Effect<A, never, R>,
): Effect.Effect<A, CombatProfileRunError, R> =>
  effect.pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.failCause(cause)
        : Effect.fail(new CombatProfileRunError(stage, cause)),
    ),
  );

const isLiving = (monster: Monster): boolean =>
  monster.hp > 0 && monster.state !== EntityState.Dead;

const targetRank = (
  monster: Monster,
  priorities: readonly MonsterQuery[],
  allowFallback: boolean,
): number | undefined => {
  const rank = priorities.findIndex((query) => monster.matches(query));
  if (rank >= 0) return rank;
  return allowFallback ? priorities.length : undefined;
};

/** Retains an eligible current target unless a strictly higher rank appears. */
export const selectCombatProfileTarget = (
  monsters: readonly Monster[],
  priorities: readonly MonsterQuery[],
  options: CombatProfileTargetSelectionOptions = {},
): Monster | undefined => {
  const allowFallback = options.allowFallback ?? true;
  const ranked = monsters
    .filter(
      (monster) =>
        isLiving(monster) &&
        options.blockedMonsterMapIds?.has(monster.monsterMapId) !== true,
    )
    .map((monster) => ({
      monster,
      rank: targetRank(monster, priorities, allowFallback),
    }))
    .filter(
      (
        candidate,
      ): candidate is { readonly monster: Monster; readonly rank: number } =>
        candidate.rank !== undefined,
    );

  const best = ranked.reduce<(typeof ranked)[number] | undefined>(
    (current, candidate) =>
      current === undefined || candidate.rank < current.rank
        ? candidate
        : current,
    undefined,
  );
  if (best === undefined) return undefined;

  const current = ranked.find(
    (candidate) =>
      candidate.monster.monsterMapId === options.currentMonsterMapId,
  );
  return current !== undefined && current.rank <= best.rank
    ? current.monster
    : best.monster;
};

/** Owns one scoped profile rotation, target lease, and event subscriptions. */
export const makeCombatProfileSession = Effect.fn("makeCombatProfileSession")(
  function* (
    dependencies: CombatProfileSessionDependencies,
    options: CombatProfileSessionOptions,
  ) {
    if (
      options.profile.steps.length === 0 &&
      (options.profile.messageTriggers?.length ?? 0) === 0
    ) {
      return {
        runCycle: () => Effect.succeed(idleCycle),
        warnings: Effect.succeed([]),
      };
    }
    const cursor = yield* makeCombatProfileCursor();
    const messageState = yield* makeCombatProfileMessageTriggerState();
    const actionGate = yield* Semaphore.make(1);
    const state = yield* Ref.make<SessionState>({
      generation: 0,
      resetPending: false,
      target: undefined,
    });
    const prepared = yield* Effect.acquireRelease(
      dependencies.prepare(options.profile),
      (result) => result.release,
    );

    const handleMonsterDeath = Effect.fn(
      "CombatProfileSession.handleMonsterDeath",
    )(function* (monsterMapId: number) {
      const action = yield* Ref.modify(
        state,
        (current): readonly [DeathAction | undefined, SessionState] => {
          if (current.target?.monsterMapId !== monsterMapId) {
            return [undefined, current];
          }

          const generation = current.generation + 1;
          const reset =
            current.target.confirmed &&
            options.profile.resetSkillIndexOnTargetDeath === true;
          return [
            { generation, reset },
            {
              generation,
              resetPending: reset,
              target: undefined,
            },
          ];
        },
      );
      if (action === undefined || !action.reset) return;

      yield* resetCombatProfileCursor(cursor);
      yield* Ref.update(state, (current) =>
        current.generation === action.generation
          ? { ...current, resetPending: false }
          : current,
      );
    });

    const disposeMonsterDeath =
      yield* dependencies.onMonsterDeath(handleMonsterDeath);
    yield* Effect.addFinalizer(() => Effect.sync(disposeMonsterDeath));

    if ((options.profile.messageTriggers?.length ?? 0) > 0) {
      const disposeMessages = yield* dependencies.onMessage((event) =>
        withFailureStage(
          "message-trigger",
          Effect.gen(function* () {
            if (
              !options.profile.messageTriggers?.some((trigger) =>
                matchesCombatProfileMessageTrigger(trigger, event),
              )
            ) {
              return;
            }
            const observed = yield* Ref.get(state);
            if (observed.resetPending) return;

            yield* actionGate.withPermits(1)(
              Effect.gen(function* () {
                const current = yield* Ref.get(state);
                if (
                  current.resetPending ||
                  current.generation !== observed.generation
                ) {
                  return;
                }
                if (!(yield* dependencies.isPlayerAlive())) return;

                const selected =
                  yield* prepared.dependencies.combat.target.get();
                const selectedIsAlive =
                  selected !== null &&
                  selected.hp > 0 &&
                  selected.state !== EntityState.Dead;
                const ownedMonsterMapId = current.target?.confirmed
                  ? current.target.monsterMapId
                  : undefined;
                if (
                  event.monsterMapId !== undefined &&
                  ((ownedMonsterMapId !== undefined &&
                    event.monsterMapId !== ownedMonsterMapId) ||
                    (selectedIsAlive &&
                      (selected.type !== "monster" ||
                        selected.monsterMapId !== event.monsterMapId)))
                ) {
                  return;
                }

                const monsterMapId =
                  event.monsterMapId ??
                  (selectedIsAlive && selected.type === "monster"
                    ? selected.monsterMapId
                    : ownedMonsterMapId);
                if (monsterMapId !== undefined) {
                  const monsters = yield* dependencies.getAvailableMonsters();
                  const monster = monsters.find(
                    (candidate) => candidate.monsterMapId === monsterMapId,
                  );
                  if (
                    monster === undefined ||
                    !isLiving(monster) ||
                    targetRank(
                      monster,
                      options.targetPriority,
                      options.allowTargetFallback ?? true,
                    ) === undefined ||
                    (yield* dependencies.isAttackBlocked(monsterMapId))
                  ) {
                    return;
                  }
                }

                const beforeCast = yield* Ref.get(state);
                if (
                  beforeCast.resetPending ||
                  beforeCast.generation !== observed.generation
                ) {
                  return;
                }
                yield* castCombatProfileMessageTriggers(
                  prepared.dependencies,
                  options.profile,
                  event,
                  messageState,
                );
              }),
            );
          }),
        ).pipe(
          Effect.catch((failure) =>
            options.onAsyncFailure === undefined
              ? Effect.logError(
                  "Combat profile message trigger failed",
                  failure.failureCause,
                ).pipe(Effect.annotateLogs({ component: "combat" }))
              : options.onAsyncFailure(failure),
          ),
        ),
      );
      yield* Effect.addFinalizer(() => Effect.sync(disposeMessages));
    }

    const resolveTarget = Effect.fn("CombatProfileSession.resolveTarget")(
      function* (
        monsters: readonly Monster[],
      ): Effect.fn.Return<TargetLease | undefined> {
        const initial = yield* Ref.get(state);
        if (initial.resetPending) return undefined;

        const allowFallback = options.allowTargetFallback ?? true;
        const active = initial.target;
        const projected =
          active === undefined
            ? undefined
            : monsters.find(
                (monster) => monster.monsterMapId === active.monsterMapId,
              );
        const projectedRank =
          projected === undefined
            ? undefined
            : targetRank(projected, options.targetPriority, allowFallback);
        const activeIsEligible =
          projected !== undefined &&
          isLiving(projected) &&
          projectedRank !== undefined;
        const activeHasAffinity =
          activeIsEligible && active?.confirmed === true;

        if (
          active !== undefined &&
          projected === undefined &&
          active.confirmed
        ) {
          // A single missing snapshot is common during projection and cell churn.
          const now = yield* Clock.currentTimeMillis;
          if (active.missingSinceMs === undefined) {
            yield* Ref.update(state, (current) =>
              current.generation === initial.generation &&
              current.target?.monsterMapId === active.monsterMapId
                ? {
                    ...current,
                    target: { ...current.target, missingSinceMs: now },
                  }
                : current,
            );
            return undefined;
          }
          if (
            now - active.missingSinceMs <
            COMBAT_PROFILE_TARGET_ABSENCE_GRACE_MS
          ) {
            return undefined;
          }
        }

        const eligible = monsters.filter(
          (monster) =>
            isLiving(monster) &&
            targetRank(monster, options.targetPriority, allowFallback) !==
              undefined,
        );
        const blocked = new Set<number>();
        for (const monster of eligible) {
          if (yield* dependencies.isAttackBlocked(monster.monsterMapId)) {
            blocked.add(monster.monsterMapId);
          }
        }

        const selected = selectCombatProfileTarget(
          eligible,
          options.targetPriority,
          {
            allowFallback,
            blockedMonsterMapIds: blocked,
            ...(activeHasAffinity && active !== undefined
              ? { currentMonsterMapId: active.monsterMapId }
              : {}),
          },
        );
        if (selected === undefined) {
          if (active !== undefined && !activeIsEligible) {
            yield* Ref.update(state, (current) =>
              current.generation === initial.generation
                ? {
                    generation: current.generation + 1,
                    resetPending: current.resetPending,
                    target: undefined,
                  }
                : current,
            );
          }
          return undefined;
        }

        return yield* Ref.modify(
          state,
          (current): readonly [TargetLease | undefined, SessionState] => {
            if (
              current.generation !== initial.generation ||
              current.resetPending
            ) {
              return [undefined, current];
            }

            if (current.target?.monsterMapId === selected.monsterMapId) {
              return [
                { generation: current.generation, monster: selected },
                {
                  ...current,
                  target: {
                    ...current.target,
                    missingSinceMs: undefined,
                  },
                },
              ];
            }

            const generation = current.generation + 1;
            return [
              { generation, monster: selected },
              {
                generation,
                resetPending: false,
                target: {
                  confirmed: false,
                  missingSinceMs: undefined,
                  monsterMapId: selected.monsterMapId,
                },
              },
            ];
          },
        );
      },
    );

    const leaseIsCurrent = (lease: TargetLease) =>
      Ref.get(state).pipe(
        Effect.map(
          (current) =>
            !current.resetPending &&
            current.generation === lease.generation &&
            current.target?.monsterMapId === lease.monster.monsterMapId,
        ),
      );

    const confirmLease = (lease: TargetLease) =>
      Ref.modify(state, (current): readonly [boolean, SessionState] => {
        if (
          current.resetPending ||
          current.generation !== lease.generation ||
          current.target?.monsterMapId !== lease.monster.monsterMapId
        ) {
          return [false, current];
        }
        return [
          true,
          {
            ...current,
            target: {
              ...current.target,
              confirmed: true,
              missingSinceMs: undefined,
            },
          },
        ];
      });

    const runCycle = Effect.fn("CombatProfileSession.runCycle")(function* (
      cycleOptions: CombatProfileSessionCycleOptions = {},
    ): Effect.fn.Return<CombatProfileCycleResult, CombatProfileRunError> {
      return yield* actionGate.withPermits(1)(
        Effect.gen(function* () {
          if (options.profile.steps.length === 0) {
            return idleCycle;
          }
          const alive = yield* withFailureStage(
            "target-selection",
            dependencies.isPlayerAlive(),
          );
          if (!alive) {
            return {
              delayMs: COMBAT_PROFILE_RETRY_DELAY_MS,
              kind: "player-dead",
            } as const;
          }

          const monsters = yield* withFailureStage(
            "target-selection",
            dependencies.getAvailableMonsters(),
          );
          const lease = yield* withFailureStage(
            "target-selection",
            resolveTarget(monsters),
          );
          if (lease === undefined) {
            return {
              delayMs: COMBAT_PROFILE_RETRY_DELAY_MS,
              kind: "no-target",
            } as const;
          }

          if (cycleOptions.beforeAttack !== undefined) {
            yield* withFailureStage(
              "target-selection",
              cycleOptions.beforeAttack(lease.monster),
            );
          }
          if (!(yield* leaseIsCurrent(lease))) {
            return {
              delayMs: COMBAT_PROFILE_RETRY_DELAY_MS,
              kind: "no-target",
            } as const;
          }

          const attacked = yield* withFailureStage(
            "attack",
            dependencies.attack(lease.monster.monsterMapId),
          );
          if (!attacked) {
            return {
              delayMs: COMBAT_PROFILE_RETRY_DELAY_MS,
              kind: "attack-rejected",
            } as const;
          }
          if (
            !(yield* confirmLease(lease)) ||
            !(yield* leaseIsCurrent(lease))
          ) {
            return {
              delayMs: COMBAT_PROFILE_RETRY_DELAY_MS,
              kind: "no-target",
            } as const;
          }

          const cast = yield* withFailureStage(
            "profile-cast",
            castNextCombatProfileStep(
              prepared.dependencies,
              options.profile,
              cursor,
              lease.monster,
            ),
          );
          return {
            cast,
            delayMs: cast
              ? Math.max(50, options.profile.delayMs)
              : COMBAT_PROFILE_RETRY_DELAY_MS,
            kind: "attacked",
          } as const;
        }),
      );
    });

    return { runCycle, warnings: prepared.warnings };
  },
);

export type CombatProfileSession = Effect.Success<
  ReturnType<typeof makeCombatProfileSession>
>;
