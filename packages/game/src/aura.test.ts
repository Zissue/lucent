import { describe, expect, it } from "@effect/vitest";

import {
  LiveAura,
  reduceActiveAura,
  type ActiveAuraEdit,
  type AuraApplication,
  type AuraMutation,
  type AuraSnapshot,
} from "./aura";
import { EntityState } from "./entity";
import { LiveMonster } from "./monster";

const application: AuraApplication = {
  name: "Focus",
  stack: 5,
  timing: { type: "seconds", duration: 8 },
  persistent: true,
  restartDuration: true,
  icon: "iwd1,ied1",
  category: "buff",
  value: "Ravenous",
};
const timed: AuraSnapshot = {
  name: "Focus",
  kind: "active",
  stack: 5,
  duration: 8,
  expiresAt: 1_008_000,
  persistent: true,
  icon: "iwd1,ied1",
  category: "buff",
  value: "Ravenous",
};

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

describe("active aura reduction", () => {
  it("seeds independent full and remaining seconds", () => {
    expect(
      reduceActiveAura(
        undefined,
        {
          type: "seed",
          entry: {
            name: "Curse of Times",
            icon: "inver2",
            stack: 5,
            persistent: false,
            timer: { type: "timed", remainingSeconds: 6.4, fullSeconds: 8 },
          },
        },
        1_000_000,
      ),
    ).toEqual({
      name: "Curse of Times",
      kind: "active",
      icon: "inver2",
      stack: 5,
      persistent: false,
      duration: 8,
      expiresAt: 1_006_400,
    });
    expect(
      reduceActiveAura(
        timed,
        {
          type: "seed",
          entry: {
            name: "Focus",
            icon: "ice",
            stack: 1,
            persistent: false,
            timer: { type: "untimed" },
          },
        },
        1_000_000,
      ),
    ).toEqual({
      name: "Focus",
      kind: "active",
      icon: "ice",
      stack: 1,
      persistent: false,
      duration: 0,
      category: "buff",
      value: "Ravenous",
    });
  });

  it.each<{
    name: string;
    before: AuraSnapshot | undefined;
    edit: ActiveAuraEdit;
    now: number;
    duration: number;
    expiresAt: number | undefined;
    stack: number;
  }>([
    {
      name: "first application",
      before: undefined,
      edit: { type: "apply", entry: application },
      now: 1_000_000,
      duration: 8,
      expiresAt: 1_008_000,
      stack: 5,
    },
    {
      name: "refresh retains full duration",
      before: timed,
      edit: {
        type: "apply",
        entry: {
          ...application,
          stack: 4,
          restartDuration: false,
          timing: { type: "seconds", duration: 3 },
        },
      },
      now: 1_002_000,
      duration: 8,
      expiresAt: 1_005_000,
      stack: 4,
    },
    {
      name: "isNew restarts full duration",
      before: timed,
      edit: {
        type: "apply",
        entry: { ...application, timing: { type: "seconds", duration: 3 } },
      },
      now: 1_002_000,
      duration: 3,
      expiresAt: 1_005_000,
      stack: 5,
    },
    {
      name: "untimed application erases expiry",
      before: timed,
      edit: {
        type: "apply",
        entry: { ...application, stack: 0, timing: { type: "untimed" } },
      },
      now: 1_002_000,
      duration: 0,
      expiresAt: undefined,
      stack: 0,
    },
    {
      name: "decay retains full duration",
      before: timed,
      edit: { type: "decay", name: "Focus", stack: 2, refreshSeconds: 2 },
      now: 1_003_000,
      duration: 8,
      expiresAt: 1_005_000,
      stack: 2,
    },
    {
      name: "decay extends full duration",
      before: timed,
      edit: { type: "decay", name: "Focus", stack: 2, refreshSeconds: 12 },
      now: 1_003_000,
      duration: 12,
      expiresAt: 1_015_000,
      stack: 2,
    },
    {
      name: "zero decay retains timed state",
      before: timed,
      edit: { type: "decay", name: "Focus", stack: 2, refreshSeconds: 0 },
      now: 1_003_000,
      duration: 8,
      expiresAt: 1_003_000,
      stack: 2,
    },
    {
      name: "negative decay refreshes deadline",
      before: timed,
      edit: { type: "decay", name: "Focus", stack: 2, refreshSeconds: -2 },
      now: 1_003_000,
      duration: 8,
      expiresAt: 1_001_000,
      stack: 2,
    },
    {
      name: "missing decay time preserves deadline",
      before: timed,
      edit: { type: "decay", name: "Focus", stack: 2 },
      now: 1_003_000,
      duration: 8,
      expiresAt: 1_008_000,
      stack: 2,
    },
    {
      name: "decay does not time an untimed row",
      before: {
        name: "Focus",
        kind: "active",
        stack: 5,
        duration: 0,
        persistent: false,
      },
      edit: { type: "decay", name: "Focus", stack: 2, refreshSeconds: 12 },
      now: 1_003_000,
      duration: 0,
      expiresAt: undefined,
      stack: 2,
    },
    {
      name: "assignment preserves timer",
      before: timed,
      edit: { type: "set-stack", name: "Focus", stack: 1 },
      now: 1_003_000,
      duration: 8,
      expiresAt: 1_008_000,
      stack: 1,
    },
  ])("$name", ({ before, edit, now, duration, expiresAt, stack }) => {
    const original = before === undefined ? undefined : { ...before };
    const after = reduceActiveAura(before, edit, now);
    expect(after).toMatchObject({
      name: "Focus",
      kind: "active",
      duration,
      stack,
    });
    expect(after?.expiresAt).toBe(expiresAt);
    if (expiresAt === undefined) expect(after).not.toHaveProperty("expiresAt");
    expect(before).toEqual(original);
  });

  it.each([0, -2])(
    "clamps seed and assignment stack %s without clamping application",
    (stack) => {
      expect(
        reduceActiveAura(
          timed,
          { type: "set-stack", name: "Focus", stack },
          1_000_000,
        )?.stack,
      ).toBe(1);
      expect(
        reduceActiveAura(
          undefined,
          {
            type: "seed",
            entry: {
              name: "Focus",
              icon: "ice",
              stack,
              persistent: false,
              timer: { type: "untimed" },
            },
          },
          1_000_000,
        )?.stack,
      ).toBe(1);
      expect(
        reduceActiveAura(
          undefined,
          { type: "apply", entry: { ...application, stack } },
          1_000_000,
        )?.stack,
      ).toBe(stack);
    },
  );

  it("retains omitted metadata and explicit persistence", () => {
    expect(
      reduceActiveAura(
        timed,
        {
          type: "apply",
          entry: {
            name: "Focus",
            stack: 1,
            timing: { type: "untimed" },
            persistent: false,
            restartDuration: false,
          },
        },
        1_002_000,
      ),
    ).toEqual({
      name: "Focus",
      kind: "active",
      stack: 1,
      duration: 0,
      persistent: false,
      icon: "iwd1,ied1",
      category: "buff",
      value: "Ravenous",
    });
    const aura = new LiveAura({
      name: "Focus",
      kind: "active",
      stack: 1,
      duration: 0,
      persistent: false,
    });
    expect(aura.persistent).toBe(false);
    expect(aura.toJSON()).toEqual({
      name: "Focus",
      kind: "active",
      stack: 1,
      duration: 0,
      persistent: false,
    });
  });

  it("folds detached deltas into the complete next snapshot", () => {
    const entity = monster();
    const mutations: AuraMutation[] = [
      {
        type: "apply",
        entries: [application, { ...application, name: "focus", stack: 4 }],
      },
      {
        type: "passives",
        mode: "merge",
        entries: [
          { name: "Focus", duration: 0 },
          { name: "Brand of Chaos", duration: 0 },
        ],
      },
      {
        type: "apply",
        entries: [
          { ...application, stack: 2 },
          { ...application, stack: 3 },
        ],
      },
      {
        type: "withdraw",
        entries: [
          { type: "decay", name: "Focus", stack: 2, refreshSeconds: 2 },
        ],
      },
      {
        type: "set-stack",
        entries: [
          { name: "focus", stack: 1 },
          { name: "Missing", stack: 1 },
        ],
      },
      {
        type: "seed",
        entries: [
          {
            name: "Focus",
            icon: "ice",
            stack: 5,
            persistent: false,
            timer: { type: "untimed" },
          },
          {
            name: "Focus",
            icon: "ice",
            stack: 4,
            persistent: true,
            timer: { type: "untimed" },
          },
        ],
      },
      {
        type: "passives",
        mode: "replace",
        entries: [
          { name: "Focus", duration: 0 },
          { name: "Focus", duration: 2 },
        ],
      },
      { type: "clear", keepPersistent: true },
      { type: "withdraw", entries: [{ type: "remove", name: "Focus" }] },
      { type: "passives", mode: "replace", entries: [] },
      { type: "apply", entries: [application] },
    ];
    const saved = [];
    for (const [index, mutation] of mutations.entries()) {
      const folded = new Map(
        entity
          .toJSON()
          .auras.map((aura) => [`${aura.kind}:${aura.name}`, aura]),
      );
      const changes = entity.projectAuras(mutation, 1_000_000 + index * 1_000);
      saved.push({ changes, snapshot: JSON.stringify(changes) });
      for (const change of changes) {
        if (change.type === "removed")
          folded.delete(`${change.before.kind}:${change.before.name}`);
        else
          folded.set(`${change.after.kind}:${change.after.name}`, change.after);
      }
      expect([...folded.values()]).toEqual(entity.toJSON().auras);
    }
    expect(entity.getAura("Focus", { kind: "active" })?.stack).toBe(5);
    for (const { changes, snapshot } of saved)
      expect(JSON.stringify(changes)).toBe(snapshot);
    expect(
      entity.projectAuras({ type: "apply", entries: [application] }, 1_010_000),
    ).toEqual([]);
  });
});
