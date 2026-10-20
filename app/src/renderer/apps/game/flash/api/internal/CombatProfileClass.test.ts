import { describe, expect, it } from "@effect/vitest";
import type { CombatProfile } from "@lucent/core/combatProfiles";
import { LiveItem } from "@lucent/game";
import * as Effect from "effect/Effect";

import { getCombatProfileClassWarning } from "./CombatProfileClass";

const classItem = (name: string) =>
  new LiveItem({
    category: "Class",
    coins: false,
    context: "inventory",
    cost: 0,
    description: "",
    equipped: true,
    equipmentSlot: "ar",
    file: "",
    houseItem: false,
    itemId: 1,
    link: "",
    memberOnly: false,
    meta: "",
    name,
    quantity: 302_500,
    temporaryItem: false,
  });

const warningFor = (
  classNames: CombatProfile["classNames"],
  equipped: { readonly item?: string; readonly className: string },
) =>
  getCombatProfileClassWarning(
    {
      inventory: {
        getAll: () =>
          Effect.succeed(
            equipped.item === undefined ? [] : [classItem(equipped.item)],
          ),
      },
      player: { getClassName: () => Effect.succeed(equipped.className) },
    },
    {
      id: "profile",
      label: "Profile",
      ...(classNames === undefined ? {} : { classNames }),
      delayMs: 150,
      cooldownMode: "use-if-ready",
      steps: [],
    },
  );

describe("getCombatProfileClassWarning", () => {
  it.effect(
    "warns when the equipped class is not one of the profile's classes",
    () =>
      Effect.gen(function* () {
        expect(
          yield* warningFor(["Void Highlord", "Lord of Order"], {
            item: "Legion Revenant",
            className: "LEGION REVENANT",
          }),
        ).toBe(
          "This profile is for Void Highlord or Lord of Order, but Legion Revenant is equipped.",
        );
      }),
  );

  it.effect("matches the game's class name without case", () =>
    Effect.gen(function* () {
      expect(
        yield* warningFor(["void highlord"], {
          item: "Void Highlord (IoDA)",
          className: "VOID HIGHLORD",
        }),
      ).toBeUndefined();
    }),
  );

  it.effect("matches the equipped class item's name", () =>
    Effect.gen(function* () {
      expect(
        yield* warningFor(["Void Highlord (IoDA)"], {
          item: "Void Highlord (IoDA)",
          className: "VOID HIGHLORD",
        }),
      ).toBeUndefined();
    }),
  );

  it.effect("allows any class when the profile lists none", () =>
    Effect.gen(function* () {
      expect(
        yield* warningFor(undefined, {
          item: "Legion Revenant",
          className: "LEGION REVENANT",
        }),
      ).toBeUndefined();
    }),
  );

  it.effect("does not warn when the equipped class is unknown", () =>
    Effect.gen(function* () {
      expect(
        yield* warningFor(["Void Highlord"], { className: "" }),
      ).toBeUndefined();
    }),
  );
});
