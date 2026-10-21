import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  COMBAT_PROFILE_LIBRARY_VERSION,
  CombatProfileLibrarySchema,
  CombatProfileNormalizationError,
  DEFAULT_COMBAT_PROFILE_ID,
  duplicateCombatProfile,
  type CombatProfileLibrary,
  getCombatProfileById,
  isCombatProfileDefinition,
  normalizeCombatProfile,
  normalizeCombatProfileLibrary,
  serializeCombatProfileLibrary,
} from "./combatProfiles";

const genericProfile = {
  id: DEFAULT_COMBAT_PROFILE_ID,
  label: "Generic",
  delayMs: 150,
  cooldownMode: "use-if-ready",
  steps: ([1, 2, 3, 4] as const).map((skill) => ({
    skill,
    conditions: [],
  })),
} satisfies CombatProfileLibrary["profiles"][number];

const canonicalLibrary = {
  version: COMBAT_PROFILE_LIBRARY_VERSION,
  profiles: [
    genericProfile,
    {
      id: "archpaladin-farm",
      label: "Farm Rotation",
      classNames: ["ArchPaladin"],
      consumable: "Potent Honor Potion",
      delayMs: 150,
      cooldownMode: "use-if-ready",
      steps: [
        {
          skill: 1,
          priority: true,
          conditions: [
            {
              type: "self-hp",
              op: "<=",
              value: 80,
              unit: "percent",
            },
          ],
        },
      ],
      messageTriggers: [
        {
          messageIncludes: "enrage",
          skill: 5,
          source: "animation",
          cooldownMs: 1_000,
        },
      ],
    },
    {
      ...genericProfile,
      id: "triggers-only",
      steps: [],
      messageTriggers: [{ messageIncludes: "enrage", skill: 5, source: "any" }],
    },
    { ...genericProfile, id: "idle", steps: [] },
  ],
} satisfies CombatProfileLibrary;

