import type {
  CombatProfile,
  CombatProfileLibrary,
} from "@lucent/core/combatProfiles";
import { getCombatProfileById } from "@lucent/core/combatProfiles";
import { parseMonsterMapId } from "@lucent/game";
import type { MonsterQuery } from "@lucent/game";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type * as FiberMapType from "effect/FiberMap";

import type { ApiService } from "../flash/api/Api";
import { makeCombatProfileRunner } from "./combat/CombatProfileRunner";

export interface AutoAttackStartOptions {
  readonly library: CombatProfileLibrary;
  readonly profileId: string;
  readonly targetPriority?: readonly MonsterQuery[];
}

export interface AutoAttackState {
  readonly enabled: boolean;
  readonly lastError?: string;
  readonly profileId?: string;
  readonly profileLabel?: string;
  readonly running: boolean;
  readonly warnings: readonly string[];
}

interface State {
  readonly enabled: boolean;
  readonly lastError: string | undefined;
  readonly profile: CombatProfile | undefined;
  readonly runId: number;
  readonly warnings: readonly string[];
}

const key = "auto-attack";
const separator = /[,;\n]+/u;

export const parseAutoAttackTargetPriority = (
  value: string,
): readonly MonsterQuery[] =>
  value
    .split(separator)
    .map((token) => token.trim())
    .filter(Boolean)
    .map((token) => {
      const monsterMapId = parseMonsterMapId(token);
      return monsterMapId ?? token;
    });

const publicState = (state: State, running: boolean): AutoAttackState => ({
  enabled: state.enabled,
  running,
  ...(state.lastError === undefined ? {} : { lastError: state.lastError }),
  ...(state.profile === undefined
    ? {}
    : { profileId: state.profile.id, profileLabel: state.profile.label }),
  warnings: state.warnings,
});

export const makeAutoAttack = Effect.fnUntraced(function* (
  api: ApiService,
  fibers: FiberMapType.FiberMap<string>,
) {
  const state = yield* SubscriptionRef.make<State>({
    enabled: false,
    lastError: undefined,
    profile: undefined,
    runId: 0,
    warnings: [],
  });
  const wakeups = yield* Queue.sliding<void>(1);
  const getState = () =>
    Effect.all({
      running: FiberMap.has(fibers, key),
      state: SubscriptionRef.get(state),
    }).pipe(Effect.map(({ running, state }) => publicState(state, running)));

  const changes = SubscriptionRef.changes(state).pipe(
    Stream.mapEffect((current) =>
      FiberMap.has(fibers, key).pipe(
        Effect.map((running) => publicState(current, running)),
      ),
    ),
  );

  const failRun = (runId: number, lastError: string) =>
    SubscriptionRef.modify(state, (current): readonly [boolean, State] =>
      current.runId === runId
        ? [
            true,
            {
              ...current,
              enabled: false,
              lastError,
              profile: undefined,
              warnings: [],
            },
          ]
        : [false, current],
    ).pipe(
      Effect.flatMap((failed) =>
        failed ? Queue.offer(wakeups, undefined) : Effect.void,
      ),
    );

  const loop = (
    runId: number,
    profile: CombatProfile,
    priorities: readonly MonsterQuery[],
  ) =>
    Effect.scoped(
      Effect.gen(function* () {
        const runner = yield* makeCombatProfileRunner(api, {
          onAsyncFailure: (failure) => failRun(runId, failure.message),
          profile,
          targetPriority: priorities,
        });
        if (runner.warnings.length > 0) {
          yield* SubscriptionRef.update(state, (current) =>
            current.runId === runId
              ? { ...current, warnings: runner.warnings }
              : current,
          );
        }

        while (true) {
          const current = yield* SubscriptionRef.get(state);
          if (!current.enabled || current.runId !== runId) {
            return;
          }

          const result = yield* runner.runCycle();
          yield* Effect.raceFirst(
            Effect.sleep(result.delayMs),
            Queue.take(wakeups),
          );
        }
      }),
    ).pipe(
      Effect.catchTag("CombatProfileRunError", (failure) =>
        failRun(runId, failure.message),
      ),
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.void
          : failRun(
              runId,
              Cause.pretty(cause).split("\n")[0] ?? "Auto attack failed",
            ),
      ),
      Effect.ensuring(
        Effect.all([api.combat.cancelAutoAttack(), api.combat.cancelTarget()], {
          discard: true,
        }),
      ),
    );

  const disable = () =>
    FiberMap.remove(fibers, key).pipe(
      Effect.andThen(Queue.clear(wakeups)),
      Effect.andThen(
        SubscriptionRef.update(state, (current) => ({
          enabled: false,
          lastError: undefined,
          profile: undefined,
          runId: current.runId + 1,
          warnings: [],
        })),
      ),
      Effect.andThen(getState()),
    );

  const enable = (options: AutoAttackStartOptions) =>
    Effect.gen(function* () {
      const profile = getCombatProfileById(options.library, options.profileId);
      const runId = yield* SubscriptionRef.modify(
        state,
        (current): readonly [number, State] => {
          const nextRunId = current.runId + 1;
          return [
            nextRunId,
            {
              enabled: true,
              lastError: undefined,
              profile,
              runId: nextRunId,
              warnings: [],
            },
          ];
        },
      );
      yield* Queue.clear(wakeups);
      yield* FiberMap.run(
        fibers,
        key,
        loop(runId, profile, options.targetPriority ?? []),
      );
      return yield* getState();
    });

  const isEnabled = () =>
    SubscriptionRef.get(state).pipe(Effect.map((current) => current.enabled));

  return {
    changes,
    disable,
    enable,
    getState,
    isEnabled,
  };
});

export type AutoAttack = Effect.Success<ReturnType<typeof makeAutoAttack>>;
