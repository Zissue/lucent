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

  const matches = (name: string) =>
    classNames.some((expected) => sameClass(expected, name));

  const itemName =
    (yield* deps.inventory.getAll()).find(
      (item) => item.classItem && item.equipped,
    )?.name ?? "";
  if (matches(itemName)) {
    return undefined;
  }
  const className = yield* deps.player.getClassName();
  if (matches(className)) {
    return undefined;
  }

  const equipped = itemName || className;
  return equipped === ""
    ? undefined
    : `This profile is for ${classList.format(classNames)}, but ${equipped} is equipped.`;
});
