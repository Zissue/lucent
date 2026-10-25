import type { EnvironmentState } from "@lucent/core/environment";
import type { BoostType } from "@lucent/game";
import type * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";

export interface EnvironmentBoostCandidate {
  readonly category: string;
  readonly link: string;
  readonly name: string;
}

export const environmentBoostTypeFromLink = (
  link: string,
): BoostType | undefined => {
  const [prefix] = link.toLowerCase().split("::");

  switch (prefix) {
    case "xpboost":
      return "exp";
    case "gboost":
      return "gold";
    case "repboost":
      return "rep";
    case "cpboost":
      return "classPoints";
    default:
      return undefined;
  }
};

export const selectEnvironmentBoost = Effect.fn("Environment.selectBoost")(
  function* (
    names: readonly string[],
    getItem: (
      name: string,
    ) => Effect.Effect<EnvironmentBoostCandidate | null, unknown>,
    hasActiveBoost: (type: BoostType) => Effect.Effect<boolean, unknown>,
    onFailure: (cause: Cause.Cause<unknown>) => Effect.Effect<void> = () =>
      Effect.void,
  ) {
    for (const name of names) {
      const item = yield* getItem(name).pipe(
        Effect.catchCause((cause) => onFailure(cause).pipe(Effect.as(null))),
      );
      if (item === null || item.category !== "ServerUse") {
        continue;
      }

      const type = environmentBoostTypeFromLink(item.link);
      if (type === undefined) {
        continue;
      }

      const active = yield* hasActiveBoost(type).pipe(
        Effect.catchCause((cause) => onFailure(cause).pipe(Effect.as(true))),
      );
      if (!active) {
        return item;
      }
    }

    return null;
  },
);

export const runEnvironmentCycleWhenLoggedIn = (
  isLoggedIn: Effect.Effect<boolean, unknown>,
  cycle: Effect.Effect<void, unknown>,
): Effect.Effect<void, unknown> =>
  isLoggedIn.pipe(
    Effect.flatMap((loggedIn) => (loggedIn ? cycle : Effect.void)),
  );

const areStringArraysEqual = (
  left: readonly string[],
  right: readonly string[],
): boolean =>
  left.length === right.length &&
  left.every((value, index) => value === right[index]);

export const shouldReconcileEnvironmentDrops = (
  previous: EnvironmentState,
  next: EnvironmentState,
): boolean =>
  next.automation.drops &&
  (!previous.automation.drops ||
    previous.itemRules.rejectElse !== next.itemRules.rejectElse ||
    !areStringArraysEqual(previous.itemNames, next.itemNames) ||
    !areStringArraysEqual(previous.itemRules.buckets, next.itemRules.buckets));
