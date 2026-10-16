import type { CombatProfile } from "@lucent/core/combatProfiles";
import type { Monster, MonsterQuery } from "@lucent/game";
import * as Effect from "effect/Effect";

import { makeCombatProfileRuntimeDeps } from "../../combatProfiles";
import {
  makeCombatProfileSession,
  type CombatProfileRunError,
} from "../../combatProfileSession";
import type { ApiService } from "../../flash/api/Api";

export {
  COMBAT_PROFILE_RETRY_DELAY_MS,
  COMBAT_PROFILE_TARGET_ABSENCE_GRACE_MS,
  CombatProfileRunError,
  selectCombatProfileTarget,
} from "../../combatProfileSession";
export type {
  CombatProfileCycleResult,
  CombatProfileRunFailureStage,
} from "../../combatProfileSession";

export interface CombatProfileRunnerCycleOptions {
  readonly beforeAttack?: (target: Monster) => Effect.Effect<void>;
}

export interface CombatProfileRunnerOptions {
  readonly onAsyncFailure?: (
    failure: CombatProfileRunError,
  ) => Effect.Effect<void>;
  readonly profile: CombatProfile;
  readonly targetPriority: readonly MonsterQuery[];
}

export const makeCombatProfileRunner = Effect.fn("makeCombatProfileRunner")(
  function* (api: ApiService, options: CombatProfileRunnerOptions) {
    const session = yield* makeCombatProfileSession(
      {
        attack: api.combat.attack,
        getAvailableMonsters: api.monsterLookup.getAvailable,
        isAttackBlocked: api.combat.isAttackBlocked,
        isPlayerAlive: api.player.isAlive,
        onMessage: (handler) =>
          api.events.on({ type: "update-message" }, (event) =>
            handler({
              message: event.message,
              ...(event.monsterMapId === undefined
                ? {}
                : { monsterMapId: event.monsterMapId }),
              source: event.source,
            }),
          ),
        onMonsterDeath: (handler) =>
          api.events.on({ type: "monster-death" }, (event) =>
            handler(event.monsterMapId),
          ),
        prepare: (profile) =>
          api.combat.prepareCombatProfileConsumable(profile).pipe(
            Effect.map((prepared) => ({
              dependencies: makeCombatProfileRuntimeDeps(
                api.combat,
                api.player,
                api.players,
                prepared.skill5ItemId,
              ),
              release: prepared.release,
              ...(prepared.warning === undefined
                ? {}
                : { warning: prepared.warning }),
            })),
          ),
      },
      {
        ...(options.onAsyncFailure === undefined
          ? {}
          : { onAsyncFailure: options.onAsyncFailure }),
        profile: options.profile,
        targetPriority: options.targetPriority,
      },
    );

    const runCycle = Effect.fn("CombatProfileRunner.runCycle")(function* (
      cycleOptions: CombatProfileRunnerCycleOptions = {},
    ) {
      return yield* session.runCycle(cycleOptions);
    });

    return {
      runCycle,
      ...(session.warning === undefined ? {} : { warning: session.warning }),
    };
  },
);

export type CombatProfileRunner = Effect.Success<
  ReturnType<typeof makeCombatProfileRunner>
>;
