import { describe, expect, it } from "@effect/vitest";

import type { AuraApplication } from "./aura";
import { EntityState } from "./entity";
import { LiveMonster } from "./monster";

const monster = () =>
  new LiveMonster({
    aggressive: false,
    cell: "r1",
    hp: 100,
    level: 1,
    maxHp: 100,
    maxMp: 0,
    monsterId: 1,
    monsterMapId: 48,
    mp: 0,
    name: "Monster",
    race: "None",
    state: EntityState.InCombat,
  });
const focus: AuraApplication = {
  name: "Focus",
  stack: 5,
  persistent: false,
  restartDuration: false,
  timing: { type: "seconds", duration: 8 },
  icon: "iwd1,ied1",
};

describe("entity aura ownership", () => {
  it("preserves exact names and cross-kind first-match order", () => {
    const entity = monster();
    entity.projectAuras(
      {
        type: "passives",
        mode: "merge",
        entries: [{ name: "Focus", duration: 0 }],
      },
      1_000_000,
    );
    entity.projectAuras(
      {
        type: "apply",
        entries: [
          focus,
          { ...focus, name: "focus" },
          { ...focus, name: " Focus " },
        ],
      },
      1_000_000,
    );
    const passive = entity.auras[0];
    const active = entity.auras[1];
    expect(entity.auras.map((aura) => `${aura.kind}:${aura.name}`)).toEqual([
      "passive:Focus",
      "active:Focus",
      "active:focus",
      "active: Focus ",
    ]);
    expect(entity.getAura(" FOCUS ")).toBe(passive);
    expect(entity.getAura(" FOCUS ", { kind: "active" })).toBe(active);
    expect(entity.hasAura(" FoCuS ")).toBe(true);
    entity.projectAuras(
      { type: "withdraw", entries: [{ type: "remove", name: "focus" }] },
      1_000_000,
    );
    expect(entity.auras.map((aura) => `${aura.kind}:${aura.name}`)).toEqual([
      "passive:Focus",
      "active:Focus",
      "active: Focus ",
    ]);
  });

  it("updates surviving objects in place and detaches removed references", () => {
    const entity = monster();
    const added = entity.projectAuras(
      {
        type: "apply",
        entries: [{ ...focus, value: "Ravenous", category: "buff" }],
      },
      1_000_000,
    );
    const held = entity.getAura("Focus");
    const before = held?.toJSON();
    entity.projectAuras(
      {
        type: "seed",
        entries: [
          {
            name: "Focus",
            icon: "ice",
            stack: 4,
            persistent: true,
            timer: { type: "untimed" },
          },
        ],
      },
      1_002_000,
    );
    expect(entity.getAura("Focus")).toBe(held);
    expect(held?.toJSON()).toEqual({
      name: "Focus",
      kind: "active",
      stack: 4,
      duration: 0,
      persistent: true,
      icon: "ice",
      category: "buff",
      value: "Ravenous",
    });
    expect(held?.toJSON()).not.toHaveProperty("expiresAt");
    expect(before?.expiresAt).toBe(1_008_000);
    expect(added).toEqual([{ type: "added", after: before }]);
    entity.projectAuras(
      { type: "withdraw", entries: [{ type: "remove", name: "Focus" }] },
      1_003_000,
    );
    entity.projectAuras({ type: "apply", entries: [focus] }, 1_004_000);
    expect(entity.getAura("Focus")).not.toBe(held);
    expect(held?.stack).toBe(4);
    expect(entity.getAura("Focus")?.stack).toBe(5);
    expect(entity.getAura("Focus")?.value).toBeUndefined();
  });

  it("separates the server gate from metadata and admits seeds while closed", () => {
    const entity = monster();
    entity.projectAuras(
      { type: "apply", entries: [{ ...focus, persistent: true }] },
      1_000_000,
    );
    entity.projectAuras(
      {
        type: "passives",
        mode: "merge",
        entries: [{ name: "Focus", duration: 0 }],
      },
      1_000_000,
    );
    expect(
      entity.writeAuraMonsterState(0).map((change) => change.type),
    ).toEqual(["removed"]);
    expect(entity.writeAuraMonsterState(0)).toEqual([]);
    entity.update({ state: 1, hp: 100 });
    expect(
      entity.projectAuras({ type: "apply", entries: [focus] }, 1_001_000),
    ).toEqual([]);
    entity.projectAuras(
      {
        type: "seed",
        entries: [
          {
            name: "Focus",
            icon: "ice",
            stack: 4,
            persistent: true,
            timer: { type: "untimed" },
          },
        ],
      },
      1_002_000,
    );
    entity.projectAuras(
      { type: "withdraw", entries: [{ type: "remove", name: "Focus" }] },
      1_002_000,
    );
    expect(entity.getAura("Focus", { kind: "active" })?.stack).toBe(4);
    expect(entity.getAura("Focus", { kind: "passive" })?.stack).toBe(1);
    entity.projectAuras(
      { type: "set-stack", entries: [{ name: "Focus", stack: 2 }] },
      1_002_000,
    );
    expect(entity.getAura("Focus", { kind: "active" })?.stack).toBe(4);
    expect(
      entity.writeAuraMonsterState(1).map((change) => change.type),
    ).toEqual(["removed"]);
    entity.projectAuras({ type: "apply", entries: [focus] }, 1_003_000);
    expect(entity.getAura("Focus", { kind: "active" })?.stack).toBe(5);
    expect(entity.writeAuraMonsterState(2)).toEqual([]);
    expect(entity.getAura("Focus", { kind: "active" })?.stack).toBe(5);
    expect(
      entity.writeAuraMonsterState(1).map((change) => change.type),
    ).toEqual(["removed"]);
  });

  it("clears only nonpersistent active rows and replaces only passive membership", () => {
    const entity = monster();
    entity.projectAuras(
      {
        type: "apply",
        entries: [
          focus,
          { ...focus, name: "Potent Battle Elixir", persistent: true },
        ],
      },
      1_000_000,
    );
    entity.projectAuras(
      {
        type: "passives",
        mode: "merge",
        entries: [
          { name: "Focus", duration: 0 },
          { name: "Brand of Chaos", duration: 0 },
        ],
      },
      1_000_000,
    );
    expect(
      entity.projectAuras({ type: "clear", keepPersistent: true }, 1_001_000),
    ).toMatchObject([
      { type: "removed", before: { name: "Focus", kind: "active" } },
    ]);
    expect(entity.auras.map((aura) => aura.name)).toEqual([
      "Potent Battle Elixir",
      "Focus",
      "Brand of Chaos",
    ]);
    expect(
      entity.projectAuras({ type: "clear", keepPersistent: true }, 1_001_000),
    ).toEqual([]);
    const held = entity.getAura("Focus");
    entity.projectAuras(
      {
        type: "passives",
        mode: "replace",
        entries: [
          { name: "Focus", duration: 2 },
          { name: "New Class", duration: 0 },
        ],
      },
      1_002_000,
    );
    expect(entity.getAura("Focus")).toBe(held);
    expect(entity.auras.map((aura) => aura.name)).toEqual([
      "Potent Battle Elixir",
      "Focus",
      "New Class",
    ]);
    expect(entity.getAura("Focus")?.duration).toBe(2);
  });
});
