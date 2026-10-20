import type { CombatProfile } from "@lucent/core/combatProfiles";
import * as Effect from "effect/Effect";

import type { Inventory } from "../Inventory";
import type { Player } from "../Player";

interface Dependencies {
  readonly inventory: Pick<Inventory, "getAll">;
  readonly player: Pick<Player, "getClassName">;
}

const classList = new Intl.ListFormat("en", { type: "disjunction" });

const sameClass = (left: string, right: string): boolean =>
  left.localeCompare(right, undefined, { sensitivity: "accent" }) === 0;

export const getCombatProfileClassWarning = Effect.fn(
  "getCombatProfileClassWarning",
)(function* (deps: Dependencies, profile: CombatProfile) {
  const classNames = profile.classNames ?? [];
  if (classNames.length === 0) {
    return undefined;
  }

  const classItem = (yield* deps.inventory.getAll()).find(
    (item) => item.classItem && item.equipped,
  );
  const equipped = [
    classItem?.name ?? "",
    yield* deps.player.getClassName(),
  ].filter((name) => name !== "");
  if (
    equipped.length === 0 ||
    classNames.some((expected) =>
      equipped.some((name) => sameClass(expected, name)),
    )
  ) {
    return undefined;
  }

  return `This profile is for ${classList.format(classNames)}, but ${equipped[0]} is equipped.`;
});
