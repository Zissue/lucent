import { describe, expect, it } from "@effect/vitest";

import { matchesEvent, type Event, type EventSelector } from "./Event";

describe("matchesEvent", () => {
  it("matches only the selected event's scalar fields", () => {
    const event: Event = {
      kind: "active",
      name: "Focus",
      stack: 5,
      sourceId: 2,
      sourceType: "player",
      targetId: 7,
      targetType: "monster",
      type: "aura-added",
    };

    expect(matchesEvent(event, undefined)).toBe(true);
    expect(
      matchesEvent(event, {
        name: "Focus",
        targetId: 7,
        type: "aura-added",
      }),
    ).toBe(true);
    expect(
      matchesEvent(event, {
        name: "Vendetta",
        type: "aura-added",
      }),
    ).toBe(false);
    expect(
      matchesEvent(event, {
        monsterMapId: 7,
        type: "aura-added",
      } as unknown as EventSelector),
    ).toBe(false);
    expect(matchesEvent(event, null as unknown as EventSelector)).toBe(false);
    const updated: Event = { ...event, type: "aura-updated", stack: 2 };
    expect(
      matchesEvent(updated, {
        type: "aura-updated",
        name: "Focus",
        targetId: 7,
      }),
    ).toBe(true);
    expect(matchesEvent(updated, { type: "aura-added", name: "Focus" })).toBe(
      false,
    );
    expect(matchesEvent(updated, { type: "aura-updated", name: "focus" })).toBe(
      false,
    );
  });

  it.each([
    {
      type: "aura-added",
      kind: "active",
      name: "Focus",
      stack: 5,
      targetId: 7,
      targetType: "monster",
    },
    {
      type: "aura-updated",
      kind: "active",
      name: "Focus",
      stack: 2,
      targetId: 7,
      targetType: "monster",
    },
    {
      type: "aura-removed",
      kind: "active",
      name: "Focus",
      targetId: 7,
      targetType: "monster",
    },
  ] satisfies readonly Event[])(
    "matches exact kind constraints for $type",
    (active) => {
      const { type } = active;
      const passive: Event = { ...active, kind: "passive" };

      expect(matchesEvent(active, { type, kind: "active" })).toBe(true);
      expect(matchesEvent(passive, { type, kind: "passive" })).toBe(true);
      expect(matchesEvent(active, { type, kind: "passive" })).toBe(false);
      expect(matchesEvent(passive, { type, kind: "active" })).toBe(false);
      expect(matchesEvent(active, { type, name: "Focus" })).toBe(true);
      expect(matchesEvent(passive, { type, name: "Focus" })).toBe(true);
      expect(matchesEvent(active, undefined)).toBe(true);
      expect(matchesEvent(passive, undefined)).toBe(true);
      expect(
        matchesEvent(active, {
          type,
          kind: "Active",
        } as unknown as EventSelector),
      ).toBe(false);
      expect(
        matchesEvent(active, {
          type,
          kind: undefined,
        } as unknown as EventSelector),
      ).toBe(false);
    },
  );
});