describe("combatProfiles", () => {
  it("keeps canonical libraries stable", () => {
    expect(
      Schema.decodeUnknownSync(CombatProfileLibrarySchema)(canonicalLibrary),
    ).toEqual(canonicalLibrary);
    expect(normalizeCombatProfileLibrary(canonicalLibrary)).toEqual(
      canonicalLibrary,
    );
    expect(serializeCombatProfileLibrary(canonicalLibrary)).toEqual(
      canonicalLibrary,
    );
  });

  it("normalizes library envelopes around the generic profile", () => {
    const normalized = normalizeCombatProfileLibrary({
      version: 1,
      profiles: [
        {
          id: "custom",
          label: "Custom",
          consumable: "Potion",
          steps: [{ skill: 1 }],
        },
        { label: "No Id", steps: [{ skill: 2 }] },
        {
          id: DEFAULT_COMBAT_PROFILE_ID,
          label: "Generic Custom",
          steps: [{ skill: 3 }],
        },
      ],
    });

    expect(normalized.version).toBe(COMBAT_PROFILE_LIBRARY_VERSION);
    expect(normalized.profiles.map((profile) => profile.id)).toEqual([
      DEFAULT_COMBAT_PROFILE_ID,
      "custom",
    ]);
    expect(normalized.profiles[0]?.label).toBe("Generic Custom");
    expect(normalized.profiles[1]?.consumable).toBe("Potion");
    expect(getCombatProfileById(normalized, "missing")).toEqual(
      normalized.profiles[0],
    );
  });

  it("recovers colliding profile ids without dropping definitions", () => {
    const normalized = normalizeCombatProfileLibrary({
      profiles: [
        {
          id: "dupe",
          label: "First",
          steps: [{ skill: 1 }, { skill: 2 }, { skill: 3 }],
          messageTriggers: [
            { messageIncludes: "first", skill: 1 },
            { messageIncludes: "second", skill: 2 },
            { messageIncludes: "third", skill: 3 },
          ],
        },
        { id: "dupe", label: "Second", steps: [{ skill: 4 }] },
        { id: "dupe-2", label: "Reserved", steps: [{ skill: 5 }] },
      ],
    });

    expect(normalized.profiles.map((profile) => profile.id)).toEqual([
      DEFAULT_COMBAT_PROFILE_ID,
      "dupe",
      "dupe-3",
      "dupe-2",
    ]);
    expect(normalized.profiles.map((profile) => profile.label)).toEqual([
      "Generic",
      "First",
      "Second",
      "Reserved",
    ]);
    expect(normalized.profiles[1]?.steps.map((step) => step.skill)).toEqual([
      1, 2, 3,
    ]);
    expect(
      normalized.profiles[1]?.messageTriggers?.map((trigger) => trigger.skill),
    ).toEqual([1, 2, 3]);
    expect(normalizeCombatProfileLibrary(normalized)).toEqual(normalized);

    const unicodeId = `${"a".repeat(77)}😀`;
    const suffixedUnicodeId = `${"a".repeat(77)}-2`;
    const unicodeNormalized = normalizeCombatProfileLibrary({
      profiles: [
        {
          id: unicodeId,
          label: "Unicode First",
          steps: [{ skill: 1 }, { skill: 2 }],
          messageTriggers: [
            { messageIncludes: "first", skill: 1 },
            { messageIncludes: "second", skill: 2 },
          ],
        },
        { id: unicodeId, label: "Unicode Second", steps: [{ skill: 3 }] },
      ],
    });
    expect(unicodeNormalized.profiles.map((profile) => profile.id)).toEqual([
      DEFAULT_COMBAT_PROFILE_ID,
      unicodeId,
      suffixedUnicodeId,
    ]);
  });

  it("rejects future library versions", () => {
    expect(() =>
      normalizeCombatProfileLibrary({
        version: COMBAT_PROFILE_LIBRARY_VERSION + 1,
        profiles: [],
      }),
    ).toThrow(CombatProfileNormalizationError);
  });

  it("trims explicit ids without changing their shape", () => {
    expect(
      normalizeCombatProfile({
        id: " Boss Profile #1 ",
        label: "Boss",
        steps: [{ skill: 1 }],
      }).id,
    ).toBe("Boss Profile #1");
  });

  it("normalizes script profile definitions into runnable profiles", () => {
    const definition = {
      cooldownMode: "wait-for-cooldown" as const,
      steps: [{ skill: 1, cooldownMode: "use-if-ready" as const }],
    };

    expect(isCombatProfileDefinition(definition)).toBe(true);
    expect(normalizeCombatProfile(definition)).toEqual({
      id: DEFAULT_COMBAT_PROFILE_ID,
      label: "Profile",
      delayMs: 150,
      cooldownMode: "wait-for-cooldown",
      steps: [
        {
          skill: 1,
          conditions: [],
          cooldownMode: "use-if-ready",
        },
      ],
    });
    expect(normalizeCombatProfile({ steps: [] }).steps).toEqual([]);
  });

  it("duplicates profiles with a fresh id and a unique label", () => {
    const source = normalizeCombatProfile(canonicalLibrary.profiles[1]!);
    const duplicate = duplicateCombatProfile(
      source,
      [
        ...canonicalLibrary.profiles,
        { ...source, id: "copy-1", label: "Farm Rotation Copy" },
        { ...source, id: "copy-2", label: "Farm Rotation Copy 2" },
      ],
      () => "copy-profile-1",
    );

    expect(duplicate).toMatchObject({
      id: "copy-profile-1",
      label: "Farm Rotation Copy 3",
      classNames: ["ArchPaladin"],
      consumable: "Potent Honor Potion",
      steps: [{ skill: 1, priority: true }],
      messageTriggers: [{ messageIncludes: "enrage" }],
    });
    expect(duplicate.steps[0]).not.toBe(source.steps[0]);
    expect(duplicate.steps[0]?.conditions[0]).not.toBe(
      source.steps[0]?.conditions[0],
    );
    expect(duplicate.messageTriggers?.[0]).not.toBe(
      source.messageTriggers?.[0],
    );
  });

  it("keeps the copy suffix when duplicating a full-length label", () => {
    const source = normalizeCombatProfile({
      ...canonicalLibrary.profiles[1]!,
      label: `${"Long Rotation ".repeat(5)}Name ABCDEFG`,
    });
    const first = duplicateCombatProfile(source, [source], () => "copy-1");
    const second = duplicateCombatProfile(
      source,
      [source, first],
      () => "copy-2",
    );

    expect(source.label).toHaveLength(80);
    expect(first.label).toBe(
      "Long Rotation Long Rotation Long Rotation Long Rotation Long Rotation Name Copy",
    );
    expect(second.label).toBe(
      "Long Rotation Long Rotation Long Rotation Long Rotation Long Rotation Copy 2",
    );
    expect(normalizeCombatProfile(second).label).toBe(second.label);
  });

  it("cuts mid-word instead of dropping most of a label with an early space", () => {
    const source = normalizeCombatProfile({
      ...canonicalLibrary.profiles[1]!,
      label: `A ${"VeryLongNameWithoutAnySpaces".repeat(3)}`.slice(0, 80),
    });

    expect(duplicateCombatProfile(source, [source], () => "copy-1").label).toBe(
      "A VeryLongNameWithoutAnySpacesVeryLongNameWithoutAnySpacesVeryLongNameWitho Copy",
    );
  });
});
